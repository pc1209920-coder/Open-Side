'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  KademliaDHT,
  RoutingTable,
  KBucket,
  xorDistance,
  compareDistance,
  normalizeNodeId,
  getBucketIndex,
  ID_BYTES,
  ID_BITS
} = require('../src/dht');

test('XOR Distance Metric - calculates bitwise XOR distance and symmetry', () => {
  const idA = Buffer.alloc(ID_BYTES, 0x0f);
  const idB = Buffer.alloc(ID_BYTES, 0xf0);

  const distAB = xorDistance(idA, idB);
  const distBA = xorDistance(idB, idA);

  assert.deepStrictEqual(distAB, distBA, 'XOR distance must be symmetric');
  assert.strictEqual(distAB[0], 0xff, '0x0f ^ 0xf0 should equal 0xff');

  const distIdentical = xorDistance(idA, idA);
  assert.deepStrictEqual(distIdentical, Buffer.alloc(ID_BYTES, 0), 'Distance to self must be 0');
});

test('XOR Distance Metric - triangle inequality d(x, y) <= d(x, z) ^ d(z, y)', () => {
  const x = crypto.randomBytes(ID_BYTES);
  const y = crypto.randomBytes(ID_BYTES);
  const z = crypto.randomBytes(ID_BYTES);

  const dXY = xorDistance(x, y);
  const dXZ = xorDistance(x, z);
  const dZY = xorDistance(z, y);

  const dX_Z_Y = Buffer.alloc(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i++) {
    dX_Z_Y[i] = dXZ[i] ^ dZY[i];
  }

  // In XOR metric, d(x, y) = d(x, z) ^ d(z, y) exactly
  assert.deepStrictEqual(dXY, dX_Z_Y);
});

test('normalizeNodeId - converts 40-char hex, byte buffers, and strings consistently', () => {
  const hex = '0123456789abcdef0123456789abcdef01234567';
  const buf = normalizeNodeId(hex);
  assert.strictEqual(buf.length, ID_BYTES);
  assert.strictEqual(buf.toString('hex'), hex);

  const str = 'peer-identity-name-abc';
  const bufFromStr = normalizeNodeId(str);
  assert.strictEqual(bufFromStr.length, ID_BYTES);
});

test('getBucketIndex - maps distance to appropriate 0-159 bucket index', () => {
  const base = Buffer.alloc(ID_BYTES, 0x00);

  // Differ at first bit (0x80 = 1000 0000)
  const diffBit0 = Buffer.alloc(ID_BYTES, 0x00);
  diffBit0[0] = 0x80;
  assert.strictEqual(getBucketIndex(base, diffBit0), 0);

  // Differ at bit 1 (0x40 = 0100 0000)
  const diffBit1 = Buffer.alloc(ID_BYTES, 0x00);
  diffBit1[0] = 0x40;
  assert.strictEqual(getBucketIndex(base, diffBit1), 1);

  // Differ at bit 8 (byte 1, bit 0)
  const diffBit8 = Buffer.alloc(ID_BYTES, 0x00);
  diffBit8[1] = 0x80;
  assert.strictEqual(getBucketIndex(base, diffBit8), 8);

  // Identical returns -1
  assert.strictEqual(getBucketIndex(base, base), -1);
});

test('KBucket - LRU eviction, duplicate updates, and capacity bounds', () => {
  const bucket = new KBucket(0, 3); // k = 3
  const c1 = { id: '0000000000000000000000000000000000000001', address: '127.0.0.1', port: 1001 };
  const c2 = { id: '0000000000000000000000000000000000000002', address: '127.0.0.1', port: 1002 };
  const c3 = { id: '0000000000000000000000000000000000000003', address: '127.0.0.1', port: 1003 };
  const c4 = { id: '0000000000000000000000000000000000000004', address: '127.0.0.1', port: 1004 };

  assert.strictEqual(bucket.add(c1).status, 'ADDED');
  assert.strictEqual(bucket.add(c2).status, 'ADDED');
  assert.strictEqual(bucket.add(c3).status, 'ADDED');
  assert.strictEqual(bucket.length, 3);

  // Existing contact updated: moves to tail (MRU)
  const updateRes = bucket.add(c1);
  assert.strictEqual(updateRes.status, 'UPDATED');
  assert.strictEqual(bucket.contacts[2].id, c1.id);

  // New contact when full returns FULL with oldest contact for ping verification
  const fullRes = bucket.add(c4);
  assert.strictEqual(fullRes.status, 'FULL');
  assert.strictEqual(fullRes.staleContact.id, c2.id); // c2 is now oldest
});

