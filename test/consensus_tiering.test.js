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

test('Peer Reputation - score clamping at upper and lower saturation boundaries (0.00 min, 1.00 max)', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('peer-clamped', 'key-c', { reputationScore: 0.95 });

  // Reward once: 0.95 + 0.05 = 1.00
  router.updatePeerReputation('peer-clamped', { success: true });
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 1.00);

  // Reward again: caps at 1.00, does not overflow
  router.updatePeerReputation('peer-clamped', { success: true });
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 1.00);

  // Slash repeatedly: 1.00 -> 0.75 -> 0.50 -> 0.25 -> 0.00
  router.updatePeerReputation('peer-clamped', { success: false }); // 0.75
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 0.75);
  router.updatePeerReputation('peer-clamped', { success: false }); // 0.50
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 0.50);
  router.updatePeerReputation('peer-clamped', { success: false }); // 0.25
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 0.25);
  router.updatePeerReputation('peer-clamped', { success: false }); // 0.00
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 0.00);

  // Slash below zero: floored at 0.00, never negative
  router.updatePeerReputation('peer-clamped', { success: false });
  assert.strictEqual(router.peerTable.get('peer-clamped').reputationScore, 0.00);
});

test('Peer Reputation - direct numerical score assignment, normalization and bounds', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('peer-num', 'key-n');

  // Direct score assignment clamped [0.0 - 1.0] and rounded to 2 decimals
  router.updatePeerReputation('peer-num', 0.725);
  assert.strictEqual(router.peerTable.get('peer-num').reputationScore, 0.73);

  router.updatePeerReputation('peer-num', 1.5);
  assert.strictEqual(router.peerTable.get('peer-num').reputationScore, 1.00);

  router.updatePeerReputation('peer-num', -0.5);
  assert.strictEqual(router.peerTable.get('peer-num').reputationScore, 0.00);
});

test('Peer Reputation - dynamic tier demotions and promotions across TIER_1, TIER_2, and TIER_3', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('dynamic-peer', 'dyn-key', {
    capacityScore: 90,
    latencyMs: 20,
    reputationScore: 0.85
  });

  const peer = router.peerTable.get('dynamic-peer');
  assert.strictEqual(peer.tier, 'TIER_1', 'Should initially qualify for TIER_1');

  // Demote to TIER_2: Slashed by 0.25 -> 0.60
  router.updatePeerReputation('dynamic-peer', { success: false });
  assert.strictEqual(peer.reputationScore, 0.60);
  assert.strictEqual(peer.tier, 'TIER_2', 'Score of 0.60 should classify as TIER_2');

  // Demote to TIER_3: Slashed by 0.25 -> 0.35
  router.updatePeerReputation('dynamic-peer', { success: false });
  assert.strictEqual(peer.reputationScore, 0.35);
  assert.strictEqual(peer.tier, 'TIER_3', 'Score below 0.60 should classify as TIER_3');

  // Promote from TIER_3 to TIER_2: 5 consecutive rewards (+0.05 * 5 = +0.25 -> 0.60)
  for (let i = 0; i < 5; i++) {
    router.updatePeerReputation('dynamic-peer', { success: true });
  }
  assert.strictEqual(peer.reputationScore, 0.60);
  assert.strictEqual(peer.tier, 'TIER_2', 'Promoted back to TIER_2 upon reaching 0.60');

  // Promote from TIER_2 to TIER_1: 5 more rewards (0.60 + 0.25 = 0.85)
  for (let i = 0; i < 5; i++) {
    router.updatePeerReputation('dynamic-peer', { success: true });
  }
  assert.strictEqual(peer.reputationScore, 0.85);
  assert.strictEqual(peer.tier, 'TIER_1', 'Promoted back to TIER_1 upon reaching 0.85 with low latency and high capacity');
});

test('Peer Reputation - TIER_1 admission strictly enforces capacityScore and latencyMs thresholds', () => {
  const router = new GridRouter('coord-node');

  // Node with high reputation (0.90) but high latency (120ms >= 100ms) -> TIER_2
  router.registerPeer('high-latency-peer', 'k-hl', {
    capacityScore: 90,
    latencyMs: 120,
    reputationScore: 0.90
  });
  assert.strictEqual(router.peerTable.get('high-latency-peer').tier, 'TIER_2');

  // Node with high reputation (0.90) and low latency (30ms) but low capacity (75 < 80) -> TIER_2
  router.registerPeer('low-capacity-peer', 'k-lc', {
    capacityScore: 75,
    latencyMs: 30,
    reputationScore: 0.90
  });
  assert.strictEqual(router.peerTable.get('low-capacity-peer').tier, 'TIER_2');
});

