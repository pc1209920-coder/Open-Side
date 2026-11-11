const test = require('node:test');
const assert = require('node:assert');
const { MeshCryptoEngine } = require('../src/crypto');
const { GridRouter } = require('../src/router');
const { StandbySandbox } = require('../src/sandbox');
const { P2PNode } = require('../src/node');
const { ProofOfComputeLedger, DoubleSpendAttemptError } = require('../src/ledger');
const { ComputeSea } = require('../src');

test('Phase 1.2: GridRouter audited refinements', () => {
  const router = new GridRouter('node-coord');

  // BigInt handling in createTaskPartitions
  const partitions = router.createTaskPartitions(
    'return data.map(x => x + 1n);',
    [10n, 20n, 30n, 40n],
    2
  );
  assert.strictEqual(partitions.length, 2);
  assert.strictEqual(typeof partitions[0].shardId, 'string');

  // aggregateResults boundary validation
  assert.throws(
    () => router.aggregateResults([], -1),
    RangeError
  );
  assert.throws(
    () => router.aggregateResults([], 1.5),
    RangeError
  );
  assert.throws(
    () => router.aggregateResults([{ index: 2, output: [1] }], 2),
    RangeError
  );

  // removeQueuedShard helper
  const task = partitions[0];
  router.taskQueue.push(task);
  assert.strictEqual(router.removeQueuedShard(task.shardId), task);
  assert.strictEqual(router.removeQueuedShard(task.shardId), null);

  // registerPeer preserves activeShards and ignores non-finite freeMemBytes
  router.registerPeer('peer-1', 'pubkey-1', { freeMemBytes: 1024 * 1024 * 100 });
  const peer = router.peerTable.get('peer-1');
  peer.activeShards = 3;
  router.registerPeer('peer-1', 'pubkey-1', { freeMemBytes: NaN });
  assert.strictEqual(peer.activeShards, 3);
  assert.strictEqual(peer.freeMemBytes, 1024 * 1024 * 100);

  // selectOptimalNodes validation
  peer.cpuLoad = -0.5;
  const nodes = router.selectOptimalNodes('any-shard', 1);
  assert.strictEqual(nodes.length, 0);
  peer.cpuLoad = 0.1;
  peer.freeMemRatio = 1.5;
  const nodes2 = router.selectOptimalNodes('any-shard', 1);
  assert.strictEqual(nodes2.length, 0);

  // isMemoryAvailable event emission
  let freeBytes = 50 * 1024 * 1024; // 5% of 1GB -> shed
  const mockMemOs = {
    freemem: () => freeBytes,
    totalmem: () => 1024 * 1024 * 1024,
    cpus: () => [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]
  };
  const memRouter = new GridRouter('node-mem', { os: mockMemOs });
  let shedEmitted = false;
  let recoverEmitted = false;
  memRouter.on('loadShed', () => { shedEmitted = true; });
  memRouter.on('telemetryRecovered', () => { recoverEmitted = true; });

  memRouter.isMemoryAvailable();
  assert.strictEqual(shedEmitted, true);
  freeBytes = 300 * 1024 * 1024; // 30% -> recover
  memRouter.isMemoryAvailable();
  assert.strictEqual(recoverEmitted, true);
});

test('Phase 1.3: MeshCryptoEngine, P2PNode, and StandbySandbox refinements', async () => {
  const engine1 = new MeshCryptoEngine();
  const engine2 = new MeshCryptoEngine();

  // Self-reflection key derivation rejected
  assert.throws(
    () => engine1.deriveSessionKey(engine1.publicKey),
    /self-reflection/i
  );
  assert.throws(
    () => engine1.deriveSharedKey(engine1.publicKey),
    /self-reflection/i
  );

  // resetReplayState safe handling
  assert.doesNotThrow(() => engine1.resetReplayState());
  assert.doesNotThrow(() => engine1.resetReplayState(null));
  assert.doesNotThrow(() => engine1.resetReplayState(''));

  // Auth-before-replay in AES-GCM
  const sessionKey = engine1.deriveSessionKey(engine2.publicKey, { epoch: 1 });
  const packet = engine1.encryptShard({ shardId: 's1', data: [1] }, sessionKey, {
    epoch: 1,
    aad: 'test-aad'
  });
  // Tampered ciphertext fails authentication without updating replay state
  const tampered = { ...packet, ciphertext: packet.ciphertext.slice(0, -2) + '00' };
  assert.throws(
    () => engine2.decryptShard(tampered, sessionKey, { senderId: engine1.nodeId, aad: 'test-aad' }),
    /Decryption failed: authentication tag verification failed/i
  );

  // StandbySandbox terminateAllWorkers
  const sandbox = new StandbySandbox();
  assert.doesNotThrow(() => sandbox.terminateAllWorkers());

  // P2PNode self-handshake rejection
  const p2p1 = new P2PNode({ crypto: engine1 });
  const fakeSocket = { write: () => true, destroyed: false };
  await assert.rejects(
    () => p2p1.initiateHandshake(fakeSocket, engine1.publicKey),
    /self-reflection/i
  );
});