test('RoutingTable - findClosestNodes ranks peers strictly by XOR distance', () => {
  const localId = '0000000000000000000000000000000000000000';
  const table = new RoutingTable(localId, { k: 20 });

  // Add 10 random contacts
  const contacts = [];
  for (let i = 1; i <= 10; i++) {
    const id = i.toString(16).padStart(40, '0');
    contacts.push({ id, address: '127.0.0.1', port: 5000 + i });
  }

  for (const c of contacts) {
    table.addContact(c);
  }

  assert.strictEqual(table.size, 10);

  // Target close to 0000...0005
  const targetId = '0000000000000000000000000000000000000005';
  const closest = table.findClosestNodes(targetId, 3);

  assert.strictEqual(closest.length, 3);
  assert.strictEqual(closest[0].id, targetId, 'Distance 0 must be first');
  // Check that distances are strictly ascending
  const targetBuf = normalizeNodeId(targetId);
  const dist0 = xorDistance(closest[0].idBuffer, targetBuf);
  const dist1 = xorDistance(closest[1].idBuffer, targetBuf);
  const dist2 = xorDistance(closest[2].idBuffer, targetBuf);

  assert.ok(compareDistance(dist0, dist1) <= 0);
  assert.ok(compareDistance(dist1, dist2) <= 0);
});

test('KademliaDHT - Local store and get with TTL expiration', async () => {
  const dht = new KademliaDHT('peer-local-node-1', { storageTtlMs: 50 });

  dht.storeLocal('key:model:weights', { layer1: [1, 2, 3] }, { ttlMs: 40 });
  const val = dht.getLocal('key:model:weights');
  assert.deepStrictEqual(val, { layer1: [1, 2, 3] });

  // Wait for TTL expiration
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(dht.getLocal('key:model:weights'), null);
});

test('KademliaDHT - RPC Handling (PING, STORE, FIND_NODE, FIND_VALUE)', () => {
  const dht = new KademliaDHT('1111111111111111111111111111111111111111');
  const sender = { id: '2222222222222222222222222222222222222222', address: '127.0.0.1', port: 9001 };

  // PING
  const pong = dht.handleRpc('PING', sender);
  assert.strictEqual(pong.type, 'PONG');
  assert.strictEqual(pong.responderId, dht.localId);

  // STORE
  const storeRes = dht.handleRpc('STORE', sender, { key: 'task:hash:99', value: { status: 'READY' } });
  assert.strictEqual(storeRes.type, 'STORE_OK');
  assert.deepStrictEqual(dht.getLocal('task:hash:99'), { status: 'READY' });

  // FIND_VALUE found
  const findValRes = dht.handleRpc('FIND_VALUE', sender, { key: 'task:hash:99' });
  assert.strictEqual(findValRes.type, 'VALUE');
  assert.deepStrictEqual(findValRes.value, { status: 'READY' });

  // FIND_VALUE not found returns closest NODES
  const findMissing = dht.handleRpc('FIND_VALUE', sender, { key: 'missing:key' });
  assert.strictEqual(findMissing.type, 'NODES');
  assert.ok(Array.isArray(findMissing.nodes));

  // FIND_NODE
  const findNodeRes = dht.handleRpc('FIND_NODE', sender, { targetId: '3333333333333333333333333333333333333333' });
  assert.strictEqual(findNodeRes.type, 'NODES');
  assert.ok(Array.isArray(findNodeRes.nodes));
});

