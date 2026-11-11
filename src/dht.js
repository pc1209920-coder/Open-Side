'use strict';

const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const DEFAULT_K = 20; // Maximum contacts per bucket
const DEFAULT_ALPHA = 3; // Concurrency parameter for lookups
const ID_BITS = 160; // 160-bit key space (standard Kademlia / SHA-1 length, or 20 bytes)
const ID_BYTES = ID_BITS / 8; // 20 bytes

/**
 * Computes the 160-bit XOR distance metric between two binary Buffers.
 * Returns a Buffer of length ID_BYTES.
 * @param {Buffer} idA
 * @param {Buffer} idB
 * @returns {Buffer}
 */
function xorDistance(idA, idB) {
  if (!Buffer.isBuffer(idA) || !Buffer.isBuffer(idB)) {
    throw new TypeError('Node IDs for XOR distance must be Buffers');
  }
  if (idA.length !== ID_BYTES || idB.length !== ID_BYTES) {
    throw new RangeError(`Node IDs must be exactly ${ID_BYTES} bytes (${ID_BITS} bits)`);
  }
  const result = Buffer.alloc(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i++) {
    result[i] = idA[i] ^ idB[i];
  }
  return result;
}

/**
 * Compares two XOR distance Buffers.
 * Returns -1 if distA < distB, 1 if distA > distB, 0 if equal.
 * @param {Buffer} distA
 * @param {Buffer} distB
 * @returns {number}
 */
function compareDistance(distA, distB) {
  return Buffer.compare(distA, distB);
}

/**
 * Normalizes an arbitrary string or buffer ID to a 20-byte Node ID Buffer.
 * If input is a hex string of length 40, decodes it.
 * Otherwise hashes it with SHA-256 and takes first 20 bytes.
 * @param {string|Buffer} rawId
 * @returns {Buffer}
 */
function normalizeNodeId(rawId) {
  if (Buffer.isBuffer(rawId)) {
    if (rawId.length === ID_BYTES) return rawId;
    if (rawId.length > ID_BYTES) return rawId.subarray(0, ID_BYTES);
    return crypto.createHash('sha256').update(rawId).digest().subarray(0, ID_BYTES);
  }
  if (typeof rawId === 'string') {
    if (/^[0-9a-fA-F]{40}$/.test(rawId)) {
      return Buffer.from(rawId, 'hex');
    }
    return crypto.createHash('sha256').update(rawId, 'utf8').digest().subarray(0, ID_BYTES);
  }
  throw new TypeError('Invalid rawId: must be string or Buffer');
}

/**
 * Finds the index of the first bit that differs between localId and targetId (0 to 159).
 * Returns -1 if identical.
 * @param {Buffer} localId
 * @param {Buffer} targetId
 * @returns {number}
 */
function getBucketIndex(localId, targetId) {
  const dist = xorDistance(localId, targetId);
  for (let byteIdx = 0; byteIdx < ID_BYTES; byteIdx++) {
    const byte = dist[byteIdx];
    if (byte !== 0) {
      // Find leading zero bits in this byte
      for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
        if ((byte & (0x80 >> bitIdx)) !== 0) {
          return byteIdx * 8 + bitIdx;
        }
      }
    }
  }
  return -1; // Exact match (distance 0)
}

/**
 * KBucket represents a bucket of up to k contacts.
 * Implements LRU eviction replacement policy.
 */
class KBucket {
  constructor(index, k = DEFAULT_K) {
    this.index = index;
    this.k = k;
    this.contacts = []; // Ordered from least-recently-seen (head) to most-recently-seen (tail)
  }

  get length() {
    return this.contacts.length;
  }

  getContact(nodeId) {
    const idBuf = normalizeNodeId(nodeId);
    return this.contacts.find((c) => c.idBuffer.equals(idBuf)) || null;
  }

