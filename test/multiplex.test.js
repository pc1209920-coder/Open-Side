'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {
  P2PNode,
  P2PStream,
  STREAM_FRAME_TAG,
  STREAM_FLAG_DATA,
  STREAM_FLAG_FIN,
  STREAM_FLAG_RST,
  STREAM_FLAG_MSG,
  MultiplexError,
  SocketDestroyedError,
  FrameTooLargeError,
  SecurityError
} = require('../src/node');
const { StandbySandbox } = require('../src/sandbox');

let ipcSeq = 0;
function makeUniqueIpcPath(tag = 'mux') {
  ipcSeq += 1;
  const suffix = `${tag}-${process.pid}-${Date.now()}-${ipcSeq}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\openside-mux-${suffix}`;
  }
  return path.join(os.tmpdir(), `openside-mux-${suffix}.sock`);
}

function isTcpRestrictedError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM'));
}

async function createConnectedPair(optsA = {}, optsB = {}) {
  async function attempt(useIpc) {
    const nodeA = new P2PNode({
      ...(useIpc ? { ipcPath: makeUniqueIpcPath('pair-a') } : { port: 0 }),
      ...optsA
    });
    const nodeB = new P2PNode({
      ...(useIpc ? { ipcPath: makeUniqueIpcPath('pair-b') } : { port: 0 }),
      ...optsB
    });

    let epA;
    try {
      epA = await nodeA.listen(useIpc ? { ipcPath: nodeA._configuredIpcPath } : undefined);
      await nodeB.listen(useIpc ? { ipcPath: nodeB._configuredIpcPath } : undefined);
    } catch (err) {
      await Promise.allSettled([nodeA.close(), nodeB.close()]);
      if (!useIpc && isTcpRestrictedError(err)) {
        return attempt(true);
      }
      throw err;
    }

    try {
      let socket;
      try {
        socket = await nodeB.connect(epA);
      } catch (err) {
        if (!useIpc && isTcpRestrictedError(err)) {
          await Promise.allSettled([nodeA.close(), nodeB.close()]);
          return attempt(true);
        }
        throw err;
      }
      await nodeB.initiateHandshake(socket, nodeA.crypto.publicKey);
      return { nodeA, nodeB, epA, socket };
    } catch (err) {
      await Promise.allSettled([nodeA.close(), nodeB.close()]);
      throw err;
    }
  }

  return attempt(false);
}

// ============================================================================
// Section 1: Wire Layout & ID Validation
// ============================================================================

test('Stream Multiplexing - Frame encoding and decoding wire layout', () => {
  const streamId = 42;
  const rawPayload = Buffer.from('hello-stream-data', 'utf8');

  // Encode binary stream frame
  const frame = P2PNode.encodeStreamFrame(streamId, rawPayload, STREAM_FLAG_DATA);
  assert.ok(Buffer.isBuffer(frame));

  // Verify header: 4 bytes length, 1 byte 0x03, 2 bytes streamId, 1 byte flags
  const totalBodyLen = frame.readUInt32BE(0);
  assert.strictEqual(totalBodyLen, 4 + rawPayload.length);
  assert.strictEqual(frame[4], STREAM_FRAME_TAG);
  assert.strictEqual(frame.readUInt16BE(5), 42);
  assert.strictEqual(frame[7], STREAM_FLAG_DATA);
  assert.strictEqual(frame.subarray(8).toString('utf8'), 'hello-stream-data');

  // Decode wire body
  const bodyBuf = frame.subarray(4);
  const decoded = P2PNode.decodeWireBody(bodyBuf);
  assert.strictEqual(decoded.isStream, true);
  assert.strictEqual(decoded.streamId, 42);
  assert.strictEqual(decoded.flags, STREAM_FLAG_DATA);
  assert.strictEqual(decoded.data.toString('utf8'), 'hello-stream-data');
});