test('KademliaDHT - Iterative Distributed Network Simulation (Bootstrap, Multi-hop Lookup & Store)', async () => {
  // Create a mesh of 5 DHT nodes
  const nodes = [];
  const nodeMap = new Map();

  for (let i = 0; i < 5; i++) {
    const id = (i + 1).toString(16).repeat(40).slice(0, 40);
    const dht = new KademliaDHT(id, { k: 4, alpha: 2 });
    nodes.push(dht);
    nodeMap.set(dht.localId, dht);
  }

  // Interconnect nodes with simulated RPC handler
  for (const node of nodes) {
    node.setRpcHandler(async (targetContact, rpcType, payload) => {
      const targetNode = nodeMap.get(targetContact.id);
      if (!targetNode) throw new Error(`Node ${targetContact.id} unreachable`);
      return targetNode.handleRpc(rpcType, { id: node.localId, address: '127.0.0.1' }, payload);
    });
  }

  // Bootstrap nodes in a daisy/mesh pattern:
  // Node 1 connects to Node 0
  // Node 2 connects to Node 1, etc.
  for (let i = 1; i < nodes.length; i++) {
    await nodes[i].bootstrap([{ id: nodes[i - 1].localId, address: '127.0.0.1' }]);
  }

  // Node 0 stores a distributed value targeting a key
  const targetKey = 'global:shard:manifest:v1';
  const testPayload = { manifestId: 'm-900', shards: 16 };
  await nodes[0].storeValue(targetKey, testPayload);

  // Node 4 (furthest node) performs iterative lookup for targetKey
  const lookupRes = await nodes[4].lookupValue(targetKey);
  assert.strictEqual(lookupRes.found, true);
  assert.deepStrictEqual(lookupRes.value, testPayload);
});

test('RoutingTable Stress - High churn, capacity bounds, and XOR monotonic ordering under load', () => {
  const localId = crypto.randomBytes(ID_BYTES);
  const kVal = 5;
  const rt = new RoutingTable(localId, { k: kVal });

  // 1. High-volume insertion: insert 500 contacts
  for (let i = 0; i < 500; i++) {
    rt.addContact({ id: crypto.randomBytes(ID_BYTES), address: '127.0.0.1', port: 1000 + i });
  }

  // 2. Capacity bounds verification
  assert.ok(rt.size <= ID_BITS * kVal, 'Routing table total size must never exceed 160 * k');
  let totalInBuckets = 0;
  for (const bucket of rt.buckets) {
    assert.ok(bucket.length <= kVal, `KBucket must not exceed k=${kVal}`);
    totalInBuckets += bucket.length;
  }
  assert.strictEqual(rt.size, totalInBuckets, 'rt.size must match sum of bucket lengths');

  // 3. Monotonic XOR distance ordering under load
  for (let q = 0; q < 20; q++) {
    const target = crypto.randomBytes(ID_BYTES);
    const closest = rt.findClosestNodes(target, 10);
    const targetBuf = normalizeNodeId(target);
    for (let i = 0; i < closest.length - 1; i++) {
      const d1 = xorDistance(closest[i].idBuffer, targetBuf);
      const d2 = xorDistance(closest[i + 1].idBuffer, targetBuf);
      assert.ok(compareDistance(d1, d2) <= 0, 'findClosestNodes must maintain non-decreasing XOR distance order');
    }
  }

  // 4. High churn stress: add, delete, and re-add contacts
  const churnContacts = [];
  for (let i = 0; i < 100; i++) {
    const c = { id: crypto.randomBytes(ID_BYTES), address: '127.0.0.1', port: 5000 + i };
    churnContacts.push(c);
    rt.addContact(c);
  }
  const sizeBeforeRemoval = rt.size;
  let removedCount = 0;
  for (let i = 0; i < 50; i++) {
    if (rt.removeContact(churnContacts[i].id)) {
      removedCount++;
    }
  }
  assert.ok(rt.size <= sizeBeforeRemoval, 'rt.size must not increase upon contact removals');
  let currentTotal = 0;
  for (const bucket of rt.buckets) currentTotal += bucket.length;
  assert.strictEqual(rt.size, currentTotal, 'rt.size must match sum of bucket lengths');
  for (let i = 0; i < 50; i++) {
    const targetBuf = normalizeNodeId(churnContacts[i].id);
    const inTable = rt.getAllContacts().some((c) => c.idBuffer.equals(targetBuf));
    assert.strictEqual(inTable, false, 'Removed contact must not appear in table');
  }
});