  /**
   * Adds or updates a contact.
   * If contact already exists, moves it to tail (most-recently seen).
   * If bucket is not full, appends to tail.
   * If full, returns { overflow: true, staleContact: oldestContact } so caller can ping oldest.
   * @param {object} contact
   * @returns {{ status: 'UPDATED'|'ADDED'|'FULL', staleContact?: object }}
   */
  add(contact) {
    if (!contact || !contact.id) {
      throw new TypeError('Invalid contact object: must contain id');
    }
    const idBuffer = normalizeNodeId(contact.id);
    const normalizedContact = {
      ...contact,
      id: idBuffer.toString('hex'),
      idBuffer,
      lastSeen: Date.now()
    };

    const existingIdx = this.contacts.findIndex((c) => c.idBuffer.equals(idBuffer));
    if (existingIdx !== -1) {
      // Move to end (most recently seen)
      this.contacts.splice(existingIdx, 1);
      this.contacts.push(normalizedContact);
      return { status: 'UPDATED', contact: normalizedContact };
    }

    if (this.contacts.length < this.k) {
      this.contacts.push(normalizedContact);
      return { status: 'ADDED', contact: normalizedContact };
    }

    // Bucket is full; oldest is at index 0
    return {
      status: 'FULL',
      staleContact: this.contacts[0],
      candidateContact: normalizedContact
    };
  }

  /**
   * Removes a contact by id.
   * @param {string|Buffer} nodeId
   * @returns {boolean}
   */
  remove(nodeId) {
    const idBuf = normalizeNodeId(nodeId);
    const idx = this.contacts.findIndex((c) => c.idBuffer.equals(idBuf));
    if (idx !== -1) {
      this.contacts.splice(idx, 1);
      return true;
    }
    return false;
  }
}

/**
 * RoutingTable manages 160 KBuckets for Kademlia routing.
 */
class RoutingTable extends EventEmitter {
  constructor(localId, options = {}) {
    super();
    this.localIdBuffer = normalizeNodeId(localId);
    this.localId = this.localIdBuffer.toString('hex');
    this.k = options.k || DEFAULT_K;

    // 160 buckets for 160 bit distance
    this.buckets = [];
    for (let i = 0; i < ID_BITS; i++) {
      this.buckets.push(new KBucket(i, this.k));
    }
  }

  /**
   * Returns total contact count across all buckets.
   * @returns {number}
   */
  get size() {
    return this.buckets.reduce((acc, b) => acc + b.length, 0);
  }

  /**
   * Adds or updates a contact in the appropriate bucket.
   * @param {object} contact { id, address, port, ... }
   * @returns {object} Result from bucket addition
   */
  addContact(contact) {
    if (!contact || !contact.id) {
      throw new TypeError('Invalid contact: missing id');
    }
    const targetBuffer = normalizeNodeId(contact.id);
    if (targetBuffer.equals(this.localIdBuffer)) {
      return { status: 'SELF_IGNORED' };
    }

    const bucketIdx = getBucketIndex(this.localIdBuffer, targetBuffer);
    if (bucketIdx < 0 || bucketIdx >= ID_BITS) {
      return { status: 'SELF_IGNORED' };
    }

    const bucket = this.buckets[bucketIdx];
    const res = bucket.add(contact);
    if (res.status === 'ADDED' || res.status === 'UPDATED') {
      this.emit('contactUpdated', res.contact || contact);
    }
    return res;
  }

  /**
   * Removes a contact from the routing table.
   * @param {string|Buffer} nodeId
   * @returns {boolean}
   */
  removeContact(nodeId) {
    const targetBuffer = normalizeNodeId(nodeId);
    const bucketIdx = getBucketIndex(this.localIdBuffer, targetBuffer);
    if (bucketIdx < 0 || bucketIdx >= ID_BITS) return false;

    const removed = this.buckets[bucketIdx].remove(targetBuffer);
    if (removed) {
      this.emit('contactRemoved', targetBuffer.toString('hex'));
    }
    return removed;
  }

