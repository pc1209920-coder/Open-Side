'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CheckpointManager } = require('../src/checkpoint');
const { GridRouter } = require('../src/router');

test('CheckpointManager - state serialization & deserialization across complex JS types', () => {
  const manager = new CheckpointManager();
  const testState = {
    step: 42,
    weights: [0.12, 0.45, 0.88],
    metadata: { model: 'transformer-mini', epoch: 3 },
    tags: new Set(['layer1', 'attention']),
    lookup: new Map([['k1', 'v1'], ['k2', 'v2']])
  };

  const serialized = manager.serializeState(testState);
  assert.ok(Buffer.isBuffer(serialized), 'Serialized output must be a Buffer');

  const deserialized = manager.deserializeState(serialized);
  assert.strictEqual(deserialized.step, 42);
  assert.deepStrictEqual(deserialized.weights, [0.12, 0.45, 0.88]);
  assert.strictEqual(deserialized.metadata.model, 'transformer-mini');
  assert.ok(deserialized.tags instanceof Set);
  assert.strictEqual(deserialized.tags.size, 2);
  assert.ok(deserialized.tags.has('layer1'));
  assert.ok(deserialized.tags.has('attention'));
  assert.ok(deserialized.lookup instanceof Map);
  assert.strictEqual(deserialized.lookup.size, 2);
  assert.strictEqual(deserialized.lookup.get('k1'), 'v1');
  assert.strictEqual(deserialized.lookup.get('k2'), 'v2');
});

