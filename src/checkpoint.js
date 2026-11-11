'use strict';

const crypto = require('node:crypto');
const v8 = require('node:v8');
const EventEmitter = require('node:events');

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
    this.maxCheckpointsPerShard = options.maxCheckpointsPerShard || 5;
    this.defaultIntervalMs = options.defaultIntervalMs || 10000;
    this.digestAlgorithm = options.digestAlgorithm || 'sha256';

    // shardId -> Array<CheckpointEntry>
    this.checkpoints = new Map();
    // shardId -> NodeJS.Timeout
    this.activeIntervals = new Map();
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
    try {
      return v8.deserialize(buffer);
    } catch {
      const str = buffer.toString('utf8');
      return JSON.parse(str, (k, v) => {
        if (typeof v === 'string' && /^-?\d+n$/.test(v)) {
          return BigInt(v.slice(0, -1));
        }
        return v;
      });
    }
  }

  /**
   * Computes SHA-256 digest over state buffer and metadata.
   */
  computeChecksum(stateBuffer, seq, stepIndex) {
    const hash = crypto.createHash(this.digestAlgorithm);
    hash.update(Buffer.from(String(seq), 'utf8'));
    hash.update(Buffer.from(String(stepIndex), 'utf8'));
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

    let shardHistory = this.checkpoints.get(shardId);
    if (!shardHistory) {
      shardHistory = [];
      this.checkpoints.set(shardId, shardHistory);
    }

    const seq = shardHistory.length + 1;
    const stepIndex = typeof meta.stepIndex === 'number' ? meta.stepIndex : seq;
    const stateBuffer = this.serializeState(state);
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
      meta: { ...meta }
    };

    shardHistory.push(entry);

    // Evict oldest checkpoints if exceeding threshold
    if (shardHistory.length > this.maxCheckpointsPerShard) {
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
    if (targetSeq !== null) {
      entry = shardHistory.find((e) => e.seq === targetSeq);
    } else {
      entry = shardHistory[shardHistory.length - 1];
    }

    if (!entry) return null;

    // Verify integrity before restoring
    const expectedChecksum = this.computeChecksum(entry.stateBuffer, entry.seq, entry.stepIndex);
    if (entry.checksum !== expectedChecksum) {
      const err = new Error(`Checkpoint integrity violation for shard ${shardId}: checksum mismatch`);
      this.emit('corruptedCheckpoint', { shardId, seq: entry.seq, error: err.message });
      throw err;
    }

    const state = this.deserializeState(entry.stateBuffer);

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
      meta: entry.meta
    };
  }

  /**
   * Starts periodic checkpointing for an active running task.
   * @param {string} shardId
   * @param {function(): *} stateProviderFn Callback returning the current task state
   * @param {number} [intervalMs]
   */
  startPeriodicCheckpoint(shardId, stateProviderFn, intervalMs = null) {
    this.stopPeriodicCheckpoint(shardId);

    const ms = intervalMs || this.defaultIntervalMs;
    const timer = setInterval(() => {
      try {
        const state = stateProviderFn();
        if (state !== undefined) {
          this.saveCheckpoint(shardId, state, { periodic: true });
        }
      } catch (err) {
        this.emit('checkpointError', { shardId, error: err.message });
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
  }

  /**
   * Cleans all active checkpoints across all shards.
   */
  clearAll() {
    for (const shardId of this.activeIntervals.keys()) {
      this.stopPeriodicCheckpoint(shardId);
    }
    this.checkpoints.clear();
  }
}

module.exports = { CheckpointManager };
