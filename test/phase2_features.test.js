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
            body: parsed
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
    // First iteration ensures JIT compilation and event-loop priming
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

  // 2. Deserialize payload
  const deserialized = v8.deserialize(v8Frame.subarray(5));
  assert.strictEqual(deserialized.msgType, 'SHARD_PAYLOAD');
  assert.strictEqual(deserialized.shardId, 'shard-v8-test-123');
  assert.deepStrictEqual(deserialized.numbers, [10, 20, 30, 40]);
  assert.strictEqual(deserialized.meta.active, true);
  assert.ok(Buffer.isBuffer(deserialized.buffer));
  assert.strictEqual(deserialized.buffer.toString('utf8'), 'binary-data-stream');

  // 3. Node instance format selection
  const p2pJson = new P2PNode({ useV8Serialization: false });
  const p2pV8 = new P2PNode({ useV8Serialization: true });

  const jsonEncoded = p2pJson.encodeFrame({ test: 1 });
  assert.strictEqual(jsonEncoded[4], 0x7b); // '{' ASCII for JSON

  const v8Encoded = p2pV8.encodeFrame({ test: 1 });
  assert.strictEqual(v8Encoded[4], 0x02); // Binary tag 0x02
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

      const authed = await httpRequest(authIpcPath, 'GET', '/v1/models', null, {
        Authorization: 'Bearer secret-token-123'
      });
      assert.strictEqual(authed.statusCode, 200);
    } finally {
      await authGateway.close();
    }
  } finally {
    await gateway.close();
  }
});
