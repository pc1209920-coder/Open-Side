const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pkg = require('../package.json');
const { MeshCryptoEngine } = require('../src/crypto');
const { StandbySandbox } = require('../src/sandbox');
const { GridRouter, QueueFullError } = require('../src/router');

function createMockOs(cpuSnapshots, freeMemFn, totalMemFn) {
  let idx = 0;
  return {
    cpus() {
      if (typeof cpuSnapshots === 'function') {
        return cpuSnapshots();
      }
      const snap = cpuSnapshots[Math.min(idx, cpuSnapshots.length - 1)];
      idx += 1;
      return snap;
    },
    freemem() {
      return typeof freeMemFn === 'function' ? freeMemFn() : freeMemFn;
    },
    totalmem() {
      return typeof totalMemFn === 'function' ? totalMemFn() : totalMemFn;
    }
  };
}

function makeCpuSnap(cores) {
  return cores.map((t) => ({ model: 'MockCPU', speed: 3000, times: t }));
}

// ============================================================================
// M1 (R1): Baseline Integrity & 5 Core Protocol Invariants
// ============================================================================
describe('Milestone 1 (R1): Baseline Integrity & 5 Core Protocol Invariants', () => {
  test('Preserves all 5 original baseline mesh protocol assertions verbatim', async () => {
    // 1. ECDH Shared Key Derivation Test
    const nodeA = new MeshCryptoEngine();
    const nodeB = new MeshCryptoEngine();
    const keyA = nodeA.deriveSharedKey(nodeB.publicKey);
    const keyB = nodeB.deriveSharedKey(nodeA.publicKey);
    assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'), 'Shared keys must match between peers');

    // 2. Dynamic Task Partitioning Test
    const router = new GridRouter(nodeA.nodeId);
    const tasks = router.createTaskPartitions('return data.reduce((a, b) => a + b, 0);', [1, 2, 3, 4], 2);
    assert.strictEqual(tasks.length, 2, 'Workload must be partitioned into 2 shards');

    // 3. AES-256-GCM Encryption & Decryption Test
    const encryptedPacket = nodeA.encryptShard(tasks[0], keyA);
    const decryptedPacket = nodeB.decryptShard(encryptedPacket, keyB);
    assert.deepStrictEqual(decryptedPacket.inputData, [1, 2], 'Decrypted payload must match input data');

    // 4. Zero-Trust Sandbox Execution Test
    const sandbox = new StandbySandbox();
    const execResult = sandbox.executeIsolatedShard(decryptedPacket);
    assert.strictEqual(execResult.output, 3, 'Sandbox math computation must equal 3');

    // 5. Proof-of-Compute Signature Test
    const proof = nodeB.signProofOfCompute(tasks[0].shardId, execResult.output);
    assert.strictEqual(typeof proof, 'string', 'Proof must be an HMAC string');
    assert.strictEqual(proof.length, 64, 'SHA-256 HMAC must be 64 characters hex');
  });

  test('F01: Zero external runtime dependencies, CommonJS exports, and clean node --check', () => {
    assert.strictEqual(Object.keys(pkg.dependencies || {}).length, 0);
    assert.strictEqual(Object.keys(pkg.devDependencies || {}).length, 0);
    assert.strictEqual(typeof MeshCryptoEngine, 'function');
    assert.strictEqual(typeof GridRouter, 'function');
    assert.strictEqual(typeof StandbySandbox, 'function');
    assert.ok(parseInt(process.versions.node.split('.')[0], 10) >= 18);

    const rootDir = path.resolve(__dirname, '..');
    const syntax = spawnSync(
      process.execPath,
      ['--check', 'src/index.js', 'src/crypto.js', 'src/router.js', 'src/sandbox.js'],
      { cwd: rootDir, encoding: 'utf8' }
    );
    assert.strictEqual(syntax.status, 0, `node --check failed: ${syntax.stderr}`);
  });

  test('F02: Baseline protocol boundary cases (MAX_SAFE_INTEGER, concurrency x50, tampered step 3)', async () => {
    const nodeA = new MeshCryptoEngine();
    const nodeB = new MeshCryptoEngine();
    const keyA = nodeA.deriveSharedKey(nodeB.publicKey);
    const keyB = nodeB.deriveSharedKey(nodeA.publicKey);
    const router = new GridRouter(nodeA.nodeId);
    const sandbox = new StandbySandbox();

    const maxTasks = router.createTaskPartitions('return data.reduce((a, b) => a + b, 0);', [Number.MAX_SAFE_INTEGER, 0], 2);
    const decMax = nodeB.decryptShard(nodeA.encryptShard(maxTasks[0], keyA), keyB);
    assert.strictEqual(sandbox.executeIsolatedShard(decMax).output, Number.MAX_SAFE_INTEGER);

    // Tampered ciphertext in step 3
    const enc = nodeA.encryptShard(maxTasks[0], keyA);
    const flipped = enc.ciphertext.slice(0, -2) + (enc.ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa');
    assert.throws(() => nodeB.decryptShard({ ...enc, ciphertext: flipped }, keyB), /authentication tag verification failed/);

    // 50 concurrent baseline protocol pairs
    const runs = Array.from({ length: 50 }, async () => {
      const a = new MeshCryptoEngine();
      const b = new MeshCryptoEngine();
      const kA = a.deriveSharedKey(b.publicKey);
      const kB = b.deriveSharedKey(a.publicKey);
      assert.strictEqual(kA.toString('hex'), kB.toString('hex'));
      const r = new GridRouter(a.nodeId);
      const shards = r.createTaskPartitions('return data.reduce((x, y) => x + y, 0);', [1, 2, 3, 4], 2);
      const dec = b.decryptShard(a.encryptShard(shards[0], kA), kB);
      const res = sandbox.executeIsolatedShard(dec);
      assert.strictEqual(res.output, 3);
      assert.strictEqual(b.signProofOfCompute(shards[0].shardId, res.output).length, 64);
    });
    await Promise.all(runs);
  });
});

// ============================================================================
// M2 (R3): Ultra Cryptographic Engine & Anti-Replay Wire Protocol (src/crypto.js)
// ============================================================================
describe('Milestone 2 (R3): Ultra Cryptographic Engine & Anti-Replay Wire Protocol', () => {
  test('F03: Ephemeral ECDH prime256v1 keys, 40-char nodeId, uniqueness, and invalid key rejection', () => {
    const engines = Array.from({ length: 10 }, () => new MeshCryptoEngine());
    const keys = new Set();
    const ids = new Set();

    for (const eng of engines) {
      assert.strictEqual(eng.publicKey.length, 130);
      assert.ok(eng.publicKey.startsWith('04'));
      assert.strictEqual(eng.nodeId.length, 40);
      assert.strictEqual(
        eng.nodeId,
        crypto.createHash('sha256').update(eng.publicKey).digest('hex').slice(0, 40)
      );
      assert.strictEqual(eng.outboundNonce, 1);
      keys.add(eng.publicKey);
      ids.add(eng.nodeId);
    }
    assert.strictEqual(keys.size, 10);
    assert.strictEqual(ids.size, 10);

    const a = engines[0];
    const b = engines[1];
    assert.strictEqual(a.deriveSharedKey(b.publicKey).length, 32);

    // Mismatched curve (secp256k1) & malformed keys fail closed
    const wrongCurve = crypto.createECDH('secp256k1');
    wrongCurve.generateKeys();
    assert.throws(() => a.deriveSharedKey(wrongCurve.getPublicKey('hex')));
    assert.throws(() => a.deriveSessionKey(wrongCurve.getPublicKey('hex')), /invalid elliptic curve public key/i);
    assert.throws(() => a.deriveSessionKey('04' + 'z'.repeat(128)), /invalid elliptic curve public key/i);
    assert.throws(() => a.deriveSessionKey('aa'.repeat(32)), /invalid elliptic curve public key/i);
    assert.throws(() => a.deriveSessionKey('00'.repeat(65)), /invalid elliptic curve public key/i);
    assert.throws(() => a.deriveSharedKey(null), TypeError);
    assert.throws(() => a.deriveSessionKey(undefined), TypeError);
  });

  test('F04: HKDF-SHA512 key derivation, epoch rotation, domain separation, and RFC 5869 limits', () => {
    const alice = new MeshCryptoEngine();
    const bob = new MeshCryptoEngine();

    const sA = alice.deriveSessionKey(bob.publicKey);
    const sB = bob.deriveSessionKey(alice.publicKey);
    assert.ok(Buffer.isBuffer(sA));
    assert.strictEqual(sA.length, 32);
    assert.strictEqual(sA.toString('hex'), sB.toString('hex'));

    // Salt epoch separation
    const e1 = alice.deriveSessionKey(bob.publicKey, { salt: 'epoch-1' });
    const e2 = alice.deriveSessionKey(bob.publicKey, { salt: 'epoch-2' });
    assert.notStrictEqual(e1.toString('hex'), e2.toString('hex'));

    // Epoch option & info domain separation
    const ep0 = alice.deriveSessionKey(bob.publicKey, { epoch: 0 });
    const ep1 = alice.deriveSessionKey(bob.publicKey, { epoch: 1 });
    assert.notStrictEqual(ep0.toString('hex'), ep1.toString('hex'));
    assert.notStrictEqual(
      alice.deriveSessionKey(bob.publicKey, { info: 'openside-wire-v1' }).toString('hex'),
      alice.deriveSessionKey(bob.publicKey, { info: 'openside-control-v1' }).toString('hex')
    );

    // Variable length & exact oracle agreement with crypto.hkdfSync
    const key64 = alice.deriveSessionKey(bob.publicKey, { keylen: 64, salt: 's', info: 'i' });
    assert.strictEqual(key64.length, 64);
    const rawSecret = alice.ecdh.computeSecret(bob.publicKey, 'hex');
    const oracle = Buffer.from(crypto.hkdfSync('sha512', rawSecret, Buffer.from('s'), Buffer.from('i'), 64));
    assert.deepStrictEqual(key64, oracle);

    // Empty string salt vs empty buffer salt consistency
    const emptyStrSalt = alice.deriveSessionKey(bob.publicKey, { salt: '' });
    const emptyBufSalt = alice.deriveSessionKey(bob.publicKey, { salt: Buffer.alloc(0) });
    assert.deepStrictEqual(emptyStrSalt, emptyBufSalt);

    // Extreme salt (1MB) and info (64KB) with sensitivity beyond 1024 bytes
    const largeKey1 = alice.deriveSessionKey(bob.publicKey, {
      salt: Buffer.alloc(1024 * 1024, 0xab),
      info: 'x'.repeat(65536)
    });
    const largeKey2 = alice.deriveSessionKey(bob.publicKey, {
      salt: Buffer.alloc(1024 * 1024, 0xab),
      info: 'x'.repeat(65535) + 'y'
    });
    assert.strictEqual(largeKey1.length, 32);
    assert.notStrictEqual(largeKey1.toString('hex'), largeKey2.toString('hex'));

    // Invalid key lengths fail closed
    assert.throws(() => alice.deriveSessionKey(bob.publicKey, { keylen: 0 }), RangeError);
    assert.throws(() => alice.deriveSessionKey(bob.publicKey, { keylen: -1 }), RangeError);
    assert.throws(() => alice.deriveSessionKey(bob.publicKey, { keylen: 20000 }), RangeError);
  });

  test('F05: Authenticated AES-256-GCM encryption, IV uniqueness, monotonic nonce, and overflow guard', () => {
    const alice = new MeshCryptoEngine();
    const bob = new MeshCryptoEngine();
    const key = alice.deriveSessionKey(bob.publicKey);

    const payload = { msg: 'compute-🌊-αβγ', nested: { arr: [true, false, null, 42] } };
    const pkt1 = alice.encryptShard(payload, key);
    const pkt2 = alice.encryptShard(payload, key);

    assert.strictEqual(pkt1.iv.length, 24);
    assert.strictEqual(pkt1.authTag.length, 32);
    assert.notStrictEqual(pkt1.iv, pkt2.iv);
    assert.notStrictEqual(pkt1.ciphertext, pkt2.ciphertext);
    assert.strictEqual(pkt1.nonce, 1);
    assert.strictEqual(pkt2.nonce, 2);
    assert.ok(Math.abs(pkt1.timestamp - Date.now()) < 2000);

    // Empty object and null payloads
    assert.deepStrictEqual(bob.decryptShard(alice.encryptShard({}, key), key), {});
    assert.deepStrictEqual(bob.decryptShard(alice.encryptShard(null, key), key), null);

    // Non-JSON-serializable & wrong key length fail closed
    assert.throws(() => alice.encryptShard(undefined, key), TypeError);
    assert.throws(() => alice.encryptShard(() => {}, key), TypeError);
    assert.throws(() => alice.encryptShard({ a: 1 }, Buffer.alloc(31)), TypeError);

    // IV collision resistance over 2,000 packets
    const ivs = new Set();
    for (let i = 0; i < 2000; i++) {
      ivs.add(alice.encryptShard({ i }, key).iv);
    }
    assert.strictEqual(ivs.size, 2000);

    // Outbound nonce overflow guard
    alice.outboundNonce = Number.MAX_SAFE_INTEGER;
    assert.throws(() => alice.encryptShard({ x: 1 }, key), RangeError);
  });

  test('F06: Authenticated AES-256-GCM decryption, AAD binding, tamper detection, and prototype safety', () => {
    const alice = new MeshCryptoEngine();
    const bob = new MeshCryptoEngine();
    const eve = new MeshCryptoEngine();
    const keyAB = alice.deriveSessionKey(bob.publicKey);
    const keyAE = alice.deriveSessionKey(eve.publicKey);

    const payload = { task: 'matrix', vals: [1, 2, 3] };
    const pkt = alice.encryptShard(payload, keyAB, { aad: '1:header-v1' });
    assert.deepStrictEqual(bob.decryptShard(pkt, keyAB, { aad: '1:header-v1' }), payload);
    assert.throws(() => bob.decryptShard(pkt, keyAB, { aad: 'wrong-aad' }), /authentication tag verification failed/);
    assert.throws(() => bob.decryptShard(pkt, keyAB, { aad: '' }), /authentication tag verification failed/);
    const { aad: _stripped, ...pktNoAad } = pkt;
    assert.throws(() => bob.decryptShard(pktNoAad, keyAB), /authentication tag verification failed/);

    // Wrong key, tampered ciphertext, tampered authTag, first-byte bit flip
    assert.throws(() => bob.decryptShard(pkt, keyAE), /authentication tag verification failed/);
    const firstByte = (parseInt(pkt.ciphertext.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0');
    assert.throws(
      () => bob.decryptShard({ ...pkt, ciphertext: firstByte + pkt.ciphertext.slice(2) }, keyAB),
      /authentication tag verification failed/
    );
    const flippedTag = pkt.authTag.slice(0, -2) + (pkt.authTag.slice(-2) === 'ff' ? '00' : 'ff');
    assert.throws(() => bob.decryptShard({ ...pkt, authTag: flippedTag }, keyAB), /authentication tag verification failed/);

    // Malformed IV, authTag, ciphertext, AAD rejected fail-closed
    assert.throws(() => bob.decryptShard({ ...pkt, iv: '0g'.repeat(12) }, keyAB), /malformed IV/);
    assert.throws(() => bob.decryptShard({ ...pkt, authTag: 'aa'.repeat(8) }, keyAB), /malformed authTag/);
    assert.throws(() => bob.decryptShard({ ...pkt, ciphertext: '' }, keyAB), /malformed ciphertext/);
    assert.throws(() => bob.decryptShard({ ...pkt, aad: 'zzzz' }, keyAB), /malformed AAD/);

    // JSON __proto__ payload does not pollute host Object.prototype
    const protoPayload = JSON.parse('{"__proto__":{"pollutedAdmin":true},"safe":1}');
    const encProto = alice.encryptShard(protoPayload, keyAB);
    const decProto = bob.decryptShard(encProto, keyAB);
    assert.strictEqual(decProto.safe, 1);
    assert.strictEqual(({}).pollutedAdmin, undefined);
  });

  test('F07: Monotonic and sliding-window anti-replay nonces, atomic auth-before-commit, and burst defense', async () => {
    const alice = new MeshCryptoEngine();
    const bob = new MeshCryptoEngine();
    const key = alice.deriveSessionKey(bob.publicKey);
    const now = Date.now();

    // Sequential acceptance & duplicate / stale rejection
    assert.strictEqual(bob.validateWirePacket({ nonce: 1, timestamp: now }, alice.nodeId), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 2, timestamp: now }, alice.nodeId), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 3, timestamp: now }, alice.nodeId), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 2, timestamp: now }, alice.nodeId), false);
    assert.strictEqual(bob.validateWirePacket({ nonce: 1, timestamp: now }, alice.nodeId), false);

    // Missing, negative, or fractional nonces rejected fail-closed
    assert.strictEqual(bob.validateWirePacket({ timestamp: now }, alice.nodeId), false);
    assert.strictEqual(bob.validateWirePacket({ nonce: -1, timestamp: now }, alice.nodeId), false);
    assert.strictEqual(bob.validateWirePacket({ nonce: 1.5, timestamp: now }, alice.nodeId), false);

    // Per-peer isolation
    assert.strictEqual(bob.validateWirePacket({ nonce: 1, timestamp: now }, 'peer-b'), true);

    // Sliding window out-of-order & pruning
    assert.strictEqual(bob.validateWirePacket({ nonce: 5, timestamp: now }, 'peer-c'), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 3, timestamp: now }, 'peer-c'), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 3, timestamp: now }, 'peer-c'), false);
    assert.strictEqual(bob.validateWirePacket({ nonce: 1000000, timestamp: now }, 'peer-c'), true);
    assert.strictEqual(bob.validateWirePacket({ nonce: 4, timestamp: now }, 'peer-c'), false);

    // Strict monotonic constructor option allowOutOfOrder: false
    const strictReceiver = new MeshCryptoEngine({ allowOutOfOrder: false });
    assert.strictEqual(strictReceiver.validateWirePacket({ nonce: 5, timestamp: now }, 'p1'), true);
    assert.strictEqual(strictReceiver.validateWirePacket({ nonce: 3, timestamp: now }, 'p1'), false);

    // Critical security check: forged packet with huge nonce MUST NOT advance replay window!
    const validPkt1 = alice.encryptShard({ seq: 1 }, key);
    const validPkt2 = alice.encryptShard({ seq: 2 }, key);
    const forgedHugeNonce = {
      ...validPkt1,
      nonce: 999999999,
      ciphertext: validPkt1.ciphertext.slice(0, -2) + (validPkt1.ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa')
    };
    const senderSessionId = `${alice.nodeId}-auth-session`;
    assert.throws(
      () => bob.decryptShard(forgedHugeNonce, key, { validateReplay: true, senderId: senderSessionId }),
      /authentication tag verification failed/
    );
    // Legitimate packet #1 and #2 must STILL succeed after forged packet failed auth!
    assert.deepStrictEqual(
      bob.decryptShard(validPkt1, key, { validateReplay: true, senderId: senderSessionId }),
      { seq: 1 }
    );
    assert.throws(
      () => bob.decryptShard(forgedHugeNonce, key, { validateReplay: true, senderId: senderSessionId }),
      /authentication tag verification failed/
    );
    assert.deepStrictEqual(
      bob.decryptShard(validPkt2, key, { validateReplay: true, senderId: senderSessionId }),
      { seq: 2 }
    );
    // Replay of validPkt2 rejected
    assert.throws(
      () => bob.decryptShard(validPkt2, key, { validateReplay: true, senderId: senderSessionId }),
      /Anti-replay validation failed/
    );

    // Concurrent burst replay (100 simultaneous attempts -> 1 accepted, 99 rejected)
    const burstPkt = alice.encryptShard({ burst: true }, key);
    const results = await Promise.all(
      Array.from({ length: 100 }, async () => {
        try {
          bob.decryptShard(burstPkt, key, { validateReplay: true, senderId: senderSessionId });
          return 'ACCEPTED';
        } catch {
          return 'REJECTED';
        }
      })
    );
    assert.strictEqual(results.filter((r) => r === 'ACCEPTED').length, 1);
    assert.strictEqual(results.filter((r) => r === 'REJECTED').length, 99);

    // Cleanup check
    assert.ok(bob.getReplayStats(senderSessionId) !== null);
    bob.resetReplayState(senderSessionId);
    assert.strictEqual(bob.getReplayStats(senderSessionId), null);
  });

  test('F08: Timestamp window drift boundaries (±60s) and safe behavior under assert.doesNotThrow', () => {
    const fixedNow = 1700000000000;
    const detEngine = new MeshCryptoEngine({ now: () => fixedNow });
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow - 59999, nonce: 1 }, 'p1'), true);
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow - 60000, nonce: 2 }, 'p1'), true);
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow - 60001, nonce: 3 }, 'p1'), false);
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow + 59999, nonce: 4 }, 'p1'), true);
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow + 60000, nonce: 5 }, 'p1'), true);
    assert.strictEqual(detEngine.validateWirePacket({ timestamp: fixedNow + 60001, nonce: 6 }, 'p1'), false);

    const engine = new MeshCryptoEngine();
    assert.strictEqual(engine.validateWirePacket({ timestamp: Date.now() - 5000, nonce: 1 }, 'p1'), true);
    assert.strictEqual(engine.validateWirePacket({ timestamp: Date.now() + 25000, nonce: 2 }, 'p1'), true);
    assert.strictEqual(engine.validateWirePacket({ timestamp: Date.now() - 65000, nonce: 5 }, 'p1'), false);
    assert.strictEqual(engine.validateWirePacket({ timestamp: Date.now() + 65000, nonce: 6 }, 'p1'), false);
    assert.strictEqual(engine.validateWirePacket({ timestamp: NaN, nonce: 7 }, 'p1'), false);
    assert.strictEqual(engine.validateWirePacket({ timestamp: Infinity, nonce: 8 }, 'p1'), false);
    assert.strictEqual(engine.validateWirePacket({ timestamp: 'now', nonce: 9 }, 'p1'), false);

    // Must NOT throw unexpectedly inside assert.doesNotThrow unless throwOnError is explicitly set
    assert.doesNotThrow(() => {
      const ok = engine.validateWirePacket({ timestamp: Date.now() - 70000, nonce: 10 }, 'p1');
      assert.strictEqual(ok, false);
    });
    assert.throws(
      () => engine.validateWirePacket({ timestamp: Date.now() - 70000, nonce: 10 }, 'p1', { throwOnError: true }),
      /Timestamp expired/
    );

    const strictDriftEngine = new MeshCryptoEngine({ maxTimeDriftMs: 5000, now: () => fixedNow });
    assert.strictEqual(strictDriftEngine.validateWirePacket({ timestamp: fixedNow - 10000, nonce: 1 }, 'p1'), false);
    assert.throws(() => new MeshCryptoEngine({ maxTimeDriftMs: 0 }), RangeError);
  });

  test('F09 & F10: Deterministic HMAC-SHA256 PoC attestation and constant-time verification', () => {
    const worker = new MeshCryptoEngine();
    const verifier = new MeshCryptoEngine();

    const sig1 = worker.signProofOfCompute('shard-101', { sum: 42 });
    const sig2 = worker.signProofOfCompute('shard-101', { sum: 42 });
    assert.strictEqual(sig1.length, 64);
    assert.strictEqual(sig1, sig2);
    assert.notStrictEqual(sig1, worker.signProofOfCompute('shard-102', { sum: 42 }));
    assert.notStrictEqual(sig1, worker.signProofOfCompute('shard-101', { sum: 43 }));

    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, sig1, worker.publicKey), true);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, sig1.toUpperCase(), worker.publicKey), true);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, Buffer.from(sig1, 'hex'), worker.publicKey), true);

    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 43 }, sig1, worker.publicKey), false);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, `  ${sig1}  `, worker.publicKey), false);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, 'short-sig', worker.publicKey), false);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, 'g'.repeat(64), worker.publicKey), false);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-101', { sum: 42 }, sig1, Buffer.alloc(0)), false);

    // Circular object throws cleanly instead of hanging
    const circular = {};
    circular.self = circular;
    assert.throws(() => worker.signProofOfCompute('shard-circ', circular), TypeError);

    // Null & 100k dataset
    const nullSig = worker.signProofOfCompute('shard-null', null);
    assert.strictEqual(verifier.verifyProofOfCompute('shard-null', null, nullSig, worker.publicKey), true);
    const bigArr = Array.from({ length: 100000 }, (_, i) => i);
    const bigSig = worker.signProofOfCompute('shard-big', bigArr);
    assert.strictEqual(bigSig.length, 64);
  });
});

