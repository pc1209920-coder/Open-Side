const crypto = require('node:crypto');

const DEFAULT_HKDF_SALT = 'open-side-hkdf-sha512-salt-v1';
const DEFAULT_HKDF_INFO = 'open-side:v1:aes-256-gcm:session-key';
const DRIFT_TOLERANCE_MS = 60000;
const REPLAY_WINDOW_SIZE = 64;
const MAX_SLIDING_WINDOW_SIZE = 65536;
const DEFAULT_MAX_TRACKED_PEERS = 10000;
const MAX_HKDF_SHA512_KEYLEN = 255 * 64; // 16320 bytes per RFC 5869

function normalizeOptions(options) {
  return options && typeof options === 'object' && !Array.isArray(options) ? options : {};
}

function safeJsonReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

function safeJsonStringify(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function computeBoundAad(userAadBuf, timestamp, nonce, epoch) {
  const parts = [
    `ts=${timestamp}`,
    `nonce=${nonce}`,
    epoch !== undefined ? `epoch=${epoch}` : ''
  ];
  const metaStr = parts.filter(Boolean).join(';');
  const metaBuf = Buffer.from(metaStr, 'utf8');
  if (userAadBuf && userAadBuf.length > 0) {
    return Buffer.concat([metaBuf, Buffer.from(':', 'utf8'), userAadBuf]);
  }
  return metaBuf;
}

class MeshCryptoEngine {
  constructor(options = {}) {
    const opts = normalizeOptions(options);
    this.curve = opts.curve || 'prime256v1';
    this.ecdh = crypto.createECDH(this.curve);
    this.publicKey = this.ecdh.generateKeys('hex');
    this.nodeId = crypto.createHash('sha256').update(this.publicKey).digest('hex').slice(0, 40);
    this.outboundNonce = 1;

    if (opts.maxTimeDriftMs !== undefined) {
      if (typeof opts.maxTimeDriftMs !== 'number' || !Number.isFinite(opts.maxTimeDriftMs) || opts.maxTimeDriftMs <= 0) {
        throw new RangeError('Invalid maxTimeDriftMs: must be a positive finite number');
      }
      this.maxTimeDriftMs = opts.maxTimeDriftMs;
    } else {
      this.maxTimeDriftMs = DRIFT_TOLERANCE_MS;
    }

    if (opts.slidingWindowSize !== undefined) {
      if (
        !Number.isSafeInteger(opts.slidingWindowSize) ||
        opts.slidingWindowSize <= 0 ||
        opts.slidingWindowSize > MAX_SLIDING_WINDOW_SIZE
      ) {
        throw new RangeError(`Invalid slidingWindowSize: must be a positive safe integer <= ${MAX_SLIDING_WINDOW_SIZE}`);
      }
      this.slidingWindowSize = opts.slidingWindowSize;
    } else {
      this.slidingWindowSize = REPLAY_WINDOW_SIZE;
    }

    if (opts.maxTrackedPeers !== undefined) {
      if (!Number.isSafeInteger(opts.maxTrackedPeers) || opts.maxTrackedPeers <= 0) {
        throw new RangeError('Invalid maxTrackedPeers: must be a positive safe integer');
      }
      this.maxTrackedPeers = opts.maxTrackedPeers;
    } else {
      this.maxTrackedPeers = DEFAULT_MAX_TRACKED_PEERS;
    }

    this.allowOutOfOrder = typeof opts.allowOutOfOrder === 'boolean' ? opts.allowOutOfOrder : true;
    this.peerReplayStates = new Map();
    this.inboundNonces = this.peerReplayStates;
    this.peerReplayWindows = this.peerReplayStates;
    this.replayWindows = this.peerReplayStates;
    this.throwOnError = Boolean(opts.throwOnError);
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  }

  /**
   * Validates EC public key hex formatting and decodes exact bytes prior to ECDH operations.
   * Rejects non-hex characters, trailing garbage, wrong lengths, and malformed prefixes.
   * @param {string} peerPublicKeyHex
   * @returns {Buffer}
   * @private
   */
  _decodePeerPublicKeyHex(peerPublicKeyHex) {
    if (typeof peerPublicKeyHex !== 'string' || !peerPublicKeyHex) {
      throw new TypeError('Invalid peer public key: must be a valid hex string');
    }

    if (peerPublicKeyHex.toLowerCase() === this.publicKey.toLowerCase()) {
      throw new Error('Key derivation failed: cannot derive key with self public key (self-reflection rejected)');
    }

    const expectedHexLen = this.publicKey.length;
    if (
      peerPublicKeyHex.length !== expectedHexLen ||
      !/^[0-9a-fA-F]+$/.test(peerPublicKeyHex) ||
      (this.publicKey.startsWith('04') && !peerPublicKeyHex.startsWith('04'))
    ) {
      throw new Error('Key derivation failed: invalid elliptic curve public key (malformed key format, prefix, or length)');
    }

    return Buffer.from(peerPublicKeyHex, 'hex');
  }

  /**
   * Strictly validates a peer EC public key against formatting rules and the active curve.
   * @param {string} peerPublicKeyHex
   * @returns {boolean}
   */
  validatePublicKey(peerPublicKeyHex) {
    const pubKeyBuf = this._decodePeerPublicKeyHex(peerPublicKeyHex);
    try {
      this.ecdh.computeSecret(pubKeyBuf);
    } catch (err) {
      throw new Error(`Key derivation failed: invalid elliptic curve public key (${err.message})`);
    }
    return true;
  }

  /**
   * Baseline shared key derivation (SHA-256 digest of ECDH secret).
   * 100% backward compatible with v0.4.2 baseline.
   * @param {string} peerPublicKeyHex
   * @returns {Buffer} 32-byte shared key buffer
   */
  deriveSharedKey(peerPublicKeyHex) {
    const pubKeyBuf = this._decodePeerPublicKeyHex(peerPublicKeyHex);
    let rawSecret;
    try {
      rawSecret = this.ecdh.computeSecret(pubKeyBuf);
    } catch (err) {
      throw new Error(`Key derivation failed: invalid elliptic curve public key (${err.message})`);
    }
    return crypto.createHash('sha256').update(rawSecret).digest();
  }

  /**
   * Requirement R3: HKDF-SHA512 session key derivation and epoch rotation.
   * Derives a fresh symmetric key from ECDH shared secret using HKDF-SHA512.
   * @param {string} peerPublicKeyHex
   * @param {object} [options]
   * @param {Buffer|string} [options.salt]
   * @param {Buffer|string} [options.info]
   * @param {number} [options.keylen=32]
   * @param {number} [options.epoch]
   * @returns {Buffer} Derived symmetric key
   */
  deriveSessionKey(peerPublicKeyHex, options = {}) {
    const pubKeyBuf = this._decodePeerPublicKeyHex(peerPublicKeyHex);
    const opts = normalizeOptions(options);
    const keylen = opts.keylen !== undefined ? opts.keylen : 32;
    if (!Number.isSafeInteger(keylen) || keylen <= 0 || keylen > MAX_HKDF_SHA512_KEYLEN) {
      throw new RangeError(`Invalid key length: must be an integer between 1 and ${MAX_HKDF_SHA512_KEYLEN}`);
    }

    let rawSecret;
    try {
      rawSecret = this.ecdh.computeSecret(pubKeyBuf);
    } catch (err) {
      throw new Error(`Key derivation failed: invalid elliptic curve public key (${err.message})`);
    }

    const salt = (opts.salt !== undefined && opts.salt !== null)
      ? (Buffer.isBuffer(opts.salt) ? opts.salt : Buffer.from(String(opts.salt), 'utf8'))
      : Buffer.from(DEFAULT_HKDF_SALT, 'utf8');

    let infoStr = DEFAULT_HKDF_INFO;
    if (opts.info !== undefined && opts.info !== null) {
      infoStr = opts.info;
    } else if (opts.epoch !== undefined) {
      infoStr = `open-side-v1-session-key-epoch:${opts.epoch}`;
    }
    let info = Buffer.isBuffer(infoStr) ? infoStr : Buffer.from(String(infoStr), 'utf8');
    // OpenSSL caps raw HKDF info at 1024 bytes; domain-separated SHA-512 digest preserves arbitrary-length info entropy.
    if (info.length > 1024) {
      info = Buffer.concat([
        Buffer.from('open-side:hkdf-info-sha512:', 'utf8'),
        crypto.createHash('sha512').update(info).digest()
      ]);
    }

    const derivedArrayBuffer = crypto.hkdfSync('sha512', rawSecret, salt, info, keylen);
    return Buffer.from(derivedArrayBuffer);
  }

  /**
   * Authenticated AES-256-GCM encryption with 12-byte random IV, 16-byte authTag,
   * monotonic sequence nonces, and optional AAD binding.
   * @param {any} payloadObj
   * @param {Buffer} sharedKeyBuffer
   * @param {object} [options]
   * @param {number} [options.nonce]
   * @param {number} [options.timestamp]
   * @param {number} [options.epoch]
   * @param {Buffer|string} [options.aad]
   * @returns {{ iv: string, authTag: string, ciphertext: string, timestamp: number, nonce: number, epoch?: number, aad?: string }}
   */
  encryptShard(payloadObj, sharedKeyBuffer, options = {}) {
    if (payloadObj === undefined) {
      throw new TypeError('Invalid payload: payloadObj must be defined');
    }
    if (!Buffer.isBuffer(sharedKeyBuffer) || sharedKeyBuffer.length !== 32) {
      throw new TypeError('Invalid key: sharedKeyBuffer must be a 32-byte Buffer');
    }

    const opts = normalizeOptions(options);
    let serialized;
    try {
      serialized = safeJsonStringify(payloadObj);
    } catch {
      throw new TypeError('Invalid payload: payloadObj must be JSON-serializable');
    }
    if (typeof serialized !== 'string') {
      throw new TypeError('Invalid payload: payloadObj must be JSON-serializable');
    }

    let nonce = opts.nonce;
    if (nonce === undefined) {
      if (this.outboundNonce >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Nonce overflow: outbound nonce counter reached maximum safe integer, key rotation required');
      }
      nonce = this.outboundNonce++;
    } else {
      if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce <= 0) {
        throw new TypeError('Invalid nonce: must be a positive safe integer');
      }
    }

    let timestamp;
    if (opts.timestamp !== undefined) {
      if (typeof opts.timestamp !== 'number' || !Number.isSafeInteger(opts.timestamp) || opts.timestamp <= 0) {
        throw new TypeError('Invalid timestamp: must be a positive safe integer');
      }
      timestamp = opts.timestamp;
    } else {
      timestamp = this._now();
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKeyBuffer, iv, { authTagLength: 16 });

    let aadBuf = null;
    if (opts.aad !== undefined && opts.aad !== null && opts.aad !== '') {
      aadBuf = Buffer.isBuffer(opts.aad) ? opts.aad : Buffer.from(String(opts.aad), 'utf8');
      if (aadBuf.length === 0) {
        aadBuf = null;
      }
    }

    const combinedAad = computeBoundAad(aadBuf, timestamp, nonce, opts.epoch);
    cipher.setAAD(combinedAad);

    let encrypted = cipher.update(serialized, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const packet = {
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: encrypted,
      timestamp,
      nonce
    };

    if (opts.epoch !== undefined) {
      packet.epoch = opts.epoch;
    }
    if (aadBuf) {
      packet.aad = aadBuf.toString('hex');
    }

    return packet;
  }

  /**
   * Authenticated AES-256-GCM decryption with strict validation, fail-closed tamper detection,
   * and optional anti-replay validation (committed only after authentication tag passes).
   * @param {object} encryptedPacket
   * @param {Buffer} sharedKeyBuffer
   * @param {object} [options]
   * @param {boolean} [options.validateReplay=false]
   * @param {string} [options.senderId]
   * @param {Buffer|string} [options.aad]
   * @returns {any} Decrypted payload object
   */
  decryptShard(encryptedPacket, sharedKeyBuffer, options = {}) {
    if (!encryptedPacket || typeof encryptedPacket !== 'object' || Array.isArray(encryptedPacket)) {
      throw new TypeError('Invalid packet: encryptedPacket must be a non-null object');
    }
    if (!Buffer.isBuffer(sharedKeyBuffer) || sharedKeyBuffer.length !== 32) {
      throw new TypeError('Invalid key: sharedKeyBuffer must be a 32-byte Buffer');
    }

    const opts = normalizeOptions(options);

    // Strict validation of IV (12 bytes = 24 hex characters)
    if (typeof encryptedPacket.iv !== 'string' || !/^[0-9a-fA-F]{24}$/.test(encryptedPacket.iv)) {
      throw new Error('Invalid packet: malformed IV (must be 24-character hex string / 12 bytes)');
    }

    // Strict validation of AuthTag (16 bytes = 32 hex characters)
    if (typeof encryptedPacket.authTag !== 'string' || !/^[0-9a-fA-F]{32}$/.test(encryptedPacket.authTag)) {
      throw new Error('Invalid packet: malformed authTag (must be 32-character hex string / 16 bytes)');
    }

    // Strict validation of Ciphertext
    if (typeof encryptedPacket.ciphertext !== 'string' || encryptedPacket.ciphertext.length === 0 || !/^[0-9a-fA-F]*$/.test(encryptedPacket.ciphertext) || encryptedPacket.ciphertext.length % 2 !== 0) {
      throw new Error('Invalid packet: malformed ciphertext (must be non-empty even-length hex string)');
    }

    if (opts.aad === undefined && encryptedPacket.aad !== undefined) {
      if (typeof encryptedPacket.aad !== 'string' || encryptedPacket.aad.length === 0 || !/^[0-9a-fA-F]*$/.test(encryptedPacket.aad) || encryptedPacket.aad.length % 2 !== 0) {
        throw new Error('Invalid packet: malformed AAD (must be non-empty even-length hex string)');
      }
    }

    let decipher;
    try {
      decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        sharedKeyBuffer,
        Buffer.from(encryptedPacket.iv, 'hex'),
        { authTagLength: 16 }
      );
      decipher.setAuthTag(Buffer.from(encryptedPacket.authTag, 'hex'));

      let userAadBuf = null;
      if (opts.aad !== undefined && opts.aad !== null) {
        const b = Buffer.isBuffer(opts.aad) ? opts.aad : Buffer.from(String(opts.aad), 'utf8');
        if (b.length > 0) userAadBuf = b;
      } else if (encryptedPacket.aad) {
        userAadBuf = Buffer.from(encryptedPacket.aad, 'hex');
      }

      const combinedAad = computeBoundAad(userAadBuf, encryptedPacket.timestamp, encryptedPacket.nonce, encryptedPacket.epoch);
      decipher.setAAD(combinedAad);
    } catch (err) {
      throw new Error(`Decryption initialization failed: ${err.message}`);
    }

    let decrypted;
    try {
      decrypted = decipher.update(encryptedPacket.ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
    } catch (err) {
      throw new Error('Decryption failed: authentication tag verification failed / corrupted ciphertext');
    }

    let parsed;
    try {
      parsed = JSON.parse(decrypted, safeJsonReviver);
    } catch (err) {
      throw new Error(`Decryption failed: invalid JSON payload in decrypted ciphertext (${err.message})`);
    }

    // Auth-before-replay: validate and commit anti-replay nonces ONLY after successful GCM authentication
    if (opts.validateReplay) {
      const senderId = opts.senderId;
      if (typeof senderId !== 'string' || !senderId) {
        throw new Error('Anti-replay validation failed: senderId is required for replay validation');
      }
      const replayEvaluation = this._evaluateWirePacket(encryptedPacket, senderId, opts);
      if (!replayEvaluation.ok) {
        throw new Error('Anti-replay validation failed: ' + replayEvaluation.error.message);
      }
      replayEvaluation.commit();
    }

    return parsed;
  }

  /**
   * Retrieves or creates bounded LRU peer replay state.
   * @param {string} peerNodeId
   * @param {number} windowSize
   * @private
   */
  _getOrCreatePeerReplayState(peerNodeId, windowSize) {
    let state = this.peerReplayStates.get(peerNodeId);
    if (state) {
      // Refresh LRU ordering on authenticated commit
      this.peerReplayStates.delete(peerNodeId);
      this.peerReplayStates.set(peerNodeId, state);
      return state;
    }

    while (this.peerReplayStates.size >= this.maxTrackedPeers) {
      const oldestPeerId = this.peerReplayStates.keys().next().value;
      if (oldestPeerId === undefined) break;
      this.peerReplayStates.delete(oldestPeerId);
    }

    state = { maxNonce: 0, lastNonce: 0, seenNonces: new Set(), windowSize };
    this.peerReplayStates.set(peerNodeId, state);
    return state;
  }

  /**
   * Prunes expired nonces from a peer's replay window in O(1) on full window jumps
   * and incremental sequential steps.
   * @private
   */
  _advanceAndPruneReplayWindow(state, nonce, windowSize) {
    const prevMax = state.maxNonce;
    const prevWindowSize = state.windowSize;
    state.maxNonce = Math.max(prevMax, nonce);
    state.windowSize = windowSize;

    const minAcceptable = state.maxNonce - windowSize;
    if (state.seenNonces.size > 0) {
      const delta = state.maxNonce - prevMax;
      if (delta >= windowSize) {
        state.seenNonces.clear();
      } else if (delta > 0 && windowSize >= prevWindowSize && delta <= state.seenNonces.size) {
        const pruneStart = Math.max(1, prevMax - prevWindowSize + 1);
        for (let oldNonce = pruneStart; oldNonce <= minAcceptable; oldNonce += 1) {
          state.seenNonces.delete(oldNonce);
        }
      } else if (delta > 0 || windowSize < prevWindowSize) {
        for (const oldNonce of state.seenNonces) {
          if (oldNonce <= minAcceptable) {
            state.seenNonces.delete(oldNonce);
          }
        }
      }
    }

    state.seenNonces.add(nonce);
  }

  /**
   * Pure read-only evaluation of timestamp drift and anti-replay nonce state.
   * Returns a commit closure so callers can defer state mutation until authentication succeeds.
   * @private
   */
  _evaluateWirePacket(packet, peerNodeId, options = {}) {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
      return { ok: false, error: new TypeError('Invalid wire packet: must be a non-null object') };
    }
    if (typeof peerNodeId !== 'string' || !peerNodeId) {
      return { ok: false, error: new TypeError('Invalid peerNodeId: must be a non-empty string') };
    }

    const opts = normalizeOptions(options);

    // 1. Timestamp validation (Anti-Drift & NaN Guard)
    const timestamp = packet.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Number.isNaN(timestamp)) {
      return { ok: false, error: new TypeError('Invalid timestamp: must be a finite number') };
    }
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      return { ok: false, error: new RangeError('Invalid timestamp: must be a positive safe integer') };
    }

    let maxDrift = this.maxTimeDriftMs;
    if (opts.maxDriftMs !== undefined) {
      maxDrift = opts.maxDriftMs;
    } else if (opts.maxTimeDriftMs !== undefined) {
      maxDrift = opts.maxTimeDriftMs;
    }
    if (typeof maxDrift !== 'number' || !Number.isFinite(maxDrift) || maxDrift <= 0) {
      return { ok: false, error: new RangeError('Invalid maxDriftMs: must be a positive finite number') };
    }

    const now = this._now();
    const drift = now - timestamp;
    if (drift > maxDrift) {
      return { ok: false, error: new Error(`Timestamp expired: packet timestamp is ${drift}ms in the past (exceeds ${maxDrift}ms tolerance)`) };
    }
    if (drift < -maxDrift) {
      return { ok: false, error: new Error(`Timestamp invalid: packet timestamp is ${-drift}ms in the future (exceeds ${maxDrift}ms tolerance)`) };
    }

    // 2. Nonce validation (Required positive safe integer; Strict Monotonic or Sliding Replay Window)
    const nonce = packet.nonce;
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce <= 0) {
      return { ok: false, error: new TypeError('Invalid nonce: must be a positive safe integer') };
    }

    const strict = opts.strictMonotonic !== undefined
      ? Boolean(opts.strictMonotonic)
      : !this.allowOutOfOrder;

    const windowSize = opts.windowSize !== undefined
      ? opts.windowSize
      : this.slidingWindowSize;
    if (!Number.isSafeInteger(windowSize) || windowSize <= 0 || windowSize > MAX_SLIDING_WINDOW_SIZE) {
      return {
        ok: false,
        error: new RangeError(`Invalid windowSize: must be a positive safe integer <= ${MAX_SLIDING_WINDOW_SIZE}`)
      };
    }

    const existingState = this.peerReplayStates.get(peerNodeId);
    const maxNonce = existingState ? existingState.maxNonce : 0;
    const lastNonce = existingState ? existingState.lastNonce : 0;

    if (strict) {
      if (nonce <= lastNonce) {
        return { ok: false, error: new Error(`Replay detected: nonce ${nonce} is not strictly greater than last received nonce ${lastNonce}`) };
      }
      return {
        ok: true,
        commit: () => {
          const state = this._getOrCreatePeerReplayState(peerNodeId, windowSize);
          state.lastNonce = nonce;
          this._advanceAndPruneReplayWindow(state, nonce, windowSize);
        }
      };
    }

    // Sliding Window Algorithm (RFC 6479)
    if (nonce > maxNonce) {
      return {
        ok: true,
        commit: () => {
          const state = this._getOrCreatePeerReplayState(peerNodeId, windowSize);
          state.lastNonce = nonce;
          this._advanceAndPruneReplayWindow(state, nonce, windowSize);
        }
      };
    }

    const minAcceptable = maxNonce - windowSize;
    if (nonce <= minAcceptable) {
      return { ok: false, error: new Error(`Replay detected: packet nonce ${nonce} is too old (outside sliding window)`) };
    }

    if (existingState && existingState.seenNonces.has(nonce)) {
      return { ok: false, error: new Error(`Replay detected: duplicate nonce ${nonce} already processed`) };
    }

    return {
      ok: true,
      commit: () => {
        const state = this._getOrCreatePeerReplayState(peerNodeId, windowSize);
        state.seenNonces.add(nonce);
      }
    };
  }

  /**
   * Anti-replay wire packet validator enforcing timestamp drift windows
   * and sequence nonces via sliding window or strict monotonic ordering.
   * @param {{ timestamp: number, nonce: number }} packet
   * @param {string} peerNodeId
   * @param {object} [options]
   * @returns {boolean}
   */
  validateWirePacket(packet, peerNodeId, options = {}) {
    const opts = normalizeOptions(options);
    const evalResult = this._evaluateWirePacket(packet, peerNodeId, opts);
    if (!evalResult.ok) {
      const shouldThrow = opts.throwOnError !== undefined
        ? Boolean(opts.throwOnError)
        : this.throwOnError;
      if (shouldThrow) {
        throw evalResult.error;
      }
      return false;
    }

    evalResult.commit();
    return true;
  }

  /**
   * Deterministic HMAC-SHA256 Proof-of-Compute signature generation.
   * @param {string} shardId
   * @param {any} resultData
   * @param {string|Buffer} [secret=this.publicKey]
   * @returns {string} 64-character hex signature
   */
  signProofOfCompute(shardId, resultData, secret = this.publicKey) {
    if (typeof shardId !== 'string' || !shardId) {
      throw new TypeError('Invalid shardId: must be a non-empty string');
    }
    if (!secret || (Buffer.isBuffer(secret) && secret.length === 0)) {
      throw new TypeError('Invalid secret: must be a non-empty string or Buffer');
    }
    const key = Buffer.isBuffer(secret) ? secret : String(secret);
    return crypto.createHmac('sha256', key).update(`${shardId}:${safeJsonStringify(resultData)}`).digest('hex');
  }

  /**
   * Constant-time Proof-of-Compute signature verification.
   * Mitigates side-channel timing attacks with buffer length guards.
   * @param {string} shardId
   * @param {any} resultData
   * @param {string|Buffer} signature
   * @param {string|Buffer} [secret=this.publicKey]
   * @returns {boolean}
   */
  verifyProofOfCompute(shardId, resultData, signature, secret = this.publicKey) {
    if (typeof shardId !== 'string' || !shardId) {
      return false;
    }
    if (!secret || (Buffer.isBuffer(secret) && secret.length === 0) || (typeof secret === 'string' && secret.length === 0)) {
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

    try {
      const key = Buffer.isBuffer(secret) ? secret : String(secret);
      const expectedSignature = crypto.createHmac('sha256', key).update(`${shardId}:${safeJsonStringify(resultData)}`).digest('hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');

      if (sigBuf.length !== 32 || expectedBuf.length !== 32) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  /**
   * Resets replay window tracking for a specific peer or all peers.
   * @param {string} [peerNodeId]
   */
  resetReplayState(peerNodeId) {
    if (typeof peerNodeId === 'string' && peerNodeId.length > 0) {
      this.peerReplayStates.delete(peerNodeId);
    } else {
      this.peerReplayStates.clear();
    }
  }

  /**
   * Inspects current replay window statistics for a peer.
   * @param {string} peerNodeId
   * @returns {{ lastNonce: number, maxNonce: number, seenCount: number, windowSize: number } | null}
   */
  getReplayStats(peerNodeId) {
    const state = this.peerReplayStates.get(peerNodeId);
    if (!state) return null;
    return {
      lastNonce: state.lastNonce,
      maxNonce: state.maxNonce,
      seenCount: state.seenNonces.size,
      windowSize: state.windowSize
    };
  }
}

module.exports = { MeshCryptoEngine };