test('CheckpointManager - state serialization across BigInt, TypedArrays, Date, RegExp, and circular refs', () => {
  const manager = new CheckpointManager();
  const circularObj = { name: 'circular-root' };
  circularObj.self = circularObj;

  const complexState = {
    bigIntPos: 12345678901234567890n,
    bigIntNeg: -98765432109876543210n,
    u8Array: new Uint8Array([1, 2, 3, 4, 255]),
    f32Array: new Float32Array([1.5, -2.5, 3.14159]),
    arrBuf: new Uint8Array([10, 20, 30]).buffer,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    pattern: /shard-[a-z0-9]+/i,
    nullVal: null,
    boolVal: true,
    emptyStr: '',
    unicodeStr: 'ComputeSea 🌊 节点 123',
    circular: circularObj
  };

  const serialized = manager.serializeState(complexState);
  assert.ok(Buffer.isBuffer(serialized));

  const deserialized = manager.deserializeState(serialized);
  assert.strictEqual(deserialized.bigIntPos, 12345678901234567890n);
  assert.strictEqual(deserialized.bigIntNeg, -98765432109876543210n);
  assert.ok(deserialized.u8Array instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(deserialized.u8Array), [1, 2, 3, 4, 255]);
  assert.ok(deserialized.f32Array instanceof Float32Array);
  assert.strictEqual(deserialized.f32Array.length, 3);
  assert.strictEqual(deserialized.timestamp.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.ok(deserialized.pattern instanceof RegExp);
  assert.strictEqual(deserialized.pattern.source, 'shard-[a-z0-9]+');
  assert.strictEqual(deserialized.nullVal, null);
  assert.strictEqual(deserialized.boolVal, true);
  assert.strictEqual(deserialized.unicodeStr, 'ComputeSea 🌊 节点 123');
  assert.strictEqual(deserialized.circular.self, deserialized.circular);
});

test('CheckpointManager - JSON fallback deserialization with BigInt reviver and type checks', () => {
  const manager = new CheckpointManager();

  // Test invalid buffer input validation
  assert.throws(() => manager.deserializeState(null), TypeError);
  assert.throws(() => manager.deserializeState('not-a-buffer'), TypeError);
  assert.throws(() => manager.deserializeState(12345), TypeError);

  // Test JSON-encoded buffer fallback with BigInt reviver
  const jsonPayload = JSON.stringify({
    shard: 's-fallback',
    counter: '9007199254740993n',
    negative: '-42n',
    normalStr: 'regular-text'
  });
  const jsonBuf = Buffer.from(jsonPayload, 'utf8');

  const restored = manager.deserializeState(jsonBuf);
  assert.strictEqual(restored.shard, 's-fallback');
  assert.strictEqual(restored.counter, 9007199254740993n);
  assert.strictEqual(restored.negative, -42n);
  assert.strictEqual(restored.normalStr, 'regular-text');
});

test('CheckpointManager - sequential saving, versioning, and metadata preservation', () => {
  const manager = new CheckpointManager({ maxCheckpointsPerShard: 3 });
  const shardId = 'shard-test-101';

  let savedEvents = [];
  manager.on('checkpointSaved', (evt) => savedEvents.push(evt));

  const cp1 = manager.saveCheckpoint(shardId, { progress: 25, iteration: 100 }, { stepIndex: 10, note: 'init' });
  assert.strictEqual(cp1.seq, 1);
  assert.strictEqual(cp1.stepIndex, 10);
  assert.strictEqual(typeof cp1.checksum, 'string');
  assert.strictEqual(cp1.checksum.length, 64); // SHA-256 hex string length
  assert.strictEqual(typeof cp1.timestamp, 'number');
  assert.ok(cp1.sizeBytes > 0);

  const cp2 = manager.saveCheckpoint(shardId, { progress: 50, iteration: 200 });
  assert.strictEqual(cp2.seq, 2);
  assert.strictEqual(cp2.stepIndex, 2); // Defaults to seq when omitted

  const cp3 = manager.saveCheckpoint(shardId, { progress: 75, iteration: 300 });
  assert.strictEqual(cp3.seq, 3);

  assert.strictEqual(savedEvents.length, 3);
  assert.strictEqual(savedEvents[0].seq, 1);
  assert.strictEqual(savedEvents[0].stepIndex, 10);

  let restoredEvents = [];
  manager.on('checkpointRestored', (evt) => restoredEvents.push(evt));

  const restored = manager.restoreCheckpoint(shardId);
  assert.strictEqual(restored.seq, 3);
  assert.strictEqual(restored.state.progress, 75);
  assert.strictEqual(restored.state.iteration, 300);
  assert.strictEqual(typeof restored.timestamp, 'number');

  // Restore specific sequence with meta verification
  const restoredSeq1 = manager.restoreCheckpoint(shardId, 1);
  assert.strictEqual(restoredSeq1.seq, 1);
  assert.strictEqual(restoredSeq1.stepIndex, 10);
  assert.strictEqual(restoredSeq1.state.progress, 25);
  assert.strictEqual(restoredSeq1.meta.note, 'init');

  assert.strictEqual(restoredEvents.length, 2);
  assert.strictEqual(restoredEvents[0].seq, 3);
  assert.strictEqual(restoredEvents[1].seq, 1);
});

test('CheckpointManager - tampering / corruption detection throws integrity violation and emits event', () => {
  const manager = new CheckpointManager();
  const shardId = 'shard-corrupt-test';

  manager.saveCheckpoint(shardId, { progress: 50, weights: [1, 2, 3] });
  const history = manager.getCheckpoints(shardId);
  assert.strictEqual(history.length, 1);

  let corruptEvents = [];
  manager.on('corruptedCheckpoint', (evt) => corruptEvents.push(evt));

  // 1. Deliberately tamper with serialized buffer data
  history[0].stateBuffer[0] = (history[0].stateBuffer[0] + 1) % 256;

  assert.throws(
    () => manager.restoreCheckpoint(shardId),
    (err) => {
      assert.match(err.message, /integrity violation/i);
      return true;
    }
  );
  assert.strictEqual(corruptEvents.length, 1);
  assert.strictEqual(corruptEvents[0].shardId, shardId);
  assert.strictEqual(corruptEvents[0].seq, 1);

  // 2. Tampering with sequence number in stored entry also fails checksum
  history[0].stateBuffer[0] = (history[0].stateBuffer[0] + 255) % 256; // Revert buffer
  history[0].seq = 999;
  assert.throws(
    () => manager.restoreCheckpoint(shardId, 999),
    (err) => {
      assert.match(err.message, /integrity violation/i);
      return true;
    }
  );
  assert.strictEqual(corruptEvents.length, 2);

  // 3. Tampering with stepIndex also fails checksum
  history[0].seq = 1; // Revert seq
  history[0].stepIndex = 777;
  assert.throws(
    () => manager.restoreCheckpoint(shardId),
    (err) => {
      assert.match(err.message, /integrity violation/i);
      return true;
    }
  );
  assert.strictEqual(corruptEvents.length, 3);
});

test('CheckpointManager - input validation for saveCheckpoint', () => {
  const manager = new CheckpointManager();

  assert.throws(() => manager.saveCheckpoint('', { ok: true }), TypeError);
  assert.throws(() => manager.saveCheckpoint(null, { ok: true }), TypeError);
  assert.throws(() => manager.saveCheckpoint(undefined, { ok: true }), TypeError);
  assert.throws(() => manager.saveCheckpoint(12345, { ok: true }), TypeError);
  assert.throws(() => manager.saveCheckpoint({}, { ok: true }), TypeError);
});

test('CheckpointManager - getLatestCheckpoint, getCheckpoints, and non-existent shard safety', () => {
  const manager = new CheckpointManager();

  // Queries on non-existent shard
  assert.strictEqual(manager.getLatestCheckpoint('ghost-shard'), null);
  assert.deepStrictEqual(manager.getCheckpoints('ghost-shard'), []);
  assert.strictEqual(manager.restoreCheckpoint('ghost-shard'), null);
  assert.strictEqual(manager.restoreCheckpoint('ghost-shard', 1), null);

  // Safe no-ops
  assert.doesNotThrow(() => manager.stopPeriodicCheckpoint('ghost-shard'));
  assert.doesNotThrow(() => manager.clearShard('ghost-shard'));

  // Normal shard lifecycle with getLatestCheckpoint
  manager.saveCheckpoint('s1', { v: 1 });
  manager.saveCheckpoint('s1', { v: 2 });
  const latest = manager.getLatestCheckpoint('s1');
  assert.ok(latest !== null);
  assert.strictEqual(latest.seq, 2);
  assert.strictEqual(latest.shardId, 's1');

  // Querying a sequence that does not exist on an existing shard
  assert.strictEqual(manager.restoreCheckpoint('s1', 999), null);
});

test('CheckpointManager - configurable digestAlgorithm (SHA-512)', () => {
  const manager = new CheckpointManager({ digestAlgorithm: 'sha512' });
  const cp = manager.saveCheckpoint('sha512-shard', { data: 'secure' });

  assert.strictEqual(typeof cp.checksum, 'string');
  assert.strictEqual(cp.checksum.length, 128); // SHA-512 hex string length

  const restored = manager.restoreCheckpoint('sha512-shard');
  assert.strictEqual(restored.state.data, 'secure');
});

test('CheckpointManager - oldest checkpoint eviction exceeding maxCheckpointsPerShard', () => {
  const manager = new CheckpointManager({ maxCheckpointsPerShard: 2 });
  const shardId = 'shard-evict-test';

  manager.saveCheckpoint(shardId, { step: 1 });
  manager.saveCheckpoint(shardId, { step: 2 });
  manager.saveCheckpoint(shardId, { step: 3 });

  const history = manager.getCheckpoints(shardId);
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].seq, 2);
  assert.strictEqual(history[1].seq, 3);

  // seq 1 was pruned
  const restoredSeq1 = manager.restoreCheckpoint(shardId, 1);
  assert.strictEqual(restoredSeq1, null);

  const latest = manager.restoreCheckpoint(shardId);
  assert.strictEqual(latest.seq, 3);
  assert.strictEqual(latest.state.step, 3);

  // Boundary: maxCheckpointsPerShard: 1
  const managerSingle = new CheckpointManager({ maxCheckpointsPerShard: 1 });
  managerSingle.saveCheckpoint('s-single', { n: 1 });
  managerSingle.saveCheckpoint('s-single', { n: 2 });
  assert.strictEqual(managerSingle.getCheckpoints('s-single').length, 1);
  assert.strictEqual(managerSingle.getLatestCheckpoint('s-single').seq, 2);
});