test('Phase 1.4: ProofOfComputeLedger refinements', () => {
  const ledger = new ProofOfComputeLedger();
  ledger.createAccount('user-1', 100);
  ledger.createAccount('worker-1', 50);

  // complexityFactor <= 0 rejected in verifyAndSettle
  const dummyProof = 'a'.repeat(64);
  assert.throws(
    () => ledger.verifyAndSettle({
      requesterId: 'user-1',
      workerId: 'worker-1',
      shardId: 'shard-1',
      resultData: [1],
      proofOfCompute: dummyProof,
      executionMetrics: { executionTimeMs: 10, inputSize: 2, complexityFactor: 0 },
      workerPublicKey: 'pub-key'
    }),
    RangeError
  );
  assert.throws(
    () => ledger.verifyAndSettle({
      requesterId: 'user-1',
      workerId: 'worker-1',
      shardId: 'shard-1',
      resultData: [1],
      proofOfCompute: dummyProof,
      executionMetrics: { executionTimeMs: 10, inputSize: 2, complexityFactor: -1 },
      workerPublicKey: 'pub-key'
    }),
    RangeError
  );

  // calculateCredit subnormal floor
  const tinyCredit = ledger.calculateCredit(0.0000001, 0, 1);
  assert.ok(tinyCredit > 0);

  // Escrow reservation & separate sharded vs unsharded tracking
  const escSharded = ledger.reserveEscrow('user-1', 10, 'shard-100');
  assert.strictEqual(escSharded.amount, 10);
  assert.strictEqual(ledger.getAccount('user-1').reserved, 10);

  const escUnsharded = ledger.reserveEscrow('user-1', 5);
  assert.strictEqual(ledger.getAccount('user-1').reserved, 15);

  // Partial release
  ledger.releaseEscrow('user-1', 2);
  assert.strictEqual(ledger.getAccount('user-1').reserved, 13);

  // Release sharded escrow
  ledger.releaseEscrow('user-1', undefined, 'shard-100');
  assert.strictEqual(ledger.getAccount('user-1').reserved, 3);

  // Release remaining unsharded
  ledger.releaseEscrow('user-1', 3);
  assert.strictEqual(ledger.getAccount('user-1').reserved, 0);

  // allowSelfSettle netting and settledCount
  const selfEngine = new MeshCryptoEngine();
  ledger.createAccount(selfEngine.nodeId, 50);
  const selfSig = selfEngine.signProofOfCompute('self-shard-1', [42]);
  const selfRes = ledger.verifyAndSettle({
    requesterId: selfEngine.nodeId,
    workerId: selfEngine.nodeId,
    shardId: 'self-shard-1',
    resultData: [42],
    proofOfCompute: selfSig,
    executionMetrics: { executionTimeMs: 10, inputSize: 1 },
    workerPublicKey: selfEngine.publicKey,
    allowSelfSettle: true
  });

  assert.strictEqual(selfRes.settled, true);
  const selfAcct = ledger.getAccount(selfEngine.nodeId);
  assert.strictEqual(selfAcct.balance, 50); // Net 0 change
  assert.strictEqual(selfAcct.settledCount, 1); // Incremented ONCE, not twice!
  assert.ok(selfAcct.totalEarned > 0);
  assert.ok(selfAcct.totalSpent > 0);

  // exportState and fromState restores sharded and unsharded escrows
  ledger.reserveEscrow('user-1', 4, 'shard-export');
  ledger.reserveEscrow('user-1', 6);
  const exported = ledger.exportState();
  const rehydrated = ProofOfComputeLedger.fromState(exported);
  assert.strictEqual(rehydrated.getAccount('user-1').reserved, 10);
  assert.strictEqual(rehydrated.verifyAuditLog().valid, true);
});

test('Phase 1.5: ComputeSea orchestrator refinements', async () => {
  // Validate shardTimeoutMs and timeoutMs validation
  assert.throws(
    () => new ComputeSea({ shardTimeoutMs: -5 }),
    RangeError
  );
  assert.throws(
    () => new ComputeSea({ queueTimeoutMs: 0 }),
    RangeError
  );

  const sea = new ComputeSea({
    enableLedger: true,
    initialBalance: 500,
    queueWaitTimeoutMs: 2500 // alias test
  });
  assert.strictEqual(sea.defaultQueueTimeoutMs, 2500);

  const worker = await sea.addLocalWorker({ latencyMs: 5 });

  // submitWorkload input validation
  await assert.rejects(
    () => sea.submitWorkload('return data;', [1, 2], { shardTimeoutMs: -1 }),
    RangeError
  );
  await assert.rejects(
    () => sea.submitWorkload('return data;', [1, 2], { timeoutMs: 0 }),
    RangeError
  );

  // Workload execution with salted shardId and real escrow
  const res = await sea.submitWorkload('return data.map(x => x * 10);', [1, 2, 3, 4], { chunkSize: 2 });
  assert.strictEqual(res.status, 'COMPLETED');
  assert.deepStrictEqual(res.output, [10, 20, 30, 40]);
  assert.strictEqual(res.settlements.length, 2);

  // ShardIds are salted per workload
  for (const s of res.shards) {
    assert.strictEqual(typeof s.shardId, 'string');
    assert.strictEqual(s.shardId.length, 64); // SHA-256 hex
  }

  // Escrow was cleaned up after completion
  assert.strictEqual(sea.ledger.getAccount(sea.nodeId).reserved, 0);

  // fundAccount single-execution safe handling
  const bal = sea.fundAccount(sea.nodeId, 100);
  assert.strictEqual(bal, 600 - res.totalCost);

  // cancelWorkload terminates workers and releases escrows
  const cancelSea = new ComputeSea({ enableLedger: true, initialBalance: 100 });
  const queuedWorkload = await cancelSea.submitWorkload('return data;', [1, 2], {
    waitForDrain: false
  });
  assert.strictEqual(queuedWorkload.status, 'QUEUED');
  assert.strictEqual(cancelSea.cancelWorkload(queuedWorkload.workloadId), true);
  assert.strictEqual(cancelSea.ledger.getAccount(cancelSea.nodeId).reserved, 0);

  await sea.close();
  await cancelSea.close();
});
