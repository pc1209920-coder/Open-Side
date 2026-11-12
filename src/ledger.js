const crypto = require('node:crypto');
const EventEmitter = require('node:events');

const MICRO_SCALE = 1_000_000;
const MICRO_SCALE_BIGINT = 1_000_000n;
const MAX_SAFE_CREDITS_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_SAFE_CREDITS_MICRO = MAX_SAFE_CREDITS_BIGINT * MICRO_SCALE_BIGINT;
const GENESIS_HASH = '0'.repeat(64);

const DEFAULT_BASE_RATE_PER_MS = 0.1;
const DEFAULT_BYTE_WEIGHT = 0.05;
const DEFAULT_MIN_COST = 1;
const DEFAULT_MAX_EXECUTION_MS = 1500;
const DEFAULT_MAX_INPUT_SIZE = 10_000_000;
const DEFAULT_MAX_COMPLEXITY_FACTOR = 100;

class DoubleSpendAttemptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DoubleSpendAttemptError';
    this.code = 'ERR_DOUBLE_SPEND';
  }
}

class InsufficientCreditBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientCreditBalanceError';
    this.code = 'ERR_INSUFFICIENT_BALANCE';
  }
}

class UnknownAccountError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnknownAccountError';
    this.code = 'ERR_UNKNOWN_ACCOUNT';
  }
}

class CreditOverflowError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'CreditOverflowError';
    this.code = 'ERR_CREDIT_OVERFLOW';
  }
}

/**
 * Converts a non-negative finite number of credits into integer BigInt micro-credits
 * (scale = 1e6) without intermediate floating-point overflow near MAX_SAFE_INTEGER.
 * @param {number} amount
 * @param {string} [label='amount']
 * @returns {bigint}
 */
function toMicroCredits(amount, label = 'amount') {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    if (Number.isNaN(amount)) {
      throw new RangeError(`Invalid ${label}: must be a non-negative finite number (got NaN)`);
    }
    throw new TypeError(`Invalid ${label}: must be a finite number`);
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(`Invalid ${label}: must be a non-negative finite number`);
  }
  if (amount === 0) {
    return 0n;
  }
  if (amount > Number.MAX_SAFE_INTEGER) {
    throw new CreditOverflowError(`Invalid ${label}: exceeds Number.MAX_SAFE_INTEGER`);
  }

  const whole = Math.trunc(amount);
  const frac = amount - whole;
  const fracMicro = Math.round(frac * MICRO_SCALE);
  const totalMicro = BigInt(whole) * MICRO_SCALE_BIGINT + BigInt(fracMicro);
  if (totalMicro > MAX_SAFE_CREDITS_MICRO) {
    throw new CreditOverflowError(`Invalid ${label}: exceeds Number.MAX_SAFE_INTEGER`);
  }
  return totalMicro;
}

/**
 * Converts integer BigInt micro-credits back to an exact decimal Number without double-rounding.
 * @param {bigint} micro
 * @returns {number}
 */
function fromMicroCredits(micro) {
  if (typeof micro !== 'bigint' || micro < 0n) {
    throw new RangeError('Invalid micro-credit value: must be a non-negative BigInt');
  }
  const whole = micro / MICRO_SCALE_BIGINT;
  const rem = micro % MICRO_SCALE_BIGINT;
  if (rem === 0n) {
    return Number(whole);
  }
  const fracStr = rem.toString().padStart(6, '0');
  return Number(`${whole.toString()}.${fracStr}`);
}

/**
 * Canonical SHA-256 hash helper for audit chaining.
 * @param {unknown} value
 * @returns {string}
 */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Encodes composite key parts without delimiter-collision ambiguity.
 * @param {...unknown} parts
 * @returns {string}
 */
function encodeCompositeKey(...parts) {
  return JSON.stringify(parts);
}

/**
 * Deterministic JSON serializer that converts BigInt values to decimal strings
 * while remaining byte-identical to JSON.stringify for all standard JSON types.
 * @param {unknown} value
 * @returns {string|undefined}
 */