test('CheckpointManager - periodic checkpointing, error trapping, and timer replacement', async () => {
  const manager = new CheckpointManager();
  const shardId = 'shard-periodic-test';

  let counter = 0;
  const stateGetter = () => ({ tick: ++counter });

  manager.startPeriodicCheckpoint(shardId, stateGetter, 10);

  // Poll until at least 2 ticks have occurred or timeout after 2000ms for load resilience
  const start = Date.now();
  while (counter < 2 && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  manager.stopPeriodicCheckpoint(shardId);
  const currentCount = counter;
  assert.ok(currentCount >= 2, `Expected at least 2 ticks, got ${currentCount}`);

  const restored = manager.restoreCheckpoint(shardId);
  assert.ok(restored !== null);
  assert.ok(restored.state.tick >= 2);
  assert.strictEqual(restored.meta.periodic, true);

  // Wait to confirm timer stopped
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(counter, currentCount, 'Counter must not advance after stopPeriodicCheckpoint');

  // Verify skipping undefined state
  const undefShard = 'shard-undef';
  manager.startPeriodicCheckpoint(undefShard, () => undefined, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  manager.stopPeriodicCheckpoint(undefShard);
  assert.strictEqual(manager.getCheckpoints(undefShard).length, 0);

  // Verify error handling when state provider throws
  let emittedErrors = [];
  manager.on('checkpointError', (err) => emittedErrors.push(err));
  const errShard = 'shard-err';
  manager.startPeriodicCheckpoint(errShard, () => {
    throw new Error('State provider crashed');
  }, 10);

  const errStart = Date.now();
  while (emittedErrors.length < 1 && Date.now() - errStart < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  manager.stopPeriodicCheckpoint(errShard);
  assert.ok(emittedErrors.length >= 1);
  assert.strictEqual(emittedErrors[0].shardId, errShard);
  assert.strictEqual(emittedErrors[0].error, 'State provider crashed');

  // Verify replacing periodic timer on same shard does not duplicate
  let replaceCount = 0;
  manager.startPeriodicCheckpoint('shard-replace', () => ({ v: ++replaceCount }), 10);
  // Re-start immediately with new getter
  let replaceCount2 = 0;
  manager.startPeriodicCheckpoint('shard-replace', () => ({ v: ++replaceCount2 }), 10);
  await new Promise((resolve) => setTimeout(resolve, 60));
  manager.stopPeriodicCheckpoint('shard-replace');
  assert.strictEqual(replaceCount, 0, 'Original timer must have been cancelled immediately');
  assert.ok(replaceCount2 >= 1, 'Second timer must have executed');
});

test('CheckpointManager - clearShard resets sequence counter and clearAll cleans all active intervals', async () => {
  const manager = new CheckpointManager();
  manager.saveCheckpoint('s1', { a: 1 });
  manager.saveCheckpoint('s1', { a: 2 });
  manager.saveCheckpoint('s2', { b: 2 });

  // Clear s1: should remove checkpoints and reset sequence counter
  manager.clearShard('s1');
  assert.strictEqual(manager.restoreCheckpoint('s1'), null);
  assert.ok(manager.restoreCheckpoint('s2') !== null);

  const reSaved = manager.saveCheckpoint('s1', { a: 99 });
  assert.strictEqual(reSaved.seq, 1, 'Sequence should reset to 1 after clearShard');

  // Test clearAll stopping active intervals across multiple shards
  let t1 = 0;
  let t2 = 0;
  manager.startPeriodicCheckpoint('s-timer-1', () => ({ v: ++t1 }), 10);
  manager.startPeriodicCheckpoint('s-timer-2', () => ({ v: ++t2 }), 10);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.strictEqual(manager.activeIntervals.size, 2);

  manager.clearAll();
  assert.strictEqual(manager.activeIntervals.size, 0);
  assert.strictEqual(manager.checkpoints.size, 0);
  assert.strictEqual(manager._seqByShard.size, 0);

  const stoppedT1 = t1;
  const stoppedT2 = t2;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(t1, stoppedT1, 'Timer 1 must not tick after clearAll');
  assert.strictEqual(t2, stoppedT2, 'Timer 2 must not tick after clearAll');
});

test('GridRouter Integration - attach resumeCheckpoint when re-dispatching shard', () => {
  const checkpointManager = new CheckpointManager();
  const router = new GridRouter('local-node-test', { checkpointManager, autoFlush: false });

  const shard = {
    shardId: 'shard-alpha-99',
    taskType: 'matrix-multiply',
    assignedPeer: 'peer-node-1',
    status: 'in-flight'
  };

  // Pre-save intermediate progress
  checkpointManager.saveCheckpoint(shard.shardId, {
    processedRows: 500,
    totalRows: 1000,
    partialResult: [10, 20, 30]
  });

  // Track the shard in router as in-flight
  router.inFlightShards.set(shard.shardId, {
    shard,
    peerId: 'peer-node-1',
    attempts: 1,
    dispatchedAt: Date.now()
  });

  // Peer-node-1 disconnects or dies; router reschedules shard
  const result = router.rescheduleShard(shard.shardId);

  assert.strictEqual(result.status, 'RESCHEDULED');
  assert.strictEqual(result.shard.shardId, 'shard-alpha-99');
  assert.ok(result.shard.resumeCheckpoint, 'Rescheduled shard must have resumeCheckpoint attached');
  assert.strictEqual(result.shard.resumeCheckpoint.seq, 1);
  assert.strictEqual(result.shard.resumeCheckpoint.state.processedRows, 500);
  assert.deepStrictEqual(result.shard.resumeCheckpoint.state.partialResult, [10, 20, 30]);

  // Check that shard was placed in pending queue
  assert.strictEqual(router.taskQueue.length, 1);
});

test('GridRouter Integration - graceful fallback when checkpoint is corrupted during reschedule', () => {
  const checkpointManager = new CheckpointManager();
  const router = new GridRouter('local-node-corrupt', { checkpointManager, autoFlush: false });

  const shard = {
    shardId: 'shard-corrupt-failover',
    taskType: 'model-eval',
    assignedPeer: 'peer-node-bad',
    status: 'in-flight'
  };

  checkpointManager.saveCheckpoint(shard.shardId, { modelWeights: [1, 2, 3] });
  // Corrupt the checkpoint
  const history = checkpointManager.getCheckpoints(shard.shardId);
  history[0].stateBuffer[0] ^= 0xFF;

  router.inFlightShards.set(shard.shardId, {
    shard,
    peerId: 'peer-node-bad',
    attempts: 1,
    dispatchedAt: Date.now()
  });

  let corruptionNotified = false;
  router.on('checkpointCorruptedOnReschedule', (evt) => {
    assert.strictEqual(evt.shardId, shard.shardId);
    assert.match(evt.error, /integrity violation/i);
    corruptionNotified = true;
  });

  const result = router.rescheduleShard(shard.shardId);
  assert.strictEqual(result.status, 'RESCHEDULED');
  assert.strictEqual(result.shard.resumeCheckpoint, null, 'Must fail-closed to null checkpoint on corruption');
  assert.ok(corruptionNotified, 'Router must emit checkpointCorruptedOnReschedule');
  assert.strictEqual(router.taskQueue.length, 1);
});

test('GridRouter Integration - reschedule shard cleanly when no checkpoint exists', () => {
  const checkpointManager = new CheckpointManager();
  const router = new GridRouter('local-node-nocp', { checkpointManager, autoFlush: false });

  const shard = {
    shardId: 'shard-no-checkpoint',
    taskType: 'lightweight-job',
    assignedPeer: 'peer-node-3',
    status: 'in-flight'
  };

  router.inFlightShards.set(shard.shardId, {
    shard,
    peerId: 'peer-node-3',
    attempts: 1,
    dispatchedAt: Date.now()
  });

  const result = router.rescheduleShard(shard.shardId);
  assert.strictEqual(result.status, 'RESCHEDULED');
  assert.strictEqual(result.shard.resumeCheckpoint, null);
  assert.strictEqual(router.taskQueue.length, 1);
});

test('Reliability & Stress - high-throughput sequential checkpointing & LRU bounds', () => {
  const maxCheckpoints = 5;
  const manager = new CheckpointManager({ maxCheckpointsPerShard: maxCheckpoints });
  const shardId = 'stress-shard-seq';
  const totalIterations = 500;

  for (let i = 1; i <= totalIterations; i++) {
    const cp = manager.saveCheckpoint(shardId, { iteration: i, timestamp: Date.now() });
    assert.strictEqual(cp.seq, i);
  }

  const history = manager.getCheckpoints(shardId);
  assert.strictEqual(history.length, maxCheckpoints, 'History must be strictly bounded by maxCheckpointsPerShard');
  assert.strictEqual(history[history.length - 1].seq, totalIterations);
  assert.strictEqual(history[0].seq, totalIterations - maxCheckpoints + 1);

  // Latest restore must accurately match last iteration
  const restoredLatest = manager.restoreCheckpoint(shardId);
  assert.strictEqual(restoredLatest.seq, totalIterations);
  assert.strictEqual(restoredLatest.state.iteration, totalIterations);

  // Pruned sequence must return null
  assert.strictEqual(manager.restoreCheckpoint(shardId, 1), null);
});

test('Reliability & Stress - multi-shard concurrent checkpointing isolation', async () => {
  const manager = new CheckpointManager({ maxCheckpointsPerShard: 3 });
  const numShards = 30;
  const opsPerShard = 10;

  const shardTasks = Array.from({ length: numShards }, async (_, sIdx) => {
    const shardId = `concurrent-shard-${sIdx}`;
    for (let op = 1; op <= opsPerShard; op++) {
      manager.saveCheckpoint(shardId, { sIdx, op, payload: `data-${sIdx}-${op}` });
    }

    const latest = manager.restoreCheckpoint(shardId);
    assert.ok(latest !== null);
    assert.strictEqual(latest.seq, opsPerShard);
    assert.strictEqual(latest.state.sIdx, sIdx);
    assert.strictEqual(latest.state.op, opsPerShard);
    assert.strictEqual(latest.state.payload, `data-${sIdx}-${opsPerShard}`);

    const history = manager.getCheckpoints(shardId);
    assert.strictEqual(history.length, 3);
  });

  await Promise.all(shardTasks);
  assert.strictEqual(manager.checkpoints.size, numShards);
});

test('Reliability & Stress - large state buffer payload serialization and integrity', () => {
  const manager = new CheckpointManager();
  const shardId = 'large-payload-shard';

  // 1 Megabyte buffer payload simulating neural network layer weights
  const floatCount = 250000;
  const weights = new Float32Array(floatCount);
  for (let i = 0; i < floatCount; i++) {
    weights[i] = (i * 0.001) % 1.0;
  }

  const largeState = {
    layer: 'fc_weights_1',
    params: weights
  };

  const cp = manager.saveCheckpoint(shardId, largeState);
  assert.ok(cp.sizeBytes >= floatCount * 4, 'Serialized size must accommodate full Float32Array');

  const restored = manager.restoreCheckpoint(shardId);
  assert.strictEqual(restored.state.layer, 'fc_weights_1');
  assert.strictEqual(restored.state.params.length, floatCount);
  assert.strictEqual(restored.state.params[0], weights[0]);
  assert.strictEqual(restored.state.params[floatCount - 1], weights[floatCount - 1]);
});
