const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { CheckpointManager } = require('./checkpoint');

const DEFAULT_MAX_CPU_THRESHOLD = 0.25;
const DEFAULT_MIN_FREE_MEM_RATIO = 0.10;
const DEFAULT_CPU_HYSTERESIS_MARGIN = 0.03;
const DEFAULT_MEM_HYSTERESIS_MARGIN = 0.0;
const DEFAULT_CPU_RECOVERY_STREAK = 2;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_QUEUE_TIME_MS = 60000;
const DEFAULT_TELEMETRY_CACHE_TTL_MS = 10;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_DEAD_PEER_TIMEOUT_MS = 15000;

function readTickValue(val) {
  if (val === undefined) {
    return { valid: true, value: 0n };
  }
  if (typeof val === 'bigint') {
    return val >= 0n ? { valid: true, value: val } : { valid: false };
  }
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return { valid: true, value: BigInt(Math.trunc(val)) };
  }
  return { valid: false };
}

function extractCpuTotals(cpus) {
  if (!Array.isArray(cpus) || cpus.length === 0) {
    return { valid: false };
  }

  let totalIdle = 0n;
  let totalTicks = 0n;

  for (const cpu of cpus) {
    if (!cpu || typeof cpu !== 'object' || !cpu.times || typeof cpu.times !== 'object') {
      return { valid: false };
    }
    const { user, nice, sys, idle, irq } = cpu.times;
    // At least user, sys, idle must exist or be valid ticks; missing irq/nice (e.g. across OS differences) default to 0
    if (idle === undefined && user === undefined && sys === undefined) {
      return { valid: false };
    }
    const u = readTickValue(user);
    const n = readTickValue(nice);
    const s = readTickValue(sys);
    const id = readTickValue(idle);
    const iq = readTickValue(irq);
    if (!u.valid || !n.valid || !s.valid || !id.valid || !iq.valid) {
      return { valid: false };
    }

    const coreTotal = u.value + n.value + s.value + id.value + iq.value;
    totalIdle += id.value;
    totalTicks += coreTotal;
  }

  return {
    valid: true,
    cpuCount: cpus.length,
    totalIdle,
    totalTicks
  };
}

class QueueFullError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueFullError';
    this.code = 'ERR_QUEUE_FULL';
  }
}

