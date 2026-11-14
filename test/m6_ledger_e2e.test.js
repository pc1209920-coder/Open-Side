const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  ProofOfComputeLedger,
  DoubleSpendAttemptError,
  InsufficientCreditBalanceError,
  UnknownAccountError,
  CreditOverflowError
} = require('../src/ledger');
const {
  ComputeSea,
  OpenSideProtocol,
  runProtocolSimulation
} = require('../src/index');
const { MeshCryptoEngine } = require('../src/crypto');
const { GridRouter } = require('../src/router');
const { StandbySandbox } = require('../src/sandbox');

let ipcSeq = 0;
let cachedLoopbackTcpPromise = null;

function makeUniqueIpcPath(tag = 'm6') {
  ipcSeq += 1;
  const suffix = `${tag}-${process.pid}-${Date.now()}-${ipcSeq}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\openside-m6-${suffix}`;
  }
  return path.join(os.tmpdir(), `openside-m6-${suffix}.sock`);
}

function isTcpRestrictedError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM'));
}

function probeLoopbackTcpAllowed() {
  if (cachedLoopbackTcpPromise) {
    return cachedLoopbackTcpPromise;
  }

  cachedLoopbackTcpPromise = new Promise((resolve) => {
    const srv = net.createServer((sock) => sock.destroy());
    let settled = false;
    const finish = (allowed) => {
      if (settled) return;
      settled = true;
      try {
        srv.close();
      } catch {
        // Ignore close errors
      }
      resolve(allowed);
    };

    const safetyTimer = setTimeout(() => finish(false), 1000);
    if (typeof safetyTimer.unref === 'function') safetyTimer.unref();

    srv.once('error', () => finish(false));
    srv.listen({ host: '127.0.0.1', port: 0 }, () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        finish(false);
        return;
      }
      const client = net.createConnection({ host: '127.0.0.1', port: addr.port });
      client.once('connect', () => {
        client.destroy();
        finish(true);
      });
      client.once('error', (err) => {
        client.destroy();
        if (isTcpRestrictedError(err)) {
          finish(false);
        } else {
          finish(false);
        }
      });
    });
  });

  return cachedLoopbackTcpPromise;
}

function flipLastHexByte(hexStr) {
  assert.strictEqual(typeof hexStr, 'string');
  assert.ok(hexStr.length >= 2);
  const tail = hexStr.slice(-2).toLowerCase();
  const replacement = tail === 'ff' ? '00' : 'ff';
  return hexStr.slice(0, -2) + replacement;
}

function snapshotLedgerState(ledger) {
  const accounts = new Map();
  for (const [id, acc] of ledger.accounts.entries()) {
    accounts.set(id, { ...acc });
  }
  return {
    accounts,
    totalBalance: ledger.getTotalBalance(),
    totalReserved: ledger.getTotalReserved(),
    settledCount: ledger.settledAttestations.size,
    auditLength: ledger.auditLog.length
  };
}

function assertLedgerStateUnchanged(ledger, beforeSnapshot, context = '') {
  const prefix = context ? `${context}: ` : '';
  assert.strictEqual(ledger.getTotalBalance(), beforeSnapshot.totalBalance, `${prefix}totalBalance mutated`);
  assert.strictEqual(ledger.getTotalReserved(), beforeSnapshot.totalReserved, `${prefix}totalReserved mutated`);
  assert.strictEqual(ledger.settledAttestations.size, beforeSnapshot.settledCount, `${prefix}settledAttestations mutated`);
  assert.strictEqual(ledger.auditLog.length, beforeSnapshot.auditLength, `${prefix}auditLog mutated`);
  assert.strictEqual(ledger.accounts.size, beforeSnapshot.accounts.size, `${prefix}account count mutated`);
  for (const [id, prev] of beforeSnapshot.accounts.entries()) {
    const curr = ledger.accounts.get(id);
    assert.ok(curr, `${prefix}missing account ${id}`);
    assert.deepStrictEqual({ ...curr }, prev, `${prefix}account ${id} snapshot mutated`);
  }
}

function makeSignedShardClaim(worker, requesterId, taskCode, inputData, options = {}) {
  const router = new GridRouter(requesterId);
  const sandbox = new StandbySandbox();
  const [shard] = router.createTaskPartitions(taskCode, inputData, Math.max(1, inputData.length));
  const execRes = sandbox.executeIsolatedShard(shard);
  const proofOfCompute = worker.signProofOfCompute(shard.shardId, execRes.output, options.hmacSecret);
  const executionTimeMs = options.executionTimeMs !== undefined ? options.executionTimeMs : Math.max(1, execRes.executionTimeMs || 1);
  const inputSize = options.inputSize !== undefined ? options.inputSize : inputData.length;

  return {
    shard,
    params: {
      requesterId,
      workerId: worker.nodeId,
      shardId: shard.shardId,
      resultData: execRes.output,
      proofOfCompute,
      executionMetrics: {
        executionTimeMs,
        inputSize,
        ...(options.complexityFactor !== undefined ? { complexityFactor: options.complexityFactor } : {})
      },
      workerPublicKey: worker.publicKey,
      ...(options.hmacSecret !== undefined ? { hmacSecret: options.hmacSecret } : {}),
      ...(options.attestationNonce !== undefined ? { attestationNonce: options.attestationNonce } : {})
    }
  };
}

async function createSeaWithWorkers(seaOptions = {}, workerSpecs = []) {
  const tcpAllowed = await probeLoopbackTcpAllowed();
  const useP2P = seaOptions.enableP2P !== undefined ? Boolean(seaOptions.enableP2P) : true;

  const coordP2POptions = useP2P && !tcpAllowed
    ? { ipcPath: makeUniqueIpcPath('coord'), ...(seaOptions.p2pOptions || {}) }
    : (seaOptions.p2pOptions || {});

  const sea = new ComputeSea({
    ...seaOptions,
    ...(useP2P ? { p2pOptions: coordP2POptions } : {})
  });

  await sea.start();
  const workers = [];
  for (let i = 0; i < workerSpecs.length; i++) {
    const spec = workerSpecs[i] || {};
    const workerUsesP2P = spec.useP2P !== undefined ? Boolean(spec.useP2P) : useP2P;
    const workerP2POptions = workerUsesP2P && !tcpAllowed
      ? { ipcPath: makeUniqueIpcPath(`worker-${i}`), ...(spec.p2pOptions || {}) }
      : (spec.p2pOptions || {});

    const handle = await sea.addLocalWorker({
      ...spec,
      useP2P: workerUsesP2P,
      ...(workerUsesP2P ? { p2pOptions: workerP2POptions } : {})
    });
    workers.push(handle);
  }

  return { sea, workers, transport: !useP2P ? 'loopback' : (tcpAllowed ? 'tcp' : 'ipc') };
}

function waitForCondition(predicate, timeoutMs = 3000, intervalMs = 15) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tick() {
      let ok;
      try {
        ok = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (ok) {
        resolve(ok);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    }
    tick();
  });
}