test('RoutingTable Bucket Partitioning & Boundary Logic - Full 160-bit prefix coverage and overflow', () => {
  const baseId = Buffer.alloc(ID_BYTES, 0x00);
  const rt = new RoutingTable(baseId, { k: 2 });

  // 1. Verify coverage across all 160 bucket positions (bit 0 through 159)
  for (let bit = 0; bit < ID_BITS; bit++) {
    const peerId = Buffer.alloc(ID_BYTES, 0x00);
    const byteIdx = Math.floor(bit / 8);
    const bitInByte = bit % 8;
    peerId[byteIdx] = 1 << (7 - bitInByte);

    const calculatedIdx = getBucketIndex(baseId, peerId);
    assert.strictEqual(calculatedIdx, bit, `Bit ${bit} must map to bucket index ${bit}`);

    const res = rt.addContact({ id: peerId, address: '127.0.0.1', port: 8000 + bit });
    assert.strictEqual(res.status, 'ADDED', `Adding peer differing at bit ${bit} should succeed`);
    assert.strictEqual(rt.buckets[bit].length, 1, `Bucket ${bit} should have length 1`);
  }
  assert.strictEqual(rt.size, 160, 'Table should have 160 contacts across all buckets');

  // 2. Boundary conditions: Bit 0 (MSB) and Bit 159 (LSB)
  const msbDiff = Buffer.alloc(ID_BYTES, 0x00);
  msbDiff[0] = 0x80;
  assert.strictEqual(getBucketIndex(baseId, msbDiff), 0, 'MSB differing must be bucket 0');

  const lsbDiff = Buffer.alloc(ID_BYTES, 0x00);
  lsbDiff[ID_BYTES - 1] = 0x01;
  assert.strictEqual(getBucketIndex(baseId, lsbDiff), 159, 'LSB differing must be bucket 159');

  // 3. Bucket overflow & replacement policy verification
  const overflowRt = new RoutingTable(baseId, { k: 2 });
  const c1 = { id: Buffer.from('80' + '00'.repeat(19), 'hex'), address: '127.0.0.1', port: 9001 };
  const c2 = { id: Buffer.from('81' + '00'.repeat(19), 'hex'), address: '127.0.0.1', port: 9002 };
  const c3 = { id: Buffer.from('82' + '00'.repeat(19), 'hex'), address: '127.0.0.1', port: 9003 };

  assert.strictEqual(overflowRt.addContact(c1).status, 'ADDED');
  assert.strictEqual(overflowRt.addContact(c2).status, 'ADDED');
  assert.strictEqual(overflowRt.buckets[0].length, 2);

  // Third contact targeting full bucket returns FULL and identifies staleContact
  const fullRes = overflowRt.addContact(c3);
  assert.strictEqual(fullRes.status, 'FULL');
  assert.strictEqual(fullRes.staleContact.id, c1.id.toString('hex'));
  assert.strictEqual(overflowRt.buckets[0].length, 2);

  // Evict stale contact and verify candidate in replacementCache is automatically promoted
  assert.strictEqual(overflowRt.removeContact(c1.id), true);
  assert.strictEqual(overflowRt.buckets[0].length, 2);
  assert.strictEqual(overflowRt.buckets[0].contacts[1].id, c3.id.toString('hex'), 'Candidate c3 should be promoted from replacementCache');
  // Re-adding c3 updates its timestamp as it is already present
  assert.strictEqual(overflowRt.addContact(c3).status, 'UPDATED');

  // 4. Self-node ignore invariant
  const selfRes = overflowRt.addContact({ id: baseId, address: '127.0.0.1', port: 9099 });
  assert.strictEqual(selfRes.status, 'SELF_IGNORED');
});