class GridRouter extends EventEmitter {
  /**
   * @param {string} localNodeId
   * @param {object} [options]
   */
  constructor(localNodeId, options = {}) {
    super();
    const opts = options && typeof options === 'object' ? options : {};
    this.localNodeId = localNodeId;
    this.maxCpuThreshold = opts.maxCpuThreshold !== undefined ? opts.maxCpuThreshold : DEFAULT_MAX_CPU_THRESHOLD;
    this.minFreeMemRatio = opts.minFreeMemRatio !== undefined ? opts.minFreeMemRatio : DEFAULT_MIN_FREE_MEM_RATIO;
    this.minFreeMemBytes = opts.minFreeMemBytes !== undefined ? opts.minFreeMemBytes : 0;
    this.cpuHysteresisMargin = opts.cpuHysteresisMargin !== undefined ? opts.cpuHysteresisMargin : DEFAULT_CPU_HYSTERESIS_MARGIN;
    this.memHysteresisMargin = opts.memHysteresisMargin !== undefined ? opts.memHysteresisMargin : DEFAULT_MEM_HYSTERESIS_MARGIN;
    this.cpuRecoveryStreakRequired = opts.cpuRecoveryStreakRequired !== undefined ? opts.cpuRecoveryStreakRequired : DEFAULT_CPU_RECOVERY_STREAK;
    this.maxQueueSize = opts.maxQueueSize !== undefined ? opts.maxQueueSize : DEFAULT_MAX_QUEUE_SIZE;
    this.maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.maxQueueTimeMs = opts.maxQueueTimeMs !== undefined ? opts.maxQueueTimeMs : DEFAULT_MAX_QUEUE_TIME_MS;
    this.autoFlush = opts.autoFlush !== undefined ? Boolean(opts.autoFlush) : true;
    this.onDispatch = typeof opts.onDispatch === 'function' ? opts.onDispatch : null;

    if (typeof this.maxCpuThreshold !== 'number' || !Number.isFinite(this.maxCpuThreshold) || this.maxCpuThreshold <= 0 || this.maxCpuThreshold > 1) {
      throw new RangeError('Invalid maxCpuThreshold: must be a finite number in (0, 1]');
    }
    if (typeof this.minFreeMemRatio !== 'number' || !Number.isFinite(this.minFreeMemRatio) || this.minFreeMemRatio < 0 || this.minFreeMemRatio >= 1) {
      throw new RangeError('Invalid minFreeMemRatio: must be a finite number in [0, 1)');
    }
    if (typeof this.minFreeMemBytes !== 'number' || !Number.isFinite(this.minFreeMemBytes) || this.minFreeMemBytes < 0) {
      throw new RangeError('Invalid minFreeMemBytes: must be a non-negative finite number');
    }
    if (!Number.isSafeInteger(this.maxQueueSize) || this.maxQueueSize < 0) {
      throw new RangeError('Invalid maxQueueSize: must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 1) {
      throw new RangeError('Invalid maxRetries: must be a positive safe integer');
    }
    if (typeof this.cpuHysteresisMargin !== 'number' || !Number.isFinite(this.cpuHysteresisMargin) || this.cpuHysteresisMargin < 0 || this.cpuHysteresisMargin > 1) {
      throw new RangeError('Invalid cpuHysteresisMargin: must be a finite number in [0, 1]');
    }
    if (typeof this.memHysteresisMargin !== 'number' || !Number.isFinite(this.memHysteresisMargin) || this.memHysteresisMargin < 0 || this.memHysteresisMargin > 1) {
      throw new RangeError('Invalid memHysteresisMargin: must be a finite number in [0, 1]');
    }
    if (!Number.isSafeInteger(this.cpuRecoveryStreakRequired) || this.cpuRecoveryStreakRequired < 1) {
      throw new RangeError('Invalid cpuRecoveryStreakRequired: must be a positive safe integer');
    }
    if (typeof this.maxQueueTimeMs !== 'number' || !Number.isFinite(this.maxQueueTimeMs) || this.maxQueueTimeMs <= 0) {
      throw new RangeError('Invalid maxQueueTimeMs: must be a positive finite number');
    }

    this._osProvider = opts.os || null;
    this._hasCustomNow = typeof opts.now === 'function';
    this._now = this._hasCustomNow ? opts.now : () => Date.now();
    this._cacheNow = this._hasCustomNow ? () => this._now() : () => performance.now();

    const defaultTelemetryCacheTtlMs = this._osProvider ? 0 : DEFAULT_TELEMETRY_CACHE_TTL_MS;
    this.telemetryCacheTtlMs = opts.telemetryCacheTtlMs !== undefined
      ? opts.telemetryCacheTtlMs
      : defaultTelemetryCacheTtlMs;
    if (typeof this.telemetryCacheTtlMs !== 'number' || !Number.isFinite(this.telemetryCacheTtlMs) || this.telemetryCacheTtlMs < 0) {
      throw new RangeError('Invalid telemetryCacheTtlMs: must be a non-negative finite number');
    }
    if (this.telemetryCacheTtlMs === 0) {
      this.telemetryCacheTtlMs = 0;
    }

    this.heartbeatIntervalMs = opts.heartbeatIntervalMs !== undefined
      ? opts.heartbeatIntervalMs
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (typeof this.heartbeatIntervalMs !== 'number' || !Number.isFinite(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new RangeError('Invalid heartbeatIntervalMs: must be a positive finite number');
    }

    this.deadPeerTimeoutMs = opts.deadPeerTimeoutMs !== undefined
      ? opts.deadPeerTimeoutMs
      : DEFAULT_DEAD_PEER_TIMEOUT_MS;
    if (typeof this.deadPeerTimeoutMs !== 'number' || !Number.isFinite(this.deadPeerTimeoutMs) || this.deadPeerTimeoutMs <= 0) {
      throw new RangeError('Invalid deadPeerTimeoutMs: must be a positive finite number');
    }

    this._onHeartbeatPing = typeof opts.onHeartbeatPing === 'function' ? opts.onHeartbeatPing : null;
    this._heartbeatTimer = null;

    this.peerTable = new Map();
    this.taskQueue = [];
    this.inFlightShards = new Map();
    this.failedTasks = [];
    this.expiredTasks = [];

    this.checkpoints = opts.checkpointManager || new CheckpointManager();

    this._cpuShedActive = false;
    this._cpuHealthyStreak = 0;
    this._memShedActive = false;
    this._lastCpuLoad = null;
    this._cachedTelemetry = null;
    this._cachedAt = null;
    this._prevCpuSnapshot = this._captureCpuSnapshotSafe();

    if (opts.autoStartHeartbeat) {
      this.startHeartbeatMonitor();
    }
  }

  _getOs() {
    if (this._osProvider) {
      return this._osProvider;
    }
    return require('node:os');
  }

  _captureCpuSnapshotSafe() {
    try {
      const osMod = this._getOs();
      const cpus = osMod.cpus();
      const snap = extractCpuTotals(cpus);
      return snap.valid ? snap : null;
    } catch {
      return null;
    }
  }

  /**
   * Sets a dispatch handler callback invoked when shards are routed or flushed from queue.
   * @param {function(object, object): void} fn
   */
  setDispatchHandler(fn) {
    if (fn !== null && typeof fn !== 'function') {
      throw new TypeError('Dispatch handler must be a function or null');
    }
    this.onDispatch = fn;
  }

  /**
   * Stateless fail-closed evaluation of raw telemetry metrics against thresholds.
   * @param {{ cpuLoad?: number, freeMemRatio?: number, freeMemBytes?: number }} metrics
   * @returns {{ standbyReady: boolean, cpuOverload: boolean, memLow: boolean, loadShedState: string, valid: boolean }}
   */
  evaluateTelemetry(metrics) {
    if (!metrics || typeof metrics !== 'object') {
      return { standbyReady: false, cpuOverload: false, memLow: false, loadShedState: 'TELEMETRY_INVALID', valid: false };
    }

    const cpuLoad = metrics.cpuLoad;
    const freeMemRatio = metrics.freeMemRatio;
    const freeMemBytes = metrics.freeMemBytes;

    const cpuValid = typeof cpuLoad === 'number' && Number.isFinite(cpuLoad) && cpuLoad >= 0 && cpuLoad <= 1;
    const memRatioValid = typeof freeMemRatio === 'number' && Number.isFinite(freeMemRatio) && freeMemRatio >= 0 && freeMemRatio <= 1;
    const memBytesValid = freeMemBytes === undefined || (typeof freeMemBytes === 'number' && Number.isFinite(freeMemBytes) && freeMemBytes >= 0);

    if (!cpuValid || !memRatioValid || !memBytesValid) {
      return { standbyReady: false, cpuOverload: false, memLow: false, loadShedState: 'TELEMETRY_INVALID', valid: false };
    }

    const cpuOverload = cpuLoad > this.maxCpuThreshold;
    const memLow = freeMemRatio < this.minFreeMemRatio || (freeMemBytes !== undefined && freeMemBytes < this.minFreeMemBytes);

    let loadShedState = 'NOMINAL';
    if (cpuOverload && memLow) {
      loadShedState = 'CPU_AND_MEMORY_EXHAUSTED';
    } else if (cpuOverload) {
      loadShedState = 'CPU_OVERLOAD';
    } else if (memLow) {
      loadShedState = 'MEMORY_EXHAUSTED';
    }

    return {
      standbyReady: !cpuOverload && !memLow,
      cpuOverload,
      memLow,
      loadShedState,
      valid: true
    };
  }

  /**
   * Computes real-time OS-level CPU delta across cores and free memory headroom,
   * enforcing strict 25% CPU ceiling and 10% memory floor with fail-closed hysteresis.
   * @param {{ forceRefresh?: boolean }} [options]
   */
  getHardwareTelemetry(options = {}) {
    const forceRefresh = Boolean(options && options.forceRefresh);
    if (!forceRefresh && this.telemetryCacheTtlMs > 0 && this._cachedTelemetry !== null && this._cachedAt !== null) {
      const cacheNow = this._cacheNow();
      const elapsed = cacheNow - this._cachedAt;
      if (elapsed >= 0 && elapsed < this.telemetryCacheTtlMs) {
        return { ...this._cachedTelemetry };
      }
    }

    const osMod = this._getOs();
    const prevShedState = this._cpuShedActive || this._memShedActive;

    // 1. CPU Delta Sampling
    let cpuValid = true;
    let cpuCount = 0;
    let cpuLoad = 0.0;
    let isZeroDelta = false;

    try {
      const current = extractCpuTotals(osMod.cpus());
      if (!current.valid) {
        cpuValid = false;
      } else {
        cpuCount = current.cpuCount;
        if (!this._prevCpuSnapshot) {
          this._prevCpuSnapshot = current;
          cpuLoad = this._lastCpuLoad !== null ? this._lastCpuLoad : 0.0;
        } else {
          const deltaTotal = current.totalTicks - this._prevCpuSnapshot.totalTicks;
          const deltaIdle = current.totalIdle - this._prevCpuSnapshot.totalIdle;

          if (deltaTotal === 0n) {
            // Identical tick sample within sub-millisecond window: avoid 0/0 NaN
            isZeroDelta = true;
            cpuLoad = this._lastCpuLoad !== null ? this._lastCpuLoad : 0.0;
          } else if (deltaTotal < 0n || deltaIdle < 0n || deltaIdle > deltaTotal) {
            // Negative delta (e.g. core re-enumeration) clamped safely to 0.0
            cpuLoad = 0.0;
            this._lastCpuLoad = cpuLoad;
            this._prevCpuSnapshot = current;
          } else {
            const deltaBusy = deltaTotal - deltaIdle;
            const scaled = Number((deltaBusy * 1000000n) / deltaTotal) / 1000000;
            cpuLoad = Math.min(1.0, Math.max(0.0, scaled));
            this._lastCpuLoad = cpuLoad;
            this._prevCpuSnapshot = current;
          }
        }
      }
    } catch {
      cpuValid = false;
    }

    // 2. Memory Headroom Sampling
    let memValid = true;
    let freeMemBytes = 0;
    let totalMemBytes = 0;
    let freeMemRatio = 0.0;

    try {
      const rawFree = osMod.freemem();
      const rawTotal = osMod.totalmem();

      if (typeof rawTotal !== 'number' || !Number.isFinite(rawTotal) || rawTotal <= 0) {
        memValid = false;
        totalMemBytes = 0;
        freeMemBytes = 0;
        freeMemRatio = 0.0;
      } else if (typeof rawFree !== 'number' || !Number.isFinite(rawFree)) {
        memValid = false;
        totalMemBytes = rawTotal;
        freeMemBytes = 0;
        freeMemRatio = 0.0;
      } else {
        totalMemBytes = rawTotal;
        freeMemBytes = Math.max(0, rawFree);
        freeMemRatio = Math.min(1.0, Math.max(0.0, freeMemBytes / totalMemBytes));
      }
    } catch {
      memValid = false;
    }

    // 3. Fail-Closed Evaluation + Schmitt Trigger Hysteresis
    const telemetryValid = cpuValid && memValid;
    let standbyReady = false;
    let loadShedState = 'TELEMETRY_INVALID';

    if (!telemetryValid) {
      if (!cpuValid) {
        cpuLoad = 1.0;
      }
      this._cpuShedActive = !cpuValid ? true : this._cpuShedActive;
      this._cpuHealthyStreak = 0;
      this._memShedActive = !memValid ? true : this._memShedActive;
      standbyReady = false;
      loadShedState = 'TELEMETRY_INVALID';
    } else {
      if (!isZeroDelta) {
        const cpuRecoveryCeiling = Math.max(0, this.maxCpuThreshold - this.cpuHysteresisMargin);
        if (this._cpuShedActive) {
          if (cpuLoad <= cpuRecoveryCeiling) {
            this._cpuShedActive = false;
            this._cpuHealthyStreak = 0;
          } else if (cpuLoad <= this.maxCpuThreshold) {
            this._cpuHealthyStreak += 1;
            if (this._cpuHealthyStreak >= this.cpuRecoveryStreakRequired) {
              this._cpuShedActive = false;
              this._cpuHealthyStreak = 0;
            }
          } else {
            this._cpuHealthyStreak = 0;
          }
        } else if (cpuLoad > this.maxCpuThreshold) {
          this._cpuShedActive = true;
          this._cpuHealthyStreak = 0;
        }
      }

      const memRecoveryFloor = Math.min(1.0, this.minFreeMemRatio + this.memHysteresisMargin);
      const belowBytesFloor = freeMemBytes < this.minFreeMemBytes;
      if (this._memShedActive) {
        if (freeMemRatio >= memRecoveryFloor && !belowBytesFloor) {
          this._memShedActive = false;
        }
      } else if (freeMemRatio < this.minFreeMemRatio || belowBytesFloor) {
        this._memShedActive = true;
      }

      if (this._cpuShedActive && this._memShedActive) {
        loadShedState = 'CPU_AND_MEMORY_EXHAUSTED';
        standbyReady = false;
      } else if (this._cpuShedActive) {
        loadShedState = 'CPU_OVERLOAD';
        standbyReady = false;
      } else if (this._memShedActive) {
        loadShedState = 'MEMORY_EXHAUSTED';
        standbyReady = false;
      } else {
        loadShedState = 'NOMINAL';
        standbyReady = true;
      }
    }

    const sampledAt = this._now();
    const result = {
      cpuLoad,
      cpuCount,
      cpuCores: cpuCount,
      freeMemBytes,
      totalMemBytes,
      freeMemRatio,
      standbyReady,
      loadShedState,
      telemetryValid,
      timestamp: sampledAt
    };

    if (this.telemetryCacheTtlMs > 0) {
      this._cachedTelemetry = { ...result };
      this._cachedAt = this._hasCustomNow ? sampledAt : this._cacheNow();
    } else {
      this._cachedTelemetry = null;
      this._cachedAt = null;
    }

    const currentShedState = !standbyReady;
    if (!prevShedState && currentShedState) {
      this.emit('loadShed', result);
    } else if (prevShedState && !currentShedState) {
      this.emit('telemetryRecovered', result);
    }

    return result;
  }

  /**
   * Checks whether local host memory headroom satisfies the operational floor.
   * @returns {boolean}
   */
  isMemoryAvailable() {
    const osMod = this._getOs();
    let rawFree;
    let rawTotal;
    try {
      rawFree = osMod.freemem();
      rawTotal = osMod.totalmem();
    } catch {
      this._cachedTelemetry = null;
      this._cachedAt = null;
      const prevShed = this._cpuShedActive || this._memShedActive;
      this._memShedActive = true;
      if (!prevShed) {
        this.emit('loadShed', {
          standbyReady: false,
          loadShedState: this._cpuShedActive ? 'CPU_AND_MEMORY_EXHAUSTED' : 'MEMORY_EXHAUSTED',
          freeMemBytes: 0,
          freeMemRatio: 0,
          timestamp: this._now()
        });
      }
      return false;
    }

    if (typeof rawTotal !== 'number' || !Number.isFinite(rawTotal) || rawTotal <= 0) {
      this._cachedTelemetry = null;
      this._cachedAt = null;
      const prevShed = this._cpuShedActive || this._memShedActive;
      this._memShedActive = true;
      if (!prevShed) {
        this.emit('loadShed', {
          standbyReady: false,
          loadShedState: this._cpuShedActive ? 'CPU_AND_MEMORY_EXHAUSTED' : 'MEMORY_EXHAUSTED',
          freeMemBytes: 0,
          freeMemRatio: 0,
          timestamp: this._now()
        });
      }
      return false;
    }
    if (typeof rawFree !== 'number' || !Number.isFinite(rawFree) || rawFree < 0) {
      this._cachedTelemetry = null;
      this._cachedAt = null;
      const prevShed = this._cpuShedActive || this._memShedActive;
      this._memShedActive = true;
      if (!prevShed) {
        this.emit('loadShed', {
          standbyReady: false,
          loadShedState: this._cpuShedActive ? 'CPU_AND_MEMORY_EXHAUSTED' : 'MEMORY_EXHAUSTED',
          freeMemBytes: 0,
          freeMemRatio: 0,
          timestamp: this._now()
        });
      }
      return false;
    }

    const freeMemBytes = Math.max(0, rawFree);
    const freeMemRatio = Math.min(1.0, freeMemBytes / rawTotal);
    const memRecoveryFloor = Math.min(1.0, this.minFreeMemRatio + this.memHysteresisMargin);
    const belowBytesFloor = freeMemBytes < this.minFreeMemBytes;
    const prevShedState = this._cpuShedActive || this._memShedActive;

    if (this._memShedActive) {
      if (freeMemRatio >= memRecoveryFloor && !belowBytesFloor) {
        this._memShedActive = false;
        this._cachedTelemetry = null;
        this._cachedAt = null;
        const currentShedState = this._cpuShedActive || this._memShedActive;
        if (prevShedState && !currentShedState) {
          this.emit('telemetryRecovered', {
            standbyReady: true,
            loadShedState: 'NOMINAL',
            freeMemBytes,
            freeMemRatio,
            timestamp: this._now()
          });
        }
        return true;
      }
      return false;
    }

    if (freeMemRatio < this.minFreeMemRatio || belowBytesFloor) {
      this._memShedActive = true;
      this._cachedTelemetry = null;
      this._cachedAt = null;
      const currentShedState = this._cpuShedActive || this._memShedActive;
      if (!prevShedState && currentShedState) {
        this.emit('loadShed', {
          standbyReady: false,
          loadShedState: this._cpuShedActive ? 'CPU_AND_MEMORY_EXHAUSTED' : 'MEMORY_EXHAUSTED',
          freeMemBytes,
          freeMemRatio,
          timestamp: this._now()
        });
      }
      return false;
    }
    return true;
  }

  /**
   * Fail-closed admission gate for an incoming shard on this worker node.
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {{ accepted: boolean, action: string, loadShedState: string, telemetry: object }}
   */
  canAcceptShard(options) {
    const telemetry = this.getHardwareTelemetry(options);
    if (!telemetry.standbyReady) {
      return {
        accepted: false,
        action: 'REJECT_OR_PAUSE',
        loadShedState: telemetry.loadShedState,
        telemetry
      };
    }
    return {
      accepted: true,
      action: 'ACCEPT',
      loadShedState: telemetry.loadShedState,
      telemetry
    };
  }

  _derivePeerReadiness(telemetry, existingPeer = null) {
    if (!telemetry || typeof telemetry !== 'object') {
      return { standbyReady: false, cpuLoad: undefined, freeMemRatio: undefined };
    }

    const cpuLoad = telemetry.cpuLoad !== undefined
      ? telemetry.cpuLoad
      : (existingPeer ? existingPeer.cpuLoad : undefined);
    const freeMemRatio = telemetry.freeMemRatio !== undefined
      ? telemetry.freeMemRatio
      : (existingPeer ? existingPeer.freeMemRatio : undefined);

    if (cpuLoad !== undefined) {
      if (typeof cpuLoad !== 'number' || !Number.isFinite(cpuLoad) || cpuLoad < 0 || cpuLoad > this.maxCpuThreshold) {
        return { standbyReady: false, cpuLoad, freeMemRatio };
      }
    }
    if (freeMemRatio !== undefined) {
      if (typeof freeMemRatio !== 'number' || !Number.isFinite(freeMemRatio) || freeMemRatio < this.minFreeMemRatio || freeMemRatio > 1) {
        return { standbyReady: false, cpuLoad, freeMemRatio };
      }
    }

    let standbyReady;
    if (telemetry.standbyReady !== undefined) {
      standbyReady = telemetry.standbyReady === true;
    } else if (cpuLoad !== undefined || freeMemRatio !== undefined) {
      standbyReady = true;
    } else if (existingPeer) {
      standbyReady = existingPeer.standbyReady === true;
    } else {
      standbyReady = false;
    }

    return { standbyReady, cpuLoad, freeMemRatio };
  }

  registerPeer(peerNodeId, publicKey, telemetry = {}) {
    if (typeof peerNodeId !== 'string' || !peerNodeId) {
      throw new TypeError('Invalid peerNodeId: must be a non-empty string');
    }
    if (typeof publicKey !== 'string' || !publicKey) {
      throw new TypeError('Invalid publicKey: must be a non-empty string');
    }

    const readiness = this._derivePeerReadiness(telemetry, null);
    const rawLatency = telemetry && telemetry.latencyMs !== undefined ? telemetry.latencyMs : 20;
    const latencyMs = (typeof rawLatency === 'number' && Number.isFinite(rawLatency))
      ? Math.max(0, rawLatency)
      : 9999;

    const rawCap = telemetry && telemetry.capacityScore !== undefined ? telemetry.capacityScore : 100;
    const capacityScore = (typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= 0)
      ? rawCap
      : 0;

    const maxConcurrentShards = (telemetry && Number.isSafeInteger(telemetry.maxConcurrentShards) && telemetry.maxConcurrentShards > 0)
      ? telemetry.maxConcurrentShards
      : Infinity;

    const existingPeer = this.peerTable.get(peerNodeId);
    const activeShards = existingPeer && typeof existingPeer.activeShards === 'number' && Number.isFinite(existingPeer.activeShards)
      ? Math.max(0, existingPeer.activeShards)
      : 0;

    const peerInfo = {
      nodeId: peerNodeId,
      publicKey,
      standbyReady: readiness.standbyReady,
      latencyMs,
      capacityScore,
      cpuLoad: readiness.cpuLoad,
      freeMemRatio: readiness.freeMemRatio,
      freeMemBytes: (telemetry && typeof telemetry.freeMemBytes === 'number' && Number.isFinite(telemetry.freeMemBytes))
        ? Math.max(0, telemetry.freeMemBytes)
        : undefined,
      activeShards,
      maxConcurrentShards,
      lastSeen: this._now()
    };

    this.peerTable.set(peerNodeId, peerInfo);

    if (telemetry && telemetry.reputationScore !== undefined) {
      this.updatePeerReputation(peerNodeId, telemetry.reputationScore);
    }

    if (peerInfo.standbyReady && this.autoFlush && this.taskQueue.length > 0) {
      this.flushQueue();
    }
  }

  updatePeerTelemetry(peerNodeId, telemetry = {}) {
    const peer = this.peerTable.get(peerNodeId);
    if (!peer) {
      throw new Error(`Unknown peer: ${peerNodeId}`);
    }
    if (!telemetry || typeof telemetry !== 'object') {
      peer.standbyReady = false;
      peer.lastSeen = this._now();
      return peer;
    }

    const readiness = this._derivePeerReadiness(telemetry, peer);
    peer.standbyReady = readiness.standbyReady;
    peer.cpuLoad = readiness.cpuLoad;
    peer.freeMemRatio = readiness.freeMemRatio;

    if (telemetry.latencyMs !== undefined) {
      peer.latencyMs = (typeof telemetry.latencyMs === 'number' && Number.isFinite(telemetry.latencyMs))
        ? Math.max(0, telemetry.latencyMs)
        : 9999;
    }
    if (telemetry.capacityScore !== undefined && typeof telemetry.capacityScore === 'number' && Number.isFinite(telemetry.capacityScore) && telemetry.capacityScore >= 0) {
      peer.capacityScore = telemetry.capacityScore;
    }
    if (telemetry.freeMemBytes !== undefined && typeof telemetry.freeMemBytes === 'number' && Number.isFinite(telemetry.freeMemBytes)) {
      peer.freeMemBytes = Math.max(0, telemetry.freeMemBytes);
    }
    if (telemetry.maxConcurrentShards !== undefined && Number.isSafeInteger(telemetry.maxConcurrentShards) && telemetry.maxConcurrentShards > 0) {
      peer.maxConcurrentShards = telemetry.maxConcurrentShards;
    }
    if (telemetry.tier !== undefined) {
      peer.tier = telemetry.tier;
    }
    if (telemetry.reputationScore !== undefined) {
      this.updatePeerReputation(peerNodeId, telemetry.reputationScore);
    }
    peer.lastSeen = this._now();

    if (peer.standbyReady && this.autoFlush && this.taskQueue.length > 0) {
      this.flushQueue();
    }
    return peer;
  }

  /**
   * Updates peer reputation score [0.0 - 1.0] and auto-assigns tier level:
   * Tier 1: Data Center / High Performance (Score >= 0.85, low latency, high capacity)
   * Tier 2: Workstation / Desktop (Score >= 0.60)
   * Tier 3: Edge / IoT / Low-RAM (Score < 0.60)
   * @param {string} peerNodeId
   * @param {number|object} deltaOrScore Either raw score or { success: boolean, executionTimeMs?: number }
   * @returns {object} Updated peer
   */
  updatePeerReputation(peerNodeId, deltaOrScore) {
    const peer = this.peerTable.get(peerNodeId);
    if (!peer) {
      throw new Error(`Unknown peer: ${peerNodeId}`);
    }

    if (peer.reputationScore === undefined) {
      peer.reputationScore = 0.8; // Default baseline score
    }

    if (typeof deltaOrScore === 'number' && Number.isFinite(deltaOrScore)) {
      peer.reputationScore = Math.round(Math.max(0.0, Math.min(1.0, deltaOrScore)) * 100) / 100;
    } else if (deltaOrScore && typeof deltaOrScore === 'object') {
      if (deltaOrScore.success) {
        // Boost reputation on successful verified attestation
        peer.reputationScore = Math.round(Math.min(1.0, peer.reputationScore + 0.05) * 100) / 100;
      } else {
        // Slash reputation on tampered result or failed verification
        peer.reputationScore = Math.round(Math.max(0.0, peer.reputationScore - 0.25) * 100) / 100;
      }
    }

    // Dynamic Tier Classification
    if (peer.reputationScore >= 0.85 && (peer.capacityScore || 0) >= 80 && (peer.latencyMs || 999) < 100) {
      peer.tier = 'TIER_1'; // High performance
    } else if (peer.reputationScore >= 0.60) {
      peer.tier = 'TIER_2'; // Standard desktop / workstation
    } else {
      peer.tier = 'TIER_3'; // Low reliability / Edge
    }

    this.emit('peerReputationUpdated', {
      peerId: peerNodeId,
      reputationScore: peer.reputationScore,
      tier: peer.tier
    });

    return peer;
  }

  /**
   * Sets the callback invoked when a heartbeat ping should be transmitted to a peer.
   * @param {function(string, object): void} fn
   */
  setHeartbeatPingHandler(fn) {
    if (fn !== null && typeof fn !== 'function') {
      throw new TypeError('Heartbeat ping handler must be a function or null');
    }
    this._onHeartbeatPing = fn;
  }

  /**
   * Starts periodic 5-second heartbeat pinging and dead peer detection (15s default).
   * @param {number} [intervalMs]
   */
  startHeartbeatMonitor(intervalMs = this.heartbeatIntervalMs) {
    if (this._heartbeatTimer) return;
    this.heartbeatIntervalMs = intervalMs;
    this._heartbeatTimer = setInterval(() => {
      this.checkHeartbeats();
    }, this.heartbeatIntervalMs);
    if (typeof this._heartbeatTimer.unref === 'function') {
      this._heartbeatTimer.unref();
    }
  }

  /**
   * Stops the periodic heartbeat monitor.
   */
  stopHeartbeatMonitor() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Records a heartbeat pong received from a peer, updating its lastSeen timestamp
   * and optionally refreshing telemetry.
   * @param {string} peerNodeId
   * @param {object} [telemetry]
   */
  recordHeartbeatPong(peerNodeId, telemetry = null) {
    const peer = this.peerTable.get(peerNodeId);
    if (!peer) return false;
    peer.lastSeen = this._now();
    if (telemetry && typeof telemetry === 'object') {
      this.updatePeerTelemetry(peerNodeId, telemetry);
    }
    this.emit('peerHeartbeat', { peerId: peerNodeId, lastSeen: peer.lastSeen });
    return true;
  }

  /**
   * Inspects all registered peers, sends heartbeat pings for live peers,
   * detects dead peers (exceeding deadPeerTimeoutMs), marks them disconnected,
   * and instantly re-queues and re-dispatches their in-flight shards to another node.
   * @returns {{ deadPeers: Array<string>, pingedPeers: Array<string>, redispatched: Array<object> }}
   */
  checkHeartbeats() {
    const now = this._now();
    const deadPeers = [];
    const pingedPeers = [];
    const redispatched = [];

    for (const [peerId, peer] of Array.from(this.peerTable.entries())) {
      const elapsed = now - (peer.lastSeen || 0);
      if (elapsed > this.deadPeerTimeoutMs) {
        deadPeers.push(peerId);
      } else {
        pingedPeers.push(peerId);
        if (this._onHeartbeatPing) {
          try {
            this._onHeartbeatPing(peerId, peer);
          } catch {
            // Heartbeat ping transmission failure handled cleanly
          }
        }
        this.emit('heartbeatPing', { peerId, peer });
      }
    }

    for (const deadPeerId of deadPeers) {
      this.emit('deadPeerDetected', { peerId: deadPeerId });
      const { rescheduled } = this.handlePeerDisconnect(deadPeerId);
      for (const s of rescheduled) {
        redispatched.push(s);
      }
    }

    return { deadPeers, pingedPeers, redispatched };
  }

  /**
   * Unregisters or marks a peer disconnected and reschedules all its in-flight shards
   * to the front of the bounded queue (bounded by maxRetries).
   * @param {string} peerNodeId
   * @param {{ remove?: boolean }} [options]
   */
  handlePeerDisconnect(peerNodeId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const peer = this.peerTable.get(peerNodeId);
    if (peer) {
      peer.standbyReady = false;
      peer.activeShards = 0;
      if (opts.remove) {
        this.peerTable.delete(peerNodeId);
      }
    }

    const affected = [];
    for (const [shardId, entry] of this.inFlightShards.entries()) {
      if (entry.peerId === peerNodeId) {
        affected.push(shardId);
      }
    }

    // Reschedule in reverse index order so unshifting preserves original priority order
    affected.reverse();
    const rescheduled = [];
    const failed = [];

    for (const shardId of affected) {
      const outcome = this.rescheduleShard(shardId);
      if (outcome.status === 'RESCHEDULED') {
        rescheduled.push(outcome.shard);
      } else {
        failed.push(outcome);
      }
    }

    if (this.autoFlush && this.taskQueue.length > 0) {
      this.flushQueue();
    }

    return { rescheduled, failed };
  }

  /**
   * Fail-closed peer selection and scoring.
   * Returns [] when no eligible standby peers exist or count <= 0.
   * @param {string} taskHash
   * @param {number} [count=1]
   */
  selectOptimalNodes(taskHash, count = 1) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
      return [];
    }

    const hashSeed = typeof taskHash === 'string' ? taskHash : String(taskHash || '');
    const snapshot = Array.from(this.peerTable.values());

    const activeNodes = snapshot.filter((p) => {
      if (!p || p.standbyReady !== true) return false;
      if (p.cpuLoad !== undefined && (!Number.isFinite(p.cpuLoad) || p.cpuLoad < 0 || p.cpuLoad > this.maxCpuThreshold)) return false;
      if (p.freeMemRatio !== undefined && (!Number.isFinite(p.freeMemRatio) || p.freeMemRatio < this.minFreeMemRatio || p.freeMemRatio > 1)) return false;
      if (this.minFreeMemBytes > 0 && p.freeMemBytes !== undefined && (!Number.isFinite(p.freeMemBytes) || p.freeMemBytes < this.minFreeMemBytes)) return false;
      if ((p.activeShards || 0) >= (p.maxConcurrentShards || Infinity)) return false;
      return true;
    });

    if (activeNodes.length === 0) {
      return [];
    }

    const tieHashCache = new Map();
    const getTieHash = (nodeId) => {
      let h = tieHashCache.get(nodeId);
      if (!h) {
        h = crypto.createHash('sha256').update(`${hashSeed}:${nodeId}`).digest('hex');
        tieHashCache.set(nodeId, h);
      }
      return h;
    };

    activeNodes.sort((a, b) => {
      // Prioritize higher reputation score if available
      const repA = a.reputationScore !== undefined ? a.reputationScore : 0.8;
      const repB = b.reputationScore !== undefined ? b.reputationScore : 0.8;
      if (Math.abs(repA - repB) >= 0.1) {
        return repB - repA; // Higher reputation preferred
      }
      if (a.latencyMs !== b.latencyMs) {
        return a.latencyMs - b.latencyMs;
      }
      if (a.capacityScore !== b.capacityScore) {
        return b.capacityScore - a.capacityScore;
      }
      const ha = getTieHash(a.nodeId);
      const hb = getTieHash(b.nodeId);
      if (ha < hb) return -1;
      if (ha > hb) return 1;
      return a.nodeId < b.nodeId ? -1 : (a.nodeId > b.nodeId ? 1 : 0);
    });

    return activeNodes.slice(0, Math.floor(count));
  }

