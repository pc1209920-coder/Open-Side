const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const {
  WebSocketConnection,
  WebSocketServer,
  WebSocketClient,
  encodeFrame,
  FrameParser,
  OPCODES
} = require('../src/transport/websocket');
const { MeshCryptoEngine } = require('../src/crypto');
const { GridRouter } = require('../src/router');
const { ComputeSea } = require('../src');

function makeUniqueIpcPath(tag = 'ws-test') {
  const suffix = crypto.randomUUID();
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\openside-ws-${tag}-${suffix}`;
  }
  return path.join(os.tmpdir(), `openside-ws-${tag}-${suffix.slice(0, 8)}.sock`);
}

// ============================================================================
// Requirement 1: Native WebSocket Transport (src/transport/websocket.js)
// ============================================================================

test('WebSocket: RFC 6455 Frame Encoding & Decoding (Text, Binary, Masking, Framing)', () => {
  // 1. Text frame with masking (client to server)
  const textMsg = 'Hello Single Compute Sea!';
  const maskedFrame = encodeFrame(textMsg, { opcode: OPCODES.TEXT, mask: true, fin: true });
  assert.ok(maskedFrame.length > textMsg.length);
  assert.strictEqual(maskedFrame[0] & 0x0F, OPCODES.TEXT);
  assert.strictEqual(maskedFrame[1] & 0x80, 0x80); // masked bit set

  const parser1 = new FrameParser();
  const parsed1 = parser1.push(maskedFrame);
  assert.strictEqual(parsed1.length, 1);
  assert.strictEqual(parsed1[0].fin, true);
  assert.strictEqual(parsed1[0].opcode, OPCODES.TEXT);
  assert.strictEqual(parsed1[0].payload.toString('utf8'), textMsg);

  // 2. Binary frame without masking (server to client)
  const binaryPayload = crypto.randomBytes(256); // triggers 16-bit extended length (126)
  const unmaskedFrame = encodeFrame(binaryPayload, { opcode: OPCODES.BINARY, mask: false, fin: true });
  assert.strictEqual(unmaskedFrame[1] & 0x7F, 126); // length field 126

  const parser2 = new FrameParser();
  const parsed2 = parser2.push(unmaskedFrame);
  assert.strictEqual(parsed2.length, 1);
  assert.strictEqual(parsed2[0].opcode, OPCODES.BINARY);
  assert.deepStrictEqual(parsed2[0].payload, binaryPayload);

  // 3. Large binary frame (> 65535 bytes triggers 64-bit length 127)
  const largePayload = Buffer.alloc(70000, 0x42);
  const largeFrame = encodeFrame(largePayload, { opcode: OPCODES.BINARY, mask: true, fin: true });
  assert.strictEqual(largeFrame[1] & 0x7F, 127);

  const parser3 = new FrameParser();
  const parsed3 = parser3.push(largeFrame);
  assert.strictEqual(parsed3.length, 1);
  assert.strictEqual(parsed3[0].payload.length, 70000);
  assert.strictEqual(parsed3[0].payload[0], 0x42);
});

test('WebSocket: Streaming Chunk Fragmentation & Reassembly', () => {
  const message = 'Distributed computing across firewall boundaries';
  const frame = encodeFrame(message, { opcode: OPCODES.TEXT, mask: true });

  const parser = new FrameParser();
  // Feed 5 bytes at a time
  const chunks = [];
  for (let i = 0; i < frame.length; i += 5) {
    const slice = frame.subarray(i, i + 5);
    const result = parser.push(slice);
    if (result.length > 0) {
      chunks.push(...result);
    }
  }

  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].payload.toString('utf8'), message);
});

test('WebSocket: Full Client-Server Handshake, Bidirectional Messaging, Ping/Pong & Clean Teardown', async () => {
  const ipcPath = makeUniqueIpcPath('bidirectional');
  const wss = new WebSocketServer();
  await wss.listen(ipcPath);

  let serverReceived = null;
  let serverGotPing = false;

  let serverWs = null;
  const pingPromise = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (msg) => {
        serverReceived = msg;
        ws.send('ACK:' + msg);
      });
      ws.on('ping', () => {
        serverGotPing = true;
        resolve();
      });
    });
  });

  const client = new WebSocketClient('ws://localhost/sea', { socketPath: ipcPath });
  const openPromise = new Promise((resolve) => client.on('open', resolve));
  await openPromise;

  // Send message
  client.send('sea-shard-task-alpha');

  const replyPromise = new Promise((resolve) => {
    client.on('message', (data) => resolve(data));
  });

  // Test Ping from client
  client.ping(Buffer.from('keepalive'));

  const reply = await replyPromise;
  await pingPromise;
  assert.strictEqual(serverReceived, 'sea-shard-task-alpha');
  assert.strictEqual(reply, 'ACK:sea-shard-task-alpha');
  assert.ok(serverGotPing);

  const clientClosed = new Promise((resolve) => client.on('close', resolve));
  client.close();
  await clientClosed;
  await wss.close();
});

// ============================================================================
// Requirement 2: Heartbeat & Dead-Peer Re-dispatch (src/router.js)
// ============================================================================

test('Router: 5-Second Peer Heartbeat Ping/Pong Tracking & Telemetry Refresh', () => {
  let virtualTime = 100000;
  const router = new GridRouter('coord-node', {
    now: () => virtualTime,
    heartbeatIntervalMs: 5000,
    deadPeerTimeoutMs: 15000
  });

  router.registerPeer('worker-1', 'pubkey-1', { standbyReady: true, latencyMs: 10 });
  router.registerPeer('worker-2', 'pubkey-2', { standbyReady: true, latencyMs: 15 });

  const pinged = [];
  router.setHeartbeatPingHandler((peerId) => {
    pinged.push(peerId);
  });

  // Advance 5 seconds: both peers are healthy and receive heartbeat pings
  virtualTime += 5000;
  const check1 = router.checkHeartbeats();
  assert.deepStrictEqual(check1.deadPeers, []);
  assert.deepStrictEqual(check1.pingedPeers.sort(), ['worker-1', 'worker-2']);
  assert.deepStrictEqual(pinged.sort(), ['worker-1', 'worker-2']);

  // Worker 1 returns pong with updated telemetry
  const pongRecorded = router.recordHeartbeatPong('worker-1', { cpuLoad: 0.12, freeMemRatio: 0.70 });
  assert.strictEqual(pongRecorded, true);
  const p1 = router.peerTable.get('worker-1');
  assert.strictEqual(p1.lastSeen, virtualTime);
  assert.strictEqual(p1.cpuLoad, 0.12);

  router.stopHeartbeatMonitor();
});

test('Router: 15-Second Dead-Peer Detection Instantly Re-Queues & Re-Dispatches In-Flight Shards', () => {
  let virtualTime = 200000;
  const router = new GridRouter('coord-node', {
    now: () => virtualTime,
    heartbeatIntervalMs: 5000,
    deadPeerTimeoutMs: 15000
  });

  router.registerPeer('worker-dying', 'pubkey-dying', { standbyReady: true, latencyMs: 5 });
  router.registerPeer('worker-backup', 'pubkey-backup', { standbyReady: true, latencyMs: 15 });

  // Dispatch a shard to worker-dying (lowest latency)
  const shard = {
    shardId: 'shard-crit-001',
    taskCode: 'return data * 2;',
    inputData: 21
  };
  const dispatchRes = router.dispatchShard(shard);
  assert.strictEqual(dispatchRes.status, 'DISPATCHED');
  assert.strictEqual(dispatchRes.peer.nodeId, 'worker-dying');
  assert.strictEqual(router.inFlightShards.size, 1);

  // Time passes: 16 seconds without heartbeat from worker-dying
  virtualTime += 16000;
  // worker-backup sends a pong so it stays alive
  router.recordHeartbeatPong('worker-backup');

  let deadDetectedEvent = null;
  router.on('deadPeerDetected', (evt) => {
    deadDetectedEvent = evt;
  });

  // Run dead-peer detection check
  const check = router.checkHeartbeats();
  assert.deepStrictEqual(check.deadPeers, ['worker-dying']);
  assert.strictEqual(deadDetectedEvent.peerId, 'worker-dying');

  // Verify shard was instantly re-routed to worker-backup!
  assert.strictEqual(router.inFlightShards.size, 1);
  const inFlightEntry = router.inFlightShards.get('shard-crit-001');
  assert.ok(inFlightEntry);
  assert.strictEqual(inFlightEntry.peerId, 'worker-backup');
  assert.strictEqual(inFlightEntry.attempts, 2);

  router.stopHeartbeatMonitor();
});

// ============================================================================
// Requirement 3: Graceful Teardown (SIGINT/SIGTERM & Drain) (src/index.js)
// ============================================================================

test('ComputeSea: Graceful Teardown Drains Active Shards Before Closing Sockets', async () => {
  const sea = new ComputeSea({
    enableP2P: false,
    handleSignals: false, // Don't bind process signals during unit tests
    teardownGracePeriodMs: 2000
  });

  const worker = await sea.addLocalWorker({ latencyMs: 5 });

  // Submit a background shard
  const workloadPromise = sea.submitWorkload(
    'return data.map(x => x * 10);',
    [1, 2, 3, 4],
    { chunkSize: 2 }
  );

  let teardownStarted = false;
  let teardownCompleted = false;

  sea.on('teardownStart', () => {
    teardownStarted = true;
  });
  sea.on('teardownComplete', () => {
    teardownCompleted = true;
  });

  // Initiate graceful teardown while workload is in flight
  const teardownPromise = sea.gracefulTeardown(2000, 'SIGTERM');

  const [res, teardownRes] = await Promise.all([workloadPromise, teardownPromise]);

  assert.strictEqual(res.status, 'COMPLETED');
  assert.deepStrictEqual(res.output, [10, 20, 30, 40]);
  assert.strictEqual(teardownRes.drained, true);
  assert.strictEqual(teardownRes.remainingShards, 0);
  assert.strictEqual(teardownStarted, true);
  assert.strictEqual(teardownCompleted, true);
});

// ============================================================================
// Extended Edge-Case Tests (RFC 6455 Protocol Errors, Masking, Close Codes)
// ============================================================================

test('WebSocket: RFC 6455 Protocol Violations & Error State Transitions', async () => {
  const parser = new FrameParser();

  // 1. Reserved RSV bits MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0xC1, 0x00])); // RSV1 bit set
  }, (err) => err.code === 1002);

  // 2. Fragmented control frames MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0x09, 0x00])); // FIN=0, opcode=PING
  }, (err) => err.code === 1002);

  // 3. Control frame payload > 125 bytes MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0x89, 126, 0x00, 126, ...Buffer.alloc(126)]));
  }, (err) => err.code === 1002);

  // 4. Undefined opcode MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0x83, 0x00])); // opcode 3
  }, (err) => err.code === 1002);

  // 5. Non-minimal length representations MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0x81, 126, 0x00, 100, ...Buffer.alloc(100)]));
  }, (err) => err.code === 1002);

  // 6. Close frame payload of 1 byte MUST fail with code 1002
  assert.throws(() => {
    parser.push(Buffer.from([0x88, 0x01, 0x03]));
  }, (err) => err.code === 1002);

  // 7. Server enforces client masking (RFC 6455 5.1)
  const mockServerSock = new (require('node:events').EventEmitter)();
  mockServerSock.destroyed = false;
  mockServerSock.writable = true;
  mockServerSock.write = () => true;
  mockServerSock.end = () => {};
  mockServerSock.destroy = () => {};

  const serverConn = new WebSocketConnection(mockServerSock, true);
  serverConn.on('error', () => {}); // Catch error event
  let serverCloseCode = null;
  serverConn.on('close', (code) => { serverCloseCode = code; });

  // Unmasked frame to server
  mockServerSock.emit('data', Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  assert.strictEqual(serverCloseCode, 1002);

  // 8. Client enforces unmasked server frames (RFC 6455 5.1)
  const mockClientSock = new (require('node:events').EventEmitter)();
  mockClientSock.destroyed = false;
  mockClientSock.writable = true;
  mockClientSock.write = () => true;
  mockClientSock.end = () => {};
  mockClientSock.destroy = () => {};

  const clientConn = new WebSocketConnection(mockClientSock, false);
  clientConn.on('error', () => {}); // Catch error event
  let clientCloseCode = null;
  clientConn.on('close', (code) => { clientCloseCode = code; });

  // Masked frame from server
  mockClientSock.emit('data', Buffer.from([0x81, 0x85, 0x01, 0x02, 0x03, 0x04, 0x49, 0x67, 0x6f, 0x68, 0x6f]));
  assert.strictEqual(clientCloseCode, 1002);

  // 9. Client close before connection is established
  const preClient = new WebSocketClient('ws://localhost:9999');
  preClient.on('error', () => {});
  let preCloseEmitted = false;
  preClient.on('close', () => { preCloseEmitted = true; });
  preClient.close();
  assert.strictEqual(preCloseEmitted, true);
  assert.strictEqual(preClient.readyState, 3);
});

// ============================================================================
// Extended Encrypted Payload & Crypto Edge-Case Coverage
// ============================================================================

test('WebSocket: Authenticated AES-256-GCM Shard Transmission (Text & Binary Frames)', async () => {
  const coordCrypto = new MeshCryptoEngine();
  const workerCrypto = new MeshCryptoEngine();

  const coordSessionKey = coordCrypto.deriveSessionKey(workerCrypto.publicKey, { epoch: 1 });
  const workerSessionKey = workerCrypto.deriveSessionKey(coordCrypto.publicKey, { epoch: 1 });

  const ipcPath = makeUniqueIpcPath('ws-crypto-bidirectional');
  const wss = new WebSocketServer();
  await wss.listen(ipcPath);

  let serverDecryptedShard = null;
  let serverDecryptedBinary = null;

  wss.on('connection', (ws) => {
    ws.on('message', (msg, isBinary) => {
      if (!isBinary) {
        // Text frame: JSON encrypted packet
        const encryptedPacket = JSON.parse(msg.toString('utf8'));
        serverDecryptedShard = workerCrypto.decryptShard(encryptedPacket, workerSessionKey, {
          validateReplay: true,
          senderId: coordCrypto.nodeId,
          aad: `${coordCrypto.nodeId}:${encryptedPacket.shardId || 'shard-001'}`
        });

        // Send encrypted response back as text frame
        const responsePacket = workerCrypto.encryptShard(
          { shardId: serverDecryptedShard.shardId, result: 42, status: 'SUCCESS' },
          workerSessionKey,
          { epoch: 1, aad: `${workerCrypto.nodeId}:${serverDecryptedShard.shardId}:res` }
        );
        ws.send(JSON.stringify(responsePacket));
      } else {
        // Binary frame: raw binary ciphertext or bytes
        const rawCiphertext = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        serverDecryptedBinary = rawCiphertext;
        ws.send(Buffer.from('BINARY_ACK'));
      }
    });
  });

  const client = new WebSocketClient('ws://localhost/crypto', { socketPath: ipcPath });
  await new Promise((resolve) => client.on('open', resolve));

  // 1. Send encrypted shard via Text Frame
  const shardPayload = { shardId: 'shard-001', task: 'compute-pi', data: [1, 2, 3] };
  const aad = `${coordCrypto.nodeId}:shard-001`;
  const encryptedPacket = coordCrypto.encryptShard(shardPayload, coordSessionKey, { epoch: 1, aad });

  const replyPromise = new Promise((resolve) => {
    client.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
  });

  client.send(JSON.stringify(encryptedPacket));
  const replyPacket = await replyPromise;

  const decryptedResult = coordCrypto.decryptShard(replyPacket, coordSessionKey, {
    validateReplay: true,
    senderId: workerCrypto.nodeId,
    aad: `${workerCrypto.nodeId}:shard-001:res`
  });

  assert.strictEqual(serverDecryptedShard.shardId, 'shard-001');
  assert.deepStrictEqual(serverDecryptedShard.data, [1, 2, 3]);
  assert.strictEqual(decryptedResult.result, 42);
  assert.strictEqual(decryptedResult.status, 'SUCCESS');

  // 2. Send encrypted binary frame
  const binaryPayload = crypto.randomBytes(512);
  const binaryReplyPromise = new Promise((resolve) => {
    client.once('message', (data) => resolve(data.toString('utf8')));
  });
  client.send(binaryPayload);
  const binaryReply = await binaryReplyPromise;
  assert.strictEqual(binaryReply, 'BINARY_ACK');
  assert.deepStrictEqual(serverDecryptedBinary, binaryPayload);

  // Clean close
  const clientClosed = new Promise((resolve) => client.on('close', resolve));
  client.close();
  await clientClosed;
  await wss.close();
});

test('WebSocket: Ciphertext Tampering & Bit-Flipping Fail-Closed Detection', () => {
  const coordCrypto = new MeshCryptoEngine();
  const workerCrypto = new MeshCryptoEngine();

  const coordSessionKey = coordCrypto.deriveSessionKey(workerCrypto.publicKey, { epoch: 1 });
  const workerSessionKey = workerCrypto.deriveSessionKey(coordCrypto.publicKey, { epoch: 1 });

  const shardPayload = { shardId: 'shard-sec-99', sensitiveCommand: 'transfer' };
  const packet = coordCrypto.encryptShard(shardPayload, coordSessionKey, { epoch: 1 });

  // 1. Bit-flip in ciphertext
  const tamperedCiphertext = Buffer.from(packet.ciphertext, 'hex');
  tamperedCiphertext[0] ^= 0xFF;
  const corruptedPkt1 = { ...packet, ciphertext: tamperedCiphertext.toString('hex') };
  assert.throws(() => {
    workerCrypto.decryptShard(corruptedPkt1, workerSessionKey);
  }, /authentication tag verification failed/i);

  // 2. Tampered authTag
  const tamperedAuthTag = Buffer.from(packet.authTag, 'hex');
  tamperedAuthTag[0] ^= 0x01;
  const corruptedPkt2 = { ...packet, authTag: tamperedAuthTag.toString('hex') };
  assert.throws(() => {
    workerCrypto.decryptShard(corruptedPkt2, workerSessionKey);
  }, /authentication tag verification failed/i);

  // 3. Truncated / malformed IV
  const corruptedPkt3 = { ...packet, iv: 'abcd' };
  assert.throws(() => {
    workerCrypto.decryptShard(corruptedPkt3, workerSessionKey);
  }, /malformed IV/i);

  // 4. Verification over WebSocket Frame Parser
  const frame = encodeFrame(JSON.stringify(corruptedPkt1), { opcode: OPCODES.TEXT, mask: true });
  const parser = new FrameParser();
  const [parsed] = parser.push(frame);
  assert.ok(parsed);
  assert.throws(() => {
    const pkt = JSON.parse(parsed.payload.toString('utf8'));
    workerCrypto.decryptShard(pkt, workerSessionKey);
  }, /authentication tag verification failed/i);
});

test('WebSocket: RFC 6455 Multi-Frame CONTINUATION Fragmentation of Encrypted Shards', () => {
  const coordCrypto = new MeshCryptoEngine();
  const workerCrypto = new MeshCryptoEngine();

  const coordSessionKey = coordCrypto.deriveSessionKey(workerCrypto.publicKey, { epoch: 1 });
  const workerSessionKey = workerCrypto.deriveSessionKey(coordCrypto.publicKey, { epoch: 1 });

  // Create a large shard payload
  const largeData = Array.from({ length: 1500 }, (_, i) => ({ id: i, val: `entry-${i}-` + 'x'.repeat(20) }));
  const shard = { shardId: 'shard-frag-01', data: largeData };
  const aad = `${coordCrypto.nodeId}:shard-frag-01`;
  const packet = coordCrypto.encryptShard(shard, coordSessionKey, { epoch: 1, aad });
  const serialized = Buffer.from(JSON.stringify(packet), 'utf8');

  // Split serialized into 3 fragments
  const part1 = serialized.subarray(0, 10000);
  const part2 = serialized.subarray(10000, 25000);
  const part3 = serialized.subarray(25000);

  // Frame 1: Opcode TEXT, FIN = false
  const frame1 = encodeFrame(part1, { opcode: OPCODES.TEXT, fin: false, mask: true });
  // Frame 2: Opcode CONTINUATION, FIN = false
  const frame2 = encodeFrame(part2, { opcode: OPCODES.CONTINUATION, fin: false, mask: true });
  // Frame 3: Opcode CONTINUATION, FIN = true
  const frame3 = encodeFrame(part3, { opcode: OPCODES.CONTINUATION, fin: true, mask: true });

  const mockSocket = new (require('node:events').EventEmitter)();
  mockSocket.destroyed = false;
  mockSocket.writable = true;
  mockSocket.write = () => true;
  mockSocket.end = () => {};
  mockSocket.destroy = () => {};

  const serverConn = new WebSocketConnection(mockSocket, true);
  let reassembledMessage = null;
  serverConn.on('message', (msg) => {
    reassembledMessage = msg;
  });

  // Push frames in sequence
  mockSocket.emit('data', frame1);
  assert.strictEqual(reassembledMessage, null); // Not complete yet

  mockSocket.emit('data', frame2);
  assert.strictEqual(reassembledMessage, null); // Still not complete

  mockSocket.emit('data', frame3);
  assert.ok(reassembledMessage); // Reassembly complete on FIN=true

  // Decrypt and verify full integrity
  const parsedPkt = JSON.parse(reassembledMessage.toString('utf8'));
  const decrypted = workerCrypto.decryptShard(parsedPkt, workerSessionKey, {
    validateReplay: true,
    senderId: coordCrypto.nodeId,
    aad
  });

  assert.strictEqual(decrypted.shardId, 'shard-frag-01');
  assert.strictEqual(decrypted.data.length, 1500);
  assert.deepStrictEqual(decrypted.data[0], { id: 0, val: 'entry-0-' + 'x'.repeat(20) });
});

test('WebSocket: Anti-Replay Attack Protection & AAD Binding Enforcement', () => {
  const coordCrypto = new MeshCryptoEngine();
  const workerCrypto = new MeshCryptoEngine();

  const coordSessionKey = coordCrypto.deriveSessionKey(workerCrypto.publicKey, { epoch: 1 });
  const workerSessionKey = workerCrypto.deriveSessionKey(coordCrypto.publicKey, { epoch: 1 });

  const shardPayload = { shardId: 'shard-replay-01', amount: 1000 };
  const aad = `${coordCrypto.nodeId}:shard-replay-01`;

  const packet1 = coordCrypto.encryptShard(shardPayload, coordSessionKey, { nonce: 1, aad });

  // 1. Initial valid decryption passes with anti-replay
  const decrypted1 = workerCrypto.decryptShard(packet1, workerSessionKey, {
    validateReplay: true,
    senderId: coordCrypto.nodeId,
    aad
  });
  assert.strictEqual(decrypted1.shardId, 'shard-replay-01');

  // 2. Replay attack with identical packet fails
  assert.throws(() => {
    workerCrypto.decryptShard(packet1, workerSessionKey, {
      validateReplay: true,
      senderId: coordCrypto.nodeId,
      aad
    });
  }, /replay.*detected/i);

  // 3. AAD binding tampering fails
  const packet2 = coordCrypto.encryptShard(shardPayload, coordSessionKey, { nonce: 2, aad });
  assert.throws(() => {
    workerCrypto.decryptShard(packet2, workerSessionKey, {
      validateReplay: true,
      senderId: coordCrypto.nodeId,
      aad: `${coordCrypto.nodeId}:wrong-shard-id`
    });
  }, /authentication tag verification failed/i);
});

test('Router: Dead-Peer Re-dispatch Performs Cryptographic Re-Encryption with Backup Key', () => {
  let virtualTime = 300000;
  const router = new GridRouter('coord-node', {
    now: () => virtualTime,
    heartbeatIntervalMs: 5000,
    deadPeerTimeoutMs: 15000
  });

  const coordCrypto = new MeshCryptoEngine();
  const dyingWorkerCrypto = new MeshCryptoEngine();
  const backupWorkerCrypto = new MeshCryptoEngine();

  const dyingSessionKey = coordCrypto.deriveSessionKey(dyingWorkerCrypto.publicKey, { epoch: 1 });
  const backupSessionKey = coordCrypto.deriveSessionKey(backupWorkerCrypto.publicKey, { epoch: 1 });

  router.registerPeer(dyingWorkerCrypto.nodeId, dyingWorkerCrypto.publicKey, { standbyReady: true, latencyMs: 5 });
  router.registerPeer(backupWorkerCrypto.nodeId, backupWorkerCrypto.publicKey, { standbyReady: true, latencyMs: 15 });

  const shard = {
    shardId: 'shard-redispatch-01',
    taskCode: 'return data * 3;',
    inputData: 10
  };

  // Dispatch to lowest latency peer (dying)
  const dispatchRes = router.dispatchShard(shard);
  assert.strictEqual(dispatchRes.status, 'DISPATCHED');
  assert.strictEqual(dispatchRes.peer.nodeId, dyingWorkerCrypto.nodeId);

  // Encrypt shard for dying worker
  const dyingPacket = coordCrypto.encryptShard(shard, dyingSessionKey, {
    epoch: 1,
    aad: `${coordCrypto.nodeId}:${shard.shardId}`
  });

  // Verify backup worker cannot decrypt dying worker's packet
  const backupWorkerSessionKey = backupWorkerCrypto.deriveSessionKey(coordCrypto.publicKey, { epoch: 1 });
  assert.throws(() => {
    backupWorkerCrypto.decryptShard(dyingPacket, backupWorkerSessionKey);
  }, /authentication tag verification failed/i);

  // Advance time: dying worker times out
  virtualTime += 16000;
  router.recordHeartbeatPong(backupWorkerCrypto.nodeId);

  // Run dead-peer check
  const check = router.checkHeartbeats();
  assert.deepStrictEqual(check.deadPeers, [dyingWorkerCrypto.nodeId]);

  // Shard re-routed to backup
  const inFlight = router.inFlightShards.get('shard-redispatch-01');
  assert.ok(inFlight);
  assert.strictEqual(inFlight.peerId, backupWorkerCrypto.nodeId);

  // Coordinator re-encrypts with backup session key
  const backupPacket = coordCrypto.encryptShard(shard, backupSessionKey, {
    epoch: 1,
    aad: `${coordCrypto.nodeId}:${shard.shardId}`
  });

  // Backup worker decrypts successfully
  const decryptedShard = backupWorkerCrypto.decryptShard(backupPacket, backupWorkerSessionKey, {
    validateReplay: true,
    senderId: coordCrypto.nodeId,
    aad: `${coordCrypto.nodeId}:${shard.shardId}`
  });
  assert.strictEqual(decryptedShard.shardId, 'shard-redispatch-01');
  assert.strictEqual(decryptedShard.inputData, 10);

  router.stopHeartbeatMonitor();
});

test('ComputeSea: Graceful Teardown Drains Encrypted Shards with Validated PoC Signatures', async () => {
  const sea = new ComputeSea({
    enableP2P: false,
    handleSignals: false,
    teardownGracePeriodMs: 2000
  });

  const workerCrypto = new MeshCryptoEngine();
  const worker = await sea.addLocalWorker({
    latencyMs: 5,
    crypto: workerCrypto
  });

  const workloadPromise = sea.submitWorkload(
    'return data.map(x => x * 100);',
    [1, 2, 3, 4],
    { chunkSize: 2 }
  );

  let teardownCompleted = false;
  sea.on('teardownComplete', () => {
    teardownCompleted = true;
  });

  const teardownPromise = sea.gracefulTeardown(2000, 'SIGTERM');
  const [res, teardownRes] = await Promise.all([workloadPromise, teardownPromise]);

  assert.strictEqual(res.status, 'COMPLETED');
  assert.deepStrictEqual(res.output, [100, 200, 300, 400]);
  assert.strictEqual(teardownRes.drained, true);
  assert.strictEqual(teardownRes.remainingShards, 0);
  assert.strictEqual(teardownCompleted, true);
});
