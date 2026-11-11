'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GridRouter } = require('../src/router');

test('Tiered Scheduling & Peer Reputation - dynamically ranks and classifies peers into Tiers', () => {
  const router = new GridRouter('coord-node');

  // Register 3 peers with different performance & reputation
  router.registerPeer('peer-dc-1', 'key-1', {
    standbyReady: true,
    cpuLoad: 0.10,
    freeMemRatio: 0.80,
    latencyMs: 15,
    capacityScore: 95,
    reputationScore: 0.95
  });

  router.registerPeer('peer-desktop-2', 'key-2', {
    standbyReady: true,
    cpuLoad: 0.15,
    freeMemRatio: 0.50,
    latencyMs: 60,
    capacityScore: 70,
    reputationScore: 0.75
  });

  router.registerPeer('peer-edge-3', 'key-3', {
    standbyReady: true,
    cpuLoad: 0.20,
    freeMemRatio: 0.30,
    latencyMs: 120,
    capacityScore: 30,
    reputationScore: 0.40
  });

  const p1 = router.peerTable.get('peer-dc-1');
  const p2 = router.peerTable.get('peer-desktop-2');
  const p3 = router.peerTable.get('peer-edge-3');

  assert.strictEqual(p1.tier, 'TIER_1');
  assert.strictEqual(p2.tier, 'TIER_2');
  assert.strictEqual(p3.tier, 'TIER_3');

  // Optimal selection prioritizes higher reputation and Tier 1 nodes
  const selected = router.selectOptimalNodes('task-hash-1', 2);
  assert.strictEqual(selected.length, 2);
  assert.strictEqual(selected[0].nodeId, 'peer-dc-1');
  assert.strictEqual(selected[1].nodeId, 'peer-desktop-2');
});

test('Peer Reputation - slashes on failure and rewards on verified consensus', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('peer-worker-a', 'key-a', { reputationScore: 0.8 });

  // Rewarded
  router.updatePeerReputation('peer-worker-a', { success: true });
  assert.strictEqual(router.peerTable.get('peer-worker-a').reputationScore, 0.85);

  // Slashed on fault / tamper
  router.updatePeerReputation('peer-worker-a', { success: false });
  assert.strictEqual(router.peerTable.get('peer-worker-a').reputationScore, 0.60);
});

test('Redundant Shard Dispatch & Majority Consensus - 2-of-3 agreement succeeds', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('node-1', 'k1');
  router.registerPeer('node-2', 'k2');
  router.registerPeer('node-3', 'k3');

  const executions = [
    { peerId: 'node-1', output: { result: 42, model: 'gpt' } },
    { peerId: 'node-2', output: { result: 42, model: 'gpt' } }, // matching node-1
    { peerId: 'node-3', output: { result: 999, model: 'byzantine' } } // dissenting
  ];

  const consensus = router.evaluateConsensus(executions);

  assert.deepStrictEqual(consensus.consensusOutput, { result: 42, model: 'gpt' });
  assert.strictEqual(consensus.agreementRatio, 2 / 3);
  assert.deepStrictEqual(consensus.consensusPeers, ['node-1', 'node-2']);
  assert.deepStrictEqual(consensus.dissentingPeers, ['node-3']);

  // Node 1 & 2 reputation boosted; Node 3 slashed
  assert.ok(router.peerTable.get('node-1').reputationScore > 0.8);
  assert.ok(router.peerTable.get('node-3').reputationScore < 0.8);
});

test('Redundant Shard Dispatch & Majority Consensus - failure when split with no majority', () => {
  const router = new GridRouter('coord-node');

  const executions = [
    { peerId: 'n1', output: 'val-1' },
    { peerId: 'n2', output: 'val-2' },
    { peerId: 'n3', output: 'val-3' }
  ];

  assert.throws(
    () => router.evaluateConsensus(executions),
    /did not meet majority/i
  );
});
