'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const {
  P2PNode,
  P2PStream,
  STREAM_FRAME_TAG,
  STREAM_FLAG_DATA,
  STREAM_FLAG_FIN,
  STREAM_FLAG_RST,
  STREAM_FLAG_MSG,
  MultiplexError
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
});

test('Stream Multiplexing - Bidirectional concurrent streams over live P2PNode connection', async () => {
  async function runAttempt(useIpc = false) {
    const nodeA = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('mux-a') } : { port: 0 });
    const nodeB = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('mux-b') } : { port: 0 });

    let epA, epB;
    try {
      epA = await nodeA.listen(useIpc ? { ipcPath: nodeA.ipcPath } : undefined);
      epB = await nodeB.listen(useIpc ? { ipcPath: nodeB.ipcPath } : undefined);
    } catch (err) {
      await Promise.allSettled([nodeA.close(), nodeB.close()]);
      if (!useIpc && isTcpRestrictedError(err)) {
        return await runAttempt(true);
      }
      throw err;
    }

    try {
      // Connect nodeB -> nodeA with endpoint object and perform handshake
      let socket;
      try {
        socket = await nodeB.connect(epA);
      } catch (err) {
        if (!useIpc && isTcpRestrictedError(err)) {
          await Promise.allSettled([nodeA.close(), nodeB.close()]);
          return await runAttempt(true);
        }
        throw err;
      }
      await nodeB.initiateHandshake(socket, nodeA.crypto.publicKey);

      // Create 3 concurrent streams on nodeB targeting nodeA
      const stream1 = nodeB.createStream(nodeA.nodeId, { streamId: 101 });
      const stream2 = nodeB.createStream(nodeA.nodeId, { streamId: 102 });
      const stream3 = nodeB.createStream(nodeA.nodeId, { streamId: 103 });

      const receivedOnA = new Map();
      nodeA.on('streamMessage', ({ streamId, data }) => {
        receivedOnA.set(streamId, data);
      });

      // Send messages concurrently on all 3 streams
      await Promise.all([
        stream1.sendMessage({ task: 'shard-alpha', index: 1 }),
        stream2.sendMessage({ task: 'shard-beta', index: 2 }),
        stream3.sendMessage({ task: 'shard-gamma', index: 3 })
      ]);

      // Give a brief tick for network delivery
      await new Promise((r) => setTimeout(r, 60));

      assert.strictEqual(receivedOnA.size, 3);
      assert.deepStrictEqual(receivedOnA.get(101), { task: 'shard-alpha', index: 1 });
      assert.deepStrictEqual(receivedOnA.get(102), { task: 'shard-beta', index: 2 });
      assert.deepStrictEqual(receivedOnA.get(103), { task: 'shard-gamma', index: 3 });

      // Clean teardown
      stream1.destroy();
      stream2.destroy();
      stream3.destroy();
    } finally {
      await Promise.all([nodeA.close(), nodeB.close()]);
    }
  }

  await runAttempt(false);
});

test('Batch Shard Pipelining - dispatchPipelinedBatch executes concurrent shards over single connection', async () => {
  async function runAttempt(useIpc = false) {
    const sandbox = new StandbySandbox();
    const workerNode = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('worker'), sandbox } : { port: 0, sandbox });
    const coordinatorNode = new P2PNode(useIpc ? { ipcPath: makeUniqueIpcPath('coord') } : { port: 0 });

    let workerEp;
    try {
      workerEp = await workerNode.listen(useIpc ? { ipcPath: workerNode.ipcPath } : undefined);
      await coordinatorNode.listen(useIpc ? { ipcPath: coordinatorNode.ipcPath } : undefined);
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