// ============================================================================
// M3 (R2): Hardware Telemetry, Fail-Closed States & Load-Shedding (src/router.js)
// ============================================================================
describe('Milestone 3 (R2): Hardware Telemetry, Fail-Closed States & Load-Shedding', () => {
  test('F11: Real OS-level multi-core CPU delta telemetry, BigInt overflow, 0-delta, and negative-delta clamping', () => {
    const router = new GridRouter('local-real');
    const tReal = router.getHardwareTelemetry();
    assert.strictEqual(typeof tReal.cpuLoad, 'number');
    assert.ok(tReal.cpuLoad >= 0.0 && tReal.cpuLoad <= 1.0);
    assert.strictEqual(tReal.cpuCount, os.cpus().length);
    assert.ok(tReal.freeMemBytes > 0 && tReal.totalMemBytes > 0);

    // 100 rapid calls cached
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      router.getHardwareTelemetry();
    }
    assert.ok(performance.now() - start < 150);

    // 64-core heterogeneous load: core 0 100% busy, cores 1-63 100% idle => 1/64 = 0.015625
    const snapA = makeCpuSnap(Array.from({ length: 64 }, () => ({ user: 1000, nice: 0, sys: 0, idle: 1000, irq: 0 })));
    const snapB = makeCpuSnap([
      { user: 1100, nice: 0, sys: 0, idle: 1000, irq: 0 },
      ...Array.from({ length: 63 }, () => ({ user: 1000, nice: 0, sys: 0, idle: 1100, irq: 0 }))
    ]);
    const r64 = new GridRouter('r64', { os: createMockOs([snapA, snapB, snapB], 500, 1000) });
    const t64 = r64.getHardwareTelemetry();
    assert.ok(Math.abs(t64.cpuLoad - 1 / 64) < 1e-6);
    assert.strictEqual(t64.cpuCount, 64);

    // Identical tick delta (0 delta) preserves last valid reading without NaN
    const tZeroDelta = r64.getHardwareTelemetry();
    assert.ok(Math.abs(tZeroDelta.cpuLoad - 1 / 64) < 1e-6);

    // Missing nice/irq fields (cross-platform) + BigInt > 2^53 - 1
    const bigSnap1 = makeCpuSnap([{ user: 9007199254741000n, sys: 0n, idle: 9007199254741000n }]);
    const bigSnap2 = makeCpuSnap([{ user: 9007199254741020n, sys: 0n, idle: 9007199254741080n }]);
    const rBig = new GridRouter('rbig', { os: createMockOs([bigSnap1, bigSnap2], 500, 1000) });
    const tBig = rBig.getHardwareTelemetry();
    assert.ok(Math.abs(tBig.cpuLoad - 0.2) < 1e-6);

    // Negative tick delta clamped to 0.0
    const negSnap1 = makeCpuSnap([{ user: 1000, nice: 0, sys: 0, idle: 5000, irq: 0 }]);
    const negSnap2 = makeCpuSnap([{ user: 500, nice: 0, sys: 0, idle: 1000, irq: 0 }]);
    const rNeg = new GridRouter('rneg', { os: createMockOs([negSnap1, negSnap2], 500, 1000) });
    assert.strictEqual(rNeg.getHardwareTelemetry().cpuLoad, 0.0);
  });

  test('F12 & F14: Free memory headroom tracking, clamping, and 10% memory floor fail-closed gating', () => {
    const idleSnap = makeCpuSnap([{ user: 100, sys: 0, idle: 900 }]);
    const nextIdleSnap = makeCpuSnap([{ user: 110, sys: 0, idle: 990 }]);

    // Memory below 10% -> MEMORY_EXHAUSTED, standbyReady: false
    let free = 80;
    let total = 1000;
    let tick = 0;
    const osMem = {
      cpus: () => (++tick % 2 === 1 ? idleSnap : nextIdleSnap),
      freemem: () => free,
      totalmem: () => total
    };

    const r = new GridRouter('mem-node', { os: osMem });
    const tLow = r.getHardwareTelemetry();
    assert.strictEqual(tLow.standbyReady, false);
    assert.strictEqual(tLow.loadShedState, 'MEMORY_EXHAUSTED');
    assert.match(tLow.loadShedState, /MEM/i);
    assert.strictEqual(r.isMemoryAvailable(), false);

    // Recovery above 10% (20%)
    free = 200;
    const tRecovered = r.getHardwareTelemetry();
    assert.strictEqual(tRecovered.standbyReady, true);
    assert.strictEqual(tRecovered.loadShedState, 'NOMINAL');
    assert.strictEqual(r.isMemoryAvailable(), true);

    // Exact boundary 9.99% vs 10.01%
    free = 999;
    total = 10000;
    assert.strictEqual(r.isMemoryAvailable(), false);
    free = 1001;
    assert.strictEqual(r.isMemoryAvailable(), true);

    // Aberrant OS values: total = 0, free = 0, free > total, negative free
    free = 0;
    total = 0;
    const tZeroTotal = r.getHardwareTelemetry();
    assert.strictEqual(tZeroTotal.freeMemRatio, 0.0);
    assert.strictEqual(tZeroTotal.standbyReady, false);

    total = 1000;
    free = 1500;
    assert.strictEqual(r.getHardwareTelemetry().freeMemRatio, 1.0);

    free = -50;
    const tNegFree = r.getHardwareTelemetry();
    assert.strictEqual(tNegFree.freeMemBytes, 0);
    assert.strictEqual(tNegFree.standbyReady, false);

    free = undefined;
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, false);
    assert.strictEqual(r.isMemoryAvailable(), false);

    // Optional absolute memory floor (100MB)
    const rAbs = new GridRouter('abs', {
      minFreeMemBytes: 100 * 1024 * 1024,
      os: createMockOs([idleSnap, nextIdleSnap], 90 * 1024 * 1024, 500 * 1024 * 1024)
    });
    assert.strictEqual(rAbs.isMemoryAvailable(), false);
  });

  test('F13: Strict 25% CPU fail-closed gating, flapping hysteresis, malformed telemetry, and peer spike eviction', () => {
    let user = 0;
    let idle = 0;
    let stepLoad = 0.15;
    const mockOs = {
      cpus() {
        const totalDelta = 100000;
        const busyDelta = Math.round(totalDelta * stepLoad);
        const idleDelta = totalDelta - busyDelta;
        user += busyDelta;
        idle += idleDelta;
        return makeCpuSnap([{ user, sys: 0, idle }]);
      },
      freemem: () => 500,
      totalmem: () => 1000
    };

    const events = [];
    const r = new GridRouter('cpu-node', { os: mockOs });
    r.on('loadShed', (t) => events.push(['shed', t.loadShedState]));
    r.on('telemetryRecovered', (t) => events.push(['recovered', t.loadShedState]));

    // 15% nominal
    const t15 = r.getHardwareTelemetry();
    assert.strictEqual(t15.standbyReady, true);
    assert.strictEqual(t15.loadShedState, 'NOMINAL');
    assert.strictEqual(r.canAcceptShard().accepted, true);

    // 24.999% -> accepted
    stepLoad = 0.24999;
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, true);

    // 25.001% -> rejected CPU_OVERLOAD
    stepLoad = 0.25001;
    const tOver = r.getHardwareTelemetry();
    assert.strictEqual(tOver.standbyReady, false);
    assert.strictEqual(tOver.loadShedState, 'CPU_OVERLOAD');
    assert.strictEqual(r.canAcceptShard().accepted, false);

    // Flapping prevention: alternating 24% and 26% stays fail-closed (no thrashing!)
    for (let i = 0; i < 6; i++) {
      stepLoad = i % 2 === 0 ? 0.24 : 0.26;
      assert.strictEqual(r.getHardwareTelemetry().standbyReady, false);
    }

    // Genuine cooling below 22% recovers immediately; steady 2-sample <=25% also recovers without flapping
    stepLoad = 0.15;
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, true);
    stepLoad = 0.30;
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, false);
    stepLoad = 0.24;
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, false); // 1st healthy sample (prevents 24/26 flapping)
    assert.strictEqual(r.getHardwareTelemetry().standbyReady, true);  // 2nd consecutive healthy sample recovers
    assert.deepStrictEqual(events, [
      ['shed', 'CPU_OVERLOAD'],
      ['recovered', 'NOMINAL'],
      ['shed', 'CPU_OVERLOAD'],
      ['recovered', 'NOMINAL']
    ]);

    // Combined CPU + Memory overload state
    const rBoth = new GridRouter('both-node', {
      os: createMockOs(
        [makeCpuSnap([{ user: 100, sys: 0, idle: 900 }]), makeCpuSnap([{ user: 600, sys: 0, idle: 1400 }])],
        50,
        1000
      )
    });
    const tBoth = rBoth.getHardwareTelemetry();
    assert.strictEqual(tBoth.standbyReady, false);
    assert.strictEqual(tBoth.loadShedState, 'CPU_AND_MEMORY_EXHAUSTED');

    // Stateless evaluator exact boundaries & malformed telemetry fail closed
    assert.strictEqual(r.evaluateTelemetry({ cpuLoad: 0.25, freeMemRatio: 0.5 }).standbyReady, true);
    assert.strictEqual(r.evaluateTelemetry({ cpuLoad: 0.25001, freeMemRatio: 0.5 }).standbyReady, false);
    assert.strictEqual(r.evaluateTelemetry({ cpuLoad: NaN, freeMemRatio: 0.5 }).standbyReady, false);
    assert.strictEqual(r.evaluateTelemetry({ cpuLoad: null, freeMemRatio: 0.5 }).standbyReady, false);
    assert.strictEqual(r.evaluateTelemetry(undefined).standbyReady, false);

    // Peer CPU spike updates peerTable and excludes from selectOptimalNodes; null telemetry fails closed
    r.registerPeer('pNull', 'pubNull', null);
    assert.strictEqual(r.peerTable.get('pNull').standbyReady, false);
    r.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 10, cpuLoad: 0.10, freeMemRatio: 0.50 });
    r.registerPeer('p2', 'pub2', { standbyReady: true, latencyMs: 5, cpuLoad: 0.30, freeMemRatio: 0.50 });
    assert.strictEqual(r.peerTable.get('p2').standbyReady, false);
    assert.deepStrictEqual(r.selectOptimalNodes('h1', 2).map((p) => p.nodeId), ['p1']);

    r.updatePeerTelemetry('p1', { cpuLoad: 0.35 });
    assert.strictEqual(r.peerTable.get('p1').standbyReady, false);
    assert.deepStrictEqual(r.selectOptimalNodes('h1', 2), []);
  });

  test('F15: Task partitioning boundaries (1M elements, odd chunks, bad args) and ordered aggregation', () => {
    const router = new GridRouter('part-node');

    const pOdd = router.createTaskPartitions('return data;', [1, 2, 3, 4, 5], 2);
    assert.strictEqual(pOdd.length, 3);
    assert.deepStrictEqual(pOdd[2].inputData, [5]);
    assert.deepStrictEqual(pOdd.map((p) => p.index), [0, 1, 2]);
    assert.strictEqual(pOdd[0].shardId.length, 40);

    // Determinism & empty dataset
    const pOdd2 = router.createTaskPartitions('return data;', [1, 2, 3, 4, 5], 2);
    assert.strictEqual(pOdd[0].shardId, pOdd2[0].shardId);
    assert.deepStrictEqual(router.createTaskPartitions('return data;', [], 2), []);
    assert.strictEqual(router.createTaskPartitions('return data;', [42], 100).length, 1);

    // 1,000,000 items into 20 shards
    const big = new Array(1000000).fill(1);
    const bigParts = router.createTaskPartitions('return data.length;', big, 50000);
    assert.strictEqual(bigParts.length, 20);

    // Invalid inputs fail closed
    assert.throws(() => router.createTaskPartitions('return data;', 'not-array', 2), TypeError);
    assert.throws(() => router.createTaskPartitions('return data;', [1, 2], 0), RangeError);
    assert.throws(() => router.createTaskPartitions('return data;', [1, 2], -5), RangeError);
    assert.throws(() => router.createTaskPartitions('return data;', [1, 2], 2.7), RangeError);

    // Out-of-order array and scalar aggregation + missing/duplicate index rejection
    assert.deepStrictEqual(
      router.aggregateResults([
        { shardId: 'b', index: 1, output: [3, 4] },
        { shardId: 'a', index: 0, output: [1, 2] }
      ]),
      [1, 2, 3, 4]
    );
    assert.deepStrictEqual(
      router.aggregateResults([
        { shardId: 'b', index: 1, output: 7 },
        { shardId: 'a', index: 0, output: 3 }
      ]),
      [3, 7]
    );
    assert.throws(
      () => router.aggregateResults([{ index: 1, output: [3, 4] }]),
      /missing shard index 0/
    );
    assert.throws(
      () => router.aggregateResults([{ index: 0, output: [1] }, { index: 0, output: [2] }]),
      /Duplicate shard index: 0/
    );
  });

  test('F16 & F17: Fail-closed peer scoring, bounded FIFO queue, TTL expiry, disconnect rescheduling & auto-flush', () => {
    let now = 1000;
    const router = new GridRouter('coord', {
      maxQueueSize: 5,
      maxRetries: 3,
      maxQueueTimeMs: 500,
      now: () => now
    });

    // No peers -> fail-closed []
    assert.deepStrictEqual(router.selectOptimalNodes('h', 2), []);

    // Peer scoring: latency first, capacityScore second, deterministic SHA-256 tie-break third
    router.registerPeer('pA', 'kA', { standbyReady: true, latencyMs: 40, capacityScore: 100 });
    router.registerPeer('pB', 'kB', { standbyReady: true, latencyMs: 15, capacityScore: 100 });
    router.registerPeer('pC', 'kC', { standbyReady: true, latencyMs: 25, capacityScore: 100 });
    assert.deepStrictEqual(router.selectOptimalNodes('h', 2).map((p) => p.nodeId), ['pB', 'pC']);

    // Identical latency, higher capacity prioritized
    router.registerPeer('pD', 'kD', { standbyReady: true, latencyMs: 15, capacityScore: 250 });
    assert.strictEqual(router.selectOptimalNodes('h', 1)[0].nodeId, 'pD');

    // Negative latency clamped to 0, count > available, empty taskHash, and invalid count fail-closed
    router.registerPeer('pNeg', 'kNeg', { standbyReady: true, latencyMs: -10, capacityScore: 50 });
    assert.strictEqual(router.peerTable.get('pNeg').latencyMs, 0);
    assert.strictEqual(router.selectOptimalNodes('', 99).length, 5);
    assert.deepStrictEqual(router.selectOptimalNodes('h', 0), []);
    assert.deepStrictEqual(router.selectOptimalNodes('h', -1), []);
    assert.deepStrictEqual(router.selectOptimalNodes('h', NaN), []);

    // Queueing when no peers are available & QueueFullError enforcement
    const qRouter = new GridRouter('q-coord', {
      maxQueueSize: 3,
      maxRetries: 3,
      maxQueueTimeMs: 500,
      now: () => now
    });
    const shards = qRouter.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6, 7, 8], 2);

    const r0 = qRouter.dispatchShard(shards[0]);
    assert.strictEqual(r0.status, 'QUEUED');
    assert.strictEqual(r0.reason, 'FAIL_CLOSED_NO_NODES');
    assert.strictEqual(qRouter.dispatchShard(shards[0], { failClosed: true }).status, 'REJECTED');
    qRouter.dispatchShard(shards[1]);
    qRouter.dispatchShard(shards[2]);
    assert.strictEqual(qRouter.taskQueue.length, 3);
    assert.throws(() => qRouter.dispatchShard(shards[3]), QueueFullError);

    // TTL expiration
    now += 600;
    assert.strictEqual(qRouter.dequeueTask(), null);
    assert.strictEqual(qRouter.expiredTasks.length, 3);

    // Auto-flush on peer registration
    qRouter.dispatchShard(shards[0]);
    qRouter.dispatchShard(shards[1]);
    assert.strictEqual(qRouter.taskQueue.length, 2);
    qRouter.registerPeer('w1', 'pub-w1', { standbyReady: true, latencyMs: 10, maxConcurrentShards: 1 });
    // w1 has maxConcurrentShards=1 so shards[0] dispatches to w1, shards[1] stays safely queued!
    assert.strictEqual(qRouter.inFlightShards.size, 1);
    assert.strictEqual(qRouter.taskQueue.length, 1);

    // Disconnect reschedules in-flight shard to HEAD of queue (priority over queued shards[1])
    qRouter.handlePeerDisconnect('w1');
    assert.strictEqual(qRouter.taskQueue.length, 2);
    assert.strictEqual(qRouter.taskQueue[0].shardId, shards[0].shardId);

    // Retry limit stops infinite reschedule loop after 3 attempts
    for (let attempt = 2; attempt <= 3; attempt++) {
      qRouter.updatePeerTelemetry('w1', { standbyReady: true });
      assert.strictEqual(qRouter.inFlightShards.has(shards[0].shardId), true);
      qRouter.handlePeerDisconnect('w1');
    }
    assert.strictEqual(qRouter.failedTasks.length, 1);
    assert.strictEqual(qRouter.failedTasks[0].reason, 'MAX_RETRIES_EXCEEDED');
    assert.strictEqual(qRouter.failedTasks[0].shard.shardId, shards[0].shardId);

    // Multi-shard disconnect preserves original in-flight priority order ahead of newer queued shards
    const mRouter = new GridRouter('m-coord', { maxQueueSize: 10, maxRetries: 3 });
    const mShards = mRouter.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    mRouter.registerPeer('wM', 'pub-wM', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 2 });
    mRouter.dispatchShard(mShards[0]);
    mRouter.dispatchShard(mShards[1]);
    mRouter.dispatchShard(mShards[2]); // queued because maxConcurrentShards = 2
    assert.strictEqual(mRouter.inFlightShards.size, 2);
    assert.strictEqual(mRouter.taskQueue.length, 1);
    mRouter.handlePeerDisconnect('wM');
    assert.deepStrictEqual(
      mRouter.taskQueue.map((s) => s.shardId),
      [mShards[0].shardId, mShards[1].shardId, mShards[2].shardId]
    );
  });

  test('Interaction 3.1 (M2 x M3): Partitioned shards encrypted with HKDF-SHA512 + AAD, routed, sandboxed, PoC-verified & aggregated', () => {
    const coord = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    const router = new GridRouter(coord.nodeId);
    const sandbox = new StandbySandbox();

    const coordSess = coord.deriveSessionKey(worker.publicKey, { epoch: 1 });
    const workerSess = worker.deriveSessionKey(coord.publicKey, { epoch: 1 });

    router.registerPeer(worker.nodeId, worker.publicKey, { standbyReady: true, latencyMs: 8, cpuLoad: 0.12, freeMemRatio: 0.65 });
    const partitions = router.createTaskPartitions('return data.map(n => n * 10);', [1, 2, 3, 4], 2);

    const collected = [];
    for (const part of partitions) {
      const route = router.dispatchShard(part);
      assert.strictEqual(route.status, 'DISPATCHED');
      assert.strictEqual(route.peer.nodeId, worker.nodeId);

      const pkt = coord.encryptShard(part, coordSess, { aad: `${coord.nodeId}:${part.shardId}` });
      const dec = worker.decryptShard(pkt, workerSess, {
        validateReplay: true,
        senderId: coord.nodeId,
        aad: `${coord.nodeId}:${part.shardId}`
      });
      assert.deepStrictEqual(dec.inputData, part.inputData);

      const out = sandbox.executeIsolatedShard(dec);
      const sig = worker.signProofOfCompute(dec.shardId, out.output, workerSess);
      assert.strictEqual(coord.verifyProofOfCompute(dec.shardId, out.output, sig, coordSess), true);

      router.completeShard(part.shardId);
      collected.push({ shardId: dec.shardId, index: dec.index, output: out.output });
    }

    assert.deepStrictEqual(router.aggregateResults(collected.reverse()), [10, 20, 30, 40]);
  });
});

