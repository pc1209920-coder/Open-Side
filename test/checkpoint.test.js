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
  assert.ok(deserialized.tags.has('layer1'));
  assert.ok(deserialized.lookup instanceof Map);
  assert.strictEqual(deserialized.lookup.get('k1'), 'v1');
});

test('CheckpointManager - sequential saving and versioning', () => {
  const manager = new CheckpointManager({ maxCheckpointsPerShard: 3 });
  const shardId = 'shard-test-101';

  const cp1 = manager.saveCheckpoint(shardId, { progress: 25, iteration: 100 });
  assert.strictEqual(cp1.seq, 1);
  assert.strictEqual(typeof cp1.checksum, 'string');
  assert.strictEqual(cp1.checksum.length, 64); // SHA-256 hex string length

  const cp2 = manager.saveCheckpoint(shardId, { progress: 50, iteration: 200 });
  assert.strictEqual(cp2.seq, 2);

  const cp3 = manager.saveCheckpoint(shardId, { progress: 75, iteration: 300 });
  assert.strictEqual(cp3.seq, 3);

  const restored = manager.restoreCheckpoint(shardId);
  assert.strictEqual(restored.seq, 3);
  assert.strictEqual(restored.state.progress, 75);
  assert.strictEqual(restored.state.iteration, 300);

  // Restore specific sequence
  const restoredSeq2 = manager.restoreCheckpoint(shardId, 2);
  assert.strictEqual(restoredSeq2.seq, 2);
  assert.strictEqual(restoredSeq2.state.progress, 50);
});

test('CheckpointManager - tampering / corruption detection throws integrity violation', () => {
  const manager = new CheckpointManager();
  const shardId = 'shard-corrupt-test';

  manager.saveCheckpoint(shardId, { progress: 50, weights: [1, 2, 3] });
  const history = manager.getCheckpoints(shardId);
  assert.strictEqual(history.length, 1);

  // Deliberately tamper with serialized buffer data
  history[0].stateBuffer[0] = (history[0].stateBuffer[0] + 1) % 256;

  assert.throws(
    () => manager.restoreCheckpoint(shardId),
    (err) => {
      assert.match(err.message, /integrity violation/i);
      return true;
    }
  );
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
});

test('CheckpointManager - periodic checkpointing and stop timer', async () => {
  const manager = new CheckpointManager();
  const shardId = 'shard-periodic-test';

  let counter = 0;
  const stateGetter = () => ({ tick: ++counter });

  manager.startPeriodicCheckpoint(shardId, stateGetter, 10);

  await new Promise((resolve) => setTimeout(resolve, 120));

  manager.stopPeriodicCheckpoint(shardId);
  const currentCount = counter;
  assert.ok(currentCount >= 2, `Expected at least 2 ticks, got ${currentCount}`);

  const restored = manager.restoreCheckpoint(shardId);
  assert.ok(restored !== null);
  assert.ok(restored.state.tick >= 2);

  // Wait a little more to confirm timer stopped
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.strictEqual(counter, currentCount, 'Counter must not advance after stopPeriodicCheckpoint');
});

test('CheckpointManager - clearShard and clearAll', () => {
  const manager = new CheckpointManager();
  manager.saveCheckpoint('s1', { a: 1 });
  manager.saveCheckpoint('s2', { b: 2 });

  manager.clearShard('s1');
  assert.strictEqual(manager.restoreCheckpoint('s1'), null);
  assert.ok(manager.restoreCheckpoint('s2') !== null);

  manager.clearAll();
  assert.strictEqual(manager.restoreCheckpoint('s2'), null);
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
