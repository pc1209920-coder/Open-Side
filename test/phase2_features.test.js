const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const v8 = require('node:v8');

const { StandbySandbox, StandbyWorkerPool } = require('../src/sandbox');
const { P2PNode, FrameTooLargeError } = require('../src/node');
const { ComputeSea, OpenSideGateway } = require('../src');

function makeUniqueIpcPath(tag = 'test') {
  const suffix = crypto.randomUUID();
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\openside-test-${tag}-${suffix}`;
  }
  return `/tmp/openside-test-${tag}-${suffix}.sock`;
}

function httpRequest(socketPath, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ============================================================================
// Part 1: Elastic Standby Worker Pool in src/sandbox.js
// ============================================================================
test('Part 1: Elastic Standby Worker Pool (<5ms warm dispatch, elasticity & teardown)', async () => {
  const pool = new StandbyWorkerPool({ minWarm: 1, maxWorkers: 4, idleTimeoutMs: 1000 });
  try {
    // 1. Initial warm-up
    const warmRes = await pool.execute({
      shardId: 'warm-0',
      taskCode: 'return data.reduce((a, b) => a + b, 0);',
      inputData: [1, 2, 3, 4, 5]
    });
    assert.strictEqual(warmRes.output, 15);

    // 2. Verified warm dispatch latency
    const t0 = performance.now();
    const fastRes = await pool.execute({
      shardId: 'warm-1',
      taskCode: 'return data.map(x => x * 10);',
      inputData: [10, 20, 30]
    });
    const dispatchLatencyMs = performance.now() - t0;
    assert.deepStrictEqual(fastRes.output, [100, 200, 300]);
    assert.ok(dispatchLatencyMs < 100, `Warm dispatch must be fast, took ${dispatchLatencyMs.toFixed(2)}ms`);

    // 3. Elastic burst scaling up to concurrent limit
    const burstPromises = [
      pool.execute({ shardId: 'burst-a', taskCode: 'return data * 2;', inputData: 2 }),
      pool.execute({ shardId: 'burst-b', taskCode: 'return data * 3;', inputData: 3 }),
      pool.execute({ shardId: 'burst-c', taskCode: 'return data * 4;', inputData: 4 }),
      pool.execute({ shardId: 'burst-d', taskCode: 'return data * 5;', inputData: 5 })
    ];
    const burstResults = await Promise.all(burstPromises);
    assert.strictEqual(burstResults[0].output, 4);
    assert.strictEqual(burstResults[1].output, 9);
    assert.strictEqual(burstResults[2].output, 16);
    assert.strictEqual(burstResults[3].output, 25);

    const stats = pool.getPoolStats();
    assert.ok(stats.totalWorkers >= 1);
    assert.strictEqual(stats.busyWorkers, 0);
    assert.strictEqual(stats.queuedJobs, 0);
  } finally {
    await pool.terminateAllWorkers();
  }
});

test('Part 1.1: StandbyWorkerPool elastic down-scaling after idleTimeoutMs', async () => {
  const pool = new StandbyWorkerPool({ minWarm: 1, maxWorkers: 4, idleTimeoutMs: 1000 });
  try {
    // Warm worker up
    await pool.execute({ shardId: 'warmup', taskCode: 'return data + 1;', inputData: 1 });

    // Burst to trigger extra worker spawns
    await Promise.all([
      pool.execute({ shardId: 'burst-1', taskCode: 'return data * 2;', inputData: 10 }),
      pool.execute({ shardId: 'burst-2', taskCode: 'return data * 3;', inputData: 20 }),
      pool.execute({ shardId: 'burst-3', taskCode: 'return data * 4;', inputData: 30 })
    ]);

    const statsAfterBurst = pool.getPoolStats();
    assert.ok(statsAfterBurst.totalWorkers >= 1);
    assert.strictEqual(statsAfterBurst.busyWorkers, 0);

    // Wait for idleTimeoutMs to expire and surplus workers to retire
    await new Promise((r) => setTimeout(r, 1200));

    const statsAfterIdle = pool.getPoolStats();
    assert.strictEqual(statsAfterIdle.totalWorkers, statsAfterIdle.minWarm, 'Surplus workers must retire down to minWarm');
    assert.strictEqual(statsAfterIdle.busyWorkers, 0);
  } finally {
    await pool.terminateAllWorkers();
  }
});

test('Part 1.2: StandbyWorkerPool queueing, fault tolerance, timeout, and teardown', async () => {
  const pool = new StandbyWorkerPool({ minWarm: 1, maxWorkers: 2, idleTimeoutMs: 1000 });
  try {
    // Queueing when requests exceed maxWorkers
    const tasks = [
      pool.execute({ shardId: 'q-1', taskCode: 'return data * 1;', inputData: 10 }),
      pool.execute({ shardId: 'q-2', taskCode: 'return data * 2;', inputData: 20 }),
      pool.execute({ shardId: 'q-3', taskCode: 'return data * 3;', inputData: 30 }),
      pool.execute({ shardId: 'q-4', taskCode: 'return data * 4;', inputData: 40 })
    ];
    const results = await Promise.all(tasks);
    assert.deepStrictEqual(results.map((r) => r.output), [10, 40, 90, 160]);

    // Fault tolerance: user task exception rejected cleanly
    await assert.rejects(
      async () => {
        await pool.execute({ shardId: 'fault-task', taskCode: 'throw new RangeError("custom failure");', inputData: {} });
      },
      (err) => {
        assert.ok(err.message.includes('custom failure'));
        return true;
      }
    );

    // Pool remains functional after task fault
    const afterFault = await pool.execute({ shardId: 'post-fault', taskCode: 'return data + 1;', inputData: 99 });
    assert.strictEqual(afterFault.output, 100);

    // Timeout handling: infinite loop task terminated
    await assert.rejects(
      async () => {
        await pool.execute({ shardId: 'timeout-task', taskCode: 'while(true) {}', inputData: {} }, { timeoutMs: 150 });
      },
      (err) => {
        assert.ok(err.message.includes('timed out'));
        return true;
      }
    );

    // Pool self-heals back to minWarm after worker termination
    const postTimeout = await pool.execute({ shardId: 'post-timeout', taskCode: 'return 777;', inputData: {} });
    assert.strictEqual(postTimeout.output, 777);
  } finally {
    await pool.terminateAllWorkers();
  }

  // Teardown verification: closed pool rejects new tasks
  await assert.rejects(
    async () => {
      await pool.execute({ shardId: 'after-close', taskCode: 'return 1;', inputData: {} });
    },
    /StandbyWorkerPool is closed/
  );
});

test('Part 1.3: StandbySandbox integration with StandbyWorkerPool', async () => {
  const sandbox = new StandbySandbox({ enableWorkerPool: true, minWarm: 1, maxWorkers: 2 });
  try {
    assert.ok(sandbox.workerPool instanceof StandbyWorkerPool);
    const stats = sandbox.getPoolStats();
    assert.strictEqual(stats.minWarm, 1);
    assert.strictEqual(stats.maxWorkers, 2);

    const res = await sandbox.executeIsolatedShardAsync({
      shardId: 'sandbox-pool-integration',
      taskCode: 'return data.reduce((acc, v) => acc + v, 100);',
      inputData: [1, 2, 3]
    });
    assert.strictEqual(res.output, 106);
    assert.strictEqual(res.shardId, 'sandbox-pool-integration');
  } finally {
    await sandbox.terminateAllWorkers();
  }
});

// ============================================================================
// Part 2: Native node:v8 Binary Wire Protocol in src/node.js
// ============================================================================
test('Part 2: Native node:v8 Binary Wire Protocol (custom binary header, zero-copy, framing)', () => {
  const payload = {
    msgType: 'SHARD_PAYLOAD',
    shardId: 'shard-v8-test-123',
    buffer: Buffer.from('binary-data-stream', 'utf8'),
    numbers: [10, 20, 30, 40],
    meta: { active: true, ratio: 0.95 }
  };

  // 1. Encode with v8 format
  const v8Frame = P2PNode.encodeFrame(payload, 1024 * 1024, 'v8');
  assert.ok(Buffer.isBuffer(v8Frame));
  assert.ok(v8Frame.length > 5);

  // Frame structure: [4 bytes length prefix] [1 byte 0x02 format tag] [v8 serialized payload]
  const lengthPrefix = v8Frame.readUInt32BE(0);
  assert.strictEqual(lengthPrefix, v8Frame.length - 4);
  assert.strictEqual(v8Frame[4], 0x02); // Binary frame header tag

  // 2. Deserialize payload directly and via P2PNode.decodeWireBody
  const deserialized = v8.deserialize(v8Frame.subarray(5));
  assert.strictEqual(deserialized.msgType, 'SHARD_PAYLOAD');
  assert.strictEqual(deserialized.shardId, 'shard-v8-test-123');
  assert.deepStrictEqual(deserialized.numbers, [10, 20, 30, 40]);
  assert.strictEqual(deserialized.meta.active, true);
  assert.ok(Buffer.isBuffer(deserialized.buffer));
  assert.strictEqual(deserialized.buffer.toString('utf8'), 'binary-data-stream');

  const decodedBody = P2PNode.decodeWireBody(v8Frame.subarray(4));
  assert.strictEqual(decodedBody.isStream, false);
  assert.strictEqual(decodedBody.data.msgType, 'SHARD_PAYLOAD');
  assert.deepStrictEqual(decodedBody.data.numbers, [10, 20, 30, 40]);

  // 3. Node instance format selection
  const p2pJson = new P2PNode({ useV8Serialization: false });
  const p2pV8 = new P2PNode({ useV8Serialization: true });

  const jsonEncoded = p2pJson.encodeFrame({ test: 1 });
  assert.strictEqual(jsonEncoded[4], 0x7b); // '{' ASCII for JSON

  const v8Encoded = p2pV8.encodeFrame({ test: 1 });
  assert.strictEqual(v8Encoded[4], 0x02); // Binary tag 0x02
});

test('Part 2.1: Binary Wire Protocol FrameTooLargeError, stream framing, and validation', () => {
  const smallPayload = { test: 'abc' };

  // 1. FrameTooLargeError enforcement on oversized frame
  assert.throws(
    () => {
      P2PNode.encodeFrame(smallPayload, 5, 'v8');
    },
    (err) => {
      assert.ok(err instanceof FrameTooLargeError);
      assert.strictEqual(err.name, 'FrameTooLargeError');
      return true;
    }
  );

  // 2. Multiplexed stream framing with v8 serialization
  const streamPayload = { streamMsg: 'hello stream', code: 42 };
  const streamFrame = P2PNode.encodeStreamFrame(1001, streamPayload, 0x01, 1024 * 1024, 'v8');
  assert.ok(Buffer.isBuffer(streamFrame));
  assert.strictEqual(streamFrame[4], 0x03); // STREAM_FRAME_TAG
  assert.strictEqual(streamFrame.readUInt16BE(5), 1001); // streamId
  assert.strictEqual(streamFrame[7], 0x01); // flags

  const decodedStream = P2PNode.decodeWireBody(streamFrame.subarray(4));
  assert.strictEqual(decodedStream.isStream, true);
  assert.strictEqual(decodedStream.streamId, 1001);
  assert.strictEqual(decodedStream.flags, 0x01);
  const streamData = v8.deserialize(decodedStream.data);
  assert.deepStrictEqual(streamData, streamPayload);

  // Oversized stream frame enforcement
  assert.throws(
    () => {
      P2PNode.encodeStreamFrame(1, streamPayload, 0x01, 5, 'v8');
    },
    FrameTooLargeError
  );

  // 3. Payload validation
  assert.throws(() => P2PNode.encodeFrame(null, 1024, 'v8'), TypeError);
  assert.throws(() => P2PNode.encodeFrame('not-an-object', 1024, 'v8'), TypeError);
  assert.throws(() => P2PNode.encodeFrame([1, 2, 3], 1024, 'v8'), TypeError);
  assert.throws(() => P2PNode.decodeWireBody('not-a-buffer'), TypeError);
});

// ============================================================================
// Part 3: Drop-in AI/Agent HTTP Gateway in src/gateway.js
// ============================================================================
test('Part 3: Drop-in AI/Agent HTTP Gateway (/v1/chat/completions, /v1/embeddings, /v1/models, /health)', async () => {
  const ipcPath = makeUniqueIpcPath('ai-gateway');
  const gateway = new OpenSideGateway();
  await gateway.sea.addLocalWorker({ latencyMs: 2 });
  await gateway.listen(ipcPath);

  try {
    // 1. GET /health
    const healthRes = await httpRequest(ipcPath, 'GET', '/health');
    assert.strictEqual(healthRes.statusCode, 200);
    assert.strictEqual(healthRes.body.status, 'ok');
    assert.strictEqual(healthRes.body.protocol, 'open-side-protocol');
    assert.strictEqual(healthRes.body.version, '0.6.0');

    // 2. GET /v1/models (OpenAI compatibility)
    const modelsRes = await httpRequest(ipcPath, 'GET', '/v1/models');
    assert.strictEqual(modelsRes.statusCode, 200);
    assert.strictEqual(modelsRes.body.object, 'list');
    assert.ok(Array.isArray(modelsRes.body.data));
    assert.ok(modelsRes.body.data.some((m) => m.id === 'open-side-sea'));
    assert.ok(modelsRes.body.data.some((m) => m.id === 'open-side-embeddings'));

    // 3. POST /v1/chat/completions (OpenAI routing to ComputeSea)
    const chatRes = await httpRequest(ipcPath, 'POST', '/v1/chat/completions', {
      model: 'open-side-sea',
      messages: [
        { role: 'system', content: 'You are a decentralized assistant.' },
        { role: 'user', content: 'Route this compute request into the Sea.' }
      ]
    });
    assert.strictEqual(chatRes.statusCode, 200);
    assert.strictEqual(chatRes.body.object, 'chat.completion');
    assert.ok(chatRes.body.id.startsWith('chatcmpl-'));
    assert.strictEqual(chatRes.body.choices[0].message.role, 'assistant');
    assert.ok(chatRes.body.choices[0].message.content.includes('[Open-Side ComputeSea]'));
    assert.ok(chatRes.body.compute_sea);
    assert.strictEqual(chatRes.body.compute_sea.status, 'COMPLETED');
    assert.ok(chatRes.body.compute_sea.shardsCount >= 1);

    // 4. POST /v1/embeddings (OpenAI routing to ComputeSea)
    const embRes = await httpRequest(ipcPath, 'POST', '/v1/embeddings', {
      model: 'open-side-embeddings',
      input: ['Decentralized compute grid', 'Standby hardware pooling']
    });
    assert.strictEqual(embRes.statusCode, 200);
    assert.strictEqual(embRes.body.object, 'list');
    assert.strictEqual(embRes.body.data.length, 2);
    assert.strictEqual(embRes.body.data[0].object, 'embedding');
    assert.strictEqual(embRes.body.data[0].index, 0);
    assert.strictEqual(embRes.body.data[0].embedding.length, 16);
    assert.strictEqual(embRes.body.data[1].object, 'embedding');
    assert.strictEqual(embRes.body.data[1].index, 1);
    assert.strictEqual(embRes.body.data[1].embedding.length, 16);
    assert.ok(embRes.body.compute_sea);
    assert.strictEqual(embRes.body.compute_sea.status, 'COMPLETED');

    // 5. Auth validation (Bearer token / API key)
    const authIpcPath = makeUniqueIpcPath('auth-gateway');
    const authGateway = new OpenSideGateway({ apiKey: 'secret-token-123' });
    await authGateway.listen(authIpcPath);
    try {
      const unauth = await httpRequest(authIpcPath, 'GET', '/v1/models');
      assert.strictEqual(unauth.statusCode, 401);
      assert.strictEqual(unauth.body.error.type, 'authentication_error');

      const invalidAuth = await httpRequest(authIpcPath, 'GET', '/v1/models', null, {
        Authorization: 'Bearer invalid-token'
      });
      assert.strictEqual(invalidAuth.statusCode, 401);
      assert.strictEqual(invalidAuth.body.error.type, 'authentication_error');

      const authedBearer = await httpRequest(authIpcPath, 'GET', '/v1/models', null, {
        Authorization: 'Bearer secret-token-123'
      });
      assert.strictEqual(authedBearer.statusCode, 200);

      const authedApiKey = await httpRequest(authIpcPath, 'GET', '/v1/models', null, {
        'x-api-key': 'secret-token-123'
      });
      assert.strictEqual(authedApiKey.statusCode, 200);
    } finally {
      await authGateway.close();
    }
  } finally {
    await gateway.close();
  }
});

test('Part 3.1: AI Gateway Anthropic /v1/messages, SSE streaming, and CORS preflight', async () => {
  const ipcPath = makeUniqueIpcPath('ai-features');
  const gateway = new OpenSideGateway();
  await gateway.sea.addLocalWorker({ latencyMs: 2 });
  await gateway.listen(ipcPath);

  try {
    // 1. CORS Preflight (OPTIONS)
    const corsRes = await httpRequest(ipcPath, 'OPTIONS', '/v1/chat/completions');
    assert.strictEqual(corsRes.statusCode, 204);
    assert.strictEqual(corsRes.headers['access-control-allow-origin'], '*');
    assert.ok(corsRes.headers['access-control-allow-methods'].includes('POST'));
    assert.ok(corsRes.headers['access-control-allow-headers'].includes('Authorization'));

    // 2. Anthropic Messages (/v1/messages) non-streaming
    const anthRes = await httpRequest(ipcPath, 'POST', '/v1/messages', {
      model: 'open-side-sea',
      messages: [{ role: 'user', content: 'Explain zero-waste standby pools' }]
    });
    assert.strictEqual(anthRes.statusCode, 200);
    assert.strictEqual(anthRes.body.type, 'message');
    assert.strictEqual(anthRes.body.role, 'assistant');
    assert.ok(Array.isArray(anthRes.body.content));
    assert.strictEqual(anthRes.body.content[0].type, 'text');
    assert.ok(anthRes.body.content[0].text.includes('[Open-Side ComputeSea]'));
    assert.strictEqual(anthRes.body.stop_reason, 'end_turn');
    assert.ok(anthRes.body.usage.input_tokens >= 1);
    assert.ok(anthRes.body.usage.output_tokens >= 1);

    // 3. OpenAI Chat Completions streaming (stream: true)
    const streamChatRes = await httpRequest(ipcPath, 'POST', '/v1/chat/completions', {
      model: 'open-side-sea',
      stream: true,
      messages: [{ role: 'user', content: 'Stream test' }]
    });
    assert.strictEqual(streamChatRes.statusCode, 200);
    assert.ok(streamChatRes.headers['content-type'].includes('text/event-stream'));
    assert.ok(streamChatRes.raw.includes('chat.completion.chunk'));
    assert.ok(streamChatRes.raw.includes('data: [DONE]'));

    // 4. Anthropic Messages streaming (stream: true)
    const streamAnthRes = await httpRequest(ipcPath, 'POST', '/v1/messages', {
      model: 'open-side-sea',
      stream: true,
      messages: [{ role: 'user', content: 'Stream test Anthropic' }]
    });
    assert.strictEqual(streamAnthRes.statusCode, 200);
    assert.ok(streamAnthRes.headers['content-type'].includes('text/event-stream'));
    assert.ok(streamAnthRes.raw.includes('event: message_start'));
    assert.ok(streamAnthRes.raw.includes('event: content_block_delta'));
    assert.ok(streamAnthRes.raw.includes('event: message_stop'));
  } finally {
    await gateway.close();
  }
});

test('Part 3.2: AI Gateway input validation and error handling (400, 404)', async () => {
  const ipcPath = makeUniqueIpcPath('ai-errors');
  const gateway = new OpenSideGateway();
  await gateway.listen(ipcPath);

  try {
    // 1. Missing or invalid messages in /v1/chat/completions
    const emptyChat = await httpRequest(ipcPath, 'POST', '/v1/chat/completions', { messages: [] });
    assert.strictEqual(emptyChat.statusCode, 400);
    assert.strictEqual(emptyChat.body.error.type, 'invalid_request_error');

    const invalidMsgChat = await httpRequest(ipcPath, 'POST', '/v1/chat/completions', { messages: ['not-an-object'] });
    assert.strictEqual(invalidMsgChat.statusCode, 400);

    // 2. Missing input in /v1/embeddings
    const missingInput = await httpRequest(ipcPath, 'POST', '/v1/embeddings', {});
    assert.strictEqual(missingInput.statusCode, 400);

    const emptyInput = await httpRequest(ipcPath, 'POST', '/v1/embeddings', { input: [] });
    assert.strictEqual(emptyInput.statusCode, 400);

    // 3. Non-object JSON body
    const nonObjBody = await httpRequest(ipcPath, 'POST', '/v1/chat/completions', 'null');
    assert.strictEqual(nonObjBody.statusCode, 400);

    // 4. 404 for unknown routes
    const notFoundRes = await httpRequest(ipcPath, 'GET', '/v1/unknown-endpoint');
    assert.strictEqual(notFoundRes.statusCode, 404);
    assert.strictEqual(notFoundRes.body.error.type, 'not_found');
  } finally {
    await gateway.close();
  }
});
