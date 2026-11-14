'use strict';

const crypto = require('node:crypto');
const v8 = require('node:v8');
const EventEmitter = require('node:events');

/**
 * Constant-time string equality comparison using crypto.timingSafeEqual.
 * Prevents timing side-channel attacks on cryptographic digests.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * CheckpointManager
 * 
 * Provides periodic checkpointing, snapshot serialization, verification,
 * and deterministic state resumption for long-running compute shards.
 * 
 * Features:
 * 1. Safe structured state serialization using native node:v8 (zero dependencies)
 *    with JSON fallback.
 * 2. SHA-256 integrity digest validation over all checkpoint payloads.
 * 3. Monotonically increasing sequence tracking per shard.
 * 4. Automatic snapshot eviction keeping last N checkpoints to prevent memory leaks.
 * 5. Resume interface providing reconstructed state and replay offset.
 */
class CheckpointManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    const maxCp = Number(options.maxCheckpointsPerShard);
    this.maxCheckpointsPerShard = Number.isSafeInteger(maxCp) && maxCp > 0 ? maxCp : 5;
    this.defaultIntervalMs = Number(options.defaultIntervalMs) > 0 ? Number(options.defaultIntervalMs) : 10000;
    this.digestAlgorithm = options.digestAlgorithm || 'sha256';
    const maxShards = Number(options.maxShards);
    this.maxShards = Number.isSafeInteger(maxShards) && maxShards > 0 ? maxShards : 1000;

    // shardId -> Array<CheckpointEntry>
    this.checkpoints = new Map();
    // shardId -> NodeJS.Timeout
    this.activeIntervals = new Map();
    // shardId -> number (monotonically increasing high-water sequence counter)
    this._seqByShard = new Map();
  }

  /**
   * Serializes a state value into a buffer.
   * Handles plain objects, arrays, maps, sets, primitives, and BigInts safely.
   * @param {*} state
   * @returns {Buffer}
   */
  serializeState(state) {
    try {
      return v8.serialize(state);
    } catch {
      // Fallback to JSON serialization with BigInt stringification
      const json = JSON.stringify(state, (k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v));
      if (typeof json !== 'string') {
        throw new TypeError('State cannot be serialized');
      }
      return Buffer.from(json, 'utf8');
    }
  }

  /**
   * Deserializes a state buffer back into an object/value.
   * @param {Buffer} buffer
   * @returns {*}
   */
  deserializeState(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('Invalid state buffer: expected Buffer');
    }

    // Check if buffer starts with V8 serialization magic version tag (0xFF)
    const isV8 = buffer.length > 0 && buffer[0] === 0xff;
    if (isV8) {
      try {
        return v8.deserialize(buffer);
      } catch (err) {
        throw new Error(`Failed to deserialize V8 state payload: ${err.message}`);
      }
    }

    try {
      const str = buffer.toString('utf8');
      return JSON.parse(str, (k, v) => {
        if (k === '__proto__' || k === 'constructor') {
          return undefined;
        }
        if (typeof v === 'string' && /^-?\d+n$/.test(v)) {
          return BigInt(v.slice(0, -1));
        }
        return v;
      });
    } catch {
      // If not JSON or failed, fallback to v8.deserialize in case it was a raw buffer
      return v8.deserialize(buffer);
    }
  }

  /**
   * Computes SHA-256 digest over state buffer and metadata.
   * Uses delimiter-separated canonical formatting to prevent concatenation collisions.
   */
  computeChecksum(stateBuffer, seq, stepIndex) {
    const hash = crypto.createHash(this.digestAlgorithm);
    hash.update(Buffer.from(`${seq}:${stepIndex}:`, 'utf8'));
    hash.update(stateBuffer);
    return hash.digest('hex');
  }

  /**
   * Saves a checkpoint for a specific shard.
   * @param {string} shardId
   * @param {*} state
   * @param {object} [meta]
   * @returns {object} The created checkpoint metadata
   */
  saveCheckpoint(shardId, state, meta = {}) {
    if (!shardId || typeof shardId !== 'string') {
      throw new TypeError('Invalid shardId: must be a non-empty string');
    }

    const safeMeta = (meta && typeof meta === 'object') ? meta : {};
    // Serialize state FIRST before incrementing sequence counter
    const stateBuffer = this.serializeState(state);

    let shardHistory = this.checkpoints.get(shardId);
    if (!shardHistory) {
      // LRU eviction of oldest inactive shard if capacity exceeded
      if (this.checkpoints.size >= this.maxShards) {
        for (const candidateId of this.checkpoints.keys()) {
          if (!this.activeIntervals.has(candidateId)) {
            this.checkpoints.delete(candidateId);
            this._seqByShard.delete(candidateId);
            break;
          }
        }
      }
      shardHistory = [];
      this.checkpoints.set(shardId, shardHistory);
    }

    const nextSeq = (this._seqByShard.get(shardId) || 0) + 1;
    this._seqByShard.set(shardId, nextSeq);
    const seq = nextSeq;
    const stepIndex = (typeof safeMeta.stepIndex === 'number' && Number.isFinite(safeMeta.stepIndex))
      ? safeMeta.stepIndex
      : seq;
    const checksum = this.computeChecksum(stateBuffer, seq, stepIndex);
    const timestamp = Date.now();

    const entry = {
      shardId,
      seq,
      stepIndex,
      timestamp,
      stateBuffer,
      checksum,
      sizeBytes: stateBuffer.length,
      meta: { ...safeMeta }
    };

    shardHistory.push(entry);

    // Evict oldest checkpoints if exceeding threshold
    while (shardHistory.length > this.maxCheckpointsPerShard) {
      shardHistory.shift();
    }

    this.emit('checkpointSaved', {
      shardId,
      seq,
      stepIndex,
      checksum,
      timestamp,
      sizeBytes: entry.sizeBytes
    });

    return {
      shardId,
      seq,
      stepIndex,
      checksum,
      timestamp,
      sizeBytes: entry.sizeBytes
    };
  }

  /**
   * Returns all stored checkpoints for a given shard.
   * @param {string} shardId
   * @returns {Array<object>}
   */
  getCheckpoints(shardId) {
    const list = this.checkpoints.get(shardId);
    return list ? list : [];
  }

  /**
   * Retrieves the latest valid checkpoint for a shard.
   * @param {string} shardId
   * @returns {object|null}
   */
  getLatestCheckpoint(shardId) {
    const shardHistory = this.checkpoints.get(shardId);
    if (!shardHistory || shardHistory.length === 0) {
      return null;
    }
    return shardHistory[shardHistory.length - 1];
  }

  /**
   * Retrieves and verifies a checkpoint, returning the restored state.
   * @param {string} shardId
   * @param {number} [targetSeq] Optional specific sequence, defaults to latest.
   * @returns {{ state: *, stepIndex: number, seq: number, timestamp: number }|null}
   */
  restoreCheckpoint(shardId, targetSeq = null) {
    const shardHistory = this.checkpoints.get(shardId);
    if (!shardHistory || shardHistory.length === 0) {
      return null;
    }

    let entry = null;
    if (targetSeq !== null && targetSeq !== undefined) {
      const parsedSeq = typeof targetSeq === 'number' ? targetSeq : Number(targetSeq);
      entry = shardHistory.find((e) => e.seq === parsedSeq);
    } else {
      entry = shardHistory[shardHistory.length - 1];
    }

    if (!entry) return null;

    // Verify integrity before restoring using timing-safe comparison
    const expectedChecksum = this.computeChecksum(entry.stateBuffer, entry.seq, entry.stepIndex);
    if (!constantTimeCompare(entry.checksum, expectedChecksum)) {
      const err = new Error(`Checkpoint integrity violation for shard ${shardId}: checksum mismatch`);
      this.emit('corruptedCheckpoint', { shardId, seq: entry.seq, error: err.message });
      throw err;
    }

    let state;
    try {
      state = this.deserializeState(entry.stateBuffer);
    } catch (err) {
      const corruptErr = new Error(`Checkpoint integrity violation for shard ${shardId}: deserialization failed - ${err.message}`);
      this.emit('corruptedCheckpoint', { shardId, seq: entry.seq, error: corruptErr.message });
      throw corruptErr;
    }

    this.emit('checkpointRestored', {
      shardId,
      seq: entry.seq,
      stepIndex: entry.stepIndex,
      timestamp: entry.timestamp
    });

    return {
      state,
      seq: entry.seq,
      stepIndex: entry.stepIndex,
      timestamp: entry.timestamp,
      meta: { ...entry.meta }
    };
  }

  /**
   * Starts periodic checkpointing for an active running task.
   * Supports both synchronous and asynchronous stateProviderFn callbacks with concurrency guard.
   * @param {string} shardId
   * @param {function(): *} stateProviderFn Callback returning the current task state
   * @param {number} [intervalMs]
   */
  startPeriodicCheckpoint(shardId, stateProviderFn, intervalMs = null) {
    if (!shardId || typeof shardId !== 'string') {
      throw new TypeError('Invalid shardId: must be a non-empty string');
    }
    if (typeof stateProviderFn !== 'function') {
      throw new TypeError('Invalid stateProviderFn: must be a function');
    }

    this.stopPeriodicCheckpoint(shardId);

    const parsedMs = Number(intervalMs);
    const ms = Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : this.defaultIntervalMs;
    let isRunning = false;

    const timer = setInterval(() => {
      if (isRunning) return; // Prevent concurrent overlapping executions
      isRunning = true;
      try {
        if (!this.activeIntervals.has(shardId)) return;
        const rawState = stateProviderFn();
        if (rawState && typeof rawState.then === 'function') {
          rawState.then((state) => {
            if (this.activeIntervals.has(shardId) && state !== undefined) {
              this.saveCheckpoint(shardId, state, { periodic: true });
            }
          }).catch((err) => {
            this.emit('checkpointError', { shardId, error: err.message });
          }).finally(() => {
            isRunning = false;
          });
          return;
        }

        if (rawState !== undefined) {
          this.saveCheckpoint(shardId, rawState, { periodic: true });
        }
      } catch (err) {
        this.emit('checkpointError', { shardId, error: err.message });
      } finally {
        if (isRunning) {
          isRunning = false;
        }
      }
    }, ms);

    if (timer.unref) timer.unref();
    this.activeIntervals.set(shardId, timer);
  }

  /**
   * Stops periodic checkpointing for a shard.
   * @param {string} shardId
   */
  stopPeriodicCheckpoint(shardId) {
    const timer = this.activeIntervals.get(shardId);
    if (timer) {
      clearInterval(timer);
      this.activeIntervals.delete(shardId);
    }
  }

  /**
   * Clears checkpoints and timers for a given shard.
   * @param {string} shardId
   */
  clearShard(shardId) {
    this.stopPeriodicCheckpoint(shardId);
    this.checkpoints.delete(shardId);
    this._seqByShard.delete(shardId);
  }

  /**
   * Cleans all active checkpoints across all shards.
   */
  clearAll() {
    for (const shardId of this.activeIntervals.keys()) {
      this.stopPeriodicCheckpoint(shardId);
    }
    this.checkpoints.clear();
    this._seqByShard.clear();
  }
}

module.exports = { CheckpointManager };