  /**
   * Finds the k closest contacts to a given targetId according to XOR distance.
   * @param {string|Buffer} targetId
   * @param {number} [count] Defaults to k
   * @returns {Array<object>} Sorted by XOR distance ascending
   */
  findClosestNodes(targetId, count = this.k) {
    const targetBuffer = normalizeNodeId(targetId);
    const allContacts = [];

    for (const bucket of this.buckets) {
      for (const contact of bucket.contacts) {
        const dist = xorDistance(contact.idBuffer, targetBuffer);
        allContacts.push({ contact, dist });
      }
    }

    allContacts.sort((a, b) => compareDistance(a.dist, b.dist));
    return allContacts.slice(0, count).map((item) => item.contact);
  }

  /**
   * Returns all contacts in the table.
   * @returns {Array<object>}
   */
  getAllContacts() {
    const list = [];
    for (const b of this.buckets) {
      for (const c of b.contacts) {
        list.push(c);
      }
    }
    return list;
  }
}

/**
 * KademliaDHT
 * Zero-dependency Kademlia Distributed Hash Table node.
 * Provides distributed key-value storage, peer auto-discovery, and k-closest routing.
 */
class KademliaDHT extends EventEmitter {
  constructor(localId, options = {}) {
    super();
    this.localIdBuffer = normalizeNodeId(localId);
    this.localId = this.localIdBuffer.toString('hex');
    this.k = options.k || DEFAULT_K;
    this.alpha = options.alpha || DEFAULT_ALPHA;
    this.storageTtlMs = options.storageTtlMs || 3600000; // 1 hour default TTL for stored values

    this.routingTable = new RoutingTable(this.localIdBuffer, { k: this.k });
    // Local key-value store: key (hex/string) -> { value, publisher, storedAt, expiresAt }
    this.store = new Map();

    // RPC transport hook: function(targetContact, rpcType, payload) => Promise<response>
    this.rpcHandler = typeof options.rpcHandler === 'function' ? options.rpcHandler : null;
  }

  setRpcHandler(fn) {
    if (typeof fn !== 'function') throw new TypeError('RPC handler must be a function');
    this.rpcHandler = fn;
  }

  /**
   * Bootstraps the node by connecting to known seed peers.
   * Discovers peers closest to self to populate local routing table.
   * @param {Array<object>} bootstrapNodes
   * @returns {Promise<number>} Number of successfully contacted nodes
   */
  async bootstrap(bootstrapNodes = []) {
    if (!Array.isArray(bootstrapNodes)) {
      throw new TypeError('bootstrapNodes must be an Array');
    }

    let added = 0;
    for (const node of bootstrapNodes) {
      if (node && node.id) {
        const res = this.routingTable.addContact(node);
        if (res.status === 'ADDED' || res.status === 'UPDATED') {
          added++;
        }
      }
    }

    // If RPC handler is present, perform self lookup to populate nearby buckets
    if (this.rpcHandler && added > 0) {
      await this.lookupNode(this.localId);
    }

    this.emit('bootstrapped', { addedContacts: added });
    return added;
  }