function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'bigint') return `${obj.toString()}n`;
    if (typeof obj === 'number' && (!Number.isFinite(obj) || Number.isNaN(obj))) {
      throw new TypeError('Cannot serialize non-finite numbers in canonical JSON');
    }
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalJson(item)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function safeJsonStringify(value) {
  try {
    return canonicalJson(value);
  } catch {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
}

/**
 * Clones own enumerable properties while stripping `__proto__` without invoking
 * Object.prototype.__proto__ setters.
 * @param {object} obj
 * @returns {object}
 */
function clonePlainObjectSafe(obj) {
  const cloned = {};
  for (const key of Object.keys(obj)) {
    if (key === '__proto__') {
      continue;
    }
    Object.defineProperty(cloned, key, {
      value: obj[key],
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  return cloned;
}

const AUDIT_BODY_KEYS = [
  'index',
  'timestamp',
  'type',
  'requesterId',
  'workerId',
  'shardId',
  'cost',
  'requesterBalance',
  'workerBalance',
  'attestationHash',
  'attestationNonce',
  'prevHash'
];
const AUDIT_ENTRY_KEY_SET = new Set([...AUDIT_BODY_KEYS, 'hash']);

/**
 * Computes the canonical SHA-256 digest of an audit entry regardless of property insertion order.
 * @param {object} entry
 * @returns {string}
 */
function computeAuditEntryHash(entry) {
  const canonicalPayload = {};
  for (const key of AUDIT_BODY_KEYS) {
    if (key === 'attestationNonce') {
      canonicalPayload[key] = entry.attestationNonce !== undefined ? entry.attestationNonce : null;
    } else {
      canonicalPayload[key] = entry[key];
    }
  }
  return sha256Hex(JSON.stringify(canonicalPayload));
}

/**
 * Parses a persisted non-negative integer BigInt string safely and enforces bounds.
 * @param {string|number|bigint} raw
 * @param {string} label
 * @returns {bigint}
 */
function parsePersistedMicro(raw, label) {
  if (typeof raw === 'bigint') {
    if (raw < 0n) {
      throw new RangeError(`Invalid persisted ${label}: must be a non-negative BigInt`);
    }
    if (raw > MAX_SAFE_CREDITS_MICRO) {
      throw new CreditOverflowError(`Invalid persisted ${label}: exceeds MAX_SAFE_CREDITS_MICRO`);
    }
    return raw;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new RangeError(`Invalid persisted ${label}: must be a non-negative finite number`);
    }
    return toMicroCredits(raw, label);
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new RangeError(`Invalid persisted ${label}: must be a non-negative integer string`);
  }
  const value = BigInt(raw);
  if (value > MAX_SAFE_CREDITS_MICRO) {
    throw new CreditOverflowError(`Invalid persisted ${label}: exceeds MAX_SAFE_CREDITS_MICRO`);
  }
  return value;
}

/**
 * Verifies an HMAC-SHA256 Proof-of-Compute signature in constant time,
 * matching MeshCryptoEngine's `${shardId}:${JSON.stringify(resultData)}` payload format
 * (with deterministic BigInt-safe serialization).
 * @param {string} shardId
 * @param {unknown} resultData
 * @param {string|Buffer} signature
 * @param {string|Buffer} secret
 * @returns {boolean}
 */
function verifyHmacProof(shardId, resultData, signature, secret) {
  if (typeof shardId !== 'string' || shardId.length === 0) {
    return false;
  }
  if (resultData === undefined) {
    return false;
  }

  // Check for 64-byte Ed25519 signature
  let isEd25519 = false;
  if (typeof signature === 'string' && signature.length === 128 && /^[0-9a-fA-F]{128}$/.test(signature)) {
    isEd25519 = true;
  } else if (Buffer.isBuffer(signature) && signature.length === 64) {
    isEd25519 = true;
  }

  if (isEd25519 && secret) {
    try {
      const payload = {
        shardId,
        resultHash: crypto.createHash('sha256').update(canonicalJson(resultData)).digest('hex')
      };
      const canonicalBytes = Buffer.from(canonicalJson(payload), 'utf8');
      const sigBuf = Buffer.isBuffer(signature) ? signature : Buffer.from(signature, 'hex');

      let pubKeyObj = secret;
      if (typeof secret === 'string') {
        const der = Buffer.from(secret, 'hex');
        pubKeyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      } else if (Buffer.isBuffer(secret)) {
        pubKeyObj = crypto.createPublicKey({ key: secret, format: 'der', type: 'spki' });
      }
      if (crypto.verify(null, canonicalBytes, pubKeyObj, sigBuf)) {
        return true;
      }
    } catch {
      // Fall through to HMAC check
    }
  }

  if (
    secret === undefined ||
    secret === null ||
    (Buffer.isBuffer(secret) && secret.length === 0) ||
    (typeof secret === 'string' && secret.length === 0) ||
    (!Buffer.isBuffer(secret) && typeof secret !== 'string')
  ) {
    return false;
  }

  let sigBuf;
  if (Buffer.isBuffer(signature)) {
    if (signature.length !== 32) {
      return false;
    }
    sigBuf = signature;
  } else if (typeof signature === 'string' && signature.length === 64 && /^[0-9a-fA-F]{64}$/.test(signature)) {
    sigBuf = Buffer.from(signature, 'hex');
  } else {
    return false;
  }

  let serializedResult;
  try {
    serializedResult = safeJsonStringify(resultData);
  } catch {
    return false;
  }
  if (typeof serializedResult !== 'string') {
    return false;
  }

  try {
    const key = Buffer.isBuffer(secret) ? secret : String(secret);
    const expectedBuf = crypto
      .createHmac('sha256', key)
      .update(`${shardId}:${serializedResult}`)
      .digest();
    if (sigBuf.length !== 32 || expectedBuf.length !== 32) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Normalizes a Proof-of-Compute signature to lowercase 64-char hex or returns null if malformed.
 * @param {string|Buffer} proofOfCompute
 * @returns {string|null}
 */
function normalizeProofHex(proofOfCompute) {
  if (Buffer.isBuffer(proofOfCompute)) {
    return (proofOfCompute.length === 32 || proofOfCompute.length === 64) ? proofOfCompute.toString('hex').toLowerCase() : null;
  }
  if (typeof proofOfCompute === 'string' && (/^[0-9a-fA-F]{64}$/.test(proofOfCompute) || /^[0-9a-fA-F]{128}$/.test(proofOfCompute))) {
    return proofOfCompute.toLowerCase();
  }
  return null;
}

/**
 * Anti-Replay Proof-of-Compute Economic & Credit Ledger (Requirement R6).
 * Enforces deterministic fixed-point work metering, constant-time PoC verification,
 * anti-replay double-spend prevention, escrow & fail-closed balance conservation,
 * and a hash-chained immutable audit log.
 */
class ProofOfComputeLedger extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.baseRatePerMs=0.1]
   * @param {number} [options.byteWeight=0.05]
   * @param {number} [options.minCost=1]
   * @param {number} [options.maxExecutionMs=1500]
   * @param {number} [options.maxInputSize=10000000]
   * @param {boolean} [options.allowSelfSettle=false]
   * @param {boolean} [options.throwOnReplay=true]
   * @param {boolean} [options.throwOnError=true]
   * @param {boolean} [options.throwOnInvalidSignature=false]
   * @param {function(): number} [options.now]
   * @param {Set<string>|string[]} [options.settledAttestations]
   * @param {Map<string, Set<string|number>>|object} [options.usedNonces]
   * @param {Map<string, object>|Array<object>|object} [options.accounts]
   * @param {Array<object>} [options.escrows]
   * @param {Array<object>} [options.auditLog]
   */
  constructor(options = {}) {
    super();
    const opts = options && typeof options === 'object' ? options : {};

    this.baseRatePerMs = opts.baseRatePerMs !== undefined ? opts.baseRatePerMs : DEFAULT_BASE_RATE_PER_MS;
    if (typeof this.baseRatePerMs !== 'number' || !Number.isFinite(this.baseRatePerMs) || this.baseRatePerMs <= 0) {
      throw new RangeError('Invalid baseRatePerMs: must be a positive finite number');
    }

    this.byteWeight = opts.byteWeight !== undefined ? opts.byteWeight : DEFAULT_BYTE_WEIGHT;
    if (typeof this.byteWeight !== 'number' || !Number.isFinite(this.byteWeight) || this.byteWeight < 0) {
      throw new RangeError('Invalid byteWeight: must be a non-negative finite number');
    }

    this.minCost = opts.minCost !== undefined ? opts.minCost : DEFAULT_MIN_COST;
    this._minCostMicro = toMicroCredits(this.minCost, 'minCost');

    this.maxExecutionMs = opts.maxExecutionMs !== undefined ? opts.maxExecutionMs : DEFAULT_MAX_EXECUTION_MS;
    if (typeof this.maxExecutionMs !== 'number' || !Number.isFinite(this.maxExecutionMs) || this.maxExecutionMs <= 0) {
      throw new RangeError('Invalid maxExecutionMs: must be a positive finite number');
    }

    this.maxInputSize = opts.maxInputSize !== undefined ? opts.maxInputSize : DEFAULT_MAX_INPUT_SIZE;
    if (typeof this.maxInputSize !== 'number' || !Number.isFinite(this.maxInputSize) || this.maxInputSize <= 0) {
      throw new RangeError('Invalid maxInputSize: must be a positive finite number');
    }

    this.maxComplexityFactor = opts.maxComplexityFactor !== undefined ? opts.maxComplexityFactor : DEFAULT_MAX_COMPLEXITY_FACTOR;
    if (typeof this.maxComplexityFactor !== 'number' || !Number.isFinite(this.maxComplexityFactor) || this.maxComplexityFactor <= 0) {
      throw new RangeError('Invalid maxComplexityFactor: must be a positive finite number');
    }

    this.allowSelfSettle = Boolean(opts.allowSelfSettle);
    this.throwOnReplay = opts.throwOnReplay !== undefined ? Boolean(opts.throwOnReplay) : true;
    this.throwOnError = opts.throwOnError !== undefined ? Boolean(opts.throwOnError) : true;
    this.throwOnInvalidSignature = Boolean(opts.throwOnInvalidSignature);
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();

    /** @type {Map<string, { nodeId: string, balance: number, reserved: number, totalEarned: number, totalSpent: number, settledCount: number }>} */
    this.accounts = new Map();
    /** @type {Map<string, { balanceMicro: bigint, reservedMicro: bigint, totalEarnedMicro: bigint, totalSpentMicro: bigint, settledCount: number }>} */
    this._accountMicro = new Map();
    /** @type {Map<string, { escrowId: string, requesterId: string, shardId: string|null, amountMicro: bigint }>} */
    this._escrowsById = new Map();
    /** @type {Map<string, string>} */
    this._escrowIdByShardKey = new Map();

    /** @type {Set<string>} */
    this.settledAttestations = new Set();
    /** @type {Set<string>} */
    this._settledShardProofs = new Set();
    /** @type {Map<string, Set<string|number>>} */
    this.usedNonces = new Map();
    /** @type {Array<object>} */
    this.auditLog = [];

    this._hydratePersistedState(opts);
  }

  /**
   * Reconstructs ledger state from persisted options / snapshots cleanly.
   * @private
   */
  _hydratePersistedState(opts) {
    if (opts.settledAttestations !== undefined && opts.settledAttestations !== null) {
      if (typeof opts.settledAttestations === 'string' || typeof opts.settledAttestations[Symbol.iterator] !== 'function') {
        throw new TypeError('Invalid persisted settledAttestations: must be an iterable collection');
      }
      for (const key of opts.settledAttestations) {
        if (typeof key === 'string' && key.length > 0) {
          this.settledAttestations.add(key);
        }
      }
    }

    if (opts.settledShardProofs !== undefined && opts.settledShardProofs !== null) {
      if (typeof opts.settledShardProofs === 'string' || typeof opts.settledShardProofs[Symbol.iterator] !== 'function') {
        throw new TypeError('Invalid persisted settledShardProofs: must be an iterable collection');
      }
      for (const key of opts.settledShardProofs) {
        if (typeof key === 'string' && key.length > 0) {
          this._settledShardProofs.add(key);
        }
      }
    }

    if (opts.usedNonces !== undefined && opts.usedNonces !== null) {
      const isMap = opts.usedNonces instanceof Map;
      if (!isMap && (typeof opts.usedNonces !== 'object' || Array.isArray(opts.usedNonces))) {
        throw new TypeError('Invalid persisted usedNonces: must be a Map or plain object');
      }
      const entries = isMap
        ? opts.usedNonces.entries()
        : Object.entries(opts.usedNonces);
      for (const [workerId, nonces] of entries) {
        if (workerId === '__proto__') {
          throw new TypeError('Invalid persisted usedNonces key: __proto__ is not permitted');
        }
        if (typeof workerId !== 'string' || workerId.trim().length === 0) {
          throw new TypeError('Invalid persisted usedNonces workerId: must be a non-empty string');
        }
        if (!(Array.isArray(nonces) || nonces instanceof Set)) {
          throw new TypeError(`Invalid persisted usedNonces entry for ${workerId}: must be an Array or Set`);
        }
        const set = new Set();
        for (const n of nonces) {
          const validNonce = (
            (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ||
            (typeof n === 'string' && n.trim().length > 0)
          );
          if (!validNonce) {
            throw new RangeError(
              `Invalid persisted nonce for ${workerId}: must be a non-empty string or non-negative safe integer`
            );
          }
          set.add(n);
        }
        this.usedNonces.set(workerId, set);
      }
    }

    if (opts.accounts !== undefined && opts.accounts !== null) {
      const isMap = opts.accounts instanceof Map;
      if (!isMap && typeof opts.accounts !== 'object') {
        throw new TypeError('Invalid persisted accounts: must be a Map, Array, or plain object');
      }
      const accountIterable = isMap
        ? opts.accounts.values()
        : (Array.isArray(opts.accounts) ? opts.accounts : Object.values(opts.accounts));
      for (const acc of accountIterable) {
        if (!acc || typeof acc !== 'object') {
          throw new TypeError('Invalid persisted account entry: must be a non-null object');
        }
        this._assertValidNodeId(acc.nodeId, 'account.nodeId');
        if (this._accountMicro.has(acc.nodeId)) {
          throw new Error(`Duplicate persisted account for nodeId: ${acc.nodeId}`);
        }
        const balanceMicro = acc.balanceMicro !== undefined
          ? parsePersistedMicro(acc.balanceMicro, 'account.balanceMicro')
          : toMicroCredits(acc.balance !== undefined ? acc.balance : 0, 'account.balance');
        const reservedMicro = acc.reservedMicro !== undefined
          ? parsePersistedMicro(acc.reservedMicro, 'account.reservedMicro')
          : toMicroCredits(acc.reserved !== undefined ? acc.reserved : 0, 'account.reserved');
        const shardedReservedMicro = acc.shardedReservedMicro !== undefined
          ? parsePersistedMicro(acc.shardedReservedMicro, 'account.shardedReservedMicro')
          : 0n;
        const unshardedReservedMicro = acc.unshardedReservedMicro !== undefined
          ? parsePersistedMicro(acc.unshardedReservedMicro, 'account.unshardedReservedMicro')
          : (reservedMicro >= shardedReservedMicro ? reservedMicro - shardedReservedMicro : 0n);
        const totalEarnedMicro = acc.totalEarnedMicro !== undefined
          ? parsePersistedMicro(acc.totalEarnedMicro, 'account.totalEarnedMicro')
          : toMicroCredits(acc.totalEarned !== undefined ? acc.totalEarned : 0, 'account.totalEarned');
        const totalSpentMicro = acc.totalSpentMicro !== undefined
          ? parsePersistedMicro(acc.totalSpentMicro, 'account.totalSpentMicro')
          : toMicroCredits(acc.totalSpent !== undefined ? acc.totalSpent : 0, 'account.totalSpent');
        if (reservedMicro > balanceMicro) {
          throw new RangeError(`Invalid persisted account ${acc.nodeId}: reserved exceeds balance`);
        }
        let settledCount = 0;
        if (acc.settledCount !== undefined) {
          if (typeof acc.settledCount !== 'number') {
            throw new TypeError(`Invalid persisted settledCount for ${acc.nodeId}: must be a number`);
          }
          if (!Number.isSafeInteger(acc.settledCount) || acc.settledCount < 0) {
            throw new RangeError(
              `Invalid persisted settledCount for ${acc.nodeId}: must be a non-negative safe integer`
            );
          }
          settledCount = acc.settledCount;
        }
        this._accountMicro.set(acc.nodeId, {
          balanceMicro,
          shardedReservedMicro,
          unshardedReservedMicro,
          reservedMicro,
          totalEarnedMicro,
          totalSpentMicro,
          settledCount
        });
        this._syncAccountSnapshot(acc.nodeId);
      }
    }

    if (opts.escrows !== undefined) {
      if (!Array.isArray(opts.escrows)) {
        throw new TypeError('Invalid persisted escrows: must be an Array');
      }
      const escrowSumByRequester = new Map();
      const shardedSumByRequester = new Map();
      const unshardedSumByRequester = new Map();
      for (const esc of opts.escrows) {
        if (!esc || typeof esc !== 'object') {
          throw new TypeError('Invalid persisted escrow entry: must be a non-null object');
        }
        this._assertValidNodeId(esc.escrowId, 'escrow.escrowId');
        if (this._escrowsById.has(esc.escrowId)) {
          throw new Error(`Duplicate persisted escrowId: ${esc.escrowId}`);
        }
        this._assertValidNodeId(esc.requesterId, 'escrow.requesterId');
        if (!this._accountMicro.has(esc.requesterId)) {
          throw new UnknownAccountError(`Unknown account for persisted escrow: ${esc.requesterId}`);
        }
        let shardId = null;
        if (esc.shardId !== undefined && esc.shardId !== null) {
          this._assertValidNodeId(esc.shardId, 'escrow.shardId');
          shardId = esc.shardId;
        }
        const amountMicro = esc.amountMicro !== undefined
          ? parsePersistedMicro(esc.amountMicro, 'escrow.amountMicro')
          : toMicroCredits(esc.amount !== undefined ? esc.amount : 0, 'escrow.amount');

        if (shardId !== null) {
          const shardKey = encodeCompositeKey(esc.requesterId, shardId);
          if (this._escrowIdByShardKey.has(shardKey)) {
            throw new Error(`Duplicate persisted escrow for requester ${esc.requesterId} and shard ${shardId}`);
          }
          this._escrowIdByShardKey.set(shardKey, esc.escrowId);
          shardedSumByRequester.set(
            esc.requesterId,
            (shardedSumByRequester.get(esc.requesterId) || 0n) + amountMicro
          );
        } else {
          unshardedSumByRequester.set(
            esc.requesterId,
            (unshardedSumByRequester.get(esc.requesterId) || 0n) + amountMicro
          );
        }

        this._escrowsById.set(esc.escrowId, {
          escrowId: esc.escrowId,
          requesterId: esc.requesterId,
          shardId,
          amountMicro
        });
        escrowSumByRequester.set(
          esc.requesterId,
          (escrowSumByRequester.get(esc.requesterId) || 0n) + amountMicro
        );
      }

      for (const [nodeId, internal] of this._accountMicro.entries()) {
        const hydratedSharded = shardedSumByRequester.get(nodeId) || 0n;
        const hydratedUnsharded = unshardedSumByRequester.get(nodeId) || 0n;
        const hydratedEscrowTotal = escrowSumByRequester.get(nodeId) || 0n;
        if (internal.reservedMicro !== hydratedEscrowTotal) {
          throw new RangeError(
            `Persisted escrow parity mismatch for ${nodeId}: reservedMicro (${internal.reservedMicro}) !== escrows sum (${hydratedEscrowTotal})`
          );
        }
        internal.shardedReservedMicro = hydratedSharded;
        internal.unshardedReservedMicro = hydratedUnsharded;
      }
    }

    if (opts.auditLog !== undefined && opts.auditLog !== null) {
      if (!Array.isArray(opts.auditLog)) {
        throw new TypeError('Invalid persisted auditLog: must be an Array');
      }
      for (const entry of opts.auditLog) {
        if (entry && typeof entry === 'object') {
          this.auditLog.push(Object.freeze(clonePlainObjectSafe(entry)));
        } else {
          this.auditLog.push(entry);
        }
      }
    }
  }

  /**
   * Synchronizes the frozen public account entry in `this.accounts` from internal BigInt state.
   * @private
   */
  _syncAccountSnapshot(nodeId) {
    const internal = this._accountMicro.get(nodeId);
    if (!internal) return null;
    const snapshot = Object.freeze({
      nodeId,
      balance: fromMicroCredits(internal.balanceMicro),
      reserved: fromMicroCredits(internal.reservedMicro),
      totalEarned: fromMicroCredits(internal.totalEarnedMicro),
      totalSpent: fromMicroCredits(internal.totalSpentMicro),
      settledCount: internal.settledCount
    });
    this.accounts.set(nodeId, snapshot);
    return snapshot;
  }

  /**
   * Returns a safe cloned account snapshot with `availableBalance`.
   * @private
   */
  _cloneAccount(nodeId) {
    const internal = this._accountMicro.get(nodeId);
    if (!internal) return null;
    const balance = fromMicroCredits(internal.balanceMicro);
    const reserved = fromMicroCredits(internal.reservedMicro);
    const availableBalance = fromMicroCredits(internal.balanceMicro - internal.reservedMicro);
    return {
      nodeId,
      balance,
      reserved,
      availableBalance,
      totalEarned: fromMicroCredits(internal.totalEarnedMicro),
      totalSpent: fromMicroCredits(internal.totalSpentMicro),
      settledCount: internal.settledCount
    };
  }

  /**
   * Validates that `nodeId` is a non-empty string.
   * @private
   */
  _assertValidNodeId(nodeId, role = 'nodeId') {
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0) {
      throw new TypeError(`Invalid ${role}: must be a non-empty string`);
    }
  }

  /**
   * Creates a new account with an initial non-negative finite balance.
   * Fails closed if the account already exists.
   * @param {string} nodeId
   * @param {number} [initialBalance=0]
   * @returns {object} Cloned account snapshot
   */
  createAccount(nodeId, initialBalance = 0) {
    this._assertValidNodeId(nodeId, 'nodeId');
    if (this.accounts.has(nodeId)) {
      throw new Error(`Account already exists for nodeId: ${nodeId}`);
    }
    const balanceMicro = toMicroCredits(initialBalance, 'initialBalance');
    this._accountMicro.set(nodeId, {
      balanceMicro,
      shardedReservedMicro: 0n,
      unshardedReservedMicro: 0n,
      reservedMicro: 0n,
      totalEarnedMicro: 0n,
      totalSpentMicro: 0n,
      settledCount: 0
    });
    this._syncAccountSnapshot(nodeId);
    const snapshot = this._cloneAccount(nodeId);
    this.emit('accountCreated', snapshot);
    return snapshot;
  }

  /**
   * Credits an account (auto-creating with 0 balance if absent).
   * Rejects negative, NaN, or infinite amounts with RangeError.
   * @param {string} nodeId
   * @param {number} amount
   * @returns {object} Cloned account snapshot
   */
  creditAccount(nodeId, amount) {
    this._assertValidNodeId(nodeId, 'nodeId');
    const amountMicro = toMicroCredits(amount, 'amount');

    let internal = this._accountMicro.get(nodeId);
    const existed = Boolean(internal);
    const currentBalance = internal ? internal.balanceMicro : 0n;
    if (currentBalance + amountMicro > MAX_SAFE_CREDITS_MICRO) {
      throw new CreditOverflowError(`Credit overflow: account ${nodeId} would exceed Number.MAX_SAFE_INTEGER`);
    }

    if (!existed) {
      internal = {
        balanceMicro: amountMicro,
        shardedReservedMicro: 0n,
        unshardedReservedMicro: 0n,
        reservedMicro: 0n,
        totalEarnedMicro: 0n,
        totalSpentMicro: 0n,
        settledCount: 0
      };
      this._accountMicro.set(nodeId, internal);
    } else {
      internal.balanceMicro += amountMicro;
    }

    this._syncAccountSnapshot(nodeId);
    const snapshot = this._cloneAccount(nodeId);
    this.emit('credited', { nodeId, amount: fromMicroCredits(amountMicro), balance: snapshot.balance });
    return snapshot;
  }

  /**
   * Alias for `creditAccount` supporting orchestrator funding interfaces.
   * @param {string} nodeId
   * @param {number} amount
   * @returns {object} Cloned account snapshot
   */
  credit(nodeId, amount) {
    return this.creditAccount(nodeId, amount);
  }

  /**
   * Alias for `debitAccount`.
   * @param {string} nodeId
   * @param {number} amount
   * @returns {object} Cloned account snapshot
   */
  debit(nodeId, amount) {
    return this.debitAccount(nodeId, amount);
  }

  /**
   * Debits an existing account fail-closed.
   * Throws UnknownAccountError if unknown, InsufficientCreditBalanceError if available balance < amount.
   * @param {string} nodeId
   * @param {number} amount
   * @returns {object} Cloned account snapshot
   */
  debitAccount(nodeId, amount) {
    this._assertValidNodeId(nodeId, 'nodeId');
    const amountMicro = toMicroCredits(amount, 'amount');
    const internal = this._accountMicro.get(nodeId);
    if (!internal) {
      throw new UnknownAccountError(`Unknown account: ${nodeId}`);
    }
    const availableMicro = internal.balanceMicro - internal.reservedMicro;
    if (availableMicro < amountMicro || internal.balanceMicro < amountMicro) {
      throw new InsufficientCreditBalanceError(
        `Insufficient credit balance for ${nodeId}: available ${fromMicroCredits(availableMicro)}, required ${fromMicroCredits(amountMicro)}`
      );
    }
    internal.balanceMicro -= amountMicro;
    internal.totalSpentMicro += amountMicro;
    this._syncAccountSnapshot(nodeId);
    const snapshot = this._cloneAccount(nodeId);
    this.emit('debited', { nodeId, amount: fromMicroCredits(amountMicro), balance: snapshot.balance });
    return snapshot;
  }

  /**
   * Returns current numeric balance for `nodeId` (0 if unknown).
   * @param {string} nodeId
   * @returns {number}
   */
  getBalance(nodeId) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      return 0;
    }
    const internal = this._accountMicro.get(nodeId);
    return internal ? fromMicroCredits(internal.balanceMicro) : 0;
  }

  /**
   * Returns a safe cloned snapshot of account stats, or null if unknown.
   * @param {string} nodeId
   * @returns {object|null}
   */
  getAccount(nodeId) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      return null;
    }
    return this._cloneAccount(nodeId);
  }

  /**
   * Checks whether requester has enough unreserved balance for `cost` without throwing.
   * Fails closed (`false`) for unknown accounts or invalid costs.
   * @param {string} requesterId
   * @param {number} cost
   * @returns {boolean}
   */
  canAfford(requesterId, cost) {
    if (typeof requesterId !== 'string' || requesterId.trim().length === 0) {
      return false;
    }
    const internal = this._accountMicro.get(requesterId);
    if (!internal) {
      return false;
    }
    let costMicro;
    try {
      costMicro = toMicroCredits(cost, 'cost');
    } catch {
      return false;
    }
    const availableMicro = internal.balanceMicro - internal.reservedMicro;
    return availableMicro >= costMicro && internal.balanceMicro >= costMicro;
  }

  /**
   * Enforces fail-closed pre-dispatch balance check.
   * Throws UnknownAccountError if account is missing, or InsufficientCreditBalanceError if balance < cost.
   * @param {string} requesterId
   * @param {number} cost
   * @returns {boolean}
   */
  checkCreditAvailable(requesterId, cost) {
    this._assertValidNodeId(requesterId, 'requesterId');
    const costMicro = toMicroCredits(cost, 'cost');
    const internal = this._accountMicro.get(requesterId);
    if (!internal) {
      throw new UnknownAccountError(`Unknown requester account: ${requesterId}`);
    }
    const availableMicro = internal.balanceMicro - internal.reservedMicro;
    if (availableMicro < costMicro || internal.balanceMicro < costMicro) {
      throw new InsufficientCreditBalanceError(
        `Insufficient credit balance for ${requesterId}: available ${fromMicroCredits(availableMicro)}, required ${fromMicroCredits(costMicro)}`
      );
    }
    return true;
  }

  /**
   * Reserves up to `maxCost` in escrow for a requester (optionally scoped to `shardId`),
   * enforcing fail-closed available balance checks.
   * @param {string} requesterId
   * @param {number} maxCost
   * @param {string} [shardId]
   * @returns {{ escrowId: string, requesterId: string, shardId: string|null, amount: number, reserved: number, availableBalance: number }}
   */
  reserveEscrow(requesterId, maxCost, shardId = null) {
    this._assertValidNodeId(requesterId, 'requesterId');
    const costMicro = toMicroCredits(maxCost, 'maxCost');
    if (shardId !== null && shardId !== undefined) {
      this._assertValidNodeId(shardId, 'shardId');
    }

    const internal = this._accountMicro.get(requesterId);
    if (!internal) {
      throw new UnknownAccountError(`Unknown requester account: ${requesterId}`);
    }

    const normalizedShardId = shardId !== null && shardId !== undefined ? shardId : null;
    if (normalizedShardId !== null) {
      const shardKey = encodeCompositeKey(requesterId, normalizedShardId);
      if (this._escrowIdByShardKey.has(shardKey)) {
        throw new Error(`Escrow already active for requester ${requesterId} and shard ${normalizedShardId}`);
      }
    }

    const availableMicro = internal.balanceMicro - internal.reservedMicro;
    if (availableMicro < costMicro) {
      throw new InsufficientCreditBalanceError(
        `Insufficient credit balance to reserve escrow for ${requesterId}: available ${fromMicroCredits(availableMicro)}, requested ${fromMicroCredits(costMicro)}`
      );
    }

    if (normalizedShardId !== null) {
      internal.shardedReservedMicro += costMicro;
    } else {
      internal.unshardedReservedMicro += costMicro;
    }
    internal.reservedMicro = internal.shardedReservedMicro + internal.unshardedReservedMicro;
    this._syncAccountSnapshot(requesterId);

    const escrowId = crypto.randomUUID();
    this._escrowsById.set(escrowId, {
      escrowId,
      requesterId,
      shardId: normalizedShardId,
      amountMicro: costMicro
    });
    if (normalizedShardId !== null) {
      this._escrowIdByShardKey.set(encodeCompositeKey(requesterId, normalizedShardId), escrowId);
    }

    const result = {
      escrowId,
      requesterId,
      shardId: normalizedShardId,
      amount: fromMicroCredits(costMicro),
      reserved: fromMicroCredits(internal.reservedMicro),
      availableBalance: fromMicroCredits(internal.balanceMicro - internal.reservedMicro)
    };
    this.emit('escrowReserved', result);
    return result;
  }

  /**
   * Releases an escrow reservation by `(requesterId, amount, shardId?)` or by `escrowId`.
   * @param {string} requesterIdOrEscrowId
   * @param {number} [amount]
   * @param {string} [shardId]
   * @returns {{ released: number, requesterId: string, reserved: number, availableBalance: number }}
   */
  releaseEscrow(requesterIdOrEscrowId, amount, shardId) {
    this._assertValidNodeId(requesterIdOrEscrowId, 'requesterIdOrEscrowId');
    const hasShardId = shardId !== undefined && shardId !== null;
    if (hasShardId) {
      this._assertValidNodeId(shardId, 'shardId');
    }

    const releaseTargetedEntry = (entry) => {
      const internal = this._accountMicro.get(entry.requesterId);
      if (!internal) {
        throw new UnknownAccountError(`Unknown account for escrow: ${entry.requesterId}`);
      }
      const releaseMicro = amount !== undefined ? toMicroCredits(amount, 'amount') : entry.amountMicro;
      if (releaseMicro > entry.amountMicro) {
        throw new RangeError(
          `Cannot release ${fromMicroCredits(releaseMicro)} from escrow ${entry.escrowId}: escrow only holds ${fromMicroCredits(entry.amountMicro)}`
        );
      }
      if (internal.reservedMicro < releaseMicro) {
        throw new RangeError('Escrow release underflow: reserved balance smaller than release amount');
      }
      if (entry.shardId !== null) {
        internal.shardedReservedMicro = internal.shardedReservedMicro >= releaseMicro
          ? internal.shardedReservedMicro - releaseMicro
          : 0n;
      } else {
        internal.unshardedReservedMicro = internal.unshardedReservedMicro >= releaseMicro
          ? internal.unshardedReservedMicro - releaseMicro
          : 0n;
      }
      internal.reservedMicro = internal.shardedReservedMicro + internal.unshardedReservedMicro;
      entry.amountMicro -= releaseMicro;
      if (entry.amountMicro === 0n) {
        this._escrowsById.delete(entry.escrowId);
        if (entry.shardId !== null) {
          this._escrowIdByShardKey.delete(encodeCompositeKey(entry.requesterId, entry.shardId));
        }
      }
      this._syncAccountSnapshot(entry.requesterId);
      const res = {
        released: fromMicroCredits(releaseMicro),
        requesterId: entry.requesterId,
        reserved: fromMicroCredits(internal.reservedMicro),
        availableBalance: fromMicroCredits(internal.balanceMicro - internal.reservedMicro)
      };
      this.emit('escrowReleased', res);
      return res;
    };

    // Form 1: releaseEscrow(escrowId) or releaseEscrow(escrowId, partialAmount)
    if (
      !hasShardId &&
      this._escrowsById.has(requesterIdOrEscrowId) &&
      (amount === undefined || !this._accountMicro.has(requesterIdOrEscrowId))
    ) {
      return releaseTargetedEntry(this._escrowsById.get(requesterIdOrEscrowId));
    }

    if (amount === undefined && !hasShardId) {
      throw new RangeError(`Unknown or already released escrowId: ${requesterIdOrEscrowId}`);
    }

    // Form 2: releaseEscrow(requesterId, amount?, shardId?)
    const requesterId = requesterIdOrEscrowId;
    const internal = this._accountMicro.get(requesterId);
    if (!internal) {
      throw new UnknownAccountError(`Unknown requester account: ${requesterId}`);
    }

    if (hasShardId) {
      const escrowId = this._escrowIdByShardKey.get(encodeCompositeKey(requesterId, shardId));
      if (!escrowId) {
        throw new RangeError(`No active escrow for requester ${requesterId} and shard ${shardId}`);
      }
      const entry = this._escrowsById.get(escrowId);
      if (!entry) {
        throw new RangeError(`No active escrow for requester ${requesterId} and shard ${shardId}`);
      }
      return releaseTargetedEntry(entry);
    }

    // Form 3: Unsharded release releaseEscrow(requesterId, amount) -> ONLY releases shardId === null escrows
    const releaseMicro = toMicroCredits(amount, 'amount');
    let unshardedTotalMicro = 0n;
    const unshardedEntries = [];
    for (const entry of this._escrowsById.values()) {
      if (entry.requesterId === requesterId && entry.shardId === null) {
        unshardedTotalMicro += entry.amountMicro;
        unshardedEntries.push(entry);
      }
    }
    if (releaseMicro > unshardedTotalMicro) {
      throw new RangeError(
        `Cannot release ${fromMicroCredits(releaseMicro)} from unsharded escrow: only ${fromMicroCredits(unshardedTotalMicro)} unsharded credits reserved`
      );
    }
    if (releaseMicro > internal.reservedMicro) {
      throw new RangeError(
        `Cannot release ${fromMicroCredits(releaseMicro)} from escrow: only ${fromMicroCredits(internal.reservedMicro)} reserved`
      );
    }

    internal.unshardedReservedMicro = internal.unshardedReservedMicro >= releaseMicro
      ? internal.unshardedReservedMicro - releaseMicro
      : 0n;
    internal.reservedMicro = internal.shardedReservedMicro + internal.unshardedReservedMicro;
    let remainingToConsume = releaseMicro;
    for (const entry of unshardedEntries) {
      if (remainingToConsume <= 0n) break;
      if (entry.amountMicro <= remainingToConsume) {
        remainingToConsume -= entry.amountMicro;
        this._escrowsById.delete(entry.escrowId);
      } else {
        entry.amountMicro -= remainingToConsume;
        remainingToConsume = 0n;
      }
    }
    this._syncAccountSnapshot(requesterId);

    const res = {
      released: fromMicroCredits(releaseMicro),
      requesterId,
      reserved: fromMicroCredits(internal.reservedMicro),
      availableBalance: fromMicroCredits(internal.balanceMicro - internal.reservedMicro)
    };
    this.emit('escrowReleased', res);
    return res;
  }

  /**
   * Deterministic Proof-of-Compute work metering:
   *   Credit = max(minCost, round6((min(T, maxExecutionMs) * baseRatePerMs + min(S, maxInputSize) * byteWeight) * complexityFactor))
   * Returns 0 when work is 0 (0ms & 0 items, or complexityFactor === 0).
   * @param {number} executionTimeMs
   * @param {number} inputSize
   * @param {number} [complexityFactor=1]
   * @returns {number}
   */
  calculateCredit(executionTimeMs, inputSize, complexityFactor = 1) {
    if (typeof executionTimeMs !== 'number') {
      throw new TypeError('Invalid executionTimeMs: must be a number');
    }
    if (Number.isNaN(executionTimeMs) || !Number.isFinite(executionTimeMs) || executionTimeMs < 0) {
      throw new RangeError('Invalid executionTimeMs: must be a non-negative finite number');
    }

    if (typeof inputSize !== 'number') {
      throw new TypeError('Invalid inputSize: must be a number');
    }
    if (Number.isNaN(inputSize) || !Number.isFinite(inputSize) || inputSize < 0) {
      throw new RangeError('Invalid inputSize: must be a non-negative finite number');
    }

    if (typeof complexityFactor !== 'number') {
      throw new TypeError('Invalid complexityFactor: must be a number');
    }
    if (Number.isNaN(complexityFactor) || !Number.isFinite(complexityFactor) || complexityFactor < 0) {
      throw new RangeError('Invalid complexityFactor: must be a non-negative finite number');
    }

    const cappedTime = Math.min(executionTimeMs, this.maxExecutionMs);
    const cappedInput = Math.min(inputSize, this.maxInputSize);
    const cappedComplexity = Math.min(complexityFactor, this.maxComplexityFactor);

    if ((cappedTime === 0 && cappedInput === 0) || cappedComplexity === 0) {
      return 0;
    }

    const raw = (cappedTime * this.baseRatePerMs + cappedInput * this.byteWeight) * cappedComplexity;
    if (!Number.isFinite(raw)) {
      throw new CreditOverflowError('Calculated credit overflows finite bounds');
    }
    if (raw <= 0) {
      return 0;
    }

    let rawMicro = toMicroCredits(raw, 'calculatedCredit');
    if (rawMicro === 0n) {
      rawMicro = 1n;
    }
    const finalMicro = rawMicro < this._minCostMicro ? this._minCostMicro : rawMicro;
    return fromMicroCredits(finalMicro);
  }

  /**
   * Computes the canonical SHA-256 attestation key for `(shardId, workerId, proofOfCompute)`.
   * Intentionally excludes `requesterId` and `attestationNonce` so replay across requesters or
   * with altered nonces cannot bypass double-spend detection.
   * @param {string} shardId
   * @param {string} workerId
   * @param {string|Buffer} proofOfCompute
   * @returns {string} 64-character hex SHA-256 key
   */
  computeAttestationKey(shardId, workerId, proofOfCompute) {
    this._assertValidNodeId(shardId, 'shardId');
    this._assertValidNodeId(workerId, 'workerId');
    const normalizedProof = normalizeProofHex(proofOfCompute);
    if (!normalizedProof) {
      throw new TypeError('Invalid proofOfCompute: must be a 64-character hex string or 32-byte Buffer');
    }
    return sha256Hex(encodeCompositeKey(shardId, workerId, normalizedProof));
  }

  /**
   * Checks whether an attestation key is valid and settled.
   * @param {string} attestationKey
   * @returns {boolean}
   */
  hasSettledAttestation(attestationKey) {
    if (typeof attestationKey !== 'string' || attestationKey.length === 0) {
      return false;
    }
    return this.settledAttestations.has(attestationKey);
  }

  /**
   * Verifies Proof-of-Compute HMAC-SHA256 attestation, checks anti-replay attestation & nonce sets,
   * validates requester credit balance, and atomically settles debit/credit + hash-chained audit entry.
   * Zero state is modified if any validation fails.
   * @param {object} params
   * @returns {object}
   */
  verifyAndSettle(params) {
    if (!params || typeof params !== 'object') {
      throw new TypeError('Invalid settlement params: must be a non-null object');
    }

    const {
      requesterId,
      workerId,
      shardId,
      resultData,
      proofOfCompute,
      executionMetrics,
      workerPublicKey,
      hmacSecret,
      attestationNonce,
      expectedInputSize,
      inputData,
      shard,
      escrowId
    } = params;

    const allowSelf = params.allowSelfSettle !== undefined ? Boolean(params.allowSelfSettle) : this.allowSelfSettle;
    const shouldThrowOnError = params.throwOnError !== undefined ? Boolean(params.throwOnError) : this.throwOnError;
    const shouldThrowOnReplay = params.throwOnError !== undefined
      ? Boolean(params.throwOnError)
      : (params.throwOnReplay !== undefined ? Boolean(params.throwOnReplay) : this.throwOnReplay);
    const shouldThrowOnBadSig = params.throwOnInvalidSignature !== undefined
      ? Boolean(params.throwOnInvalidSignature)
      : (params.throwOnError === true ? true : this.throwOnInvalidSignature);

    this._assertValidNodeId(requesterId, 'requesterId');
    this._assertValidNodeId(workerId, 'workerId');

    if (!allowSelf && requesterId === workerId) {
      const err = new Error(`Self-settlement rejected: requesterId and workerId cannot match (${requesterId})`);
      if (shouldThrowOnError) throw err;
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: err.message
      };
    }

    if (params.aborted === true || params.status === 'FAILED' || params.status === 'ABORTED') {
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: 'Execution failed or aborted: zero credit settlement permitted'
      };
    }

    if (!executionMetrics || typeof executionMetrics !== 'object') {
      throw new TypeError('Invalid executionMetrics: must be a non-null object');
    }

    const { executionTimeMs, inputSize, complexityFactor = 1 } = executionMetrics;
    if (complexityFactor !== undefined && (typeof complexityFactor !== 'number' || !Number.isFinite(complexityFactor) || complexityFactor <= 0)) {
      throw new RangeError('Invalid complexityFactor: must be a positive finite number');
    }
    const cost = this.calculateCredit(executionTimeMs, inputSize, complexityFactor);
    const costMicro = toMicroCredits(cost, 'cost');

    // Validate claimed inputSize against actual partition size when available (T2.F29.04)
    if (expectedInputSize !== undefined) {
      if (typeof expectedInputSize !== 'number' || !Number.isSafeInteger(expectedInputSize) || expectedInputSize < 0) {
        throw new RangeError('Invalid expectedInputSize: must be a non-negative safe integer');
      }
      if (inputSize !== expectedInputSize) {
        throw new RangeError(
          `Input size mismatch: claimed ${inputSize} does not match expected partition size ${expectedInputSize}`
        );
      }
    } else {
      const actualData = Array.isArray(inputData)
        ? inputData
        : (shard && Array.isArray(shard.inputData) ? shard.inputData : null);
      if (actualData !== null) {
        const actualItemCount = actualData.length;
        let actualSerialized;
        try {
          actualSerialized = safeJsonStringify(actualData);
        } catch {
          throw new TypeError('Invalid inputData: must be JSON-serializable');
        }
        const actualByteCount = Buffer.byteLength(actualSerialized || '[]', 'utf8');
        if (inputSize > Math.max(actualItemCount, actualByteCount)) {
          throw new RangeError(
            `Inflated inputSize rejected: claimed ${inputSize} exceeds actual partition count (${actualItemCount}) and byte size (${actualByteCount})`
          );
        }
      }
    }

    // 1. Validate shardId, resultData, proof format, and HMAC-SHA256 PoC signature BEFORE touching replay/account state
    if (typeof shardId !== 'string' || shardId.trim().length === 0) {
      const msg = 'Invalid shardId: must be a non-empty string';
      if (shouldThrowOnBadSig) throw new TypeError(msg);
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: msg
      };
    }

    if (resultData === undefined) {
      const msg = 'Invalid resultData: must be defined';
      if (shouldThrowOnBadSig) throw new TypeError(msg);
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: msg
      };
    }

    const normalizedProof = normalizeProofHex(proofOfCompute);
    if (!normalizedProof) {
      const msg = 'Proof-of-Compute verification failed: malformed or missing signature';
      if (shouldThrowOnBadSig) throw new Error(msg);
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: msg
      };
    }

    // Enforce strict secret selection: if hmacSecret is explicitly supplied, do NOT fall back to public key
    const hasExplicitSecret = hmacSecret !== undefined && hmacSecret !== null;
    const verificationSecret = hasExplicitSecret ? hmacSecret : workerPublicKey;
    const sigValid = verifyHmacProof(shardId, resultData, normalizedProof, verificationSecret);
    if (!sigValid) {
      const msg = 'Proof-of-Compute verification failed: invalid HMAC-SHA256 signature';
      if (shouldThrowOnBadSig) throw new Error(msg);
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        error: msg
      };
    }

    // 2. Anti-Replay / Double-Spend Verification (read-only until all checks succeed)
    const attestationHash = this.computeAttestationKey(shardId, workerId, normalizedProof);
    const shardProofHash = sha256Hex(encodeCompositeKey(shardId, normalizedProof));

    if (this.settledAttestations.has(attestationHash) || this._settledShardProofs.has(shardProofHash)) {
      const err = new DoubleSpendAttemptError(
        `Attestation already settled (double-spend attempt rejected): ${attestationHash}`
      );
      if (shouldThrowOnReplay) throw err;
      return {
        settled: false,
        cost: 0,
        requesterBalance: this.getBalance(requesterId),
        workerBalance: this.getBalance(workerId),
        attestationHash,
        error: err.message
      };
    }

    if (attestationNonce !== undefined) {
      const validNonce = (
        (typeof attestationNonce === 'number' && Number.isSafeInteger(attestationNonce) && attestationNonce >= 0) ||
        (typeof attestationNonce === 'string' && attestationNonce.trim().length > 0)
      );
      if (!validNonce) {
        throw new TypeError('Invalid attestationNonce: must be a non-empty string or non-negative safe integer');
      }
      const workerNonces = this.usedNonces.get(workerId);
      if (workerNonces && workerNonces.has(attestationNonce)) {
        const err = new DoubleSpendAttemptError(
          `Attestation nonce already settled (replay rejected) for worker ${workerId}: ${attestationNonce}`
        );
        if (shouldThrowOnReplay) throw err;
        return {
          settled: false,
          cost: 0,
          requesterBalance: this.getBalance(requesterId),
          workerBalance: this.getBalance(workerId),
          attestationHash,
          error: err.message
        };
      }
    }

    // 3. Fail-Closed Balance, Escrow & Overflow Checks (read-only before commit)
    const requester = this._accountMicro.get(requesterId);
    if (!requester) {
      const err = new UnknownAccountError(`Unknown requester account: ${requesterId}`);
      if (shouldThrowOnError) throw err;
      return {
        settled: false,
        cost: 0,
        requesterBalance: 0,
        workerBalance: this.getBalance(workerId),
        error: err.message
      };
    }

    const shardEscrowKey = encodeCompositeKey(requesterId, shardId);
    let matchingEscrow = null;
    if (escrowId !== undefined && escrowId !== null) {
      if (typeof escrowId !== 'string' || escrowId.trim().length === 0) {
        throw new TypeError('Invalid escrowId: must be a non-empty string');
      }
      const esc = this._escrowsById.get(escrowId);
      if (!esc) {
        throw new Error(`Invalid or already consumed escrowId: ${escrowId}`);
      }
      if (esc.requesterId !== requesterId) {
        throw new Error(`Escrow ownership mismatch: ${escrowId} does not belong to ${requesterId}`);
      }
      if (esc.shardId !== null && esc.shardId !== shardId) {
        throw new Error(`Escrow shard mismatch: ${escrowId} is bound to ${esc.shardId}, not ${shardId}`);
      }
      matchingEscrow = esc;
    } else {
      const matchingEscrowId = this._escrowIdByShardKey.get(shardEscrowKey);
      matchingEscrow = matchingEscrowId ? this._escrowsById.get(matchingEscrowId) : null;
    }

    const escrowReliefMicro = matchingEscrow ? matchingEscrow.amountMicro : 0n;
    const effectiveReservedMicro = requester.reservedMicro >= escrowReliefMicro
      ? requester.reservedMicro - escrowReliefMicro
      : 0n;
    const effectiveAvailableMicro = requester.balanceMicro - effectiveReservedMicro;

    if (requester.balanceMicro < costMicro || effectiveAvailableMicro < costMicro) {
      const err = new InsufficientCreditBalanceError(
        `Insufficient credit balance for requester ${requesterId}: available ${fromMicroCredits(effectiveAvailableMicro)}, cost ${cost}`
      );
      if (shouldThrowOnError) throw err;
      return {
        settled: false,
        cost: 0,
        requesterBalance: fromMicroCredits(requester.balanceMicro),
        workerBalance: this.getBalance(workerId),
        error: err.message
      };
    }

    let worker = this._accountMicro.get(workerId);
    if (requesterId !== workerId) {
      const currentWorkerBalanceMicro = worker ? worker.balanceMicro : 0n;
      if (currentWorkerBalanceMicro + costMicro > MAX_SAFE_CREDITS_MICRO) {
        const err = new CreditOverflowError(
          `Credit overflow: worker ${workerId} balance would exceed Number.MAX_SAFE_INTEGER`
        );
        if (shouldThrowOnError) throw err;
        return {
          settled: false,
          cost: 0,
          requesterBalance: fromMicroCredits(requester.balanceMicro),
          workerBalance: fromMicroCredits(currentWorkerBalanceMicro),
          error: err.message
        };
      }
    }

    // 4. Atomic Commit (All cryptographic, replay, and balance checks have passed)
    if (matchingEscrow) {
      if (matchingEscrow.shardId !== null) {
        requester.shardedReservedMicro = requester.shardedReservedMicro >= matchingEscrow.amountMicro
          ? requester.shardedReservedMicro - matchingEscrow.amountMicro
          : 0n;
        requester.reservedMicro = requester.shardedReservedMicro + requester.unshardedReservedMicro;
        this._escrowsById.delete(matchingEscrow.escrowId);
        this._escrowIdByShardKey.delete(encodeCompositeKey(requesterId, matchingEscrow.shardId));
      } else {
        const consumeMicro = costMicro <= matchingEscrow.amountMicro ? costMicro : matchingEscrow.amountMicro;
        matchingEscrow.amountMicro -= consumeMicro;
        requester.unshardedReservedMicro = requester.unshardedReservedMicro >= consumeMicro
          ? requester.unshardedReservedMicro - consumeMicro
          : 0n;
        requester.reservedMicro = requester.shardedReservedMicro + requester.unshardedReservedMicro;
      }
    }

    if (requesterId === workerId) {
      requester.totalSpentMicro += costMicro;
      requester.totalEarnedMicro += costMicro;
      requester.settledCount += 1;
      this._syncAccountSnapshot(requesterId);
    } else {
      if (!worker) {
        worker = {
          balanceMicro: 0n,
          shardedReservedMicro: 0n,
          unshardedReservedMicro: 0n,
          reservedMicro: 0n,
          totalEarnedMicro: 0n,
          totalSpentMicro: 0n,
          settledCount: 0
        };
        this._accountMicro.set(workerId, worker);
      }

      requester.balanceMicro -= costMicro;
      requester.totalSpentMicro += costMicro;
      requester.settledCount += 1;

      worker.balanceMicro += costMicro;
      worker.totalEarnedMicro += costMicro;
      worker.settledCount += 1;

      this._syncAccountSnapshot(requesterId);
      this._syncAccountSnapshot(workerId);
    }

    this.settledAttestations.add(attestationHash);
    this._settledShardProofs.add(shardProofHash);

    if (attestationNonce !== undefined) {
      let workerNonces = this.usedNonces.get(workerId);
      if (!workerNonces) {
        workerNonces = new Set();
        this.usedNonces.set(workerId, workerNonces);
      }
      workerNonces.add(attestationNonce);
    }

    const requesterBalance = fromMicroCredits(requester.balanceMicro);
    const workerBalance = fromMicroCredits(worker.balanceMicro);

    const prevHash = this.auditLog.length > 0
      ? this.auditLog[this.auditLog.length - 1].hash
      : GENESIS_HASH;
    const index = this.auditLog.length;
    const timestamp = this._now();

    const auditPayload = {
      index,
      timestamp,
      type: 'SETTLEMENT',
      requesterId,
      workerId,
      shardId,
      cost,
      requesterBalance,
      workerBalance,
      attestationHash,
      attestationNonce: attestationNonce !== undefined ? attestationNonce : null,
      prevHash
    };
    const hash = computeAuditEntryHash(auditPayload);
    const auditEntry = Object.freeze({ ...auditPayload, hash });
    this.auditLog.push(auditEntry);

    const settlement = {
      settled: true,
      cost,
      requesterId,
      workerId,
      shardId,
      requesterBalance,
      workerBalance,
      attestationHash,
      auditHash: hash
    };

    this.emit('settled', settlement);
    return settlement;
  }

  /**
   * Verifies the integrity of the hash-chained audit log from genesis entry.
   * @returns {{ valid: boolean, length: number, error?: string }}
   */
  verifyAuditLog() {
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < this.auditLog.length; i++) {
      const entry = this.auditLog[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { valid: false, length: this.auditLog.length, error: `Corrupted audit entry at index ${i}` };
      }

      const keys = Object.keys(entry);
      if (keys.length !== AUDIT_ENTRY_KEY_SET.size) {
        return { valid: false, length: this.auditLog.length, error: `Invalid audit entry schema at index ${i}` };
      }
      for (const key of keys) {
        if (!AUDIT_ENTRY_KEY_SET.has(key)) {
          return { valid: false, length: this.auditLog.length, error: `Invalid audit entry schema at index ${i}` };
        }
      }

      if (entry.index !== i) {
        return { valid: false, length: this.auditLog.length, error: `Audit index mismatch at ${i}` };
      }

      if (entry.prevHash !== expectedPrev) {
        return { valid: false, length: this.auditLog.length, error: `Audit prevHash chain broken at index ${i}` };
      }

      const validNonce = (
        entry.attestationNonce === null ||
        (typeof entry.attestationNonce === 'number' && Number.isSafeInteger(entry.attestationNonce) && entry.attestationNonce >= 0) ||
        (typeof entry.attestationNonce === 'string' && entry.attestationNonce.trim().length > 0)
      );
      const validFields = (
        entry.type === 'SETTLEMENT' &&
        typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) && entry.timestamp >= 0 &&
        typeof entry.requesterId === 'string' && entry.requesterId.trim().length > 0 &&
        typeof entry.workerId === 'string' && entry.workerId.trim().length > 0 &&
        typeof entry.shardId === 'string' && entry.shardId.trim().length > 0 &&
        typeof entry.cost === 'number' && Number.isFinite(entry.cost) && entry.cost >= 0 &&
        typeof entry.requesterBalance === 'number' && Number.isFinite(entry.requesterBalance) && entry.requesterBalance >= 0 &&
        typeof entry.workerBalance === 'number' && Number.isFinite(entry.workerBalance) && entry.workerBalance >= 0 &&
        typeof entry.attestationHash === 'string' && /^[0-9a-f]{64}$/i.test(entry.attestationHash) &&
        validNonce &&
        typeof entry.hash === 'string' && /^[0-9a-f]{64}$/i.test(entry.hash)
      );
      if (!validFields) {
        return { valid: false, length: this.auditLog.length, error: `Invalid audit entry schema at index ${i}` };
      }

      const expectedHash = computeAuditEntryHash(entry);
      if (entry.hash !== expectedHash) {
        return { valid: false, length: this.auditLog.length, error: `Audit digest mismatch at index ${i}` };
      }
      expectedPrev = entry.hash;
    }
    return { valid: true, length: this.auditLog.length };
  }

  /**
   * Computes exact total credits across all accounts using BigInt micro-credits.
   * @returns {number}
   */
  getTotalBalance() {
    let sumMicro = 0n;
    for (const internal of this._accountMicro.values()) {
      sumMicro += internal.balanceMicro;
    }
    return fromMicroCredits(sumMicro);
  }

  /**
   * Computes exact total reserved escrow credits across all accounts.
   * @returns {number}
   */
  getTotalReserved() {
    let sumMicro = 0n;
    for (const internal of this._accountMicro.values()) {
      sumMicro += internal.reservedMicro;
    }
    return fromMicroCredits(sumMicro);
  }

  /**
   * Exports JSON-serializable state snapshot for persistence / ledger restart recovery.
   * @returns {object}
   */
  exportState() {
    const accounts = [];
    for (const [nodeId, internal] of this._accountMicro.entries()) {
      accounts.push({
        nodeId,
        balance: fromMicroCredits(internal.balanceMicro),
        reserved: fromMicroCredits(internal.reservedMicro),
        totalEarned: fromMicroCredits(internal.totalEarnedMicro),
        totalSpent: fromMicroCredits(internal.totalSpentMicro),
        balanceMicro: internal.balanceMicro.toString(),
        reservedMicro: internal.reservedMicro.toString(),
        shardedReservedMicro: (internal.shardedReservedMicro || 0n).toString(),
        unshardedReservedMicro: (internal.unshardedReservedMicro || 0n).toString(),
        totalEarnedMicro: internal.totalEarnedMicro.toString(),
        totalSpentMicro: internal.totalSpentMicro.toString(),
        settledCount: internal.settledCount
      });
    }

    const escrows = [];
    for (const entry of this._escrowsById.values()) {
      escrows.push({
        escrowId: entry.escrowId,
        requesterId: entry.requesterId,
        shardId: entry.shardId,
        amount: fromMicroCredits(entry.amountMicro),
        amountMicro: entry.amountMicro.toString()
      });
    }

    const usedNonces = {};
    for (const [workerId, set] of this.usedNonces.entries()) {
      if (workerId === '__proto__') continue;
      Object.defineProperty(usedNonces, workerId, {
        value: Array.from(set),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }

    return {
      baseRatePerMs: this.baseRatePerMs,
      byteWeight: this.byteWeight,
      minCost: this.minCost,
      maxExecutionMs: this.maxExecutionMs,
      maxInputSize: this.maxInputSize,
      accounts,
      escrows,
      settledAttestations: Array.from(this.settledAttestations),
      settledShardProofs: Array.from(this._settledShardProofs),
      usedNonces,
      auditLog: this.auditLog.map((e) => clonePlainObjectSafe(e))
    };
  }

  /**
   * Reconstructs a ledger instance from an exported state snapshot.
   * @param {object} snapshot
   * @param {object} [options]
   * @returns {ProofOfComputeLedger}
   */
  static fromState(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('Invalid ledger snapshot: must be a non-null object');
    }
    const opts = options && typeof options === 'object' ? options : {};
    return new ProofOfComputeLedger({
      baseRatePerMs: snapshot.baseRatePerMs,
      byteWeight: snapshot.byteWeight,
      minCost: snapshot.minCost,
      maxExecutionMs: snapshot.maxExecutionMs,
      maxInputSize: snapshot.maxInputSize,
      accounts: snapshot.accounts,
      ...(snapshot.escrows !== undefined ? { escrows: snapshot.escrows } : {}),
      settledAttestations: snapshot.settledAttestations,
      settledShardProofs: snapshot.settledShardProofs,
      usedNonces: snapshot.usedNonces,
      auditLog: snapshot.auditLog,
      ...opts
    });
  }
}

module.exports = {
  ProofOfComputeLedger,
  DoubleSpendAttemptError,
  InsufficientCreditBalanceError,
  UnknownAccountError,
  CreditOverflowError
};