// ============================================================================
// Feature 29: Proof-of-Compute Work Metering
// ============================================================================
describe('Milestone 6 (F29): Proof-of-Compute Work Metering', () => {
  test('F29.01: calculateCredit() is deterministic and proportional to executionTimeMs and inputSize', () => {
    const ledgerA = new ProofOfComputeLedger();
    const ledgerB = new ProofOfComputeLedger();

    // Determinism across calls and instances
    const cost1 = ledgerA.calculateCredit(125.5, 42);
    const cost2 = ledgerA.calculateCredit(125.5, 42);
    const cost3 = ledgerB.calculateCredit(125.5, 42);
    assert.strictEqual(cost1, cost2);
    assert.strictEqual(cost1, cost3);
    assert.strictEqual(cost1, 14.65); // 125.5 * 0.1 + 42 * 0.05 = 12.55 + 2.1 = 14.65

    // Zero work & zero complexity yield 0 cost
    assert.strictEqual(ledgerA.calculateCredit(0, 0), 0);
    assert.strictEqual(ledgerA.calculateCredit(250, 100, 0), 0);

    // Minimum cost floor applied for tiny non-zero work
    assert.strictEqual(ledgerA.calculateCredit(1, 1), 1);

    // Monotonic proportionality to executionTimeMs (baseRatePerMs = 0.1)
    const t20 = ledgerA.calculateCredit(20, 0);
    const t100 = ledgerA.calculateCredit(100, 0);
    const t500 = ledgerA.calculateCredit(500, 0);
    assert.strictEqual(t20, 2);
    assert.strictEqual(t100, 10);
    assert.strictEqual(t500, 50);
    assert.strictEqual(t100 / t20, 5);
    assert.strictEqual(t500 / t100, 5);

    // Monotonic proportionality to inputSize (byteWeight = 0.05)
    const s40 = ledgerA.calculateCredit(0, 40);
    const s200 = ledgerA.calculateCredit(0, 200);
    const s1000 = ledgerA.calculateCredit(0, 1000);
    assert.strictEqual(s40, 2);
    assert.strictEqual(s200, 10);
    assert.strictEqual(s1000, 50);
    assert.strictEqual(s200 / s40, 5);
    assert.strictEqual(s1000 / s200, 5);

    // Complexity multiplier & custom metering rates & fractional ms (T2.F29.02)
    assert.strictEqual(ledgerA.calculateCredit(100, 100, 2), 30);

    const fractionalLedger = new ProofOfComputeLedger({
      baseRatePerMs: 0.1,
      byteWeight: 0.05,
      minCost: 0
    });
    assert.strictEqual(fractionalLedger.calculateCredit(0.0001, 0), 0.00001);
    assert.strictEqual(fractionalLedger.calculateCredit(1e-9, 0), 0.000001); // non-zero work floors at 1 micro-credit

    // Ceiling caps (T2.F29.03)
    assert.strictEqual(ledgerA.calculateCredit(1_000_000_000, 0), ledgerA.calculateCredit(1500, 0));
    assert.strictEqual(ledgerA.calculateCredit(1_000_000_000, 0), 150);
    assert.strictEqual(ledgerA.calculateCredit(0, 1_000_000_000), ledgerA.calculateCredit(0, 10_000_000));
    assert.strictEqual(ledgerA.calculateCredit(0, 1_000_000_000), 500_000);

    const customCapped = new ProofOfComputeLedger({
      baseRatePerMs: 0.25,
      byteWeight: 0.1,
      minCost: 0.5,
      maxExecutionMs: 200,
      maxInputSize: 500
    });
    assert.strictEqual(customCapped.calculateCredit(1, 1), 0.5);
    assert.strictEqual(customCapped.calculateCredit(999, 9999), 200 * 0.25 + 500 * 0.1);
  });

  test('F29.02 / T2.F29.01 / T2.F29.05: rejects negative, NaN, Infinity, and non-numeric metrics fail-closed', () => {
    const ledger = new ProofOfComputeLedger();

    // Constructor option bounds
    for (const badRate of [0, -0.1, NaN, Infinity, -Infinity]) {
      assert.throws(() => new ProofOfComputeLedger({ baseRatePerMs: badRate }), RangeError);
      assert.throws(() => new ProofOfComputeLedger({ maxExecutionMs: badRate }), RangeError);
      assert.throws(() => new ProofOfComputeLedger({ maxInputSize: badRate }), RangeError);
    }
    for (const badNonNeg of [-1, -0.000001, NaN, Infinity, -Infinity]) {
      assert.throws(() => new ProofOfComputeLedger({ byteWeight: badNonNeg }), RangeError);
      assert.throws(() => new ProofOfComputeLedger({ minCost: badNonNeg }), RangeError);
    }

    // Negative / NaN / Infinity -> RangeError on calculateCredit
    const badRangeValues = [-1, -50, -0.000001, NaN, Infinity, -Infinity];
    for (const bad of badRangeValues) {
      assert.throws(() => ledger.calculateCredit(bad, 10), RangeError);
      assert.throws(() => ledger.calculateCredit(10, bad), RangeError);
      assert.throws(() => ledger.calculateCredit(10, 10, bad), RangeError);
    }

    // Non-numeric arguments -> TypeError on calculateCredit
    const badTypeValues = ['10', 'fast', null, undefined, {}, [], true, 10n];
    for (const bad of badTypeValues) {
      assert.throws(() => ledger.calculateCredit(bad, 10), TypeError);
      assert.throws(() => ledger.calculateCredit(10, bad), TypeError);
      if (bad !== undefined) {
        assert.throws(() => ledger.calculateCredit(10, 10, bad), TypeError);
      }
    }

    // verifyAndSettle must also reject bad executionMetrics with zero state mutation
    const requester = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    ledger.createAccount(requester.nodeId, 100);
    const snapBefore = snapshotLedgerState(ledger);

    const { params } = makeSignedShardClaim(worker, requester.nodeId, 'return data.map(x => x + 1);', [1, 2, 3]);

    for (const badExecTime of [-1, -50, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: badExecTime, inputSize: 3 } }),
        RangeError
      );
    }
    for (const badInputSize of [-1, -100, NaN, Infinity, -Infinity]) {
      assert.throws(
        () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: 10, inputSize: badInputSize } }),
        RangeError
      );
    }
    assert.throws(
      () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: '10', inputSize: 3 } }),
      TypeError
    );
    assert.throws(
      () => ledger.verifyAndSettle({ ...params, executionMetrics: null }),
      TypeError
    );

    assertLedgerStateUnchanged(ledger, snapBefore, 'after invalid executionMetrics rejections');
  });

  test('F29.03 / T2.F29.04: rejects inflated inputSize claims and aborted/failed shards with zero balance changes', () => {
    const ledger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    ledger.createAccount(requester.nodeId, 500);
    const snapBefore = snapshotLedgerState(ledger);

    const inputData = [10, 20];
    const { shard, params } = makeSignedShardClaim(worker, requester.nodeId, 'return data.reduce((a, b) => a + b, 0);', inputData);

    // Inflated inputSize vs expectedInputSize
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        expectedInputSize: 2,
        executionMetrics: { executionTimeMs: 10, inputSize: 1_000_000 }
      }),
      RangeError
    );

    // Inflated inputSize vs shard.inputData (exceeds both item count and UTF-8 JSON byte length)
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        shard,
        executionMetrics: { executionTimeMs: 10, inputSize: 10_000 }
      }),
      RangeError
    );

    // Aborted / failed settlements produce zero cost and do not burn attestation key
    for (const failFlags of [{ aborted: true }, { status: 'FAILED' }, { status: 'ABORTED' }]) {
      const res = ledger.verifyAndSettle({ ...params, ...failFlags });
      assert.strictEqual(res.settled, false);
      assert.strictEqual(res.cost, 0);
      assert.strictEqual(res.requesterBalance, 500);
      assert.strictEqual(res.workerBalance, 0);
    }

    assertLedgerStateUnchanged(ledger, snapBefore, 'after inflated size and aborted rejections');
  });
});