test('Peer Reputation - emits peerReputationUpdated event with updated score and tier', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('event-peer', 'k-ev', {
    capacityScore: 90,
    latencyMs: 30,
    reputationScore: 0.80
  });

  const events = [];
  router.on('peerReputationUpdated', (evt) => events.push(evt));

  router.updatePeerReputation('event-peer', { success: true }); // 0.85 -> TIER_1
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], {
    peerId: 'event-peer',
    reputationScore: 0.85,
    tier: 'TIER_1'
  });

  router.updatePeerReputation('event-peer', { success: false }); // 0.60 -> TIER_2
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events[1], {
    peerId: 'event-peer',
    reputationScore: 0.60,
    tier: 'TIER_2'
  });
});

test('Peer Reputation - throws descriptive Error when updating unknown peer', () => {
  const router = new GridRouter('coord-node');
  assert.throws(
    () => router.updatePeerReputation('unknown-node-xyz', { success: true }),
    /Unknown peer: unknown-node-xyz/i
  );
});

test('Peer Reputation - preserves slashed reputation score and tier across peer re-registration', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('flaky-peer', 'k-flaky', { reputationScore: 0.8 });

  // Slashed to 0.55 -> TIER_3
  router.updatePeerReputation('flaky-peer', { success: false });
  assert.strictEqual(router.peerTable.get('flaky-peer').reputationScore, 0.55);
  assert.strictEqual(router.peerTable.get('flaky-peer').tier, 'TIER_3');

  // Re-registers without providing telemetry.reputationScore
  router.registerPeer('flaky-peer', 'k-flaky', { standbyReady: true });

  // Must retain slashed reputation score and tier, not reset to default 0.8 / TIER_2
  const rePeer = router.peerTable.get('flaky-peer');
  assert.strictEqual(rePeer.reputationScore, 0.55);
  assert.strictEqual(rePeer.tier, 'TIER_3');
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

test('Majority Consensus - key ordering invariance and canonical serialization in 2-of-3', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('c-node-1', 'ck1');
  router.registerPeer('c-node-2', 'ck2');
  router.registerPeer('c-node-3', 'ck3');

  // Node 1 and Node 2 return the same JSON data but with permuted object keys and nested structures
  const executions = [
    { peerId: 'c-node-1', output: { z: [1, 2], a: { deep: true, count: 10 } } },
    { peerId: 'c-node-2', output: { a: { count: 10, deep: true }, z: [1, 2] } },
    { peerId: 'c-node-3', output: { a: { count: 99, deep: true }, z: [1, 2] } }
  ];

  const consensus = router.evaluateConsensus(executions);

  assert.strictEqual(consensus.agreementRatio, 2 / 3);
  assert.deepStrictEqual(consensus.consensusPeers, ['c-node-1', 'c-node-2']);
  assert.deepStrictEqual(consensus.dissentingPeers, ['c-node-3']);
  assert.deepStrictEqual(consensus.consensusOutput, { z: [1, 2], a: { deep: true, count: 10 } });
});

test('Majority Consensus - preserves primitive, boolean, zero, empty string, and null outputs without falsy bugs', () => {
  const router = new GridRouter('coord-node');

  // Boolean false
  const execFalse = [
    { peerId: 'f1', output: false },
    { peerId: 'f2', output: false },
    { peerId: 'f3', output: true }
  ];
  const consFalse = router.evaluateConsensus(execFalse);
  assert.strictEqual(consFalse.consensusOutput, false);
  assert.strictEqual(consFalse.agreementRatio, 2 / 3);

  // Integer zero
  const execZero = [
    { peerId: 'z1', output: 0 },
    { peerId: 'z2', output: 0 },
    { peerId: 'z3', output: 1 }
  ];
  const consZero = router.evaluateConsensus(execZero);
  assert.strictEqual(consZero.consensusOutput, 0);

  // Empty string
  const execStr = [
    { peerId: 's1', output: '' },
    { peerId: 's2', output: '' },
    { peerId: 's3', output: 'non-empty' }
  ];
  const consStr = router.evaluateConsensus(execStr);
  assert.strictEqual(consStr.consensusOutput, '');

  // Null value
  const execNull = [
    { peerId: 'nl1', output: null },
    { peerId: 'nl2', output: null },
    { peerId: 'nl3', output: { err: true } }
  ];
  const consNull = router.evaluateConsensus(execNull);
  assert.strictEqual(consNull.consensusOutput, null);
});