test('KademliaDHT - Concurrent Incoming RPC Stress and Race Handling', async () => {
  const dht = new KademliaDHT(crypto.randomBytes(ID_BYTES));

  // 1. Fire 100 concurrent incoming RPC requests across all supported methods
  const rpcPromises = [];
  for (let i = 0; i < 100; i++) {
    const sender = { id: crypto.randomBytes(ID_BYTES), address: '127.0.0.1', port: 7000 + i };
    const rpcType = ['PING', 'STORE', 'FIND_NODE', 'FIND_VALUE'][i % 4];
    rpcPromises.push(Promise.resolve().then(() => {
      return dht.handleRpc(rpcType, sender, {
        key: `concurrent:store:key:${i % 10}`,
        value: { idx: i, payload: `test-data-${i}` },
        targetId: sender.id
      });
    }));
  }

  const responses = await Promise.all(rpcPromises);
  assert.strictEqual(responses.length, 100, 'All 100 concurrent RPCs must settle');
  for (const resp of responses) {
    assert.ok(resp && resp.type, 'Each RPC response must have a valid type');
  }

  // 2. Simultaneous STORE and FIND_VALUE race conditions on the same key
  const raceKey = 'concurrent:race:key:shared';
  const racePromises = [];
  for (let i = 0; i < 20; i++) {
    const sender = { id: crypto.randomBytes(ID_BYTES), address: '127.0.0.1', port: 8500 + i };
    racePromises.push(Promise.resolve().then(() => {
      dht.handleRpc('STORE', sender, { key: raceKey, value: { updateId: i } });
    }));
    racePromises.push(Promise.resolve().then(() => {
      return dht.handleRpc('FIND_VALUE', sender, { key: raceKey });
    }));
  }

  const raceResults = await Promise.all(racePromises);
  assert.strictEqual(raceResults.length, 40, 'All concurrent race operations must complete');
  const finalVal = dht.getLocal(raceKey);
  assert.ok(finalVal && typeof finalVal.updateId === 'number', 'Key must hold valid final update');
});

test('KademliaDHT - Multi-node Network Concurrency with Latency Jitter and Peer Failures', async () => {
  const nodeCount = 5;
  const nodes = [];
  const nodeMap = new Map();

  for (let i = 0; i < nodeCount; i++) {
    const id = Buffer.alloc(ID_BYTES, i + 1);
    const dht = new KademliaDHT(id, { k: 4, alpha: 2 });
    nodes.push(dht);
    nodeMap.set(dht.localId, dht);
  }

  // Define one peer that fails intermittently/unreachable
  const failingPeerId = nodes[3].localId;

  for (const node of nodes) {
    node.setRpcHandler(async (targetContact, rpcType, payload) => {
      // Simulate network latency jitter (1-5ms)
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5) + 1));

      if (targetContact.id === failingPeerId) {
        throw new Error('RPC connection refused: peer crashed');
      }

      const targetNode = nodeMap.get(targetContact.id);
      if (!targetNode) throw new Error(`Node ${targetContact.id} unreachable`);
      return targetNode.handleRpc(rpcType, { id: node.localId, address: '127.0.0.1' }, payload);
    });
  }

  // Bootstrap reachable nodes together
  await nodes[1].bootstrap([{ id: nodes[0].localId, address: '127.0.0.1' }]);
  await nodes[2].bootstrap([{ id: nodes[1].localId, address: '127.0.0.1' }]);
  // Also add failing node 3 to routing tables so peers encounter it during concurrent lookups
  nodes[0].routingTable.addContact({ id: nodes[3].localId, address: '127.0.0.1' });
  nodes[1].routingTable.addContact({ id: nodes[3].localId, address: '127.0.0.1' });
  nodes[2].routingTable.addContact({ id: nodes[3].localId, address: '127.0.0.1' });
  // Node 4 bootstraps to reachable node 2
  await nodes[4].bootstrap([{ id: nodes[2].localId, address: '127.0.0.1' }]);

  // Concurrently store multiple values from multiple origins
  const storeOps = [];
  for (let i = 0; i < 5; i++) {
    storeOps.push(nodes[0].storeValue(`dataset:partition:${i}`, { partition: i, ready: true }));
    storeOps.push(nodes[1].storeValue(`model:weights:${i}`, { layer: i, converged: true }));
  }
  await Promise.all(storeOps);

  // Concurrently perform iterative lookups across healthy nodes
  const lookupOps = [];
  for (let i = 0; i < 5; i++) {
    lookupOps.push(nodes[2].lookupValue(`dataset:partition:${i}`));
    lookupOps.push(nodes[4].lookupValue(`model:weights:${i}`));
  }
  const lookupResults = await Promise.all(lookupOps);

  for (let i = 0; i < 5; i++) {
    const datasetRes = lookupResults[i * 2];
    const modelRes = lookupResults[i * 2 + 1];
    assert.strictEqual(datasetRes.found, true);
    assert.deepStrictEqual(datasetRes.value, { partition: i, ready: true });
    assert.strictEqual(modelRes.found, true);
    assert.deepStrictEqual(modelRes.value, { layer: i, converged: true });
  }

  for (const node of nodes) {
    if (typeof node.destroy === 'function') {
      node.destroy();
    }
  }
});