// ============================================================================
// Feature 30: Anti-Replay Double-Spend Prevention & PoC Verification
// ============================================================================
describe('Milestone 6 (F30): Anti-Replay Double-Spend Prevention & PoC Verification', () => {
  test('F30.01: First valid settlement succeeds and duplicate attestation (including Buffer/case/cross-requester) fails closed', () => {
    const ledger = new ProofOfComputeLedger();
    const requesterA = new MeshCryptoEngine();
    const requesterB = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();

    ledger.createAccount(requesterA.nodeId, 200);
    ledger.createAccount(requesterB.nodeId, 200);

    let settledEvents = 0;
    ledger.on('settled', () => {
      settledEvents += 1;
    });

    const { params } = makeSignedShardClaim(
      worker,
      requesterA.nodeId,
      'return data.reduce((a, b) => a + b, 0);',
      [5, 15],
      { executionTimeMs: 50, inputSize: 2, attestationNonce: 'att-1' }
    );
    const expectedCost = ledger.calculateCredit(50, 2); // max(1, 5 + 0.1) = 5.1

    const res = ledger.verifyAndSettle(params);
    assert.strictEqual(res.settled, true);
    assert.strictEqual(res.cost, expectedCost);
    assert.strictEqual(res.requesterBalance, 194.9);
    assert.strictEqual(res.workerBalance, 5.1);
    assert.strictEqual(settledEvents, 1);

    const expectedKey = ledger.computeAttestationKey(params.shardId, worker.nodeId, params.proofOfCompute);
    assert.strictEqual(res.attestationHash, expectedKey);
    assert.strictEqual(ledger.hasSettledAttestation(expectedKey), true);
    assert.strictEqual(ledger.accounts.get(requesterA.nodeId).totalSpent, 5.1);
    assert.strictEqual(ledger.accounts.get(worker.nodeId).totalEarned, 5.1);

    const snapAfterFirst = snapshotLedgerState(ledger);

    // 1. Exact replay throws DoubleSpendAttemptError
    assert.throws(
      () => ledger.verifyAndSettle(params),
      (err) => err instanceof DoubleSpendAttemptError && err.code === 'ERR_DOUBLE_SPEND'
    );

    // 2. Uppercase / Buffer encoding of the exact same PoC signature still triggers replay rejection
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        proofOfCompute: params.proofOfCompute.toUpperCase(),
        attestationNonce: 'att-upper'
      }),
      DoubleSpendAttemptError
    );
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        proofOfCompute: Buffer.from(params.proofOfCompute, 'hex'),
        attestationNonce: 'att-buf'
      }),
      DoubleSpendAttemptError
    );

    // 3. Cross-requester replay attempt even with different attestationNonce fails closed
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        requesterId: requesterB.nodeId,
        attestationNonce: 'att-cross-req'
      }),
      DoubleSpendAttemptError
    );

    // 4. Non-throwing mode returns settled: false with zero balance mutation
    const nonThrowReplay = ledger.verifyAndSettle({
      ...params,
      throwOnReplay: false,
      throwOnError: false
    });
    assert.strictEqual(nonThrowReplay.settled, false);
    assert.strictEqual(nonThrowReplay.cost, 0);
    assert.match(nonThrowReplay.error, /double-spend|already settled/i);

    assertLedgerStateUnchanged(ledger, snapAfterFirst, 'after replay attempts');
    assert.strictEqual(ledger.getBalance(requesterB.nodeId), 200);
  });

  test('F30.02 / T2.F30.01 / T2.F30.02: enforces per-worker attestationNonce uniqueness, concurrency burst safety, and persistence across reload', async () => {
    const ledger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const worker1 = new MeshCryptoEngine();
    const worker2 = new MeshCryptoEngine();
    ledger.createAccount(requester.nodeId, 500);

    // Worker 1 settles shard 1 with attestationNonce 'nonce-shared'
    const claim1 = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x * 2);', [1, 2], {
      executionTimeMs: 20,
      attestationNonce: 'nonce-shared'
    });
    const r1 = ledger.verifyAndSettle(claim1.params);
    assert.strictEqual(r1.settled, true);

    const snapMid = snapshotLedgerState(ledger);

    // Worker 1 reusing 'nonce-shared' on a brand new valid shard fails closed
    const claim1DifferentShard = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x * 3);', [3, 4], {
      executionTimeMs: 20,
      attestationNonce: 'nonce-shared'
    });
    assert.throws(
      () => ledger.verifyAndSettle(claim1DifferentShard.params),
      DoubleSpendAttemptError
    );
    assertLedgerStateUnchanged(ledger, snapMid, 'after worker1 nonce reuse');

    // Different worker (worker2) using same nonce string succeeds independently
    const claim2 = makeSignedShardClaim(worker2, requester.nodeId, 'return data.map(x => x * 4);', [5, 6], {
      executionTimeMs: 20,
      attestationNonce: 'nonce-shared'
    });
    const r2 = ledger.verifyAndSettle(claim2.params);
    assert.strictEqual(r2.settled, true);

    // Numeric nonce 0 is valid once, rejected on reuse; malformed nonces rejected with TypeError
    const claimZeroNonce = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x + 9);', [7, 8], {
      executionTimeMs: 20,
      attestationNonce: 0
    });
    assert.strictEqual(ledger.verifyAndSettle(claimZeroNonce.params).settled, true);

    const claimZeroNonceReuse = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x + 10);', [7, 8], {
      executionTimeMs: 20,
      attestationNonce: 0
    });
    assert.throws(() => ledger.verifyAndSettle(claimZeroNonceReuse.params), DoubleSpendAttemptError);

    for (const badNonce of [-1, 1.5, '', '   ', null]) {
      assert.throws(
        () => ledger.verifyAndSettle({ ...claim1DifferentShard.params, attestationNonce: badNonce }),
        TypeError
      );
    }

    // Concurrent double-spend race burst (25 concurrent attempts with identical attestation)
    const burstClaim = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x + 5);', [11, 12], {
      executionTimeMs: 40,
      attestationNonce: 'burst-nonce-1'
    });
    const costBurst = ledger.calculateCredit(40, 2);
    const reqBalBeforeBurst = ledger.getBalance(requester.nodeId);
    const w1BalBeforeBurst = ledger.getBalance(worker1.nodeId);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 25 }, () => Promise.resolve().then(() => ledger.verifyAndSettle(burstClaim.params)))
    );
    const succeeded = outcomes.filter((o) => o.status === 'fulfilled' && o.value.settled === true);
    const rejected = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof DoubleSpendAttemptError);
    assert.strictEqual(succeeded.length, 1);
    assert.strictEqual(rejected.length, 24);
    assert.strictEqual(ledger.getBalance(requester.nodeId), Number((reqBalBeforeBurst - costBurst).toFixed(6)));
    assert.strictEqual(ledger.getBalance(worker1.nodeId), Number((w1BalBeforeBurst + costBurst).toFixed(6)));

    // Reload persisted snapshot into new ledger instance (T2.F30.02)
    const exportedJson = JSON.stringify(ledger.exportState());
    const reloaded = ProofOfComputeLedger.fromState(JSON.parse(exportedJson));
    assert.strictEqual(reloaded.verifyAuditLog().valid, true);
    assert.strictEqual(reloaded.getTotalBalance(), 500);
    assert.strictEqual(reloaded.getBalance(worker1.nodeId), ledger.getBalance(worker1.nodeId));

    const reloadedSnap = snapshotLedgerState(reloaded);
    // Previously settled attestation remains rejected after reload
    assert.throws(() => reloaded.verifyAndSettle(burstClaim.params), DoubleSpendAttemptError);
    // Previously used nonce remains rejected after reload even on new shard
    const postReloadSameNonce = makeSignedShardClaim(worker1, requester.nodeId, 'return data.map(x => x + 77);', [1, 2], {
      executionTimeMs: 20,
      attestationNonce: 'burst-nonce-1'
    });
    assert.throws(() => reloaded.verifyAndSettle(postReloadSameNonce.params), DoubleSpendAttemptError);
    assertLedgerStateUnchanged(reloaded, reloadedSnap, 'reloaded ledger rejects replays without mutating state');
  });

  test('F30.03 / T2.F30.03–05: forged, tampered, mismatched, malformed PoC signatures and self-settlement fail closed with zero balance changes', () => {
    const ledger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    const rogue = new MeshCryptoEngine();

    ledger.createAccount(requester.nodeId, 300);
    const snapBefore = snapshotLedgerState(ledger);

    const { shard, params } = makeSignedShardClaim(worker, requester.nodeId, 'return data.reduce((a, b) => a + b, 0);', [10, 20], {
      executionTimeMs: 30,
      attestationNonce: 'forged-check-1'
    });

    const invalidCases = [
      { label: 'bit-flipped signature', override: { proofOfCompute: flipLastHexByte(params.proofOfCompute) } },
      { label: 'wrong worker signer (rogue)', override: { proofOfCompute: rogue.signProofOfCompute(shard.shardId, params.resultData) } },
      { label: 'tampered resultData (T2.F30.03)', override: { resultData: 31 } },
      { label: 'tampered shardId (T2.F30.04)', override: { shardId: `${shard.shardId.slice(0, -1)}0` } },
      { label: 'wrong explicit hmacSecret (must not fall back to publicKey)', override: { hmacSecret: 'wrong-secret-key' } },
      { label: 'empty signature (T2.F30.05)', override: { proofOfCompute: '' } },
      { label: 'non-hex 64-char signature', override: { proofOfCompute: 'g'.repeat(64) } },
      { label: 'short signature', override: { proofOfCompute: 'abcd' } },
      { label: 'undefined proof', override: { proofOfCompute: undefined } },
      { label: 'null proof', override: { proofOfCompute: null } },
      { label: 'undefined resultData', override: { resultData: undefined } },
      { label: 'empty shardId', override: { shardId: '' } }
    ];

    for (const tc of invalidCases) {
      // Non-throwing default PoC behavior
      const nonThrow = ledger.verifyAndSettle({ ...params, ...tc.override });
      assert.strictEqual(nonThrow.settled, false, `${tc.label}: must not settle`);
      assert.strictEqual(nonThrow.cost, 0, `${tc.label}: cost must be 0`);
      assert.ok(typeof nonThrow.error === 'string' && nonThrow.error.length > 0);

      // Strict throwing mode
      assert.throws(
        () => ledger.verifyAndSettle({ ...params, ...tc.override, throwOnInvalidSignature: true }),
        Error,
        `${tc.label}: strict mode must throw`
      );
    }

    // Self-settlement fail-closed by default
    const selfSig = requester.signProofOfCompute(shard.shardId, params.resultData);
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        workerId: requester.nodeId,
        workerPublicKey: requester.publicKey,
        proofOfCompute: selfSig
      }),
      /Self-settlement/i
    );
    const nonThrowSelf = ledger.verifyAndSettle({
      ...params,
      workerId: requester.nodeId,
      workerPublicKey: requester.publicKey,
      proofOfCompute: selfSig,
      throwOnError: false
    });
    assert.strictEqual(nonThrowSelf.settled, false);
    assert.strictEqual(nonThrowSelf.cost, 0);

    assertLedgerStateUnchanged(ledger, snapBefore, 'after all forged/tampered/self-settle checks');

    // Also prove valid original claim STILL settles cleanly (failed PoC checks never poisoned nonce/replay state)
    const cleanRes = ledger.verifyAndSettle(params);
    assert.strictEqual(cleanRes.settled, true);
  });

  test('F30.04: rejects replayed, consumed, and cross-account escrows fail-closed with zero balance mutations', () => {
    const ledger = new ProofOfComputeLedger();
    const requesterA = new MeshCryptoEngine();
    const requesterB = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();

    ledger.createAccount(requesterA.nodeId, 200);
    ledger.createAccount(requesterB.nodeId, 200);

    const claim = makeSignedShardClaim(worker, requesterA.nodeId, 'return data.map(n => n + 1);', [1, 2], {
      executionTimeMs: 50,
      attestationNonce: 'escrow-replay-1'
    });

    const escrowA = ledger.reserveEscrow(requesterA.nodeId, 50, claim.shard.shardId);
    assert.strictEqual(escrowA.reserved, 50);

    // 1. Cross-account escrow usage rejected fail-closed
    assert.throws(
      () => ledger.verifyAndSettle({
        ...claim.params,
        requesterId: requesterB.nodeId,
        escrowId: escrowA.escrowId
      }),
      /Escrow ownership mismatch/i
    );
    assert.strictEqual(ledger.getBalance(requesterA.nodeId), 200);
    assert.strictEqual(ledger.getBalance(requesterB.nodeId), 200);

    // 2. Consume escrow legitimately
    const r1 = ledger.verifyAndSettle({ ...claim.params, escrowId: escrowA.escrowId });
    assert.strictEqual(r1.settled, true);

    const snapAfter = snapshotLedgerState(ledger);

    // 3. Replay of consumed escrowId fails closed even with fresh valid signature
    const claimNew = makeSignedShardClaim(worker, requesterA.nodeId, 'return data;', [3, 4], {
      executionTimeMs: 20,
      attestationNonce: 'escrow-replay-2'
    });
    assert.throws(
      () => ledger.verifyAndSettle({
        ...claimNew.params,
        escrowId: escrowA.escrowId
      }),
      /Invalid or already consumed escrowId/i
    );

    // 4. Nonce re-use on consumed escrow fails closed via DoubleSpendAttemptError
    assert.throws(
      () => ledger.verifyAndSettle({
        ...claimNew.params,
        escrowId: escrowA.escrowId,
        attestationNonce: 'escrow-replay-1'
      }),
      DoubleSpendAttemptError
    );

    assertLedgerStateUnchanged(ledger, snapAfter, 'after consumed escrow replay attempts');
  });

  test('F30.05: rejects invalid PoC payloads (malformed metrics, prototype pollution payloads, and status edge cases) fail-closed', () => {
    const ledger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    ledger.createAccount(requester.nodeId, 200);

    const { shard, params } = makeSignedShardClaim(worker, requester.nodeId, 'return data;', [1, 2], {
      executionTimeMs: 20,
      attestationNonce: 'payload-edge-1'
    });

    // 1. Missing executionMetrics object
    assert.throws(() => ledger.verifyAndSettle({ ...params, executionMetrics: undefined }), TypeError);
    assert.throws(() => ledger.verifyAndSettle({ ...params, executionMetrics: 'not-an-object' }), TypeError);

    // 2. Negative or non-numeric complexityFactor
    assert.throws(
      () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: 10, inputSize: 2, complexityFactor: -1 } }),
      RangeError
    );
    assert.throws(
      () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: 10, inputSize: 2, complexityFactor: 0 } }),
      RangeError
    );
    assert.throws(
      () => ledger.verifyAndSettle({ ...params, executionMetrics: { executionTimeMs: 10, inputSize: 2, complexityFactor: NaN } }),
      RangeError
    );

    // 3. Prototype pollution in resultData does not pollute ledger prototypes
    const pollutionResult = JSON.parse('{"__proto__":{"polluted":true},"value":42}');
    const cleanProof = worker.signProofOfCompute(shard.shardId, pollutionResult);
    const pollClaim = {
      ...params,
      resultData: pollutionResult,
      proofOfCompute: cleanProof,
      attestationNonce: 'pollute-nonce'
    };
    const pollRes = ledger.verifyAndSettle(pollClaim);
    assert.strictEqual(pollRes.settled, true);
    assert.strictEqual(Object.prototype.polluted, undefined, 'Object.prototype must not be polluted');
    assert.strictEqual({}.polluted, undefined);

    // 4. Aborted status edge cases
    const failRes = ledger.verifyAndSettle({ ...params, aborted: true, attestationNonce: 'aborted-nonce' });
    assert.strictEqual(failRes.settled, false);
    assert.strictEqual(failRes.cost, 0);

    // 5. throwOnError: false returns cleanly on signature failure
    const badSigNonThrow = ledger.verifyAndSettle({
      ...params,
      proofOfCompute: 'f'.repeat(64),
      throwOnError: false
    });
    assert.strictEqual(badSigNonThrow.settled, false);
    assert.strictEqual(badSigNonThrow.cost, 0);
    assert.ok(typeof badSigNonThrow.error === 'string');

    assert.strictEqual(ledger.getBalance(requester.nodeId) < 200, true);
    assert.strictEqual(ledger.verifyAuditLog().valid, true);
  });
});