// ============================================================================
// GridRouter Hardening: Telemetry Caching, Null Options Normalization & Flush Rollback
// ============================================================================
describe('GridRouter Hardening: Telemetry Caching, Null Options Normalization & Flush Rollback', () => {
  test('telemetryCacheTtlMs caching behavior, mock OS 0ms default, TTL expiry, and forceRefresh bypass', () => {
    // 1. Default TTL configuration (10ms without options.os), real-OS rapid cache reuse, and RangeError validation
    const realRouter = new GridRouter('real-ttl-default');
    assert.strictEqual(realRouter.telemetryCacheTtlMs, 10);
    assert.strictEqual(new GridRouter('null-os-default', { os: null }).telemetryCacheTtlMs, 10);

    let realCacheHitObserved = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const tStart = performance.now();
      const firstReal = realRouter.getHardwareTelemetry({ forceRefresh: true });
      const secondReal = realRouter.getHardwareTelemetry();
      const thirdReal = realRouter.getHardwareTelemetry();
      const elapsed = performance.now() - tStart;
      assert.strictEqual(firstReal.telemetryValid, true);
      if (elapsed < realRouter.telemetryCacheTtlMs) {
        assert.notStrictEqual(secondReal, firstReal);
        assert.notStrictEqual(thirdReal, secondReal);
        assert.deepStrictEqual(secondReal, firstReal);
        assert.deepStrictEqual(thirdReal, firstReal);
        realCacheHitObserved = true;
        break;
      }
    }
    // In high-load test runner runs, realCacheHitObserved may be false if elapsed > 10ms; verify cache directly if loop missed
    if (!realCacheHitObserved) {
      realRouter._cachedTelemetry = { standbyReady: true, telemetryValid: true, cpuLoad: 0.1 };
      realRouter._cachedAt = realRouter._cacheNow();
      const cached = realRouter.getHardwareTelemetry();
      assert.strictEqual(cached.cpuLoad, 0.1);
      realCacheHitObserved = true;
    }
    assert.strictEqual(realCacheHitObserved, true);

    const zeroTtlRealRouter = new GridRouter('zero-ttl-real', { telemetryCacheTtlMs: 0 });
    assert.strictEqual(zeroTtlRealRouter.telemetryCacheTtlMs, 0);
    assert.strictEqual(zeroTtlRealRouter.getHardwareTelemetry().telemetryValid, true);

    const negZeroRouter = new GridRouter('neg-zero-ttl', { telemetryCacheTtlMs: -0 });
    assert.strictEqual(Object.is(negZeroRouter.telemetryCacheTtlMs, 0), true);

    for (const badTtl of [-1, NaN, Infinity, -Infinity, '10', null]) {
      assert.throws(() => new GridRouter('bad-ttl', { telemetryCacheTtlMs: badTtl }), RangeError);
    }

    // 2. Mock options.os defaults to 0ms (no caching unless telemetryCacheTtlMs is configured)
    let userTicks = 0;
    let idleTicks = 0;
    let stepLoad = 0.10;
    let freeMem = 600;
    const totalMem = 1000;
    let cpusCalls = 0;
    let freememCalls = 0;
    let totalmemCalls = 0;
    let throwCpus = false;

    const countingMockOs = {
      cpus() {
        cpusCalls += 1;
        if (throwCpus) {
          throw new Error('transient os.cpus failure');
        }
        const busy = Math.round(100000 * stepLoad);
        userTicks += busy;
        idleTicks += (100000 - busy);
        return makeCpuSnap([{ user: userTicks, sys: 0, idle: idleTicks }]);
      },
      freemem() {
        freememCalls += 1;
        return freeMem;
      },
      totalmem() {
        totalmemCalls += 1;
        return totalMem;
      }
    };

    const uncachedMockRouter = new GridRouter('mock-default-0ms', { os: countingMockOs });
    assert.strictEqual(uncachedMockRouter.telemetryCacheTtlMs, 0);
    assert.strictEqual(cpusCalls, 1); // constructor initial CPU snapshot

    const m1 = uncachedMockRouter.getHardwareTelemetry();
    freeMem = 400;
    const m2 = uncachedMockRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 3);
    assert.strictEqual(freememCalls, 2);
    assert.strictEqual(totalmemCalls, 2);
    assert.strictEqual(m1.freeMemBytes, 600);
    assert.strictEqual(m2.freeMemBytes, 400);

    // 3. Real performance.now() caching path (without options.now) reuses cache across rapid calls and bypasses on forceRefresh
    freeMem = 600;
    stepLoad = 0.10;
    const perfCachedRouter = new GridRouter('perf-now-cached', {
      os: countingMockOs,
      telemetryCacheTtlMs: 5000
    });
    cpusCalls = 0;
    freememCalls = 0;
    totalmemCalls = 0;

    const perfEvents = [];
    perfCachedRouter.on('loadShed', (t) => perfEvents.push(t.loadShedState));

    const p1 = perfCachedRouter.getHardwareTelemetry();
    stepLoad = 0.85;
    freeMem = 50;
    const p2 = perfCachedRouter.getHardwareTelemetry();
    const p3 = perfCachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 1);
    assert.strictEqual(freememCalls, 1);
    assert.strictEqual(totalmemCalls, 1);
    assert.notStrictEqual(p2, p1);
    assert.deepStrictEqual(p2, p1);
    assert.deepStrictEqual(p3, p1);

    const pForced = perfCachedRouter.getHardwareTelemetry({ forceRefresh: true });
    assert.strictEqual(cpusCalls, 2);
    assert.strictEqual(pForced.standbyReady, false);
    assert.strictEqual(pForced.loadShedState, 'CPU_AND_MEMORY_EXHAUSTED');
    assert.deepStrictEqual(perfEvents, ['CPU_AND_MEMORY_EXHAUSTED']);

    // Cache hit while in shed state must not emit duplicate loadShed events
    const pShedCached = perfCachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 2);
    assert.strictEqual(pShedCached.standbyReady, false);
    assert.deepStrictEqual(perfEvents, ['CPU_AND_MEMORY_EXHAUSTED']);

    // 4. Deterministic clock TTL behavior: cache reuse, clone isolation, forceRefresh, exact boundary, backward clock
    let now = 1000;
    freeMem = 600;
    stepLoad = 0.10;
    const cachedRouter = new GridRouter('cached-ttl', {
      os: countingMockOs,
      telemetryCacheTtlMs: 50,
      now: () => now
    });
    assert.strictEqual(cachedRouter.telemetryCacheTtlMs, 50);

    cpusCalls = 0;
    freememCalls = 0;
    totalmemCalls = 0;

    const first = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 1);
    assert.strictEqual(freememCalls, 1);
    assert.strictEqual(totalmemCalls, 1);
    assert.strictEqual(first.standbyReady, true);
    assert.strictEqual(first.loadShedState, 'NOMINAL');
    assert.strictEqual(first.timestamp, 1000);

    // Mutating returned object must not corrupt the cached copy; OS spikes are masked within TTL
    first.cpuLoad = 0.99;
    first.standbyReady = false;
    stepLoad = 0.80;
    freeMem = 50;

    now = 1020;
    const hit1 = cachedRouter.getHardwareTelemetry();
    now = 1049;
    const hit2 = cachedRouter.getHardwareTelemetry({ forceRefresh: false });
    const gateHit = cachedRouter.canAcceptShard();

    assert.strictEqual(cpusCalls, 1);
    assert.strictEqual(freememCalls, 1);
    assert.strictEqual(totalmemCalls, 1);
    assert.notStrictEqual(hit1, hit2);
    assert.strictEqual(hit1.standbyReady, true);
    assert.ok(hit1.cpuLoad <= 0.25);
    assert.strictEqual(hit1.timestamp, 1000);
    assert.strictEqual(hit2.timestamp, 1000);
    assert.strictEqual(gateHit.accepted, true);
    assert.strictEqual(gateHit.telemetry.timestamp, 1000);

    // { forceRefresh: true } bypasses cache cleanly and updates cached snapshot
    const shedStates = [];
    cachedRouter.on('loadShed', (t) => shedStates.push(t.loadShedState));

    const forced = cachedRouter.getHardwareTelemetry({ forceRefresh: true });
    assert.strictEqual(cpusCalls, 2);
    assert.strictEqual(freememCalls, 2);
    assert.strictEqual(totalmemCalls, 2);
    assert.strictEqual(forced.standbyReady, false);
    assert.strictEqual(forced.loadShedState, 'CPU_AND_MEMORY_EXHAUSTED');
    assert.strictEqual(forced.timestamp, 1049);
    assert.deepStrictEqual(shedStates, ['CPU_AND_MEMORY_EXHAUSTED']);

    // Subsequent call within refreshed TTL reuses the refreshed snapshot without duplicate loadShed emission
    stepLoad = 0.10;
    freeMem = 600;
    now = 1060;
    const cachedAfterForce = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 2);
    assert.strictEqual(cachedAfterForce.standbyReady, false);
    assert.strictEqual(cachedAfterForce.timestamp, 1049);
    assert.deepStrictEqual(shedStates, ['CPU_AND_MEMORY_EXHAUSTED']);

    // canAcceptShard({ forceRefresh: true }) also bypasses cache cleanly
    const recoveredGate = cachedRouter.canAcceptShard({ forceRefresh: true });
    assert.strictEqual(cpusCalls, 3);
    assert.strictEqual(recoveredGate.accepted, true);
    assert.strictEqual(recoveredGate.loadShedState, 'NOMINAL');
    assert.strictEqual(recoveredGate.telemetry.timestamp, 1060);

    // Exact TTL boundary (elapsed === telemetryCacheTtlMs) and backward clock jump miss cache
    now = 1109; // elapsed = 49 < 50 -> hit
    assert.strictEqual(cachedRouter.getHardwareTelemetry().timestamp, 1060);
    assert.strictEqual(cpusCalls, 3);

    now = 1110; // elapsed = 50 -> miss
    const atBoundary = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 4);
    assert.strictEqual(atBoundary.timestamp, 1110);

    now = 1100; // elapsed = -10 < 0 -> miss
    const backwardClock = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 5);
    assert.strictEqual(backwardClock.timestamp, 1100);

    // 5. isMemoryAvailable() transitions invalidate stale telemetry cache; non-transition preserves valid cache
    freeMem = 500; // remains nominal (true -> true), must keep cache valid
    assert.strictEqual(cachedRouter.isMemoryAvailable(), true);
    now = 1102;
    assert.strictEqual(cachedRouter.getHardwareTelemetry().timestamp, 1100);
    assert.strictEqual(cpusCalls, 5);

    freeMem = 50; // 5% < 10% floor -> transitions _memShedActive false -> true
    assert.strictEqual(cachedRouter.isMemoryAvailable(), false);
    now = 1105; // within 50ms of 1100, yet cache must be invalidated
    const postMemShed = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 6);
    assert.strictEqual(postMemShed.standbyReady, false);
    assert.strictEqual(postMemShed.loadShedState, 'MEMORY_EXHAUSTED');

    freeMem = 600; // transitions _memShedActive true -> false, invalidating cached MEMORY_EXHAUSTED
    assert.strictEqual(cachedRouter.isMemoryAvailable(), true);
    now = 1110; // within 50ms of 1105, yet cache must be invalidated
    const postMemRecover = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(cpusCalls, 7);
    assert.strictEqual(postMemRecover.standbyReady, true);
    assert.strictEqual(postMemRecover.loadShedState, 'NOMINAL');

    // 6. forceRefresh recovers cleanly from cached TELEMETRY_INVALID state
    throwCpus = true;
    now = 1200;
    const invalidSample = cachedRouter.getHardwareTelemetry();
    assert.strictEqual(invalidSample.telemetryValid, false);
    assert.strictEqual(invalidSample.loadShedState, 'TELEMETRY_INVALID');
    throwCpus = false;
    now = 1210;
    assert.strictEqual(cachedRouter.getHardwareTelemetry().loadShedState, 'TELEMETRY_INVALID'); // cached within TTL
    const recoveredInvalid = cachedRouter.getHardwareTelemetry({ forceRefresh: true });
    assert.strictEqual(recoveredInvalid.telemetryValid, true);
    assert.strictEqual(recoveredInvalid.loadShedState, 'NOMINAL');
  });

  test('null and non-object options normalization across GridRouter methods never throws TypeError: Cannot read properties of null', () => {
    const idleSnap = makeCpuSnap([{ user: 100, sys: 0, idle: 900 }]);
    const mockOs = createMockOs([idleSnap, idleSnap], 600, 1000);

    // Constructor with null / primitive / callable / array options & null sub-fields
    for (const badOpts of [null, undefined, 'bad', 42, 0, '', false, () => {}, []]) {
      const r = new GridRouter('norm-node', badOpts);
      assert.strictEqual(r.localNodeId, 'norm-node');
      assert.strictEqual(r.telemetryCacheTtlMs, 10);
    }
    const nullFieldOptsRouter = new GridRouter('null-fields', { os: null, now: null, onDispatch: null });
    assert.strictEqual(nullFieldOptsRouter.telemetryCacheTtlMs, 10);
    assert.strictEqual(nullFieldOptsRouter.onDispatch, null);

    const router = new GridRouter('router-norm', { os: mockOs, autoFlush: false, maxQueueSize: 20 });

    // setDispatchHandler accepts null and rejects invalid non-null values cleanly
    router.setDispatchHandler(() => {});
    router.setDispatchHandler(null);
    assert.strictEqual(router.onDispatch, null);
    assert.throws(() => router.setDispatchHandler(undefined), TypeError);
    assert.throws(() => router.setDispatchHandler(123), TypeError);

    // Telemetry and admission gates with null / non-object options
    for (const badOpts of [null, undefined, 'bad', 123, 0, '', true, () => {}]) {
      const tel = router.getHardwareTelemetry(badOpts);
      assert.strictEqual(tel.standbyReady, true);
      assert.strictEqual(tel.loadShedState, 'NOMINAL');

      const gate = router.canAcceptShard(badOpts);
      assert.strictEqual(gate.accepted, true);
      assert.strictEqual(gate.action, 'ACCEPT');

      const stat = router.evaluateTelemetry(badOpts);
      assert.strictEqual(stat.standbyReady, false);
      assert.strictEqual(stat.valid, false);
      assert.strictEqual(stat.loadShedState, 'TELEMETRY_INVALID');
    }

    // Peer registration & telemetry update with null / non-object telemetry & null fields
    router.registerPeer('p-null', 'pub-null', null);
    router.registerPeer('p-str', 'pub-str', 'bad');
    router.registerPeer('p-num', 'pub-num', 99);
    router.registerPeer('p-subnull', 'pub-subnull', {
      standbyReady: null,
      cpuLoad: null,
      freeMemRatio: null,
      latencyMs: null,
      capacityScore: null,
      maxConcurrentShards: null,
      freeMemBytes: null
    });
    assert.strictEqual(router.peerTable.get('p-null').standbyReady, false);
    assert.strictEqual(router.peerTable.get('p-str').standbyReady, false);
    assert.strictEqual(router.peerTable.get('p-num').standbyReady, false);
    assert.strictEqual(router.peerTable.get('p-subnull').standbyReady, false);
    assert.strictEqual(router.peerTable.get('p-subnull').latencyMs, 9999);
    assert.strictEqual(router.peerTable.get('p-subnull').capacityScore, 0);

    assert.strictEqual(router.updatePeerTelemetry('p-subnull', { cpuLoad: null, freeMemRatio: null, latencyMs: null }).standbyReady, false);
    assert.strictEqual(router.updatePeerTelemetry('p-subnull', { standbyReady: true }).standbyReady, false);
    assert.strictEqual(router.updatePeerTelemetry('p-subnull', { standbyReady: true, cpuLoad: 0.1, freeMemRatio: 0.6, latencyMs: 10 }).standbyReady, true);
    assert.strictEqual(router.updatePeerTelemetry('p-subnull', null).standbyReady, false);

    router.registerPeer('p-ready', 'pub-ready', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 10 });
    assert.strictEqual(router.updatePeerTelemetry('p-ready', null).standbyReady, false);
    assert.strictEqual(router.updatePeerTelemetry('p-ready', 'bad').standbyReady, false);
    assert.strictEqual(router.updatePeerTelemetry('p-ready', { standbyReady: true }).standbyReady, true);

    // selectOptimalNodes with null hash, null/undefined count, and extra null trailing arg
    assert.strictEqual(router.selectOptimalNodes('hash', 1, null).length, 1);
    assert.strictEqual(router.selectOptimalNodes('hash', undefined, null).length, 1);
    assert.strictEqual(router.selectOptimalNodes(null, 1).length, 1);
    assert.deepStrictEqual(router.selectOptimalNodes('hash', null), []);
    assert.deepStrictEqual(router.selectOptimalNodes(null, null), []);

    // createTaskPartitions 3rd param is chunkSize (not options): null fails closed with RangeError, not property-read TypeError
    assert.throws(
      () => router.createTaskPartitions('return data;', [1, 2, 3, 4], null),
      RangeError
    );
    const shards = router.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 2, null);
    assert.strictEqual(shards.length, 6);

    // enqueueTask (note: GridRouter exposes enqueueTask, not enqueueShard) with null / non-object options
    router.enqueueTask(shards[0], null);
    router.enqueueTask(shards[1], 'bad');
    router.enqueueTask(shards[2], 123);
    assert.strictEqual(router.taskQueue.length, 3);
    assert.throws(() => router.enqueueTask(null, null), /Invalid shard/);

    // flushQueue with null callback, trailing null arg, and fallback to setDispatchHandler when null passed
    const flushedViaNull = router.flushQueue(null);
    assert.strictEqual(flushedViaNull.length, 3);
    assert.strictEqual(router.taskQueue.length, 0);

    const handlerSeen = [];
    router.setDispatchHandler((shard) => handlerSeen.push(shard.shardId));
    router.enqueueTask(shards[3], null);
    const flushedViaDefaultHandler = router.flushQueue(null);
    assert.strictEqual(flushedViaDefaultHandler.length, 1);
    assert.deepStrictEqual(handlerSeen, [shards[3].shardId]);

    const seen = [];
    router.enqueueTask(shards[4], null);
    const flushedWithTrailingNull = router.flushQueue((shard) => seen.push(shard.shardId), null);
    assert.strictEqual(flushedWithTrailingNull.length, 1);
    assert.deepStrictEqual(seen, [shards[4].shardId]);

    // dispatchShard & routeShard with null / non-object options & { onDispatch: null } fallback
    const d1 = router.dispatchShard(shards[5], null);
    assert.strictEqual(d1.status, 'DISPATCHED');
    assert.deepStrictEqual(handlerSeen, [shards[3].shardId, shards[5].shardId]);
    router.completeShard(shards[5].shardId);

    const d2 = router.routeShard({ ...shards[5], shardId: `${shards[5].shardId}-r` }, 'bad');
    assert.strictEqual(d2.status, 'DISPATCHED');
    const d3 = router.dispatchShard({ ...shards[5], shardId: `${shards[5].shardId}-n` }, { onDispatch: null, failClosed: null });
    assert.strictEqual(d3.status, 'DISPATCHED');
    router.setDispatchHandler(null);

    assert.throws(() => router.dispatchShard(null, null), /Invalid shard/);
    assert.throws(() => router.routeShard(null, null), /Invalid shard/);

    // handlePeerDisconnect with null / non-object options and null peerId
    const disc1 = router.handlePeerDisconnect('p-ready', null);
    assert.strictEqual(disc1.rescheduled.length, 7);
    assert.strictEqual(router.taskQueue.length, 7);
    assert.strictEqual(router.peerTable.has('p-ready'), true);
    const disc2 = router.handlePeerDisconnect('p-null', 'bad');
    assert.strictEqual(disc2.rescheduled.length, 0);
    assert.strictEqual(router.peerTable.has('p-null'), true);
    assert.deepStrictEqual(router.handlePeerDisconnect(null, null), { rescheduled: [], failed: [] });

    // Queueing path of dispatchShard / routeShard when no peers are available and options is null
    router.updatePeerTelemetry('p-ready', { standbyReady: false });
    const queuedByNull = router.dispatchShard({ shardId: 'queued-null-opts', taskCode: 'return data;', inputData: [1] }, null);
    assert.strictEqual(queuedByNull.status, 'QUEUED');
    assert.strictEqual(queuedByNull.reason, 'ALL_PEERS_BUSY_OR_SHEDDING');

    // completeShard, rescheduleShard, and aggregateResults with null arguments never fail with property-read TypeError
    assert.strictEqual(router.completeShard(null), false);
    assert.deepStrictEqual(router.rescheduleShard(null), { status: 'NOT_FOUND', shardId: null });
    assert.throws(() => router.aggregateResults(null, null), /Invalid results/);
    assert.throws(() => router.aggregateResults([null], 1), /Invalid shard result/);
  });

  test('flushQueue transactional rollback preserves zero duplicates, zero lost shards, and clean activeShards', () => {
    // Case 1: dispatchCallback throws leaving shard un-assigned (immediate & mid-flush)
    const rUnassigned = new GridRouter('flush-unassigned', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const uShards = rUnassigned.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    rUnassigned.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 3 });
    for (const s of uShards) {
      rUnassigned.enqueueTask(s);
    }

    const flushedEvents = [];
    rUnassigned.on('queueFlushed', (batch) => flushedEvents.push(batch.map((b) => b.shard.shardId)));

    // 1st shard throws immediately
    assert.throws(
      () => rUnassigned.flushQueue(() => { throw new Error('immediate fail'); }),
      /immediate fail/
    );
    assert.deepStrictEqual(rUnassigned.taskQueue.map((s) => s.shardId), uShards.map((s) => s.shardId));
    assert.strictEqual(rUnassigned.taskQueue[0].attempts, undefined);
    assert.strictEqual(rUnassigned.inFlightShards.size, 0);
    assert.strictEqual(rUnassigned.peerTable.get('p1').activeShards, 0);
    assert.strictEqual(flushedEvents.length, 0);

    // Partial flush: shard 0 succeeds, shard 1 throws un-assigned
    assert.throws(
      () => rUnassigned.flushQueue((shard) => {
        if (shard.shardId === uShards[1].shardId) {
          throw new Error('mid-flush fail');
        }
      }),
      /mid-flush fail/
    );
    assert.strictEqual(rUnassigned.inFlightShards.size, 1);
    assert.strictEqual(rUnassigned.inFlightShards.has(uShards[0].shardId), true);
    assert.strictEqual(rUnassigned.peerTable.get('p1').activeShards, 1);
    assert.deepStrictEqual(rUnassigned.taskQueue.map((s) => s.shardId), [uShards[1].shardId, uShards[2].shardId]);
    assert.strictEqual(rUnassigned.taskQueue[0].attempts, undefined);
    assert.deepStrictEqual(flushedEvents, [[uShards[0].shardId]]);

    // Retry succeeds cleanly with accurate attempt counts
    const remaining = rUnassigned.flushQueue();
    assert.strictEqual(remaining.length, 2);
    assert.strictEqual(remaining[0].shard.attempts, 1);
    assert.strictEqual(remaining[1].shard.attempts, 1);
    assert.strictEqual(rUnassigned.taskQueue.length, 0);
    assert.strictEqual(rUnassigned.inFlightShards.size, 3);
    assert.strictEqual(rUnassigned.peerTable.get('p1').activeShards, 3);

    // Case 2a: dispatchCallback completes shard then throws (autoFlush: false) -> no duplicate re-enqueue
    const rComplete = new GridRouter('flush-complete', { autoFlush: false, maxQueueSize: 10 });
    const cShards = rComplete.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rComplete.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    for (const s of cShards) {
      rComplete.enqueueTask(s);
    }

    assert.throws(
      () => rComplete.flushQueue((shard) => {
        assert.strictEqual(rComplete.completeShard(shard.shardId), true);
        throw new Error('post-complete error');
      }),
      /post-complete error/
    );
    assert.deepStrictEqual(rComplete.taskQueue.map((s) => s.shardId), [cShards[1].shardId]);
    assert.strictEqual(rComplete.inFlightShards.size, 0);
    assert.strictEqual(rComplete.peerTable.get('p1').activeShards, 0);

    // Case 2b: dispatchCallback completes shard then throws (autoFlush: true, maxConcurrentShards: 1)
    const rCompleteAuto = new GridRouter('flush-complete-auto', { autoFlush: true, maxQueueSize: 10 });
    const caShards = rCompleteAuto.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rCompleteAuto.enqueueTask(caShards[0]);
    rCompleteAuto.enqueueTask(caShards[1]);
    rCompleteAuto.autoFlush = false;
    rCompleteAuto.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 1 });
    rCompleteAuto.autoFlush = true;

    assert.throws(
      () => rCompleteAuto.flushQueue((shard) => {
        rCompleteAuto.completeShard(shard.shardId);
        throw new Error('post-complete-autoflush error');
      }),
      /post-complete-autoflush error/
    );
    assert.strictEqual(rCompleteAuto.taskQueue.length, 0);
    assert.strictEqual(rCompleteAuto.inFlightShards.size, 1);
    assert.strictEqual(rCompleteAuto.inFlightShards.has(caShards[1].shardId), true);
    assert.strictEqual(rCompleteAuto.peerTable.get('p1').activeShards, 1);

    // Case 3a: dispatchCallback reschedules shard then throws -> zero duplicate in taskQueue
    const rResched = new GridRouter('flush-resched', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const rsShards = rResched.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rResched.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    for (const s of rsShards) {
      rResched.enqueueTask(s);
    }

    assert.throws(
      () => rResched.flushQueue((shard) => {
        const out = rResched.rescheduleShard(shard.shardId);
        assert.strictEqual(out.status, 'RESCHEDULED');
        throw new Error('post-reschedule error');
      }),
      /post-reschedule error/
    );
    assert.deepStrictEqual(rResched.taskQueue.map((s) => s.shardId), [rsShards[0].shardId, rsShards[1].shardId]);
    assert.strictEqual(rResched.taskQueue[0].attempts, 1);
    assert.strictEqual(rResched.inFlightShards.size, 0);
    assert.strictEqual(rResched.peerTable.get('p1').activeShards, 0);

    // Case 3b: dispatchCallback exhausts maxRetries via rescheduleShard then throws -> stays in failedTasks, not re-queued
    const rExhaust = new GridRouter('flush-exhaust', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const exShards = rExhaust.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rExhaust.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    rExhaust.enqueueTask({ ...exShards[0], attempts: 2 });
    rExhaust.enqueueTask(exShards[1]);

    assert.throws(
      () => rExhaust.flushQueue((shard) => {
        const out = rExhaust.rescheduleShard(shard.shardId);
        assert.strictEqual(out.status, 'FAILED');
        throw new Error('post-exhaust error');
      }),
      /post-exhaust error/
    );
    assert.strictEqual(rExhaust.failedTasks.length, 1);
    assert.strictEqual(rExhaust.failedTasks[0].shard.shardId, exShards[0].shardId);
    assert.strictEqual(rExhaust.failedTasks[0].reason, 'MAX_RETRIES_EXCEEDED');
    assert.deepStrictEqual(rExhaust.taskQueue.map((s) => s.shardId), [exShards[1].shardId]);
    assert.strictEqual(rExhaust.inFlightShards.size, 0);
    assert.strictEqual(rExhaust.peerTable.get('p1').activeShards, 0);

    // Case 4a: dispatchCallback disconnects peer mid-flush after shard 0 succeeded -> zero duplicates, clean activeShards
    const rDisc = new GridRouter('flush-disconnect', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const dShards = rDisc.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    rDisc.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 3 });
    for (const s of dShards) {
      rDisc.enqueueTask(s);
    }

    assert.throws(
      () => rDisc.flushQueue((shard) => {
        if (shard.shardId === dShards[1].shardId) {
          rDisc.handlePeerDisconnect('p1');
          throw new Error('disconnect mid-flush');
        }
      }),
      /disconnect mid-flush/
    );
    assert.strictEqual(rDisc.peerTable.get('p1').standbyReady, false);
    assert.strictEqual(rDisc.peerTable.get('p1').activeShards, 0);
    assert.strictEqual(rDisc.inFlightShards.size, 0);
    assert.deepStrictEqual(
      rDisc.taskQueue.map((s) => s.shardId),
      [dShards[0].shardId, dShards[1].shardId, dShards[2].shardId]
    );
    assert.strictEqual(rDisc.taskQueue[0].attempts, 1);
    assert.strictEqual(rDisc.taskQueue[1].attempts, 1);
    assert.strictEqual(rDisc.taskQueue[2].attempts, undefined);

    // Case 4b: dispatchCallback removes peer triggering autoFlush failover to p2, then throws
    const rFailover = new GridRouter('flush-failover', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const fShards = rFailover.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rFailover.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 1 });
    rFailover.registerPeer('p2', 'pub2', { standbyReady: true, latencyMs: 20, maxConcurrentShards: 2 });
    rFailover.enqueueTask(fShards[0]);
    rFailover.enqueueTask(fShards[1]);
    rFailover.autoFlush = true;

    const failoverFlushed = [];
    rFailover.on('queueFlushed', (batch) => failoverFlushed.push(batch.map((b) => [b.shard.shardId, b.peer.nodeId])));

    assert.throws(
      () => rFailover.flushQueue(() => {
        rFailover.handlePeerDisconnect('p1', { remove: true });
        throw new Error('failover disconnect error');
      }),
      /failover disconnect error/
    );
    assert.strictEqual(rFailover.peerTable.has('p1'), false);
    assert.strictEqual(rFailover.taskQueue.length, 0);
    assert.strictEqual(rFailover.inFlightShards.size, 2);
    assert.strictEqual(rFailover.inFlightShards.get(fShards[0].shardId).peerId, 'p2');
    assert.strictEqual(rFailover.inFlightShards.get(fShards[0].shardId).attempts, 2);
    assert.strictEqual(rFailover.inFlightShards.get(fShards[1].shardId).peerId, 'p2');
    assert.strictEqual(rFailover.inFlightShards.get(fShards[1].shardId).attempts, 1);
    assert.strictEqual(rFailover.peerTable.get('p2').activeShards, 2);
    assert.deepStrictEqual(failoverFlushed, [[
      [fShards[0].shardId, 'p2'],
      [fShards[1].shardId, 'p2']
    ]]);

    // Case 4c: handlePeerDisconnect triggers autoFlush failover to p2 AND onDispatch throws during failover
    const rFailoverErr = new GridRouter('flush-failover-err', { autoFlush: false, maxQueueSize: 10, maxRetries: 3 });
    const feShards = rFailoverErr.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rFailoverErr.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 1 });
    rFailoverErr.registerPeer('p2', 'pub2', { standbyReady: true, latencyMs: 20, maxConcurrentShards: 2 });
    rFailoverErr.enqueueTask(feShards[0]);
    rFailoverErr.enqueueTask(feShards[1]);
    rFailoverErr.setDispatchHandler(() => {
      throw new Error('p2 failover onDispatch failed');
    });
    rFailoverErr.autoFlush = true;

    assert.throws(
      () => rFailoverErr.flushQueue(() => {
        rFailoverErr.handlePeerDisconnect('p1');
      }),
      /p2 failover onDispatch failed/
    );
    assert.strictEqual(rFailoverErr.peerTable.get('p1').standbyReady, false);
    assert.strictEqual(rFailoverErr.peerTable.get('p1').activeShards, 0);
    assert.strictEqual(rFailoverErr.peerTable.get('p2').activeShards, 0);
    assert.strictEqual(rFailoverErr.inFlightShards.size, 0);
    assert.deepStrictEqual(
      rFailoverErr.taskQueue.map((s) => s.shardId),
      [feShards[0].shardId, feShards[1].shardId]
    );
    assert.strictEqual(rFailoverErr.taskQueue[0].attempts, 1);

    // Case 5: shardDispatched listener throw rolls back & queueFlushed listener error preserves original dispatch error
    const rListeners = new GridRouter('flush-listeners', { autoFlush: false, maxQueueSize: 10 });
    const lShards = rListeners.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rListeners.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    rListeners.enqueueTask(lShards[0]);
    rListeners.enqueueTask(lShards[1]);

    const listenerFlushed = [];
    rListeners.on('shardDispatched', ({ shard }) => {
      if (shard.shardId === lShards[1].shardId) {
        throw new Error('listener boom on s1');
      }
    });
    rListeners.on('queueFlushed', (batch) => {
      listenerFlushed.push(batch.map((b) => b.shard.shardId));
      throw new Error('secondary queueFlushed listener boom');
    });

    assert.throws(
      () => rListeners.flushQueue(),
      (err) => err instanceof Error && err.message === 'listener boom on s1'
    );
    assert.deepStrictEqual(listenerFlushed, [[lShards[0].shardId]]);
    assert.deepStrictEqual(rListeners.taskQueue.map((s) => s.shardId), [lShards[1].shardId]);
    assert.strictEqual(rListeners.inFlightShards.size, 1);
    assert.strictEqual(rListeners.inFlightShards.has(lShards[0].shardId), true);
    assert.strictEqual(rListeners.peerTable.get('p1').activeShards, 1);

    // Case 6a & 6b: dispatchCallback completes an already in-flight sibling shard (triggering autoFlush) then throws
    const rSiblingOk = new GridRouter('flush-sibling-ok', { autoFlush: true, maxQueueSize: 10 });
    const sibShards = rSiblingOk.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    rSiblingOk.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 1 });
    rSiblingOk.registerPeer('p2', 'pub2', { standbyReady: true, latencyMs: 20, maxConcurrentShards: 1 });
    rSiblingOk.dispatchShard(sibShards[0]); // in-flight on p1
    rSiblingOk.enqueueTask(sibShards[1]);
    rSiblingOk.enqueueTask(sibShards[2]);

    assert.throws(
      () => rSiblingOk.flushQueue((shard) => {
        assert.strictEqual(shard.shardId, sibShards[1].shardId);
        rSiblingOk.completeShard(sibShards[0].shardId); // frees p1 and auto-flushes sibShards[2] -> p1
        throw new Error('sibling complete post-throw');
      }),
      /sibling complete post-throw/
    );
    assert.deepStrictEqual(rSiblingOk.taskQueue.map((s) => s.shardId), [sibShards[1].shardId]);
    assert.strictEqual(rSiblingOk.inFlightShards.size, 1);
    assert.strictEqual(rSiblingOk.inFlightShards.get(sibShards[2].shardId).peerId, 'p1');
    assert.strictEqual(rSiblingOk.peerTable.get('p1').activeShards, 1);
    assert.strictEqual(rSiblingOk.peerTable.get('p2').activeShards, 0);

    // Case 6b: sibling autoFlush inner onDispatch ALSO throws -> both inner and outer shards roll back cleanly
    const rSiblingFail = new GridRouter('flush-sibling-fail', { autoFlush: true, maxQueueSize: 10 });
    const sfShards = rSiblingFail.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    rSiblingFail.registerPeer('p1', 'pub1', { standbyReady: true, latencyMs: 5, maxConcurrentShards: 1 });
    rSiblingFail.registerPeer('p2', 'pub2', { standbyReady: true, latencyMs: 20, maxConcurrentShards: 1 });
    rSiblingFail.dispatchShard(sfShards[0]); // in-flight on p1
    rSiblingFail.enqueueTask(sfShards[1]);
    rSiblingFail.enqueueTask(sfShards[2]);
    rSiblingFail.setDispatchHandler(() => {
      throw new Error('inner autoFlush onDispatch boom');
    });

    assert.throws(
      () => rSiblingFail.flushQueue(() => {
        rSiblingFail.completeShard(sfShards[0].shardId);
      }),
      /inner autoFlush onDispatch boom/
    );
    assert.deepStrictEqual(
      rSiblingFail.taskQueue.map((s) => s.shardId),
      [sfShards[1].shardId, sfShards[2].shardId]
    );
    assert.strictEqual(rSiblingFail.inFlightShards.size, 0);
    assert.strictEqual(rSiblingFail.peerTable.get('p1').activeShards, 0);
    assert.strictEqual(rSiblingFail.peerTable.get('p2').activeShards, 0);

    // Case 7a: dispatchCallback calls enqueueTask up to maxQueueSize before throwing -> zero lost shards, zero duplicates
    const rEnqRollback = new GridRouter('flush-enqueue-rollback', { autoFlush: false, maxQueueSize: 2 });
    const erShards = rEnqRollback.createTaskPartitions('return data;', [1, 2, 3, 4, 5, 6], 2);
    rEnqRollback.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    rEnqRollback.enqueueTask(erShards[0]);
    rEnqRollback.enqueueTask(erShards[1]);

    assert.throws(
      () => rEnqRollback.flushQueue(() => {
        rEnqRollback.enqueueTask(erShards[2]); // taskQueue is now at maxQueueSize (2)
        throw new Error('post-enqueue fail');
      }),
      /post-enqueue fail/
    );
    assert.deepStrictEqual(
      rEnqRollback.taskQueue.map((s) => s.shardId),
      [erShards[0].shardId, erShards[1].shardId, erShards[2].shardId]
    );
    assert.strictEqual(rEnqRollback.inFlightShards.size, 0);
    assert.strictEqual(rEnqRollback.peerTable.get('p1').activeShards, 0);

    // Case 7b: dispatchCallback fills queue then reschedules current shard (QUEUE_FULL_ON_RESCHEDULE) then throws
    const rReschedFull = new GridRouter('flush-resched-full', { autoFlush: false, maxQueueSize: 1, maxRetries: 3 });
    const rfShards = rReschedFull.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rReschedFull.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 2 });
    rReschedFull.enqueueTask(rfShards[0]);

    assert.throws(
      () => rReschedFull.flushQueue((shard) => {
        rReschedFull.enqueueTask(rfShards[1]);
        const resched = rReschedFull.rescheduleShard(shard.shardId);
        assert.strictEqual(resched.status, 'FAILED');
        assert.strictEqual(resched.reason, 'QUEUE_FULL_ON_RESCHEDULE');
        throw new Error('post-queue-full-resched fail');
      }),
      /post-queue-full-resched fail/
    );
    assert.strictEqual(rReschedFull.failedTasks.length, 1);
    assert.strictEqual(rReschedFull.failedTasks[0].shard.shardId, rfShards[0].shardId);
    assert.deepStrictEqual(rReschedFull.taskQueue.map((s) => s.shardId), [rfShards[1].shardId]);
    assert.strictEqual(rReschedFull.inFlightShards.size, 0);
    assert.strictEqual(rReschedFull.peerTable.get('p1').activeShards, 0);

    // Case 8: autoFlush failures on completeShard & registerPeer leave state clean without lost shards
    const rAutoErr = new GridRouter('autoflush-caller-rollback', { autoFlush: true, maxQueueSize: 10 });
    const aeShards = rAutoErr.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rAutoErr.enqueueTask(aeShards[0]);
    let failDispatch = true;
    rAutoErr.setDispatchHandler(() => {
      if (failDispatch) {
        throw new Error('autoFlush registerPeer boom');
      }
    });
    assert.throws(
      () => rAutoErr.registerPeer('p1', 'pub1', { standbyReady: true, maxConcurrentShards: 1 }),
      /autoFlush registerPeer boom/
    );
    assert.strictEqual(rAutoErr.peerTable.has('p1'), true);
    assert.strictEqual(rAutoErr.peerTable.get('p1').activeShards, 0);
    assert.deepStrictEqual(rAutoErr.taskQueue.map((s) => s.shardId), [aeShards[0].shardId]);

    failDispatch = false;
    rAutoErr.flushQueue();
    rAutoErr.enqueueTask(aeShards[1]);
    failDispatch = true;
    assert.throws(
      () => rAutoErr.completeShard(aeShards[0].shardId),
      /autoFlush registerPeer boom/
    );
    assert.strictEqual(rAutoErr.inFlightShards.size, 0);
    assert.strictEqual(rAutoErr.peerTable.get('p1').activeShards, 0);
    assert.deepStrictEqual(rAutoErr.taskQueue.map((s) => s.shardId), [aeShards[1].shardId]);

    // Direct dispatchShard rollback when onDispatch throws (both per-call & setDispatchHandler, with external reschedule)
    const rDirect = new GridRouter('direct-rollback');
    const [directShard, directShard2] = rDirect.createTaskPartitions('return data;', [1, 2, 3, 4], 2);
    rDirect.registerPeer('p1', 'pub1', { standbyReady: true });
    assert.throws(
      () => rDirect.dispatchShard(directShard, { onDispatch: () => { throw new Error('direct dispatch fail'); } }),
      /direct dispatch fail/
    );
    assert.strictEqual(rDirect.inFlightShards.size, 0);
    assert.strictEqual(rDirect.peerTable.get('p1').activeShards, 0);

    rDirect.setDispatchHandler((shard) => {
      assert.strictEqual(rDirect.rescheduleShard(shard.shardId).status, 'RESCHEDULED');
      throw new Error('direct handler after reschedule fail');
    });
    assert.throws(() => rDirect.dispatchShard(directShard2), /direct handler after reschedule fail/);
    assert.strictEqual(rDirect.inFlightShards.size, 0);
    assert.strictEqual(rDirect.peerTable.get('p1').activeShards, 0);
    assert.deepStrictEqual(rDirect.taskQueue.map((s) => s.shardId), [directShard2.shardId]);
  });
});
