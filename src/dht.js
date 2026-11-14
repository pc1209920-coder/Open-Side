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
 * Defensively copies buffer instances to prevent mutation leaks.
 * If input is a hex string of length 40, decodes it.
 * Otherwise hashes it with SHA-256 and takes first 20 bytes.
 * @param {string|Buffer|Uint8Array} rawId
 * @returns {Buffer}
 */
function normalizeNodeId(rawId) {
  if (Buffer.isBuffer(rawId)) {
    if (rawId.length === ID_BYTES) return Buffer.from(rawId);
    if (rawId.length > ID_BYTES) return Buffer.from(rawId.subarray(0, ID_BYTES));
    return Buffer.from(crypto.createHash('sha256').update(rawId).digest().subarray(0, ID_BYTES));
  }
  if (rawId instanceof Uint8Array) {
    const buf = Buffer.from(rawId);
    if (buf.length === ID_BYTES) return buf;
    if (buf.length > ID_BYTES) return Buffer.from(buf.subarray(0, ID_BYTES));
    return Buffer.from(crypto.createHash('sha256').update(buf).digest().subarray(0, ID_BYTES));
  }
  if (typeof rawId === 'string') {
    if (/^[0-9a-fA-F]{40}$/.test(rawId)) {
      return Buffer.from(rawId, 'hex');
    }
    return Buffer.from(crypto.createHash('sha256').update(rawId, 'utf8').digest().subarray(0, ID_BYTES));
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
  if (!Buffer.isBuffer(localId) || !Buffer.isBuffer(targetId)) {
    throw new TypeError('Node IDs for XOR distance must be Buffers');
  }
  if (localId.length !== ID_BYTES || targetId.length !== ID_BYTES) {
    throw new RangeError(`Node IDs must be exactly ${ID_BYTES} bytes (${ID_BITS} bits)`);
  }

  for (let byteIdx = 0; byteIdx < ID_BYTES; byteIdx++) {
    const byte = localId[byteIdx] ^ targetId[byteIdx];
    if (byte !== 0) {
      // Math.clz32(byte) returns leading zeros of a 32-bit int.
      // Since byte is 8-bit, we subtract 24.
      return byteIdx * 8 + (Math.clz32(byte) - 24);
    }
  }
  return -1; // Exact match (distance 0)
}

/**
 * Generates a random 160-bit node ID that falls exactly into the specified bucket
 * relative to the given local node ID. Used for Kademlia bucket refresh and partition recovery.
 * @param {Buffer} localIdBuffer
 * @param {number} bucketIdx (0 to 159)
 * @returns {Buffer}
 */
function generateRandomIdInBucket(localIdBuffer, bucketIdx) {
  if (!Buffer.isBuffer(localIdBuffer) || localIdBuffer.length !== ID_BYTES) {
    throw new TypeError(`localIdBuffer must be a Buffer of length ${ID_BYTES}`);
  }
  if (typeof bucketIdx !== 'number' || bucketIdx < 0 || bucketIdx >= ID_BITS) {
    throw new RangeError(`bucketIdx must be an integer between 0 and ${ID_BITS - 1}`);
  }

  const result = Buffer.from(localIdBuffer);
  const targetByteIdx = Math.floor(bucketIdx / 8);
  const bitOffsetInByte = bucketIdx % 8;
  const mask = 0x80 >> bitOffsetInByte;

  // Invert the differing bit
  result[targetByteIdx] ^= mask;

  // Randomize lower bits in the same byte if any
  if (bitOffsetInByte < 7) {
    const lowerMask = (1 << (7 - bitOffsetInByte)) - 1;
    const randByte = crypto.randomBytes(1)[0];
    result[targetByteIdx] = (result[targetByteIdx] & ~lowerMask) | (randByte & lowerMask);
  }

  // Randomize all subsequent bytes
  for (let b = targetByteIdx + 1; b < ID_BYTES; b++) {
    result[b] = crypto.randomBytes(1)[0];
  }

  return result;
}

/**
 * KBucket represents a bucket of up to k contacts.
 * Implements LRU eviction replacement policy and candidate replacement cache.
 */
class KBucket {
  constructor(index, k = DEFAULT_K) {
    this.index = index;
    this.k = k;
    this.contacts = []; // Ordered from least-recently-seen (head) to most-recently-seen (tail)
    this.replacementCache = []; // Candidate contacts queued when bucket is full (FIFO)
  }

  get length() {
    return this.contacts.length;
  }

  getContact(nodeId) {
    if (!nodeId) return null;
    let idBuf;
    try {
      idBuf = normalizeNodeId(nodeId);
    } catch {
      return null;
    }
    return this.contacts.find((c) => c.idBuffer.equals(idBuf)) || null;
  }

  /**
   * Adds or updates a contact.
   * If contact already exists, moves it to tail (most-recently seen).
   * If bucket is not full, appends to tail.
   * If full, queues candidate in replacementCache and returns { status: 'FULL', staleContact, candidateContact }.
   * @param {object} contact
   * @returns {{ status: 'UPDATED'|'ADDED'|'FULL', contact?: object, staleContact?: object, candidateContact?: object }}
   */
  add(contact) {
    if (!contact || typeof contact !== 'object' || !contact.id) {
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

    // Bucket is full; maintain candidate in replacement cache
    const replIdx = this.replacementCache.findIndex((c) => c.idBuffer.equals(idBuffer));
    if (replIdx !== -1) {
      this.replacementCache.splice(replIdx, 1);
    } else if (this.replacementCache.length >= this.k) {
      this.replacementCache.shift(); // Evict oldest candidate from replacement cache
    }
    this.replacementCache.push(normalizedContact);

    // Oldest contact is at index 0
    return {
      status: 'FULL',
      staleContact: this.contacts[0],
      candidateContact: normalizedContact
    };
  }

  /**
   * Removes a contact by id. If a replacement candidate exists in replacementCache,
   * promotes it to the active bucket.
   * @param {string|Buffer} nodeId
   * @returns {boolean}
   */
  remove(nodeId) {
    if (!nodeId) return false;
    let idBuf;
    try {
      idBuf = normalizeNodeId(nodeId);
    } catch {
      return false;
    }
    const idx = this.contacts.findIndex((c) => c.idBuffer.equals(idBuf));
    if (idx !== -1) {
      this.contacts.splice(idx, 1);
      // Promote oldest candidate from replacementCache if present
      if (this.replacementCache.length > 0) {
        const promoted = this.replacementCache.shift();
        this.contacts.push(promoted);
      }
      return true;
    }
    // Also remove from replacementCache if present
    const replIdx = this.replacementCache.findIndex((c) => c.idBuffer.equals(idBuf));
    if (replIdx !== -1) {
      this.replacementCache.splice(replIdx, 1);
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
   * Gets a contact by ID if present.
   * @param {string|Buffer} nodeId
   * @returns {object|null}
   */
  getContact(nodeId) {
    if (!nodeId) return null;
    let targetBuffer;
    try {
      targetBuffer = normalizeNodeId(nodeId);
    } catch {
      return null;
    }
    const bucketIdx = getBucketIndex(this.localIdBuffer, targetBuffer);
    if (bucketIdx < 0 || bucketIdx >= ID_BITS) return null;
    return this.buckets[bucketIdx].getContact(targetBuffer);
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
    } else if (res.status === 'FULL') {
      this.emit('bucketFull', {
        bucketIdx,
        staleContact: res.staleContact,
        candidateContact: res.candidateContact
      });
    }
    return res;
  }

  /**
   * Removes a contact from the routing table.
   * @param {string|Buffer} nodeId
   * @returns {boolean}
   */
  removeContact(nodeId) {
    if (!nodeId) return false;
    let targetBuffer;
    try {
      targetBuffer = normalizeNodeId(nodeId);
    } catch {
      return false;
    }
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
    this.maxFailures = typeof options.maxFailures === 'number' ? options.maxFailures : 3;

    this.routingTable = new RoutingTable(this.localIdBuffer, { k: this.k });
    // Local key-value store: key (hex/string) -> { value, publisher, storedAt, expiresAt }
    this.store = new Map();

    // Bootstrap seed nodes retained for partition recovery
    this.bootstrapNodes = [];

    // Peer failure counter: peerId -> consecutive failure count
    this._peerFailures = new Map();

    // RPC transport hook: function(targetContact, rpcType, payload) => Promise<response>
    this.rpcHandler = typeof options.rpcHandler === 'function' ? options.rpcHandler : null;

    // Automatic periodic sweep timer
    this._sweepInterval = null;
    if (options.autoSweepIntervalMs) {
      this.startPeriodicSweep(options.autoSweepIntervalMs);
    }
  }

  setRpcHandler(fn) {
    if (typeof fn !== 'function') throw new TypeError('RPC handler must be a function');
    this.rpcHandler = fn;
  }

  /**
   * Pings the stale contact when a bucket is full. If unreachable, evicts it
   * and inserts the candidate contact.
   * @param {object} staleContact
   * @param {object} candidateContact
   * @returns {Promise<boolean>}
   */
  async pingAndEvict(staleContact, candidateContact) {
    if (!this.rpcHandler || !staleContact || !candidateContact) return false;
    try {
      const res = await this.rpcHandler(staleContact, 'PING', {});
      if (res && res.type === 'PONG') {
        // Stale contact is alive: refresh to tail
        this.routingTable.addContact(staleContact);
        return false;
      }
      throw new Error('Invalid PING response');
    } catch {
      // Stale contact unreachable: evict and insert candidate
      this.routingTable.removeContact(staleContact.id);
      this.routingTable.addContact(candidateContact);
      return true;
    }
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

    // Preserve bootstrap seed nodes for network partition recovery
    for (const node of bootstrapNodes) {
      if (node && node.id) {
        const idBuf = normalizeNodeId(node.id);
        const hexId = idBuf.toString('hex');
        if (!this.bootstrapNodes.some((b) => b.id === hexId)) {
          this.bootstrapNodes.push({ ...node, id: hexId });
        }
      }
    }

    let added = 0;
    for (const node of bootstrapNodes) {
      if (node && node.id) {
        const res = this.routingTable.addContact(node);
        if (res.status === 'ADDED' || res.status === 'UPDATED') {
          added++;
        } else if (res.status === 'FULL') {
          this.pingAndEvict(res.staleContact, res.candidateContact).catch(() => {});
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
   * Re-bootstraps using preserved seed nodes to recover after network partition.
   * @returns {Promise<number>}
   */
  async rebootstrap() {
    if (this.bootstrapNodes.length === 0) return 0;
    return this.bootstrap(this.bootstrapNodes);
  }

  /**
   * Refreshes active buckets by looking up random keys in their distance ranges.
   * Kademlia RFC partition recovery mechanism.
   * @returns {Promise<void>}
   */
  async refreshBuckets() {
    if (!this.rpcHandler) return;
    const promises = [];
    for (let i = 0; i < ID_BITS; i++) {
      if (this.routingTable.buckets[i].length > 0) {
        const randomTarget = generateRandomIdInBucket(this.localIdBuffer, i);
        promises.push(this.lookupNode(randomTarget).catch(() => {}));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Stores a key-value pair locally with TTL.
   * Validates non-negative numeric TTL to prevent string concatenation and NaN bugs.
   * @param {string} key
   * @param {*} value
   * @param {object} [options]
   */
  storeLocal(key, value, options = {}) {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('Invalid key: must be a non-empty string');
    }
    const ttl = (typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0)
      ? options.ttlMs
      : this.storageTtlMs;
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
    if (typeof key !== 'string' || !key) return null;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.emit('valueExpired', { key, publisher: entry.publisher });
      return null;
    }
    return entry.value;
  }

  /**
   * Checks whether a valid unexpired value exists locally for key.
   * Unlike getLocal, correctly distinguishes between missing keys and stored null/false/0 values.
   * @param {string} key
   * @returns {boolean}
   */
  hasLocal(key) {
    if (typeof key !== 'string' || !key) return false;
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.emit('valueExpired', { key, publisher: entry.publisher });
      return false;
    }
    return true;
  }

  /**
   * Actively purges all expired entries from local storage to prevent memory leaks.
   * @returns {number} Count of purged keys
   */
  purgeExpired() {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        this.emit('valueExpired', { key, publisher: entry.publisher });
        purged++;
      }
    }
    return purged;
  }

  /**
   * Starts periodic active background sweep of expired keys.
   * @param {number} [intervalMs=60000]
   */
  startPeriodicSweep(intervalMs = 60000) {
    this.stopPeriodicSweep();
    this._sweepInterval = setInterval(() => {
      this.purgeExpired();
    }, intervalMs);
    if (this._sweepInterval && this._sweepInterval.unref) {
      this._sweepInterval.unref();
    }
  }

  /**
   * Stops periodic background sweep.
   */
  stopPeriodicSweep() {
    if (this._sweepInterval) {
      clearInterval(this._sweepInterval);
      this._sweepInterval = null;
    }
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
    const addRes = this.routingTable.addContact(senderContact);
    if (addRes && addRes.status === 'FULL') {
      this.pingAndEvict(addRes.staleContact, addRes.candidateContact).catch(() => {});
    }

    switch (rpcType) {
      case 'PING':
        return { type: 'PONG', responderId: this.localId };

      case 'STORE': {
        const { key, value, ttlMs } = payload;
        if (!key || typeof key !== 'string') throw new Error('STORE RPC requires non-empty string key');
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
        if (!key || typeof key !== 'string') throw new Error('FIND_VALUE RPC requires non-empty string key');
        if (this.hasLocal(key)) {
          return { type: 'VALUE', key, value: this.getLocal(key) };
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
   * Terminates when all k closest candidates have been queried or search space exhausted.
   * @param {string|Buffer} targetId
   * @returns {Promise<Array<object>>}
   */
  async lookupNode(targetId) {
    if (!this.rpcHandler) {
      return this.routingTable.findClosestNodes(targetId, this.k);
    }

    const targetBuffer = normalizeNodeId(targetId);
    const targetKey = targetBuffer.toString('hex');

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
          this._peerFailures.delete(peer.id);

          if (res && Array.isArray(res.nodes)) {
            for (const n of res.nodes) {
              if (!n || !n.id) continue;
              let nBuf;
              try {
                nBuf = normalizeNodeId(n.id);
              } catch {
                continue;
              }
              if (nBuf.equals(this.localIdBuffer)) continue;
              const nHex = nBuf.toString('hex');
              if (!candidateMap.has(nHex)) {
                const normalizedPeer = {
                  ...n,
                  id: nHex,
                  idBuffer: nBuf
                };
                candidateMap.set(nHex, normalizedPeer);
                const addRes = this.routingTable.addContact(normalizedPeer);
                if (addRes && addRes.status === 'FULL') {
                  this.pingAndEvict(addRes.staleContact, addRes.candidateContact).catch(() => {});
                }
              }
            }
          }
        } catch {
          // Unreachable peer with tolerance counter
          const fails = (this._peerFailures.get(peer.id) || 0) + 1;
          this._peerFailures.set(peer.id, fails);
          if (fails >= this.maxFailures) {
            this.routingTable.removeContact(peer.id);
          }
        }
      });

      await Promise.all(promises);

      // Refresh unqueried
      unqueried = Array.from(candidateMap.values()).filter((c) => !contacted.has(c.id));

      // Kademlia convergence condition: terminate when top k closest nodes have all been queried
      const sortedCandidates = Array.from(candidateMap.values())
        .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, targetBuffer) }))
        .sort((a, b) => compareDistance(a.dist, b.dist));

      const kClosest = sortedCandidates.slice(0, this.k);
      const allKClosestQueried = kClosest.length > 0 && kClosest.every((item) => contacted.has(item.contact.id));

      if (unqueried.length === 0 || allKClosestQueried) {
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
    if (this.hasLocal(key)) {
      return { found: true, value: this.getLocal(key), provider: this.localId };
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
      // Pick up to alpha unqueried nodes sorted by XOR distance to key
      const batch = unqueried
        .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, keyBuffer) }))
        .sort((a, b) => compareDistance(a.dist, b.dist))
        .slice(0, this.alpha)
        .map((item) => item.contact);

      let foundValue = undefined;
      let valueProvider = null;
      let hasFound = false;

      const promises = batch.map(async (peer) => {
        contacted.add(peer.id);
        try {
          const res = await this.rpcHandler(peer, 'FIND_VALUE', { key });
          this._peerFailures.delete(peer.id);
          if (res && res.type === 'VALUE') {
            foundValue = res.value;
            valueProvider = peer.id;
            hasFound = true;
          } else if (res && Array.isArray(res.nodes)) {
            for (const n of res.nodes) {
              if (!n || !n.id) continue;
              let nBuf;
              try {
                nBuf = normalizeNodeId(n.id);
              } catch {
                continue;
              }
              if (nBuf.equals(this.localIdBuffer)) continue;
              const nHex = nBuf.toString('hex');
              if (!candidateMap.has(nHex)) {
                const normalizedPeer = {
                  ...n,
                  id: nHex,
                  idBuffer: nBuf
                };
                candidateMap.set(nHex, normalizedPeer);
                const addRes = this.routingTable.addContact(normalizedPeer);
                if (addRes && addRes.status === 'FULL') {
                  this.pingAndEvict(addRes.staleContact, addRes.candidateContact).catch(() => {});
                }
              }
            }
          }
        } catch {
          const fails = (this._peerFailures.get(peer.id) || 0) + 1;
          this._peerFailures.set(peer.id, fails);
          if (fails >= this.maxFailures) {
            this.routingTable.removeContact(peer.id);
          }
        }
      });

      await Promise.all(promises);

      if (hasFound) {
        // Cache value locally (Kademlia caching heuristic)
        this.storeLocal(key, foundValue);
        return { found: true, value: foundValue, provider: valueProvider };
      }

      unqueried = Array.from(candidateMap.values()).filter((c) => !contacted.has(c.id));

      const sortedCandidates = Array.from(candidateMap.values())
        .map((c) => ({ contact: c, dist: xorDistance(c.idBuffer, keyBuffer) }))
        .sort((a, b) => compareDistance(a.dist, b.dist));

      const kClosest = sortedCandidates.slice(0, this.k);
      const allKClosestQueried = kClosest.length > 0 && kClosest.every((item) => contacted.has(item.contact.id));

      if (unqueried.length === 0 || allKClosestQueried) {
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
    if (typeof key !== 'string' || !key) {
      throw new TypeError('Invalid key: must be a non-empty string');
    }
    this.storeLocal(key, value, options);

    if (!this.rpcHandler) {
      return { storedNodes: 1, targetNodes: 1 };
    }

    const ttlMs = (typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs >= 0)
      ? options.ttlMs
      : this.storageTtlMs;

    const closestNodes = await this.lookupNode(key);
    let successfulStores = 1; // Count local node

    const storePromises = closestNodes.map(async (peer) => {
      try {
        const res = await this.rpcHandler(peer, 'STORE', {
          key,
          value,
          ttlMs
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

  /**
   * Gracefully tears down DHT node and clears background sweep intervals.
   */
  destroy() {
    this.stopPeriodicSweep();
    this.store.clear();
    this.removeAllListeners();
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
  generateRandomIdInBucket,
  DEFAULT_K,
  DEFAULT_ALPHA,
  ID_BITS,
  ID_BYTES
};