// ============================================================================
// Feature 31: Fail-Closed Balance Enforcement, Conservation & Audit Chain
// ============================================================================
describe('Milestone 6 (F31): Fail-Closed Balance Enforcement, Conservation & Audit Chain', () => {
  test('F31.01 / T2.F31.01–02 / T2.F31.04: rejects unknown, zero, insufficient, and escrow-blocked balances fail-closed (never negative)', () => {
    const ledger = new ProofOfComputeLedger();
    const unknownReq = new MeshCryptoEngine();
    const poorReq = new MeshCryptoEngine();
    const zeroReq = new MeshCryptoEngine();
    const escrowReq = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();

    ledger.createAccount(zeroReq.nodeId, 0);
    // Compute cost = 50 (500ms * 0.1 = 50)
    const exactClaim = makeSignedShardClaim(worker, poorReq.nodeId, 'return data.reduce((a, b) => a + b, 0);', [1, 2], {
      executionTimeMs: 500,
      inputSize: 0,
      attestationNonce: 'poor-req-nonce'
    });
    assert.strictEqual(ledger.calculateCredit(500, 0), 50);

    // 1. Unknown requester account -> UnknownAccountError, zero mutations
    assert.strictEqual(ledger.getBalance(unknownReq.nodeId), 0);
    assert.strictEqual(ledger.getAccount(unknownReq.nodeId), null);
    assert.strictEqual(ledger.canAfford(unknownReq.nodeId, 1), false);
    assert.throws(() => ledger.checkCreditAvailable(unknownReq.nodeId, 1), UnknownAccountError);
    assert.throws(() => ledger.debitAccount(unknownReq.nodeId, 1), UnknownAccountError);
    assert.throws(
      () => ledger.verifyAndSettle({ ...exactClaim.params, requesterId: unknownReq.nodeId }),
      UnknownAccountError
    );
    assert.strictEqual(ledger.getAccount(worker.nodeId), null);

    // 2. Zero balance requester -> InsufficientCreditBalanceError, never goes negative
    assert.throws(
      () => ledger.verifyAndSettle({ ...exactClaim.params, requesterId: zeroReq.nodeId }),
      InsufficientCreditBalanceError
    );
    const zeroNonThrow = ledger.verifyAndSettle({
      ...exactClaim.params,
      requesterId: zeroReq.nodeId,
      throwOnError: false
    });
    assert.strictEqual(zeroNonThrow.settled, false);
    assert.strictEqual(zeroNonThrow.cost, 0);
    assert.strictEqual(ledger.getBalance(zeroReq.nodeId), 0);

    // 3. Partial insufficient balance (49 and 49.999999 vs 50) -> fails closed, zero debited
    ledger.createAccount(poorReq.nodeId, 49.999999);
    assert.strictEqual(ledger.canAfford(poorReq.nodeId, 50), false);
    assert.throws(() => ledger.checkCreditAvailable(poorReq.nodeId, 50), InsufficientCreditBalanceError);
    assert.throws(() => ledger.debitAccount(poorReq.nodeId, 50), InsufficientCreditBalanceError);
    assert.throws(() => ledger.verifyAndSettle(exactClaim.params), InsufficientCreditBalanceError);
    assert.strictEqual(ledger.getBalance(poorReq.nodeId), 49.999999);
    assert.strictEqual(ledger.getBalance(worker.nodeId), 0);
    assert.strictEqual(ledger.auditLog.length, 0);

    // Topping up exact missing 0.000001 makes balance === 50 -> exact balance settles to 0 (T2.F31.01)
    ledger.creditAccount(poorReq.nodeId, 0.000001);
    assert.strictEqual(ledger.getBalance(poorReq.nodeId), 50);
    assert.strictEqual(ledger.canAfford(poorReq.nodeId, 50), true);

    const exactRes = ledger.verifyAndSettle(exactClaim.params);
    assert.strictEqual(exactRes.settled, true);
    assert.strictEqual(exactRes.cost, 50);
    assert.strictEqual(exactRes.requesterBalance, 0);
    assert.strictEqual(exactRes.workerBalance, 50);
    assert.strictEqual(ledger.canAfford(poorReq.nodeId, 0.000001), false);

    // 4. Escrow reservation prevents unescrowed overspend, yet unlocks tied settlement cleanly
    ledger.createAccount(escrowReq.nodeId, 100);
    const reservedShardClaim = makeSignedShardClaim(worker, escrowReq.nodeId, 'return data.map(x => x * 2);', [2, 4], {
      executionTimeMs: 600,
      inputSize: 0,
      attestationNonce: 'escrow-shard'
    });
    const escrow = ledger.reserveEscrow(escrowReq.nodeId, 80, reservedShardClaim.shard.shardId);
    assert.strictEqual(escrow.reserved, 80);
    assert.strictEqual(escrow.availableBalance, 20);
    assert.strictEqual(ledger.canAfford(escrowReq.nodeId, 20), true);
    assert.strictEqual(ledger.canAfford(escrowReq.nodeId, 21), false);

    // Unrelated shard costing 30 fails closed because availableBalance is 20
    const unescrowedClaim = makeSignedShardClaim(worker, escrowReq.nodeId, 'return data.map(x => x + 1);', [9, 10], {
      executionTimeMs: 300,
      inputSize: 0,
      attestationNonce: 'unescrowed-shard'
    });
    assert.throws(() => ledger.verifyAndSettle(unescrowedClaim.params), InsufficientCreditBalanceError);
    assert.strictEqual(ledger.getBalance(escrowReq.nodeId), 100);

    // Escrow-bound shard costing 60 succeeds and consumes escrow atomically
    const escrowSettled = ledger.verifyAndSettle({ ...reservedShardClaim.params, escrowId: escrow.escrowId });
    assert.strictEqual(escrowSettled.settled, true);
    assert.strictEqual(escrowSettled.cost, 60);
    assert.strictEqual(ledger.getAccount(escrowReq.nodeId).balance, 40);
    assert.strictEqual(ledger.getAccount(escrowReq.nodeId).reserved, 0);
    assert.strictEqual(ledger.getTotalReserved(), 0);
    assert.throws(() => ledger.releaseEscrow(escrow.escrowId), RangeError); // already released
  });

  test('F31.02 / T2.F31.05: rejects negative, NaN, Infinity, non-numeric funding and MAX_SAFE_INTEGER credit overflow', () => {
    const ledger = new ProofOfComputeLedger();
    ledger.createAccount('req-valid', 25);
    const snapBefore = snapshotLedgerState(ledger);

    for (const badAmount of [-1, -0.000001, -1000, NaN, Infinity, -Infinity]) {
      assert.throws(() => ledger.creditAccount('req-valid', badAmount), RangeError);
      assert.throws(() => ledger.creditAccount('ghost-new-account', badAmount), RangeError);
      assert.throws(() => ledger.createAccount('another-new', badAmount), RangeError);
    }

    for (const badType of ['10', null, undefined, {}, [], true, 10n]) {
      assert.throws(() => ledger.creditAccount('req-valid', badType), TypeError);
      if (badType !== undefined) {
        assert.throws(() => ledger.createAccount('bad-type-acc', badType), TypeError);
      }
    }

    // Duplicate createAccount & blank nodeIds rejected
    assert.throws(() => ledger.createAccount('req-valid', 10), /already exists/i);
    assert.throws(() => ledger.createAccount('', 10), TypeError);
    assert.throws(() => ledger.creditAccount('   ', 10), TypeError);

    assertLedgerStateUnchanged(ledger, snapBefore, 'after negative/invalid funding attempts');

    // CreditOverflowError on creditAccount and verifyAndSettle exceeding MAX_SAFE_INTEGER
    ledger.createAccount('whale-req', 100);
    ledger.createAccount('whale-worker', Number.MAX_SAFE_INTEGER - 2);
    assert.throws(
      () => ledger.creditAccount('whale-worker', 5),
      (err) => err instanceof CreditOverflowError && err.code === 'ERR_CREDIT_OVERFLOW'
    );
    assert.strictEqual(ledger.getBalance('whale-worker'), Number.MAX_SAFE_INTEGER - 2);

    const whaleCrypto = new MeshCryptoEngine();
    const { params } = makeSignedShardClaim(whaleCrypto, 'whale-req', 'return data;', [1, 2], {
      executionTimeMs: 50,
      inputSize: 0
    });
    assert.throws(
      () => ledger.verifyAndSettle({
        ...params,
        workerId: 'whale-worker',
        workerPublicKey: whaleCrypto.publicKey,
        proofOfCompute: whaleCrypto.signProofOfCompute(params.shardId, params.resultData)
      }),
      CreditOverflowError
    );
    assert.strictEqual(ledger.getBalance('whale-req'), 100);
    assert.strictEqual(ledger.getBalance('whale-worker'), Number.MAX_SAFE_INTEGER - 2);
  });

  test('F31.03 / T2.F31.03: enforces exact credit conservation (sumBefore === sumAfter) across 30 settlements and prevents float drift', () => {
    // 1. Exact decimal precision (no 0.1 + 0.2 !== 0.3 IEEE-754 drift)
    const fracLedger = new ProofOfComputeLedger({
      baseRatePerMs: 0.1,
      byteWeight: 0,
      minCost: 0
    });
    const reqFrac = new MeshCryptoEngine();
    const wFrac = new MeshCryptoEngine();
    fracLedger.createAccount(reqFrac.nodeId, 0.3);

    const s1 = makeSignedShardClaim(wFrac, reqFrac.nodeId, 'return data;', [1], { executionTimeMs: 1, inputSize: 0 });
    const s2 = makeSignedShardClaim(wFrac, reqFrac.nodeId, 'return data;', [2], { executionTimeMs: 2, inputSize: 0 });
    const r1 = fracLedger.verifyAndSettle(s1.params);
    const r2 = fracLedger.verifyAndSettle(s2.params);

    assert.strictEqual(r1.cost, 0.1);
    assert.strictEqual(r2.cost, 0.2);
    assert.strictEqual(fracLedger.getBalance(reqFrac.nodeId), 0);
    assert.strictEqual(fracLedger.getBalance(wFrac.nodeId), 0.3);
    assert.strictEqual(fracLedger.getTotalBalance(), 0.3);

    // 2. Multi-party 30 sequential settlements + interleaved failures conservation test
    const ledger = new ProofOfComputeLedger({ baseRatePerMs: 0.1, byteWeight: 0.05, minCost: 1 });
    const requesters = [new MeshCryptoEngine(), new MeshCryptoEngine(), new MeshCryptoEngine()];
    const workers = [new MeshCryptoEngine(), new MeshCryptoEngine(), new MeshCryptoEngine(), new MeshCryptoEngine()];

    const initialFunding = new Map([
      [requesters[0].nodeId, 1234.567891],
      [requesters[1].nodeId, 500.1],
      [requesters[2].nodeId, 250.2],
      [workers[0].nodeId, 10.132109],
      [workers[1].nodeId, 0],
      [workers[2].nodeId, 4.999999],
      [workers[3].nodeId, 0.000001]
    ]);

    for (const [id, amt] of initialFunding.entries()) {
      ledger.createAccount(id, amt);
    }

    const expectedTotalCredits = ledger.getTotalBalance();
    assert.strictEqual(expectedTotalCredits, 2000);

    for (let i = 0; i < 30; i++) {
      const req = requesters[i % requesters.length];
      const w = workers[i % workers.length];
      const payload = [i + 1, i + 2, (i % 5) + 1];
      const execMs = Number((5 + (i * 1.37)).toFixed(3));

      const claim = makeSignedShardClaim(w, req.nodeId, `return data.map(n => n + ${i});`, payload, {
        executionTimeMs: execMs,
        inputSize: payload.length,
        complexityFactor: (i % 3) + 1,
        attestationNonce: `seq-${i}`
      });

      const res = ledger.verifyAndSettle(claim.params);
      assert.strictEqual(res.settled, true);

      // Periodically inject failed replay & forged signature between real settlements
      if (i % 5 === 0) {
        assert.throws(() => ledger.verifyAndSettle(claim.params), DoubleSpendAttemptError);
        const forged = ledger.verifyAndSettle({ ...claim.params, proofOfCompute: flipLastHexByte(claim.params.proofOfCompute) });
        assert.strictEqual(forged.settled, false);
      }

      // Conservation invariant holds after EVERY single step
      assert.strictEqual(ledger.getTotalBalance(), expectedTotalCredits);
      let manualMicroSum = 0n;
      let spentMicro = 0n;
      let earnedMicro = 0n;
      for (const acc of ledger.accounts.values()) {
        assert.ok(acc.balance >= 0, `Negative balance detected for ${acc.nodeId}: ${acc.balance}`);
        manualMicroSum += BigInt(Math.round(acc.balance * 1_000_000));
        spentMicro += BigInt(Math.round(acc.totalSpent * 1_000_000));
        earnedMicro += BigInt(Math.round(acc.totalEarned * 1_000_000));

        const fundedMicro = BigInt(Math.round((initialFunding.get(acc.nodeId) || 0) * 1_000_000));
        const accMicro = BigInt(Math.round(acc.balance * 1_000_000));
        const accEarned = BigInt(Math.round(acc.totalEarned * 1_000_000));
        const accSpent = BigInt(Math.round(acc.totalSpent * 1_000_000));
        assert.strictEqual(accMicro, fundedMicro + accEarned - accSpent);
      }
      assert.strictEqual(Number(manualMicroSum) / 1_000_000, expectedTotalCredits);
      assert.strictEqual(spentMicro, earnedMicro);
    }

    assert.strictEqual(ledger.auditLog.length, 30);
    assert.strictEqual(ledger.verifyAuditLog().valid, true);
  });

  test('F31.04: verifies hash-chained audit trail integrity, entry freezing, and tamper detection', () => {
    const ledger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const worker = new MeshCryptoEngine();
    ledger.createAccount(requester.nodeId, 500);

    for (let i = 0; i < 6; i++) {
      const claim = makeSignedShardClaim(worker, requester.nodeId, `return data.map(n => n * ${i + 1});`, [i + 1, i + 2], {
        executionTimeMs: 10 + i * 5,
        attestationNonce: `audit-${i}`
      });
      assert.strictEqual(ledger.verifyAndSettle(claim.params).settled, true);
    }

    const GENESIS = '0'.repeat(64);
    assert.strictEqual(ledger.auditLog.length, 6);
    assert.strictEqual(ledger.auditLog[0].prevHash, GENESIS);

    for (let i = 0; i < ledger.auditLog.length; i++) {
      const entry = ledger.auditLog[i];
      assert.strictEqual(Object.isFrozen(entry), true);
      assert.strictEqual(entry.index, i);
      assert.strictEqual(entry.type, 'SETTLEMENT');
      if (i > 0) {
        assert.strictEqual(entry.prevHash, ledger.auditLog[i - 1].hash);
      }
      const { hash, ...body } = entry;
      const expectedDigest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
      assert.strictEqual(hash, expectedDigest);
    }

    assert.deepStrictEqual(ledger.verifyAuditLog(), { valid: true, length: 6 });

    // Tamper test 1: alter cost inside an exported snapshot -> digest mismatch caught
    const tamperedSnapCost = JSON.parse(JSON.stringify(ledger.exportState()));
    tamperedSnapCost.auditLog[2].cost += 999;
    const tamperedLedgerCost = ProofOfComputeLedger.fromState(tamperedSnapCost);
    const checkCost = tamperedLedgerCost.verifyAuditLog();
    assert.strictEqual(checkCost.valid, false);
    assert.match(checkCost.error, /digest mismatch/i);

    // Tamper test 2: alter prevHash chain -> broken prevHash caught
    const tamperedSnapChain = JSON.parse(JSON.stringify(ledger.exportState()));
    tamperedSnapChain.auditLog[4].prevHash = 'f'.repeat(64);
    const tamperedLedgerChain = ProofOfComputeLedger.fromState(tamperedSnapChain);
    const checkChain = tamperedLedgerChain.verifyAuditLog();
    assert.strictEqual(checkChain.valid, false);
    assert.match(checkChain.error, /prevHash chain broken/i);
  });

  test('F31.05: Chain split simulation — detects divergent audit forks from common ancestor and isolates branched histories', () => {
    // 1. Establish common ancestor state
    const baseLedger = new ProofOfComputeLedger();
    const requester = new MeshCryptoEngine();
    const workerA = new MeshCryptoEngine();
    const workerB = new MeshCryptoEngine();
    baseLedger.createAccount(requester.nodeId, 500);

    for (let i = 0; i < 3; i++) {
      const claim = makeSignedShardClaim(workerA, requester.nodeId, `return data.map(n => n + ${i});`, [i, i + 1], {
        executionTimeMs: 20,
        attestationNonce: `ancestor-${i}`
      });
      assert.strictEqual(baseLedger.verifyAndSettle(claim.params).settled, true);
    }

    assert.strictEqual(baseLedger.auditLog.length, 3);
    const commonAncestorHash = baseLedger.auditLog[2].hash;

    // 2. Network partition occurs: fork into Branch A and Branch B
    const forkA = ProofOfComputeLedger.fromState(baseLedger.exportState());
    const forkB = ProofOfComputeLedger.fromState(baseLedger.exportState());

    // Branch A settles Shard 4A with Worker A
    const claimA = makeSignedShardClaim(workerA, requester.nodeId, 'return data.map(n => n * 2);', [10, 20], {
      executionTimeMs: 25,
      attestationNonce: 'fork-A-nonce'
    });
    const resA = forkA.verifyAndSettle(claimA.params);
    assert.strictEqual(resA.settled, true);

    // Branch B settles Shard 4B with Worker B
    const claimB = makeSignedShardClaim(workerB, requester.nodeId, 'return data.map(n => n * 3);', [30, 40], {
      executionTimeMs: 30,
      attestationNonce: 'fork-B-nonce'
    });
    const resB = forkB.verifyAndSettle(claimB.params);
    assert.strictEqual(resB.settled, true);

    // 3. Chain split verification:
    // Both branches advanced to index 3 with the exact same prevHash (the common ancestor)
    assert.strictEqual(forkA.auditLog[3].prevHash, commonAncestorHash);
    assert.strictEqual(forkB.auditLog[3].prevHash, commonAncestorHash);

    // The block digests diverged deterministically
    assert.notStrictEqual(forkA.auditLog[3].hash, forkB.auditLog[3].hash);
    assert.notStrictEqual(forkA.getBalance(requester.nodeId), forkB.getBalance(requester.nodeId));

    // Both chains are internally valid
    assert.deepStrictEqual(forkA.verifyAuditLog(), { valid: true, length: 4 });
    assert.deepStrictEqual(forkB.verifyAuditLog(), { valid: true, length: 4 });

    // 4. Cross-branch collision prevention:
    // Attempting to append Branch B's divergent entry onto Fork A breaks the hash chain
    const corruptedChain = JSON.parse(JSON.stringify(forkA.exportState()));
    corruptedChain.auditLog.push({ ...forkB.auditLog[3], index: 4, prevHash: forkA.auditLog[3].hash });
    const badLedger = ProofOfComputeLedger.fromState(corruptedChain);
    const verifyRes = badLedger.verifyAuditLog();
    assert.strictEqual(verifyRes.valid, false);
    assert.match(verifyRes.error, /digest mismatch/i);
  });
});