test('Stream Multiplexing - Rejects invalid streamIds fail-closed', () => {
  assert.throws(() => P2PNode.encodeStreamFrame(-1, Buffer.alloc(1)), RangeError);
  assert.throws(() => P2PNode.encodeStreamFrame(65536, Buffer.alloc(1)), RangeError);
  assert.throws(() => P2PNode.encodeStreamFrame(NaN, Buffer.alloc(1)), RangeError);
  assert.throws(() => P2PNode.encodeStreamFrame(Infinity, Buffer.alloc(1)), RangeError);
  assert.throws(() => P2PNode.encodeStreamFrame('42', Buffer.alloc(1)), RangeError);
  assert.throws(() => P2PNode.encodeStreamFrame(3.14, Buffer.alloc(1)), RangeError);

  // Boundary checks: 0 and 65535 are valid uint16
  const f0 = P2PNode.encodeStreamFrame(0, Buffer.alloc(0));
  assert.strictEqual(f0.readUInt16BE(5), 0);
  const fMax = P2PNode.encodeStreamFrame(65535, Buffer.alloc(0));
  assert.strictEqual(fMax.readUInt16BE(5), 65535);
});

// ============================================================================
// Section 2: Stream ID Lifecycle, Reuse & Collision
// ============================================================================

test('Stream Multiplexing - Stream ID collision detection and reuse after teardown', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const streamId = 250;
    const stream1 = nodeB.createStream(nodeA.nodeId, { streamId });
    assert.strictEqual(stream1.streamId, streamId);

    // Collision detection: creating another stream with same streamId must throw ERR_STREAM_EXISTS
    assert.throws(
      () => nodeB.createStream(nodeA.nodeId, { streamId }),
      (err) => err instanceof MultiplexError && err.code === 'ERR_STREAM_EXISTS'
    );

    // Teardown stream1
    const closePromise = new Promise((resolve) => stream1.on('close', resolve));
    stream1.destroy();
    await closePromise;

    // After close, streamId should be reusable on the same connection
    const stream2 = nodeB.createStream(nodeA.nodeId, { streamId });
    assert.strictEqual(stream2.streamId, streamId);
    stream2.destroy();
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

test('Stream Multiplexing - Auto-assigned stream ID allocation avoids collisions', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const s1 = nodeB.createStream(nodeA.nodeId);
    const s2 = nodeB.createStream(nodeA.nodeId);
    const s3 = nodeB.createStream(nodeA.nodeId);

    assert.ok(s1.streamId > 0 && s1.streamId <= 0xffff);
    assert.ok(s2.streamId > 0 && s2.streamId <= 0xffff);
    assert.ok(s3.streamId > 0 && s3.streamId <= 0xffff);

    assert.notStrictEqual(s1.streamId, s2.streamId);
    assert.notStrictEqual(s2.streamId, s3.streamId);
    assert.notStrictEqual(s1.streamId, s3.streamId);

    // Close s2 and allocate s4
    const s2Closed = new Promise((resolve) => s2.on('close', resolve));
    s2.destroy();
    await s2Closed;

    const s4 = nodeB.createStream(nodeA.nodeId);
    assert.ok(s4.streamId > 0 && s4.streamId <= 0xffff);
    assert.notStrictEqual(s4.streamId, s1.streamId);
    assert.notStrictEqual(s4.streamId, s3.streamId);

    s1.destroy();
    s3.destroy();
    s4.destroy();
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

// ============================================================================
// Section 3: Frame Corruption & Error Handling
// ============================================================================

test('Stream Multiplexing - Rejects stream frame on unauthenticated socket fail-closed', async () => {
  async function runAttempt(useIpc = false) {
    const node = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('unauth-node') } : { port: 0 });
    let ep;
    try {
      ep = await node.listen(useIpc ? { ipcPath: node._configuredIpcPath } : undefined);
    } catch (err) {
      await node.close();
      if (!useIpc && isTcpRestrictedError(err)) {
        return runAttempt(true);
      }
      throw err;
    }

    let client;
    try {
      let nodeError = null;
      node.on('error', (err) => {
        nodeError = err;
      });

      try {
        client = await new Promise((resolve, reject) => {
          const s = useIpc ? net.connect(ep.ipcPath) : net.connect(ep.port, ep.address);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
      } catch (err) {
        if (!useIpc && isTcpRestrictedError(err)) {
          await node.close();
          return runAttempt(true);
        }
        throw err;
      }

      const socketClosedPromise = new Promise((resolve) => {
        client.on('close', resolve);
        client.on('end', resolve);
        client.on('error', () => resolve());
      });

      // Send unauthenticated stream frame (format tag 0x03)
      const frame = P2PNode.encodeStreamFrame(1, Buffer.from('unauth-payload'), STREAM_FLAG_DATA);
      client.write(frame);

      await socketClosedPromise;
      assert.ok(nodeError, 'Node should have emitted an authentication error');
      assert.strictEqual(nodeError.code, 'ERR_UNAUTHENTICATED_STREAM_FRAME');
    } finally {
      if (client && !client.destroyed) client.destroy();
      await node.close();
    }
  }

  await runAttempt(false);
});

test('Stream Multiplexing - Rejects frame exceeding maxFrameSize fail-closed', async () => {
  async function runAttempt(useIpc = false) {
    const maxFrameSize = 1024;
    const node = new P2PNode(
      useIpc ? { ipcPath: makeUniqueIpcPath('large-node'), maxFrameSize } : { port: 0, maxFrameSize }
    );
    let ep;
    try {
      ep = await node.listen(useIpc ? { ipcPath: node._configuredIpcPath } : undefined);
    } catch (err) {
      await node.close();
      if (!useIpc && isTcpRestrictedError(err)) {
        return runAttempt(true);
      }
      throw err;
    }

    let client;
    try {
      let nodeError = null;
      node.on('error', (err) => {
        nodeError = err;
      });

      try {
        client = await new Promise((resolve, reject) => {
          const s = useIpc ? net.connect(ep.ipcPath) : net.connect(ep.port, ep.address);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
      } catch (err) {
        if (!useIpc && isTcpRestrictedError(err)) {
          await node.close();
          return runAttempt(true);
        }
        throw err;
      }

      const socketClosedPromise = new Promise((resolve) => {
        client.on('close', resolve);
        client.on('end', resolve);
        client.on('error', () => resolve());
      });

      // Send frame header claiming 2048 bytes (exceeds maxFrameSize 1024)
      const oversizedHeader = Buffer.alloc(4);
      oversizedHeader.writeUInt32BE(2048, 0);
      client.write(oversizedHeader);

      await socketClosedPromise;
      assert.ok(nodeError, 'Node should emit FrameTooLargeError');
      assert.strictEqual(nodeError.code, 'ERR_FRAME_TOO_LARGE');
    } finally {
      if (client && !client.destroyed) client.destroy();
      await node.close();
    }
  }

  await runAttempt(false);
});

test('Stream Multiplexing - Corrupted structured message payload falls back to raw Buffer', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const stream = nodeB.createStream(nodeA.nodeId, { streamId: 301 });
    const corruptBytes = Buffer.from([0x00, 0xff, 0xfe, 0x12, 0x34]);

    const receivedPromise = new Promise((resolve) => {
      nodeA.on('streamMessage', ({ streamId, data }) => {
        if (streamId === 301) {
          resolve(data);
        }
      });
    });

    // Manually encode a STREAM_FLAG_MSG with corrupt payload bytes
    const frame = P2PNode.encodeStreamFrame(301, corruptBytes, STREAM_FLAG_MSG);
    stream.socket.write(frame);

    const received = await receivedPromise;
    assert.ok(Buffer.isBuffer(received));
    assert.deepStrictEqual(received, corruptBytes);
    stream.destroy();
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

test('Stream Multiplexing - Remote RST frame tears down stream with ERR_STREAM_RESET', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const streamOnB = nodeB.createStream(nodeA.nodeId, { streamId: 401 });
    streamOnB.on('error', () => {}); // Handle local reset error

    let streamOnA;
    const streamCreatedOnA = new Promise((resolve) => {
      nodeA.on('stream', (s) => {
        if (s.streamId === 401) {
          streamOnA = s;
          resolve(s);
        }
      });
    });

    // Send initial frame so nodeA allocates streamOnA
    await streamOnB.sendMessage({ hello: 'init' });
    await streamCreatedOnA;
    assert.ok(streamOnA);

    const resetErrorPromise = new Promise((resolve) => {
      streamOnA.on('error', (err) => resolve(err));
    });

    // Send RST from B to A
    streamOnB.reset();

    const resetErr = await resetErrorPromise;
    assert.ok(resetErr instanceof MultiplexError);
    assert.strictEqual(resetErr.code, 'ERR_STREAM_RESET');
    assert.ok(streamOnA.destroyed);
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

test('Stream Multiplexing - Post-destruction write and sendMessage throw SocketDestroyedError', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const stream = nodeB.createStream(nodeA.nodeId, { streamId: 501 });

    // 1. sendMessage after stream.destroy throws SocketDestroyedError
    stream.destroy();
    await assert.rejects(
      async () => stream.sendMessage({ test: 'fail' }),
      (err) => err instanceof SocketDestroyedError
    );

    // 2. write after socket destruction triggers SocketDestroyedError
    const stream2 = nodeB.createStream(nodeA.nodeId, { streamId: 502 });
    stream2.on('error', () => {}); // Handle stream error emission on write failure
    stream2.socket.destroy();

    await assert.rejects(
      async () => stream2.sendMessage({ test: 'fail' }),
      (err) => err instanceof SocketDestroyedError
    );

    const writeErr = await new Promise((resolve) => {
      stream2.write(Buffer.from('hello'), (err) => resolve(err));
    });
    assert.ok(writeErr instanceof SocketDestroyedError);
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

// ============================================================================
// Section 4: Concurrency & Duplex Streaming
// ============================================================================

test('Stream Multiplexing - Deterministic concurrent streams over live P2PNode connection', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    // Create 3 concurrent streams on nodeB targeting nodeA
    const stream1 = nodeB.createStream(nodeA.nodeId, { streamId: 101 });
    const stream2 = nodeB.createStream(nodeA.nodeId, { streamId: 102 });
    const stream3 = nodeB.createStream(nodeA.nodeId, { streamId: 103 });

    const receivedOnA = new Map();
    const allReceived = new Promise((resolve) => {
      nodeA.on('streamMessage', ({ streamId, data }) => {
        receivedOnA.set(streamId, data);
        if (receivedOnA.size === 3) resolve();
      });
    });

    // Send messages concurrently on all 3 streams
    await Promise.all([
      stream1.sendMessage({ task: 'shard-alpha', index: 1 }),
      stream2.sendMessage({ task: 'shard-beta', index: 2 }),
      stream3.sendMessage({ task: 'shard-gamma', index: 3 })
    ]);

    // Deterministic event-driven barrier (no arbitrary setTimeout)
    await allReceived;

    assert.strictEqual(receivedOnA.size, 3);
    assert.deepStrictEqual(receivedOnA.get(101), { task: 'shard-alpha', index: 1 });
    assert.deepStrictEqual(receivedOnA.get(102), { task: 'shard-beta', index: 2 });
    assert.deepStrictEqual(receivedOnA.get(103), { task: 'shard-gamma', index: 3 });

    // Clean teardown
    stream1.destroy();
    stream2.destroy();
    stream3.destroy();
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

test('Stream Multiplexing - True bidirectional concurrent duplex binary streaming', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    // Stream 1: B -> A
    // Stream 2: A -> B
    const streamBtoA = nodeB.createStream(nodeA.nodeId, { streamId: 601 });
    const streamAtoB = nodeA.createStream(nodeB.nodeId, { streamId: 602 });

    const receivedChunksOnA = [];
    const streamOnAPromise = new Promise((resolve) => {
      nodeA.on('stream', (s) => {
        if (s.streamId === 601) {
          s.on('data', (c) => receivedChunksOnA.push(c));
          s.on('end', () => resolve(Buffer.concat(receivedChunksOnA)));
        }
      });
    });

    const receivedChunksOnB = [];
    const streamOnBPromise = new Promise((resolve) => {
      nodeB.on('stream', (s) => {
        if (s.streamId === 602) {
          s.on('data', (c) => receivedChunksOnB.push(c));
          s.on('end', () => resolve(Buffer.concat(receivedChunksOnB)));
        }
      });
    });

    const dataFromB = Buffer.alloc(16 * 1024, 0xaa);
    const dataFromA = Buffer.alloc(16 * 1024, 0xbb);

    // Concurrently write and end in both directions
    await Promise.all([
      new Promise((res, rej) => streamBtoA.end(dataFromB, (err) => (err ? rej(err) : res()))),
      new Promise((res, rej) => streamAtoB.end(dataFromA, (err) => (err ? rej(err) : res())))
    ]);

    const [finalOnA, finalOnB] = await Promise.all([streamOnAPromise, streamOnBPromise]);

    assert.strictEqual(finalOnA.length, 16 * 1024);
    assert.deepStrictEqual(finalOnA, dataFromB);

    assert.strictEqual(finalOnB.length, 16 * 1024);
    assert.deepStrictEqual(finalOnB, dataFromA);
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

test('Stream Multiplexing - High concurrency multi-stream stress test (16 concurrent streams)', async () => {
  const { nodeA, nodeB } = await createConnectedPair();
  try {
    const STREAM_COUNT = 16;
    const streams = [];
    const receivedMap = new Map();

    const allReceivedPromise = new Promise((resolve) => {
      nodeA.on('streamMessage', ({ streamId, data }) => {
        receivedMap.set(streamId, data);
        if (receivedMap.size === STREAM_COUNT) {
          resolve();
        }
      });
    });

    for (let i = 1; i <= STREAM_COUNT; i++) {
      const s = nodeB.createStream(nodeA.nodeId, { streamId: 1000 + i });
      streams.push(s);
    }

    // Send messages across all 16 streams concurrently
    await Promise.all(
      streams.map((s, idx) => s.sendMessage({ streamIndex: idx + 1, payload: `payload-${idx + 1}` }))
    );

    await allReceivedPromise;

    assert.strictEqual(receivedMap.size, STREAM_COUNT);
    for (let i = 1; i <= STREAM_COUNT; i++) {
      assert.deepStrictEqual(receivedMap.get(1000 + i), {
        streamIndex: i,
        payload: `payload-${i}`
      });
    }

    streams.forEach((s) => s.destroy());
  } finally {
    await Promise.allSettled([nodeA.close(), nodeB.close()]);
  }
});

// ============================================================================
// Section 5: Batch Shard Pipelining
// ============================================================================

test('Batch Shard Pipelining - dispatchPipelinedBatch executes concurrent shards over single connection', async () => {
  async function runAttempt(useIpc = false) {
    const sandbox = new StandbySandbox();
    const workerNode = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('worker'), sandbox } : { port: 0, sandbox });
    const coordinatorNode = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('coord') } : { port: 0 });

    let workerEp;
    try {
      workerEp = await workerNode.listen(useIpc ? { ipcPath: workerNode._configuredIpcPath } : undefined);
      await coordinatorNode.listen(useIpc ? { ipcPath: coordinatorNode._configuredIpcPath } : undefined);
    } catch (err) {
      await Promise.allSettled([workerNode.close(), coordinatorNode.close()]);
      if (!useIpc && isTcpRestrictedError(err)) {
        return await runAttempt(true);
      }
      throw err;
    }

    try {
      let socket;
      try {
        socket = await coordinatorNode.connect(workerEp);
      } catch (err) {
        if (!useIpc && isTcpRestrictedError(err)) {
          await Promise.allSettled([workerNode.close(), coordinatorNode.close()]);
          return await runAttempt(true);
        }
        throw err;
      }
      await coordinatorNode.initiateHandshake(socket, workerNode.crypto.publicKey);

      // Batch of 5 shards to execute in parallel
      const shards = [
        { shardId: 'batch-shard-1', taskCode: 'return data.val * 2;', inputData: { val: 10 } },
        { shardId: 'batch-shard-2', taskCode: 'return data.val * 3;', inputData: { val: 20 } },
        { shardId: 'batch-shard-3', taskCode: 'return data.val + 100;', inputData: { val: 5 } },
        { shardId: 'batch-shard-4', taskCode: 'return data.text.toUpperCase();', inputData: { text: 'openside' } },
        { shardId: 'batch-shard-5', taskCode: 'return data.arr.reduce((a, b) => a + b, 0);', inputData: { arr: [1, 2, 3, 4] } }
      ];

      const results = await coordinatorNode.dispatchPipelinedBatch(workerNode.nodeId, shards);

      assert.strictEqual(results.length, 5);
      assert.strictEqual(results[0].shardId, 'batch-shard-1');
      assert.strictEqual(results[0].output, 20);

      assert.strictEqual(results[1].shardId, 'batch-shard-2');
      assert.strictEqual(results[1].output, 60);

      assert.strictEqual(results[2].shardId, 'batch-shard-3');
      assert.strictEqual(results[2].output, 105);

      assert.strictEqual(results[3].shardId, 'batch-shard-4');
      assert.strictEqual(results[3].output, 'OPENSIDE');

      assert.strictEqual(results[4].shardId, 'batch-shard-5');
      assert.strictEqual(results[4].output, 10);
    } finally {
      await Promise.all([workerNode.close(), coordinatorNode.close()]);
    }
  }

  await runAttempt(false);
});