test('Majority Consensus - Byzantine un-serializable output DoS immunity (circular structures and non-finite NaN)', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('honest-1', 'hk1', { reputationScore: 0.8 });
  router.registerPeer('honest-2', 'hk2', { reputationScore: 0.8 });
  router.registerPeer('byzantine-malicious', 'bk1', { reputationScore: 0.8 });

  // Byzantine node returns circular structure that crashes naive JSON serialization
  const circularObj = { val: 42 };
  circularObj.self = circularObj;

  const executionsCircular = [
    { peerId: 'honest-1', output: { answer: 42 } },
    { peerId: 'honest-2', output: { answer: 42 } },
    { peerId: 'byzantine-malicious', output: circularObj }
  ];

  const consCircular = router.evaluateConsensus(executionsCircular);
  assert.deepStrictEqual(consCircular.consensusOutput, { answer: 42 });
  assert.strictEqual(consCircular.agreementRatio, 2 / 3);
  assert.deepStrictEqual(consCircular.consensusPeers, ['honest-1', 'honest-2']);
  assert.deepStrictEqual(consCircular.dissentingPeers, ['byzantine-malicious']);
  assert.strictEqual(router.peerTable.get('byzantine-malicious').reputationScore, 0.55);

  // Byzantine node returns non-finite NaN
  const executionsNaN = [
    { peerId: 'honest-1', output: { answer: 42 } },
    { peerId: 'honest-2', output: { answer: 42 } },
    { peerId: 'byzantine-malicious', output: { corrupt: NaN } }
  ];

  const consNaN = router.evaluateConsensus(executionsNaN);
  assert.deepStrictEqual(consNaN.consensusOutput, { answer: 42 });
  assert.strictEqual(consNaN.agreementRatio, 2 / 3);
  assert.deepStrictEqual(consNaN.dissentingPeers, ['byzantine-malicious']);
});

test('Majority Consensus - Sybil attack defense: duplicate execution submissions from single peer rejected', () => {
  const router = new GridRouter('coord-node');

  // Attacker attempts to flood with duplicate outputs to fake a 2-of-3 majority
  const sybilExecutions = [
    { peerId: 'attacker-node', output: 'fake-result' },
    { peerId: 'attacker-node', output: 'fake-result' },
    { peerId: 'honest-node', output: 'real-result' }
  ];

  // With deduplication, effective executions are 2 (1 attacker, 1 honest).
  // Neither has majority (needs 2 of 2). Consensus must throw fail-closed.
  assert.throws(
    () => router.evaluateConsensus(sybilExecutions),
    /did not meet majority/i
  );
});

test('Majority Consensus - unanimous 3-of-3 agreement rewards all participating peers', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('u-1', 'uk1', { reputationScore: 0.8 });
  router.registerPeer('u-2', 'uk2', { reputationScore: 0.8 });
  router.registerPeer('u-3', 'uk3', { reputationScore: 0.8 });

  const executions = [
    { peerId: 'u-1', output: { status: 'verified' } },
    { peerId: 'u-2', output: { status: 'verified' } },
    { peerId: 'u-3', output: { status: 'verified' } }
  ];

  const consensus = router.evaluateConsensus(executions);
  assert.strictEqual(consensus.agreementRatio, 1.0);
  assert.deepStrictEqual(consensus.consensusPeers, ['u-1', 'u-2', 'u-3']);
  assert.deepStrictEqual(consensus.dissentingPeers, []);

  assert.strictEqual(router.peerTable.get('u-1').reputationScore, 0.85);
  assert.strictEqual(router.peerTable.get('u-2').reputationScore, 0.85);
  assert.strictEqual(router.peerTable.get('u-3').reputationScore, 0.85);
});