// ============================================================================
// Feature 32: Unified Single Compute Sea E2E & Decision-Taking Under All Conditions
// ============================================================================
describe('Milestone 6 (F32): Unified Single Compute Sea E2E & Decision-Taking', () => {
  test('F32.01: E2E healthy peers executes partition -> HKDF-SHA512 encrypt -> sandbox -> PoC verify -> settle -> ordered aggregate', async () => {
    const caps = ComputeSea.getCapabilities();
    assert.strictEqual(caps.crypto, true);
    assert.strictEqual(caps.router, true);
    assert.strictEqual(caps.sandbox, true);
    assert.strictEqual(caps.p2p, true);
    assert.strictEqual(caps.ledger, true);
    assert.strictEqual(OpenSideProtocol, ComputeSea);

    const { sea, workers } = await createSeaWithWorkers(
      {
        enableLedger: true,
        initialBalance: 450,
        queueTimeoutMs: 3000
      },
      [
        { latencyMs: 5, capacityScore: 250, maxConcurrentShards: 2 },
        { latencyMs: 15, capacityScore: 180, maxConcurrentShards: 2 },
        { latencyMs: 25, capacityScore: 120, maxConcurrentShards: 2 }
      ]
    );

    try {
      // Verify repeated ComputeSea.fundAccount top-up integrates cleanly with creditAccount
      const toppedUp = sea.fundAccount(sea.nodeId, 50);
      assert.strictEqual(toppedUp, 500);
      assert.strictEqual(sea.ledger.getBalance(sea.nodeId), 500);

      let rotations = 0;
      sea.on('sessionRotated', () => {
        rotations += 1;
      });
      const prevEpoch = sea.sessionEpoch;
      const newEpoch = sea.rotateSessionKeys();
      assert.strictEqual(newEpoch, prevEpoch + 1);
      assert.strictEqual(rotations, 1);

      const dataset = [10, 20, 30, 40, 50, 60];
      const expected = dataset.map((n) => (n * n) + 42); // [142, 442, 942, 1642, 2542, 3642]

      const res = await sea.submitWorkload('return data.map(n => (n * n) + 42);', dataset, { chunkSize: 2 });

      assert.strictEqual(res.status, 'COMPLETED');
      assert.strictEqual(res.shardCount, 3);
      assert.deepStrictEqual(res.output, expected);
      assert.strictEqual(res.shards.length, 3);
      assert.strictEqual(res.proofs.length, 3);
      assert.strictEqual(res.settlements.length, 3);
      assert.ok(res.totalCost > 0);

      const workerById = new Map(workers.map((w) => [w.workerId, w]));
      const getPocSecretForWorker = (workerId) => {
        const w = workerById.get(workerId);
        const wireKey = sea.p2pNode && typeof sea.p2pNode.getSessionKey === 'function'
          ? sea.p2pNode.getSessionKey(workerId)
          : null;
        return wireKey || w.publicKey;
      };

      let sumWorkerEarnings = 0;
      for (const s of res.shards) {
        const w = workerById.get(s.workerId);
        assert.ok(w, `Shard executed on unknown worker ${s.workerId}`);
        const pocSecret = getPocSecretForWorker(s.workerId);
        assert.strictEqual(
          sea.crypto.verifyProofOfCompute(s.shardId, s.output, s.proofOfCompute, pocSecret),
          true
        );
      }

      for (const w of workers) {
        sumWorkerEarnings += sea.ledger.getBalance(w.workerId);
      }

      // Exact credit conservation in E2E ComputeSea execution
      assert.strictEqual(sea.ledger.getTotalBalance(), 500);
      assert.strictEqual(Number((500 - sea.ledger.getBalance(sea.nodeId)).toFixed(6)), Number(res.totalCost.toFixed(6)));
      assert.strictEqual(Number(sumWorkerEarnings.toFixed(6)), Number(res.totalCost.toFixed(6)));
      assert.deepStrictEqual(sea.ledger.verifyAuditLog(), { valid: true, length: 3 });

      // Attempting replay of an E2E settled shard PoC directly against sea.ledger must fail closed
      const firstShard = res.shards[0];
      assert.throws(
        () => sea.ledger.verifyAndSettle({
          requesterId: sea.nodeId,
          workerId: firstShard.workerId,
          shardId: firstShard.shardId,
          resultData: firstShard.output,
          proofOfCompute: firstShard.proofOfCompute,
          executionMetrics: { executionTimeMs: firstShard.executionTimeMs || 1, inputSize: 2 },
          workerPublicKey: workerById.get(firstShard.workerId).publicKey,
          hmacSecret: getPocSecretForWorker(firstShard.workerId)
        }),
        DoubleSpendAttemptError
      );
    } finally {
      await sea.close();
    }
  });

  test('F32.02: In-process HKDF-SHA512 cryptographic loopback with epoch auto-rotation executes multi-shard workloads & conserves credits', async () => {
    const { sea, workers } = await createSeaWithWorkers(
      {
        enableP2P: false,
        enableLedger: true,
        initialBalance: 300,
        rotateAfterShards: 2,
        queueTimeoutMs: 3000
      },
      [
        { latencyMs: 5, capacityScore: 200, maxConcurrentShards: 3 },
        { latencyMs: 10, capacityScore: 150, maxConcurrentShards: 3 }
      ]
    );

    try {
      // Also mix in a bare peer registered strictly with nodeId + publicKey
      const barePeer = new MeshCryptoEngine();
      sea.registerPeer(barePeer.nodeId, barePeer.publicKey, {
        standbyReady: true,
        latencyMs: 50,
        capacityScore: 80
      });

      const dataset = Array.from({ length: 20 }, (_, i) => i + 1);
      const expected = dataset.map((n) => n * 3 + 7);
      const startEpoch = sea.sessionEpoch;

      const res = await sea.submitWorkload('return data.map(n => (n * 3) + 7);', dataset, { chunkSize: 2 });
      assert.strictEqual(res.status, 'COMPLETED');
      assert.strictEqual(res.shardCount, 10);
      assert.deepStrictEqual(res.output, expected);
      assert.ok(sea.sessionEpoch > startEpoch, 'rotateAfterShards must advance HKDF session epoch');

      // Conservation & audit chain across all 10 loopback shards
      assert.strictEqual(sea.ledger.getTotalBalance(), 300);
      assert.deepStrictEqual(sea.ledger.verifyAuditLog(), { valid: true, length: 10 });
      assert.strictEqual(
        Number((300 - sea.ledger.getBalance(sea.nodeId)).toFixed(6)),
        Number(res.totalCost.toFixed(6))
      );

      // Verify returned shard proof signatures against their derived HKDF-SHA512 epoch keys (or bare peer key)
      const peerKeyMap = new Map(workers.map((w) => [w.workerId, w.publicKey]));
      peerKeyMap.set(barePeer.nodeId, barePeer.publicKey);
      for (const shard of res.shards) {
        const key = peerKeyMap.get(shard.workerId);
        assert.ok(key);
        let verified = false;
        let matchingSecret = null;
        if (shard.workerId === barePeer.nodeId) {
          verified = sea.crypto.verifyProofOfCompute(shard.shardId, shard.output, shard.proofOfCompute, key);
          matchingSecret = key;
        } else {
          for (let e = startEpoch; e <= sea.sessionEpoch; e++) {
            const candidateKey = sea.getSessionKey(shard.workerId, key, e);
            if (sea.crypto.verifyProofOfCompute(shard.shardId, shard.output, shard.proofOfCompute, candidateKey)) {
              verified = true;
              matchingSecret = candidateKey;
              break;
            }
          }
        }
        assert.strictEqual(verified, true, `PoC verification failed for loopback shard ${shard.shardId}`);
        assert.throws(
          () => sea.ledger.verifyAndSettle({
            requesterId: sea.nodeId,
            workerId: shard.workerId,
            shardId: shard.shardId,
            resultData: shard.output,
            proofOfCompute: shard.proofOfCompute,
            executionMetrics: { executionTimeMs: shard.executionTimeMs || 1, inputSize: 2 },
            workerPublicKey: key,
            ...(matchingSecret !== key ? { hmacSecret: matchingSecret } : {})
          }),
          DoubleSpendAttemptError
        );
      }
    } finally {
      await sea.close();
    }
  });

  test('F32.03: Fail-closed pre-dispatch balance check, AST sandbox guard, empty grid failClosed:true rejection, and empty dataset handling', async () => {
    // 1. Pre-dispatch insufficient balance & AST sandbox pre-validation rejections
    const { sea: brokeSea, workers: brokeWorkers } = await createSeaWithWorkers(
      { enableLedger: true, initialBalance: 2, queueTimeoutMs: 2000 },
      [{ latencyMs: 10, capacityScore: 100 }]
    );

    try {
      // Malicious code rejected pre-dispatch without spending any balance or touching workers
      const maliciousRes = await brokeSea.submitWorkload('return process.env;', [1, 2], { chunkSize: 2 });
      assert.strictEqual(maliciousRes.status, 'REJECTED');
      assert.strictEqual(maliciousRes.reason, 'SANDBOX_VALIDATION_FAILED');
      assert.strictEqual(brokeSea.ledger.getBalance(brokeSea.nodeId), 2);
      assert.strictEqual(brokeSea.ledger.auditLog.length, 0);

      const brokeRes = await brokeSea.submitWorkload('return data.map(n => n * 2);', [1, 2, 3, 4, 5, 6], { chunkSize: 2 });
      assert.strictEqual(brokeRes.status, 'REJECTED');
      assert.strictEqual(brokeRes.reason, 'INSUFFICIENT_CREDIT_BALANCE');
      assert.strictEqual(brokeRes.requiredCredit, 3); // 3 shards * minCost 1
      assert.strictEqual(brokeRes.availableCredit, 2);
      assert.strictEqual(brokeSea.ledger.getBalance(brokeSea.nodeId), 2);
      assert.strictEqual(brokeSea.ledger.getBalance(brokeWorkers[0].workerId), 0);
      assert.strictEqual(brokeSea.ledger.auditLog.length, 0);

      // Empty dataset finishes cleanly at 0 cost
      const emptyRes = await brokeSea.submitWorkload('return data;', []);
      assert.strictEqual(emptyRes.status, 'COMPLETED');
      assert.deepStrictEqual(emptyRes.output, []);
      assert.strictEqual(emptyRes.shardCount, 0);
      assert.strictEqual(emptyRes.totalCost, 0);
      assert.strictEqual(brokeSea.ledger.getBalance(brokeSea.nodeId), 2);
    } finally {
      await brokeSea.close();
    }

    // 2. Empty grid (no compute nodes) with failClosed: true
    const { sea: emptySea } = await createSeaWithWorkers({
      enableLedger: true,
      initialBalance: 100,
      queueTimeoutMs: 2000
    });

    try {
      const res = await emptySea.submitWorkload('return data.map(x => x + 1);', [10, 20, 30, 40], {
        chunkSize: 2,
        failClosed: true
      });
      assert.strictEqual(res.status, 'REJECTED');
      assert.strictEqual(res.reason, 'FAIL_CLOSED_NO_NODES');
      assert.strictEqual(emptySea.router.taskQueue.length, 0);
      assert.strictEqual(emptySea.ledger.getBalance(emptySea.nodeId), 100);
      assert.strictEqual(emptySea.ledger.auditLog.length, 0);
    } finally {
      await emptySea.close();
    }
  });

  test('F32.04: Empty grid queued mode (failClosed:false) holds shards safely and auto-drains 100% upon worker join', async () => {
    const sea = new ComputeSea({
      enableLedger: true,
      initialBalance: 250,
      queueTimeoutMs: 3000
    });

    try {
      await sea.start();
      const dataset = [11, 22, 33, 44, 55, 66];
      const queued = await sea.submitWorkload('return data.map(n => n * 10);', dataset, {
        chunkSize: 2,
        failClosed: false
      });

      assert.strictEqual(queued.status, 'QUEUED');
      assert.strictEqual(queued.reason, 'FAIL_CLOSED_NO_NODES');
      assert.strictEqual(queued.shardCount, 3);
      assert.strictEqual(queued.queuedCount, 3);
      assert.strictEqual(sea.router.taskQueue.length, 3);
      assert.ok(queued.completion && typeof queued.completion.then === 'function');

      // Dynamically join 2 default compute workers (auto TCP or automatic IPC fallback); router autoFlush drains all 3 shards
      const w1 = await sea.addLocalWorker({ latencyMs: 10, capacityScore: 200, maxConcurrentShards: 2 });
      const w2 = await sea.addLocalWorker({ latencyMs: 15, capacityScore: 150, maxConcurrentShards: 2 });

      const completed = await queued.completion;
      assert.strictEqual(completed.status, 'COMPLETED');
      assert.strictEqual(completed.shardCount, 3);
      assert.deepStrictEqual(completed.output, [110, 220, 330, 440, 550, 660]);
      assert.strictEqual(sea.router.taskQueue.length, 0);
      assert.strictEqual(sea.ledger.getTotalBalance(), 250);
      assert.ok(sea.ledger.getBalance(w1.workerId) + sea.ledger.getBalance(w2.workerId) > 0);
      assert.deepStrictEqual(sea.ledger.verifyAuditLog(), { valid: true, length: 3 });
    } finally {
      await sea.close();
    }
  });

  test('F32.05: Load-shedding (CPU>25%, Mem<10%), worker saturation, queued recovery, and bounded timeout', async () => {
    const { sea, workers } = await createSeaWithWorkers(
      {
        enableLedger: true,
        initialBalance: 400,
        queueTimeoutMs: 3000,
        telemetryPollIntervalMs: 15
      },
      [
        { latencyMs: 10, capacityScore: 150, cpuLoad: 0.42, freeMemRatio: 0.65, maxConcurrentShards: 1 },
        { latencyMs: 15, capacityScore: 150, cpuLoad: 0.10, freeMemRatio: 0.05, maxConcurrentShards: 1 }
      ]
    );

    try {
      // 1. All peers load-shedding -> failClosed: true rejects deterministically
      const rejShed = await sea.submitWorkload('return data.map(n => n + 1);', [1, 2, 3, 4], {
        chunkSize: 2,
        failClosed: true
      });
      assert.strictEqual(rejShed.status, 'REJECTED');
      assert.strictEqual(rejShed.reason, 'ALL_PEERS_BUSY_OR_SHEDDING');
      assert.strictEqual(sea.ledger.getBalance(sea.nodeId), 400);

      // 2. All peers load-shedding + returnOnQueue: true -> QUEUED then recovers cleanly
      const queuedShed = await sea.submitWorkload('return data.map(n => n + 1);', [1, 2, 3, 4, 5, 6], {
        chunkSize: 2,
        failClosed: false,
        returnOnQueue: true,
        deadlineMs: 3000
      });
      assert.strictEqual(queuedShed.status, 'QUEUED');
      assert.strictEqual(queuedShed.reason, 'ALL_PEERS_BUSY_OR_SHEDDING');
      assert.strictEqual(queuedShed.shardCount, 3);
      assert.strictEqual(queuedShed.queuedCount, 3);

      workers[0].setTelemetry({ cpuLoad: 0.10, freeMemRatio: 0.65 });
      workers[1].setTelemetry({ cpuLoad: 0.12, freeMemRatio: 0.60 });

      const recovered = await queuedShed.completion;
      assert.strictEqual(recovered.status, 'COMPLETED');
      assert.deepStrictEqual(recovered.output, [2, 3, 4, 5, 6, 7]);
      assert.strictEqual(sea.router.taskQueue.length, 0);

      // 3. Saturated busy grid (all peers above 25% CPU) -> waiting workload recovers when cooled
      workers[0].setTelemetry({ cpuLoad: 0.35, freeMemRatio: 0.65 });
      workers[1].setTelemetry({ cpuLoad: 0.40, freeMemRatio: 0.65 });

      const waitPromise = sea.submitWorkload('return data.map(n => n * 5);', [2, 4, 6, 8], {
        chunkSize: 2,
        failClosed: false,
        deadlineMs: 3000
      });

      const timer = setTimeout(() => {
        workers[0].setTelemetry({ cpuLoad: 0.15, freeMemRatio: 0.65 });
      }, 25);
      if (typeof timer.unref === 'function') timer.unref();

      const waitDone = await waitPromise;
      assert.strictEqual(waitDone.status, 'COMPLETED');
      assert.deepStrictEqual(waitDone.output, [10, 20, 30, 40]);

      // 4. Bounded deadlineMs timeout when peers stay unavailable (must not hang and must clean queue)
      workers[0].setTelemetry({ cpuLoad: 0.88, freeMemRatio: 0.65 });
      workers[1].setTelemetry({ cpuLoad: 0.90, freeMemRatio: 0.65 });

      const timeoutRes = await sea.submitWorkload('return data.map(n => n + 9);', [100, 200], {
        chunkSize: 2,
        failClosed: false,
        deadlineMs: 120
      });
      assert.strictEqual(timeoutRes.status, 'TIMEOUT');
      assert.strictEqual(timeoutRes.reason, 'QUEUE_TIMEOUT_PEERS_UNAVAILABLE');
      assert.strictEqual(sea.router.taskQueue.length, 0);
      assert.strictEqual(sea.ledger.getTotalBalance(), 400);
      assert.strictEqual(sea.ledger.verifyAuditLog().valid, true);
    } finally {
      await sea.close();
    }
  });

  test('F32.06: Bounded queue overflow, duplicate in-flight shard guard, mid-shard peer failover, and closed sea fail-closed', async () => {
    const sea = new ComputeSea({
      enableP2P: false,
      enableLedger: true,
      initialBalance: 500,
      routerOptions: { maxQueueSize: 2 },
      queueTimeoutMs: 3000
    });

    try {
      // 1. Bounded queue overflow rejected fail-closed without stalling router
      const overflowRes = await sea.submitWorkload('return data;', [1, 2, 3, 4, 5, 6], {
        chunkSize: 2,
        failClosed: false
      });
      assert.strictEqual(overflowRes.status, 'REJECTED');
      assert.strictEqual(overflowRes.reason, 'QUEUE_FULL');
      assert.strictEqual(sea.router.taskQueue.length, 0);

      // 2. Duplicate in-flight shard rejection & mid-shard failover via recoverable executor failure
      const failingWorker = new MeshCryptoEngine();
      const healthyWorker = new MeshCryptoEngine();
      let failWorkerCalled = 0;

      // Defer failing worker slightly so second concurrent submission collides in-flight
      let releaseFirst;
      const firstGate = new Promise((r) => {
        releaseFirst = r;
      });

      sea.registerPeer(failingWorker.nodeId, failingWorker.publicKey, {
        standbyReady: true,
        latencyMs: 5,
        capacityScore: 300,
        executor: async ({ shard }) => {
          failWorkerCalled += 1;
          await firstGate;
          const err = new Error('Simulated peer mid-shard disconnect');
          err.recoverable = true;
          throw err;
        }
      });

      const primaryPromise = sea.submitWorkload('return data.map(n => n * 2);', [7, 8], { chunkSize: 2 });
      await waitForCondition(() => failWorkerCalled === 1, 2000);

      // Identical task+dataset while in-flight is rejected cleanly
      const dupRes = await sea.submitWorkload('return data.map(n => n * 2);', [7, 8], { chunkSize: 2 });
      assert.strictEqual(dupRes.status, 'REJECTED');
      assert.strictEqual(dupRes.reason, 'DUPLICATE_INFLIGHT_SHARD');

      // Register healthy sibling worker, then fail the first worker -> auto-reschedules to healthy sibling
      const healthySandbox = new StandbySandbox();
      sea.registerPeer(healthyWorker.nodeId, healthyWorker.publicKey, {
        standbyReady: true,
        latencyMs: 20,
        capacityScore: 150,
        executor: async ({ shard }) => {
          const out = healthySandbox.executeIsolatedShard(shard);
          return {
            output: out.output,
            executionTimeMs: out.executionTimeMs,
            proofOfCompute: healthyWorker.signProofOfCompute(shard.shardId, out.output)
          };
        }
      });

      releaseFirst();
      const primaryOutcome = await primaryPromise;
      assert.strictEqual(primaryOutcome.status, 'COMPLETED');
      assert.deepStrictEqual(primaryOutcome.output, [14, 16]);
      assert.strictEqual(primaryOutcome.settlements.length, 1);
      assert.strictEqual(primaryOutcome.settlements[0].workerId, healthyWorker.nodeId);
      assert.strictEqual(sea.ledger.getBalance(failingWorker.nodeId), 0);
      assert.ok(sea.ledger.getBalance(healthyWorker.nodeId) > 0);
      assert.strictEqual(sea.ledger.getTotalBalance(), 500);
    } finally {
      await sea.close();
    }

    // 3. Closed ComputeSea fails closed on submitWorkload and addLocalWorker
    const closedRes = await sea.submitWorkload('return data;', [1, 2]);
    assert.strictEqual(closedRes.status, 'REJECTED');
    assert.strictEqual(closedRes.reason, 'COMPUTE_SEA_CLOSED');
    await assert.rejects(() => sea.addLocalWorker({ useP2P: false }), /closed/i);
  });

  test('F32.07: runProtocolSimulation() executes cleanly without throwing', () => {
    const origLog = console.log;
    const capturedLogs = [];
    console.log = (...args) => {
      capturedLogs.push(args.join(' '));
    };

    let simResult;
    try {
      assert.doesNotThrow(() => {
        simResult = runProtocolSimulation();
      });
    } finally {
      console.log = origLog;
    }

    assert.ok(simResult && typeof simResult === 'object');
    assert.strictEqual(simResult.ok, true);
    assert.strictEqual(simResult.shardCount, 2);
    assert.ok(simResult.telemetry && typeof simResult.telemetry.standbyReady === 'boolean');
    assert.ok(capturedLogs.some((line) => line.includes('[OK] Task Partition')));
  });
});
