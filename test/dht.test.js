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
  ID_BYTES
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