  /**
   * Enqueues a shard into the bounded FIFO queue (or head if priority=true).
   * Throws QueueFullError fail-closed if queue capacity is reached.
   * @param {object} shard
   * @param {{ priority?: boolean }} [options]
   */
  enqueueTask(shard, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!shard || typeof shard !== 'object' || typeof shard.shardId !== 'string' || !shard.shardId) {
      throw new TypeError('Invalid shard: must be an object with non-empty shardId');
    }

    if (this.inFlightShards.has(shard.shardId) || this.taskQueue.some((t) => t.shardId === shard.shardId)) {
      throw new Error(`Duplicate shardId already in flight: ${shard.shardId}`);
    }

    this.pruneExpiredQueue();

    if (this.taskQueue.length >= this.maxQueueSize) {
      throw new QueueFullError(`Task queue capacity (${this.maxQueueSize}) exceeded: fail-closed rejection`);
    }

    const queuedItem = {
      ...shard,
      enqueuedAt: shard.enqueuedAt !== undefined ? shard.enqueuedAt : this._now()
    };

    if (opts.priority) {
      this.taskQueue.unshift(queuedItem);
    } else {
      this.taskQueue.push(queuedItem);
    }

    this.emit('shardQueued', queuedItem);
    return queuedItem;
  }

  /**
   * Removes and returns a queued shard by its shardId without failing the task.
   * Returns null if not found in queue.
   * @param {string} shardId
   * @returns {object|null}
   */
  removeQueuedShard(shardId) {
    if (typeof shardId !== 'string' || !shardId) return null;
    const idx = this.taskQueue.findIndex((t) => t.shardId === shardId);
    if (idx === -1) return null;
    const [removed] = this.taskQueue.splice(idx, 1);
    return removed;
  }

  /**
   * Dequeues the next non-expired shard from the FIFO queue, or null if empty.
   * @returns {object | null}
   */
  dequeueTask() {
    this.pruneExpiredQueue();
    if (this.taskQueue.length === 0) {
      return null;
    }
    return this.taskQueue.shift();
  }

  /**
   * Purges expired queued tasks exceeding maxQueueTimeMs without silent loss.
   * @returns {Array<object>}
   */
  pruneExpiredQueue() {
    if (!Number.isFinite(this.maxQueueTimeMs) || this.maxQueueTimeMs <= 0) {
      return [];
    }

    const now = this._now();
    const expired = [];
    const remaining = [];

    for (const shard of this.taskQueue) {
      const age = now - (shard.enqueuedAt !== undefined ? shard.enqueuedAt : now);
      if (age > this.maxQueueTimeMs) {
        const record = { shard, reason: 'QUEUE_TTL_EXPIRED', expiredAt: now, ageMs: age };
        expired.push(record);
        this.expiredTasks.push(record);
        this.emit('shardExpired', record);
      } else {
        remaining.push(shard);
      }
    }

    if (expired.length > 0) {
      this.taskQueue = remaining;
    }
    return expired;
  }

  /**
   * Reschedules an in-flight shard back to the head of the task queue,
   * or fails closed permanently if maxRetries is exceeded.
   * @param {string} shardId
   */
  rescheduleShard(shardId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const entry = this.inFlightShards.get(shardId);
    if (!entry) {
      return { status: 'NOT_FOUND', shardId };
    }

    this.inFlightShards.delete(shardId);
    const peer = this.peerTable.get(entry.peerId);
    if (peer && peer.activeShards > 0) {
      peer.activeShards -= 1;
    }

    const effectiveAttempts = opts.preserveAttempts ? Math.max(0, entry.attempts - 1) : entry.attempts;
    if (effectiveAttempts >= this.maxRetries) {
      const failure = {
        shard: entry.shard,
        reason: 'MAX_RETRIES_EXCEEDED',
        attempts: entry.attempts,
        failedAt: this._now()
      };
      this.failedTasks.push(failure);
      this.emit('shardFailed', failure);
      return { status: 'FAILED', ...failure };
    }

    // Check if there is an existing checkpoint to resume from
    let resumeCheckpoint = null;
    if (this.checkpoints) {
      try {
        resumeCheckpoint = this.checkpoints.restoreCheckpoint(shardId);
      } catch (err) {
        this.emit('checkpointCorruptedOnReschedule', { shardId, error: err.message });
      }
    }

    const updatedShard = {
      ...entry.shard,
      attempts: effectiveAttempts,
      enqueuedAt: this._now(),
      resumeCheckpoint: resumeCheckpoint || entry.shard.resumeCheckpoint || null
    };

    this.pruneExpiredQueue();

    if (this.taskQueue.length >= this.maxQueueSize) {
      const failure = {
        shard: updatedShard,
        reason: 'QUEUE_FULL_ON_RESCHEDULE',
        attempts: entry.attempts,
        failedAt: this._now()
      };
      this.failedTasks.push(failure);
      this.emit('shardFailed', failure);
      return { status: 'FAILED', ...failure };
    }

    this.taskQueue = this.taskQueue.filter((t) => t.shardId !== updatedShard.shardId);
    this.taskQueue.unshift(updatedShard);
    this.emit('shardRescheduled', updatedShard);
    return { status: 'RESCHEDULED', shard: updatedShard };
  }

  /**
   * Routes a shard to the best available standby peer, or safely queues it fail-closed
   * when no compute nodes are available or all nodes are busy/load-shedding.
   * @param {object} shard
   * @param {{ failClosed?: boolean, onDispatch?: function }} [options]
   */
  dispatchShard(shard, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!shard || typeof shard !== 'object' || typeof shard.shardId !== 'string' || !shard.shardId) {
      throw new TypeError('Invalid shard: must be an object with non-empty shardId');
    }
    if (opts.onDispatch !== undefined && opts.onDispatch !== null && typeof opts.onDispatch !== 'function') {
      throw new TypeError('Dispatch callback must be a function');
    }

    this.pruneExpiredQueue();
    const candidates = this.selectOptimalNodes(shard.shardId, 1);

    if (candidates.length === 0) {
      const reason = this.peerTable.size === 0 ? 'FAIL_CLOSED_NO_NODES' : 'ALL_PEERS_BUSY_OR_SHEDDING';
      if (opts.failClosed) {
        return { status: 'REJECTED', reason, shard };
      }
      const queued = this.enqueueTask(shard);
      return { status: 'QUEUED', reason, queueLength: this.taskQueue.length, shard: queued };
    }

    if (this.inFlightShards.has(shard.shardId)) {
      throw new Error(`Duplicate shardId already in flight: ${shard.shardId}`);
    }

    return this._assignShardToPeer(shard, candidates[0], opts.onDispatch);
  }

  routeShard(shard, options = {}) {
    return this.dispatchShard(shard, options);
  }

  _assignShardToPeer(shard, peer, dispatchCallback, assignState = null) {
    if (!shard || typeof shard !== 'object' || typeof shard.shardId !== 'string' || !shard.shardId) {
      throw new TypeError('Invalid shard: must be an object with non-empty shardId');
    }
    if (!peer || typeof peer !== 'object' || typeof peer.nodeId !== 'string' || !peer.nodeId) {
      throw new TypeError('Invalid peer: must be a peer object with non-empty nodeId');
    }
    if (dispatchCallback !== undefined && dispatchCallback !== null && typeof dispatchCallback !== 'function') {
      throw new TypeError('Dispatch callback must be a function');
    }

    if (this.inFlightShards.has(shard.shardId) || this.taskQueue.some((t) => t.shardId === shard.shardId)) {
      throw new Error(`Duplicate shardId already in flight: ${shard.shardId}`);
    }

    const attempts = (shard.attempts || 0) + 1;
    const assignedShard = { ...shard, attempts };
    const assignedAt = this._now();

    const hadPrevEntry = this.inFlightShards.has(assignedShard.shardId);
    const prevEntry = hadPrevEntry ? this.inFlightShards.get(assignedShard.shardId) : null;
    const entry = {
      shard: assignedShard,
      peerId: peer.nodeId,
      assignedAt,
      attempts
    };

    peer.activeShards = (peer.activeShards || 0) + 1;
    this.inFlightShards.set(assignedShard.shardId, entry);

    try {
      const handler = typeof dispatchCallback === 'function' ? dispatchCallback : this.onDispatch;
      if (handler) {
        handler(assignedShard, peer);
      }

      this.emit('shardDispatched', { shard: assignedShard, peer });
    } catch (err) {
      if (this.inFlightShards.get(assignedShard.shardId) === entry) {
        if (hadPrevEntry) {
          this.inFlightShards.set(assignedShard.shardId, prevEntry);
        } else {
          this.inFlightShards.delete(assignedShard.shardId);
        }
        if (typeof peer.activeShards === 'number' && peer.activeShards > 0) {
          peer.activeShards -= 1;
        } else {
          peer.activeShards = 0;
        }
      } else if (assignState && typeof assignState === 'object') {
        assignState.settledExternally = true;
      }
      throw err;
    }

    return { status: 'DISPATCHED', peer, shard: assignedShard };
  }

  /**
   * Marks an in-flight shard completed, freeing peer capacity and flushing queued shards.
   * @param {string} shardId
   */
  completeShard(shardId) {
    const entry = this.inFlightShards.get(shardId);
    if (!entry) {
      return false;
    }
    this.inFlightShards.delete(shardId);
    const peer = this.peerTable.get(entry.peerId);
    if (peer && peer.activeShards > 0) {
      peer.activeShards -= 1;
    }
    if (this.autoFlush && this.taskQueue.length > 0) {
      this.flushQueue();
    }
    return true;
  }

  /**
   * Dispatches as many queued shards as currently available peer capacity allows.
   * @param {function} [dispatchCallback]
   * @returns {Array<{ shard: object, peer: object }>}
   */
  flushQueue(dispatchCallback) {
    if (dispatchCallback !== undefined && dispatchCallback !== null && typeof dispatchCallback !== 'function') {
      throw new TypeError('Dispatch callback must be a function');
    }
    this.pruneExpiredQueue();
    const dispatched = [];

    while (this.taskQueue.length > 0) {
      const nextShard = this.taskQueue[0];
      const candidates = this.selectOptimalNodes(nextShard.shardId, 1);
      if (candidates.length === 0) {
        break;
      }
      this.taskQueue.shift();
      const assignState = { settledExternally: false };
      try {
        const assignment = this._assignShardToPeer(nextShard, candidates[0], dispatchCallback, assignState);
        dispatched.push({ shard: assignment.shard, peer: assignment.peer });
      } catch (err) {
        if (!assignState.settledExternally) {
          this.taskQueue.unshift(nextShard);
        }
        if (dispatched.length > 0) {
          try {
            this.emit('queueFlushed', dispatched);
          } catch {
            // Preserve original dispatch error
          }
        }
        throw err;
      }
    }

    if (dispatched.length > 0) {
      this.emit('queueFlushed', dispatched);
    }
    return dispatched;
  }

  createTaskPartitions(taskCode, datasetArray, chunkSize = 2) {
    if (typeof taskCode !== 'string' || !taskCode) {
      throw new TypeError('Invalid taskCode: must be a non-empty string');
    }
    if (!Array.isArray(datasetArray)) {
      throw new TypeError('Invalid datasetArray: must be an Array');
    }
    if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError('Invalid chunkSize: must be a positive safe integer');
    }

    const partitions = [];
    for (let i = 0; i < datasetArray.length; i += chunkSize) {
      const chunk = datasetArray.slice(i, i + chunkSize);
      const serializedChunk = JSON.stringify(chunk, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      const partitionId = crypto
        .createHash('sha256')
        .update(`${taskCode}:${serializedChunk}:${i}`)
        .digest('hex')
        .slice(0, 40);

      partitions.push({
        shardId: partitionId,
        index: Math.floor(i / chunkSize),
        taskCode,
        inputData: chunk
      });
    }
    return partitions;
  }

  /**
   * Deterministically reassembles worker shard outputs in index order,
   * rejecting missing or duplicate partition indices fail-closed.
   * @param {Array<{ shardId?: string, index: number, output: any }>} results
   * @param {number} [expectedCount]
   * @returns {any[]}
   */
  aggregateResults(results, expectedCount) {
    if (!Array.isArray(results)) {
      throw new TypeError('Invalid results: must be an Array');
    }
    if (expectedCount !== undefined) {
      if (typeof expectedCount !== 'number' || !Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new RangeError('Invalid expectedCount: must be a non-negative safe integer');
      }
    }
    if (results.length === 0) {
      if (expectedCount !== undefined && expectedCount > 0) {
        throw new Error('Incomplete shard aggregation: missing shard index 0');
      }
      return [];
    }

    const seenIndices = new Set();
    let maxIndex = -1;

    for (const item of results) {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.index) || item.index < 0) {
        throw new TypeError('Invalid shard result: each item must have a non-negative integer index');
      }
      if (expectedCount !== undefined && item.index >= expectedCount) {
        throw new RangeError(`Shard index out of range: ${item.index} >= expectedCount (${expectedCount})`);
      }
      if (seenIndices.has(item.index)) {
        throw new Error(`Duplicate shard index: ${item.index}`);
      }
      seenIndices.add(item.index);
      if (item.index > maxIndex) {
        maxIndex = item.index;
      }
    }

    const targetCount = expectedCount !== undefined ? expectedCount : (maxIndex + 1);
    for (let i = 0; i < targetCount; i++) {
      if (!seenIndices.has(i)) {
        throw new Error(`Incomplete shard aggregation: missing shard index ${i}`);
      }
    }

    const sorted = results.slice().sort((a, b) => a.index - b.index);
    const allArrays = sorted.every((r) => Array.isArray(r.output));

    if (allArrays) {
      const aggregated = [];
      for (const r of sorted) {
        for (const el of r.output) {
          aggregated.push(el);
        }
      }
      return aggregated;
    }

    return sorted.map((r) => r.output);
  }

  /**
   * Evaluates Byzantine majority consensus across redundant shard outputs.
   * If a majority agreement exists (e.g., 2-of-3 or 2-of-2), returns the consensus output
   * and lists consensus/dissenting peer nodes.
   * Throws Error fail-closed if no majority consensus is achieved.
   * @param {Array<{ output: any, peerId?: string, workerId?: string }>} executions
   * @returns {{ consensusOutput: any, agreementRatio: number, consensusPeers: string[], dissentingPeers: string[] }}
   */
  evaluateConsensus(executions) {
    if (!Array.isArray(executions) || executions.length === 0) {
      throw new TypeError('Invalid executions: expected non-empty Array');
    }

    // Map each output to deterministic canonical serialization hash
    const hashes = executions.map((exec) => {
      const canonicalStr = JSON.stringify(exec.output, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
      const hash = crypto.createHash('sha256').update(String(canonicalStr)).digest('hex');
      return {
        hash,
        exec,
        peerId: exec.peerId || exec.workerId || 'unknown'
      };
    });

    const frequency = new Map();
    for (const h of hashes) {
      const count = (frequency.get(h.hash) || 0) + 1;
      frequency.set(h.hash, count);
    }

    let winningHash = null;
    let maxCount = 0;
    for (const [hash, count] of frequency.entries()) {
      if (count > maxCount) {
        maxCount = count;
        winningHash = hash;
      }
    }

    const majorityNeeded = Math.floor(executions.length / 2) + 1;
    if (maxCount < majorityNeeded) {
      throw new Error(`Consensus failed: largest agreement (${maxCount}/${executions.length}) did not meet majority (${majorityNeeded})`);
    }

    const consensusPeers = [];
    const dissentingPeers = [];
    let consensusOutput = undefined;

    for (const h of hashes) {
      if (h.hash === winningHash) {
        consensusPeers.push(h.peerId);
        if (consensusOutput === undefined) {
          consensusOutput = h.exec.output;
        }
      } else {
        dissentingPeers.push(h.peerId);
      }
    }

    // Update reputation of participating peers
    for (const peerId of consensusPeers) {
      if (this.peerTable.has(peerId)) {
        this.updatePeerReputation(peerId, { success: true });
      }
    }
    for (const peerId of dissentingPeers) {
      if (this.peerTable.has(peerId)) {
        this.updatePeerReputation(peerId, { success: false });
      }
    }

    return {
      consensusOutput,
      agreementRatio: maxCount / executions.length,
      consensusPeers,
      dissentingPeers
    };
  }
}

module.exports = { GridRouter, QueueFullError };