  /**
   * Stores a key-value pair locally with TTL.
   * @param {string} key
   * @param {*} value
   * @param {object} [options]
   */
  storeLocal(key, value, options = {}) {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('Invalid key: must be a non-empty string');
    }
    const ttl = options.ttlMs || this.storageTtlMs;
    const now = Date.now();
    const entry = {
      key,
      value,
      publisher: options.publisher || this.localId,
      storedAt: now,
      expiresAt: now + ttl
    };
    this.store.set(key, entry);
    this.emit('valueStored', { key, publisher: entry.publisher });
    return entry;
  }

  /**
   * Retrieves a value from local storage, checking expiry.
   * @param {string} key
   * @returns {*|null}
   */
  getLocal(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Handles an incoming RPC message from a remote peer.
   * Returns response payload object.
   * @param {string} rpcType 'PING' | 'STORE' | 'FIND_NODE' | 'FIND_VALUE'
   * @param {object} senderContact { id, ... }
   * @param {object} payload
   * @returns {object}
   */
  handleRpc(rpcType, senderContact, payload = {}) {
    if (!senderContact || !senderContact.id) {
      throw new TypeError('Invalid RPC: missing senderContact');
    }

    // Refresh sender in routing table
    this.routingTable.addContact(senderContact);

    switch (rpcType) {
      case 'PING':
        return { type: 'PONG', responderId: this.localId };

      case 'STORE': {
        const { key, value, ttlMs } = payload;
        if (!key) throw new Error('STORE RPC requires key');
        this.storeLocal(key, value, { publisher: senderContact.id, ttlMs });
        return { type: 'STORE_OK', stored: true };
      }

      case 'FIND_NODE': {
        const { targetId } = payload;
        const closest = this.routingTable.findClosestNodes(targetId || senderContact.id, this.k);
        return {
          type: 'NODES',
          nodes: closest.map((c) => ({ id: c.id, address: c.address, port: c.port }))
        };
      }

      case 'FIND_VALUE': {
        const { key } = payload;
        const localVal = this.getLocal(key);
        if (localVal !== null && localVal !== undefined) {
          return { type: 'VALUE', key, value: localVal };
        }
        // Not found locally; return k closest nodes to key
        const closest = this.routingTable.findClosestNodes(key, this.k);
        return {
          type: 'NODES',
          nodes: closest.map((c) => ({ id: c.id, address: c.address, port: c.port }))
        };
      }

      default:
        throw new Error(`Unknown RPC type: ${rpcType}`);
    }
  }

  /**
   * Iterative lookup algorithm to find k closest nodes to targetId.
   * Queries peers in parallel with alpha concurrency.
   * @param {string|Buffer} targetId
   * @returns {Promise<Array<object>>}
   */
  async lookupNode(targetId) {
    if (!this.rpcHandler) {
      return this.routingTable.findClosestNodes(targetId, this.k);
    }

    const targetKey = typeof targetId === 'string' ? targetId : targetId.toString('hex');
    const targetBuffer = normalizeNodeId(targetId);

    // Initial shortlist: alpha closest from local routing table
    const shortlist = this.routingTable.findClosestNodes(targetBuffer, this.alpha);
    const contacted = new Set();
    const candidateMap = new Map();

    for (const c of shortlist) {
      candidateMap.set(c.id, c);
    }

    let unqueried = shortlist.filter((c) => !contacted.has(c.id));

    while (unqueried.length > 0) {
      // Pick up to alpha unqueried nodes closest to target
      const batch = unqueried
        .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, targetBuffer) }))
        .sort((a, b) => compareDistance(a.dist, b.dist))
        .slice(0, this.alpha)
        .map((item) => item.contact);

      const promises = batch.map(async (peer) => {
        contacted.add(peer.id);
        try {
          const res = await this.rpcHandler(peer, 'FIND_NODE', { targetId: targetKey });
          if (res && Array.isArray(res.nodes)) {
            for (const n of res.nodes) {
              if (n && n.id && n.id !== this.localId && !candidateMap.has(n.id)) {
                this.routingTable.addContact(n);
                candidateMap.set(n.id, {
                  ...n,
                  idBuffer: normalizeNodeId(n.id)
                });
              }
            }
          }
        } catch {
          // Unreachable peer; remove or mark failed
          this.routingTable.removeContact(peer.id);
        }
      });

      await Promise.all(promises);

      // Refresh unqueried
      unqueried = Array.from(candidateMap.values()).filter((c) => !contacted.has(c.id));
      if (unqueried.length === 0 || contacted.size >= this.k) {
        break;
      }
    }

    // Return k closest from all discovered candidates
    const allCandidates = Array.from(candidateMap.values())
      .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, targetBuffer) }))
      .sort((a, b) => compareDistance(a.dist, b.dist))
      .slice(0, this.k)
      .map((item) => item.contact);

    return allCandidates;
  }

  /**
   * Iterative lookup for a value stored across the DHT.
   * If value is found, returns { found: true, value, provider }.
   * If not found, returns { found: false, closestNodes }.
   * @param {string} key
   * @returns {Promise<{ found: boolean, value?: any, closestNodes?: Array<object> }>}
   */
  async lookupValue(key) {
    const local = this.getLocal(key);
    if (local !== null && local !== undefined) {
      return { found: true, value: local, provider: this.localId };
    }

    if (!this.rpcHandler) {
      return { found: false, closestNodes: this.routingTable.findClosestNodes(key, this.k) };
    }

    const keyBuffer = normalizeNodeId(key);
    const shortlist = this.routingTable.findClosestNodes(keyBuffer, this.alpha);
    const contacted = new Set();
    const candidateMap = new Map();

    for (const c of shortlist) {
      candidateMap.set(c.id, c);
    }

    let unqueried = shortlist.filter((c) => !contacted.has(c.id));

    while (unqueried.length > 0) {
      const batch = unqueried.slice(0, this.alpha);
      let foundValue = null;
      let valueProvider = null;

      const promises = batch.map(async (peer) => {
        contacted.add(peer.id);
        try {
          const res = await this.rpcHandler(peer, 'FIND_VALUE', { key });
          if (res && res.type === 'VALUE') {
            foundValue = res.value;
            valueProvider = peer.id;
          } else if (res && Array.isArray(res.nodes)) {
            for (const n of res.nodes) {
              if (n && n.id && n.id !== this.localId && !candidateMap.has(n.id)) {
                this.routingTable.addContact(n);
                candidateMap.set(n.id, {
                  ...n,
                  idBuffer: normalizeNodeId(n.id)
                });
              }
            }
          }
        } catch {
          this.routingTable.removeContact(peer.id);
        }
      });

      await Promise.all(promises);

      if (foundValue !== null && foundValue !== undefined) {
        // Cache value locally (Kademlia caching heuristic)
        this.storeLocal(key, foundValue);
        return { found: true, value: foundValue, provider: valueProvider };
      }

      unqueried = Array.from(candidateMap.values()).filter((c) => !contacted.has(c.id));
      if (unqueried.length === 0 || contacted.size >= this.k) {
        break;
      }
    }

    const closestNodes = Array.from(candidateMap.values())
      .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, keyBuffer) }))
      .sort((a, b) => compareDistance(a.dist, b.dist))
      .slice(0, this.k)
      .map((item) => item.contact);

    return { found: false, closestNodes };
  }

  /**
   * Distributes a key-value pair to the k closest nodes to the key across the DHT.
   * @param {string} key
   * @param {*} value
   * @param {object} [options]
   * @returns {Promise<{ storedNodes: number, targetNodes: number }>}
   */
  async storeValue(key, value, options = {}) {
    this.storeLocal(key, value, options);

    if (!this.rpcHandler) {
      return { storedNodes: 1, targetNodes: 1 };
    }

    const closestNodes = await this.lookupNode(key);
    let successfulStores = 1; // Count local node

    const storePromises = closestNodes.map(async (peer) => {
      try {
        const res = await this.rpcHandler(peer, 'STORE', {
          key,
          value,
          ttlMs: options.ttlMs || this.storageTtlMs
        });
        if (res && res.stored) {
          successfulStores++;
        }
      } catch {
        // Failure on single node does not abort distribution
      }
    });

    await Promise.all(storePromises);
    return { storedNodes: successfulStores, targetNodes: closestNodes.length + 1 };
  }
}

module.exports = {
  KademliaDHT,
  RoutingTable,
  KBucket,
  xorDistance,
  compareDistance,
  normalizeNodeId,
  getBucketIndex,
  DEFAULT_K,
  DEFAULT_ALPHA,
  ID_BITS,
  ID_BYTES
};