test('Majority Consensus - quorum configurations: 1-of-1, 2-of-2, 1-of-2 split, 2-of-4 split, and 3-of-5 with multiple dissenters', () => {
  const router = new GridRouter('coord-node');

  // 1-of-1 execution succeeds
  const exec1 = [{ peerId: 'single-node', output: 'solitary' }];
  const cons1 = router.evaluateConsensus(exec1);
  assert.strictEqual(cons1.agreementRatio, 1.0);
  assert.strictEqual(cons1.consensusOutput, 'solitary');

  // 2-of-2 execution succeeds
  const exec2Success = [
    { peerId: 'p-1', output: 'pair' },
    { peerId: 'p-2', output: 'pair' }
  ];
  const cons2 = router.evaluateConsensus(exec2Success);
  assert.strictEqual(cons2.agreementRatio, 1.0);

  // 1-of-2 split fails (majority needed: 2)
  const exec2Fail = [
    { peerId: 'p-1', output: 'pair-A' },
    { peerId: 'p-2', output: 'pair-B' }
  ];
  assert.throws(() => router.evaluateConsensus(exec2Fail), /did not meet majority/i);

  // 2-of-4 split fails (majority needed: 3)
  const exec4Tie = [
    { peerId: 'p1', output: 'A' },
    { peerId: 'p2', output: 'A' },
    { peerId: 'p3', output: 'B' },
    { peerId: 'p4', output: 'B' }
  ];
  assert.throws(() => router.evaluateConsensus(exec4Tie), /did not meet majority/i);

  // 3-of-5 consensus with 2 distinct dissenting peers
  router.registerPeer('n1', 'k1', { reputationScore: 0.8 });
  router.registerPeer('n2', 'k2', { reputationScore: 0.8 });
  router.registerPeer('n3', 'k3', { reputationScore: 0.8 });
  router.registerPeer('n4', 'k4', { reputationScore: 0.8 });
  router.registerPeer('n5', 'k5', { reputationScore: 0.8 });

  const exec5 = [
    { peerId: 'n1', output: 'alpha' },
    { peerId: 'n2', output: 'alpha' },
    { peerId: 'n3', output: 'alpha' },
    { peerId: 'n4', output: 'beta' },
    { peerId: 'n5', output: 'gamma' }
  ];

  const cons5 = router.evaluateConsensus(exec5);
  assert.strictEqual(cons5.consensusOutput, 'alpha');
  assert.strictEqual(cons5.agreementRatio, 3 / 5);
  assert.deepStrictEqual(cons5.consensusPeers, ['n1', 'n2', 'n3']);
  assert.deepStrictEqual(cons5.dissentingPeers, ['n4', 'n5']);

  // All consensus peers rewarded (+0.05 -> 0.85), both dissenting peers slashed (-0.25 -> 0.55)
  assert.strictEqual(router.peerTable.get('n1').reputationScore, 0.85);
  assert.strictEqual(router.peerTable.get('n2').reputationScore, 0.85);
  assert.strictEqual(router.peerTable.get('n3').reputationScore, 0.85);
  assert.strictEqual(router.peerTable.get('n4').reputationScore, 0.55);
  assert.strictEqual(router.peerTable.get('n5').reputationScore, 0.55);
});

test('Majority Consensus - supports workerId fallback and gracefully handles unregistered peers', () => {
  const router = new GridRouter('coord-node');
  router.registerPeer('reg-peer-1', 'rk1', { reputationScore: 0.8 });

  // 1 registered peer + 1 unregistered worker + 1 unregistered dissenter
  const executions = [
    { peerId: 'reg-peer-1', output: 'cluster-result' },
    { workerId: 'worker-node-2', output: 'cluster-result' },
    { workerId: 'worker-node-3', output: 'bad-result' }
  ];

  const consensus = router.evaluateConsensus(executions);
  assert.strictEqual(consensus.consensusOutput, 'cluster-result');
  assert.strictEqual(consensus.agreementRatio, 2 / 3);
  assert.deepStrictEqual(consensus.consensusPeers, ['reg-peer-1', 'worker-node-2']);
  assert.deepStrictEqual(consensus.dissentingPeers, ['worker-node-3']);

  // Registered peer receives reputation boost, unregistered workers are safely ignored without throwing
  assert.strictEqual(router.peerTable.get('reg-peer-1').reputationScore, 0.85);
});

test('Majority Consensus - fail-closed validation on empty, null, or malformed executions input', () => {
  const router = new GridRouter('coord-node');

  assert.throws(() => router.evaluateConsensus([]), /Invalid executions/i);
  assert.throws(() => router.evaluateConsensus(null), /Invalid executions/i);
  assert.throws(() => router.evaluateConsensus(undefined), /Invalid executions/i);
  assert.throws(() => router.evaluateConsensus('invalid-str'), /Invalid executions/i);
  assert.throws(() => router.evaluateConsensus(123), /Invalid executions/i);
});

test('Tiered Scheduling - IEEE-754 precision and deterministic tie-breaking in selectOptimalNodes', () => {
  const router = new GridRouter('coord-node');

  // Two peers where reputation difference is exactly 0.10 (0.85 - 0.75)
  // IEEE-754 produces 0.09999999999999998, which must be safely rounded to >= 0.1
  router.registerPeer('node-rep-high', 'kh', {
    standbyReady: true,
    reputationScore: 0.85,
    latencyMs: 80
  });

  router.registerPeer('node-rep-lower', 'kl', {
    standbyReady: true,
    reputationScore: 0.75,
    latencyMs: 10 // lower latency, but should NOT beat 0.10 reputation advantage
  });

  const selected = router.selectOptimalNodes('test-task-precision', 2);
  assert.strictEqual(selected[0].nodeId, 'node-rep-high', 'Node with 0.85 reputation must be selected first over 0.75');
  assert.strictEqual(selected[1].nodeId, 'node-rep-lower');
});
