# Cryptographic Hardening & Security Edge Case Analysis for Milestone 2 (`src/crypto.js`)

**Agent**: `explorer_m2_2`  
**Milestone**: Milestone 2 (Requirement R3)  
**Target File**: `c:\Users\pc120\Documents\REPO\src\crypto.js`  
**Timestamp**: 2026-11-10T05:38:00Z  

---

## 1. Observations

### 1.1 Baseline Implementation Inspection (`src/crypto.js`)
Direct inspection of `src/crypto.js` (lines 1–42) reveals the current baseline cryptographic implementation:

```javascript
// src/crypto.js:1-42
const crypto = require('node:crypto');

class MeshCryptoEngine {
  constructor() {
    this.ecdh = crypto.createECDH('prime256v1');
    this.publicKey = this.ecdh.generateKeys('hex');
    this.nodeId = crypto.createHash('sha256').update(this.publicKey).digest('hex').slice(0, 40);
  }

  deriveSharedKey(peerPublicKeyHex) {
    const rawSecret = this.ecdh.computeSecret(peerPublicKeyHex, 'hex');
    return crypto.createHash('sha256').update(rawSecret).digest();
  }

  encryptShard(payloadObj, sharedKeyBuffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKeyBuffer, iv);
    let encrypted = cipher.update(JSON.stringify(payloadObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return {
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: encrypted,
      timestamp: Date.now()
    };
  }

  decryptShard(encryptedPacket, sharedKeyBuffer) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKeyBuffer, Buffer.from(encryptedPacket.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encryptedPacket.authTag, 'hex'));
    let decrypted = decipher.update(encryptedPacket.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }

  signProofOfCompute(shardId, resultData) {
    return crypto.createHmac('sha256', this.publicKey).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex');
  }
}

module.exports = { MeshCryptoEngine };
```

### 1.2 Observed Vulnerabilities and Deficiencies in Baseline Code
1. **No Input Validation on Encrypted Packet Components (`src/crypto.js:28-34`)**:
   - `encryptedPacket.iv`: Unchecked. If missing, undefined, truncated, or non-hex, `Buffer.from(encryptedPacket.iv, 'hex')` returns an empty or truncated Buffer.
   - `encryptedPacket.authTag`: Unchecked. If missing or shorter than 16 bytes (128 bits), Node.js emits `[DEP0182] DeprecationWarning: Using AES-GCM authentication tags of less than 128 bits without specifying the authTagLength option...` and accepts truncated tags, exposing the protocol to polynomial forgery attacks.
   - `encryptedPacket.ciphertext`: Unchecked. Bit-flipped or altered ciphertext throws an raw OpenSSL error (`Error: Unsupported state or unable to authenticate data`) without structured context or fail-closed descriptive wrapping.
   - Plaintext parsing: `JSON.parse(decrypted)` throws an unhandled `SyntaxError` if corrupted ciphertext somehow passes or yields non-JSON data.
2. **Missing Anti-Replay Nonce Engine (`src/crypto.js:15-34`)**:
   - `encryptShard` returns `{ iv, authTag, ciphertext, timestamp }` with no `nonce`.
   - `decryptShard` performs zero nonce checking. Duplicate packets can be replayed infinitely against worker nodes.
   - No tracking of inbound peer nonces, strictly monotonic ordering, or sliding replay windows.
3. **Missing Timestamp Validation (`src/crypto.js:28-34`)**:
   - Although `encryptShard` attaches `timestamp: Date.now()`, `decryptShard` never inspects or validates `timestamp`.
   - Packets from minutes, days, or years ago, or packets with future timestamps, are decrypted unconditionally.
   - JavaScript comparison trap: `Math.abs(Date.now() - NaN) > 60000` evaluates to `false`, allowing `NaN` timestamps to bypass naive drift checks.
4. **Missing Proof-of-Compute Verification & Timing Attack Vulnerability**:
   - `src/crypto.js` provides `signProofOfCompute` (line 36), but provides NO `verifyProofOfCompute` method.
   - Naive comparison using `===` leaks execution timing proportional to matching leading bytes.
   - Node.js's native `crypto.timingSafeEqual(bufA, bufB)` throws an uncaught `RangeError [ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH]` if `bufA.length !== bufB.length`.
5. **Missing RFC 5869 HKDF-SHA512 Key Derivation & Domain Separation**:
   - `deriveSharedKey` (lines 10-13) only computes `sha256(rawSecret)`.
   - No `deriveSessionKey` implementation using `crypto.hkdfSync('sha512', ...)`.
   - Node.js runtime verification: `crypto.hkdfSync` returns an `ArrayBuffer` (`Buffer.isBuffer(out) === false`), requiring explicit `Buffer.from(...)` wrapping to prevent downstream crashes in `createCipheriv`.

### 1.3 Verified Runtime Behaviors on Node.js v24.22.1
Direct commands executed in the target environment:

- **HKDF Return Type**:
  Command: `node -e "const crypto = require('node:crypto'); const out = crypto.hkdfSync('sha512', 'secret', 'salt', 'info', 32); console.log(out.constructor.name, Buffer.isBuffer(out), out.byteLength);"`
  Output: `ArrayBuffer false 32`
  Finding: Node's `crypto.hkdfSync` returns `ArrayBuffer`. `Buffer.from()` is mandatory for 32-byte `Buffer` compatibility.

- **timingSafeEqual Length Exception**:
  Command: `node -e "const crypto = require('node:crypto'); try { crypto.timingSafeEqual(Buffer.from('aa', 'hex'), Buffer.from('aaaa', 'hex')); } catch(e) { console.log(e.name, e.code, e.message); }"`
  Output: `RangeError ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH Input buffers must have the same byte length`
  Finding: `timingSafeEqual` throws if lengths differ; explicit 32-byte length and hex format pre-validation are mandatory before invoking `timingSafeEqual`.

- **AES-GCM AuthTag Truncation Deprecation**:
  Command: `node -e "const crypto = require('node:crypto'); const key = crypto.randomBytes(32); const iv = crypto.randomBytes(12); const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(Buffer.alloc(8));"`
  Output: `(node:5708) [DEP0182] DeprecationWarning: Using AES-GCM authentication tags of less than 128 bits without specifying the authTagLength option when initializing decryption is deprecated.`
  Command with `{ authTagLength: 16 }`:
  Output: `TypeError ERR_CRYPTO_INVALID_AUTH_TAG Invalid authentication tag length: 8`
  Finding: Node accepts <128-bit tags unless explicit length validation is performed or `{ authTagLength: 16 }` is specified.

- **Non-96-Bit IV Silent Acceptance in OpenSSL**:
  Command: `node -e "const crypto = require('node:crypto'); const key = crypto.randomBytes(32); const c = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(8));"`
  Output: `(no error thrown)`
  Finding: OpenSSL accepts 8-byte and 16-byte IVs by hashing them with GHASH. The application layer MUST enforce exactly 12 bytes (24 hex characters) to comply with NIST SP 800-38D and prevent GHASH collision/performance degradation.

- **Corrupted Ciphertext / AuthTag Error**:
  Command: `node -e "const crypto = require('node:crypto'); ... corruptedTag[0] ^= 1; ... d.final('utf8');"`
  Output: `Error: Unsupported state or unable to authenticate data`
  Finding: Authentication failure must be caught and wrapped into a descriptive `Error('Decryption failed: authentication tag verification failed / corrupted ciphertext')`.

---

## 2. Logic Chain

### 2.1 Chain 1: Fail-Closed Protection Against Malformed / Corrupted Payloads
1. From Observation 1.1 & 1.3, incoming encrypted packets originate over untrusted P2P transport.
2. In AES-256-GCM, NIST SP 800-38D requires a 96-bit (12-byte) IV and a 128-bit (16-byte) authentication tag.
3. If an IV is not 12 bytes (24 hex chars) or an authTag is not 16 bytes (32 hex chars), OpenSSL or Node.js either defaults to non-standard GHASH processing or truncated tag verification, weakening forgery resistance from $2^{-128}$ to $2^{-64}$ or $2^{-32}$.
4. If a ciphertext or tag is modified by an active attacker or network corruption, GCM authentication fails at `decipher.final()`.
5. Therefore, `decryptShard` must:
   - Validate that `encryptedPacket` is a valid non-null object.
   - Enforce regex `/^[0-9a-fA-F]{24}$/` on `iv` (exactly 12 bytes).
   - Enforce regex `/^[0-9a-fA-F]{32}$/` on `authTag` (exactly 16 bytes).
   - Enforce that `ciphertext` is a non-empty, even-length hex string.
   - Enforce `{ authTagLength: 16 }` on `createDecipheriv`.
   - Wrap OpenSSL decryption errors in a descriptive exception: `Error('Decryption failed: authentication tag verification failed / corrupted ciphertext')`.
   - Wrap JSON parsing in `Error('Decryption failed: invalid JSON payload in decrypted ciphertext')`.

### 2.2 Chain 2: Anti-Replay Defense Architecture (Monotonic & Sliding Window)
1. From Observation 1.1 & Requirement R3, network adversaries can replay valid encrypted shards to exhaust worker compute resources or double-claim ledger credits.
2. Senders must maintain an `outboundNonce` counter starting at 1, incremented monotonically per encrypted packet.
3. Receivers must track replay states per peer (`peerReplayStates = new Map<string, PeerReplayState>()`) to avoid cross-peer interference.
4. Transport protocols vary:
   - For strict in-order delivery (TCP streams in M5), strict monotonic ordering ($N > N_{\text{last}}$) guarantees that any replayed or out-of-order packet is rejected immediately.
   - For asynchronous, multi-path, or datagram delivery, network jitter may cause minor packet reordering. A sliding window of size $W = 64$ (RFC 6479 / RFC 4303) allows valid out-of-order packets within $[N_{\text{max}} - W + 1, N_{\text{max}}]$ while strictly rejecting duplicates and any packets older than $N_{\text{max}} - W$.
5. JavaScript represents integers safely up to `Number.MAX_SAFE_INTEGER` ($2^{53} - 1 = 9,007,199,254,740,991$). Nonce values must be validated with `Number.isSafeInteger(nonce) && nonce > 0`. If `outboundNonce` reaches `MAX_SAFE_INTEGER`, the engine must halt and mandate key rotation to prevent nonce reuse under the same session key.

### 2.3 Chain 3: Timestamp Window Drift Validation & NaN Defense
1. Nonces alone protect against replays within an active session, but do not prevent delayed replay if a node restarts and resets its sequence counter.
2. Combining nonces with a 60-second timestamp window ensures that any packet older than 60,000 ms ($T_{\text{now}} - T_{\text{pkt}} > 60000$) is rejected unconditionally.
3. Future timestamps ($T_{\text{pkt}} - T_{\text{now}} > 60000$) indicate severe clock skew or malicious timestamp inflation and must also be rejected.
4. JavaScript type-juggling edge case: `Math.abs(Date.now() - NaN) > 60000` evaluates to `false`. If a naive check `if (Math.abs(now - ts) > 60000) reject()` is used, `NaN`, `null`, and string timestamps bypass validation.
5. Therefore, timestamps must be strictly validated with `typeof timestamp === 'number' && Number.isFinite(timestamp) && !Number.isNaN(timestamp) && Number.isSafeInteger(timestamp) && timestamp > 0` before checking drift bounds.

### 2.4 Chain 4: Constant-Time HMAC-SHA256 Proof-of-Compute Verification
1. Proof-of-Compute attestations are signed using `crypto.createHmac('sha256', secret).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex')`.
2. Verifying signatures using standard JavaScript string comparison `===` terminates at the first differing byte, leaking timing differentials (Brumley-Boneh side channel) that allow forging signatures byte-by-byte.
3. Using Node's native `crypto.timingSafeEqual` prevents timing leakage.
4. However, as verified in Observation 1.3, `crypto.timingSafeEqual(a, b)` throws `RangeError ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` if `a.length !== b.length`.
5. Therefore, `verifyProofOfCompute` must:
   - Validate that `signature` is a string of exactly 64 hex characters (`/^[0-9a-fA-F]{64}$/`).
   - If invalid format or length $\ne 64$, immediately return `false` (length of SHA-256 is public knowledge, so early return on length does not leak secret data).
   - Convert both `signature` and `expectedSignature` to 32-byte Buffers.
   - Guard `sigBuf.length === 32 && expectedBuf.length === 32` before calling `crypto.timingSafeEqual`.
   - Return `false` on any mismatch; return `true` only if `timingSafeEqual` returns `true`.

### 2.5 Chain 5: HKDF-SHA512 Domain Separation (RFC 5869)
1. Deriving symmetric session keys directly from ECDH shared secrets without domain separation allows cross-context key reuse attacks (e.g. using a shard encryption key to decrypt P2P control frames).
2. RFC 5869 specifies HMAC-based Extract-and-Expand Key Derivation Function (HKDF):
   - **Extract**: $PRK = \text{HMAC-SHA512}(\text{salt}, \text{IKM})$
   - **Expand**: $OKM = \text{HKDF-Expand}(PRK, \text{info}, L)$
3. Domain separation is achieved through structured `info` tags:
   - Shard encryption: `open-side:v1:aes-256-gcm:session-key`
   - PoC ledger signing: `open-side:v1:hmac-sha256:poc-attestation`
   - Handshake authentication: `open-side:v1:p2p:handshake-key`
4. As verified in Observation 1.3, `crypto.hkdfSync` returns an `ArrayBuffer`. The method must wrap the result in `Buffer.from(...)` to ensure a 32-byte `Buffer` is returned.

---

## 3. Caveats

1. **Clock Synchronization Dependency**:
   Timestamp validation assumes peer host clocks are synchronized via NTP within $\pm 60$ seconds. In extreme environments with unsynchronized system clocks, packets may be rejected. The $\pm 60,000 \text{ ms}$ tolerance provides ample buffer for standard NTP drift.
2. **Replay State Memory Lifetime**:
   The sliding window replay state is stored in memory (`this.peerReplayStates`). In Milestone 2, this is in-process memory. If a node process restarts, ephemeral replay state is reset, but the 60-second timestamp drift guard prevents old packets from being accepted.
3. **Sliding Window Size Choice ($W = 64$)**:
   A 64-packet window provides the optimal balance: it accommodates normal P2P packet reordering while keeping memory consumption bounded at $< 1 \text{ KB}$ per peer using a bounded `Set<number>`.
4. **Backward Compatibility Priority**:
   `deriveSharedKey`, `signProofOfCompute(shardId, resultData)` (defaulting to `this.publicKey`), and unadorned `decryptShard(packet, key)` calls from baseline tests must continue to work without requiring extra arguments unless replay validation is explicitly enabled or wire envelopes contain nonces.

---

## 4. Conclusion & Cryptographic Hardening Specification

### 4.1 Complete Error Matrix & Exact Exceptions

| Method | Fault Condition | Exact Exception Type | Exact Exception Message Pattern |
|---|---|---|---|
| `deriveSessionKey` | Missing or non-string peer key | `TypeError` | `Invalid peer public key: must be a valid hex string` |
| `deriveSessionKey` | Invalid EC point / uncompressed key failure | `Error` | `Key derivation failed: invalid elliptic curve public key` |
| `deriveSessionKey` | Invalid `keylen` ($\le 0$ or not integer) | `RangeError` | `Invalid key length: must be a positive integer` |
| `encryptShard` | Undefined / non-serializable payload | `TypeError` | `Invalid payload: payloadObj must be defined` |
| `encryptShard` | Key is not 32-byte Buffer | `TypeError` | `Invalid key: sharedKeyBuffer must be a 32-byte Buffer` |
| `encryptShard` | Nonce $\ge \text{MAX\_SAFE\_INTEGER}$ | `RangeError` | `Nonce overflow: outbound nonce counter reached maximum safe integer` |
| `decryptShard` | Packet is null / non-object | `TypeError` | `Invalid packet: encryptedPacket must be a non-null object` |
| `decryptShard` | IV $\ne 24$ hex chars / non-hex | `Error` | `Invalid packet: malformed IV (must be 24-character hex string / 12 bytes)` |
| `decryptShard` | AuthTag $\ne 32$ hex chars / non-hex | `Error` | `Invalid packet: malformed authTag (must be 32-character hex string / 16 bytes)` |
| `decryptShard` | Ciphertext non-hex or odd length | `Error` | `Invalid packet: malformed ciphertext (must be non-empty even-length hex string)` |
| `decryptShard` | Tampered ciphertext or tag | `Error` | `Decryption failed: authentication tag verification failed / corrupted ciphertext` |
| `decryptShard` | Corrupted JSON in plaintext | `Error` | `Decryption failed: invalid JSON payload in decrypted ciphertext` |
| `validateWirePacket`| Timestamp is `NaN` or non-numeric | `TypeError` | `Invalid timestamp: must be a finite number` |
| `validateWirePacket`| Timestamp $> 60,000\text{ms}$ in past | `Error` | `Timestamp expired: packet timestamp is Xms in the past (exceeds 60000ms tolerance)` |
| `validateWirePacket`| Timestamp $> 60,000\text{ms}$ in future | `Error` | `Timestamp invalid: packet timestamp is Xms in the future (exceeds 60000ms tolerance)` |
| `validateWirePacket`| Nonce not positive safe integer | `TypeError` | `Invalid nonce: must be a positive safe integer` |
| `validateWirePacket`| Duplicate nonce within window | `Error` | `Replay detected: duplicate nonce X already processed` |
| `validateWirePacket`| Nonce older than window ($< N_{\text{max}} - W$)| `Error` | `Replay detected: packet nonce X is too old (outside sliding window)` |
| `validateWirePacket`| Nonce $\le N_{\text{last}}$ (strict mode) | `Error` | `Replay detected: nonce X is not strictly greater than last received nonce Y` |
| `verifyProofOfCompute`| Invalid shardId / signature format | Return `false` | Safe boolean fail-closed (no uncaught exception) |
| `verifyProofOfCompute`| Tampered payload / signature mismatch| Return `false` | Constant-time `crypto.timingSafeEqual` evaluation |

---

### 4.2 Proposed Implementation Blueprint for `src/crypto.js`

The Worker agent should implement `src/crypto.js` according to the following complete, hardened design:

```javascript
const crypto = require('node:crypto');

const DEFAULT_HKDF_SALT = 'open-side-hkdf-sha512-salt-v1';
const DEFAULT_HKDF_INFO = 'open-side:v1:aes-256-gcm:session-key';
const DRIFT_TOLERANCE_MS = 60000;
const REPLAY_WINDOW_SIZE = 64;

class MeshCryptoEngine {
  constructor() {
    this.ecdh = crypto.createECDH('prime256v1');
    this.publicKey = this.ecdh.generateKeys('hex');
    this.nodeId = crypto.createHash('sha256').update(this.publicKey).digest('hex').slice(0, 40);
    this.outboundNonce = 1;
    // Map<peerId, { maxNonce: number, lastNonce: number, seenNonces: Set<number>, windowSize: number }>
    this.peerReplayStates = new Map();
  }

  // Baseline backward compatible SHA-256 shared key
  deriveSharedKey(peerPublicKeyHex) {
    if (typeof peerPublicKeyHex !== 'string' || !peerPublicKeyHex) {
      throw new TypeError('Invalid peer public key: must be a valid hex string');
    }
    const rawSecret = this.ecdh.computeSecret(peerPublicKeyHex, 'hex');
    return crypto.createHash('sha256').update(rawSecret).digest();
  }

  // Requirement R3 & RFC 5869 HKDF-SHA512 Key Derivation
  deriveSessionKey(peerPublicKeyHex, options = {}) {
    if (typeof peerPublicKeyHex !== 'string' || !peerPublicKeyHex) {
      throw new TypeError('Invalid peer public key: must be a valid hex string');
    }
    const keylen = options.keylen !== undefined ? options.keylen : 32;
    if (!Number.isSafeInteger(keylen) || keylen <= 0) {
      throw new RangeError('Invalid key length: must be a positive integer');
    }

    let rawSecret;
    try {
      rawSecret = this.ecdh.computeSecret(peerPublicKeyHex, 'hex');
    } catch (err) {
      throw new Error(`Key derivation failed: invalid elliptic curve public key (${err.message})`);
    }

    const salt = options.salt ? (Buffer.isBuffer(options.salt) ? options.salt : Buffer.from(options.salt)) : Buffer.from(DEFAULT_HKDF_SALT);
    const info = options.info ? (Buffer.isBuffer(options.info) ? options.info : Buffer.from(options.info)) : Buffer.from(DEFAULT_HKDF_INFO);

    // crypto.hkdfSync returns ArrayBuffer; wrap in Buffer.from() for 32-byte Buffer return
    const derivedArrayBuffer = crypto.hkdfSync('sha512', rawSecret, salt, info, keylen);
    return Buffer.from(derivedArrayBuffer);
  }

  // Authenticated AES-256-GCM Encryption with Anti-Replay Nonce
  encryptShard(payloadObj, sharedKeyBuffer, options = {}) {
    if (payloadObj === undefined) {
      throw new TypeError('Invalid payload: payloadObj must be defined');
    }
    if (!Buffer.isBuffer(sharedKeyBuffer) || sharedKeyBuffer.length !== 32) {
      throw new TypeError('Invalid key: sharedKeyBuffer must be a 32-byte Buffer');
    }

    let nonce = options.nonce;
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

    const timestamp = options.timestamp !== undefined ? options.timestamp : Date.now();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKeyBuffer, iv);

    if (options.aad) {
      const aadBuf = Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(String(options.aad));
      cipher.setAAD(aadBuf);
    }

    let encrypted = cipher.update(JSON.stringify(payloadObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      ciphertext: encrypted,
      timestamp,
      nonce
    };
  }

  // Authenticated AES-256-GCM Decryption with Strict Validation and Fail-Closed Behavior
  decryptShard(encryptedPacket, sharedKeyBuffer, options = {}) {
    if (!encryptedPacket || typeof encryptedPacket !== 'object') {
      throw new TypeError('Invalid packet: encryptedPacket must be a non-null object');
    }
    if (!Buffer.isBuffer(sharedKeyBuffer) || sharedKeyBuffer.length !== 32) {
      throw new TypeError('Invalid key: sharedKeyBuffer must be a 32-byte Buffer');
    }

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

    // Replay and Timestamp validation if requested
    if (options.validateReplay && options.senderId) {
      this.validateWirePacket(encryptedPacket, options.senderId, options);
    }

    let decipher;
    try {
      decipher = crypto.createDecipheriv('aes-256-gcm', sharedKeyBuffer, Buffer.from(encryptedPacket.iv, 'hex'), { authTagLength: 16 });
      decipher.setAuthTag(Buffer.from(encryptedPacket.authTag, 'hex'));
      if (options.aad) {
        const aadBuf = Buffer.isBuffer(options.aad) ? options.aad : Buffer.from(String(options.aad));
        decipher.setAAD(aadBuf);
      }
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

    try {
      return JSON.parse(decrypted);
    } catch (err) {
      throw new Error(`Decryption failed: invalid JSON payload in decrypted ciphertext (${err.message})`);
    }
  }

  // Anti-Replay Nonce & Timestamp Wire Packet Validator
  validateWirePacket(packet, peerNodeId, options = {}) {
    if (!packet || typeof packet !== 'object') {
      throw new TypeError('Invalid wire packet: must be a non-null object');
    }
    if (typeof peerNodeId !== 'string' || !peerNodeId) {
      throw new TypeError('Invalid peerNodeId: must be a non-empty string');
    }

    // 1. Timestamp Validation (Anti-Drift & NaN Guard)
    const timestamp = packet.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Number.isNaN(timestamp)) {
      throw new TypeError('Invalid timestamp: must be a finite number');
    }
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new RangeError('Invalid timestamp: must be a positive safe integer');
    }

    const maxDrift = options.maxDriftMs || DRIFT_TOLERANCE_MS;
    const now = Date.now();
    const drift = now - timestamp; // positive = past, negative = future

    if (drift > maxDrift) {
      throw new Error(`Timestamp expired: packet timestamp is ${drift}ms in the past (exceeds ${maxDrift}ms tolerance)`);
    }
    if (drift < -maxDrift) {
      throw new Error(`Timestamp invalid: packet timestamp is ${-drift}ms in the future (exceeds ${maxDrift}ms tolerance)`);
    }

    // 2. Nonce Validation (Strict Monotonic or Sliding Replay Window)
    const nonce = packet.nonce;
    if (nonce !== undefined) {
      if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce <= 0) {
        throw new TypeError('Invalid nonce: must be a positive safe integer');
      }

      const strict = options.strictMonotonic ?? false;
      const windowSize = options.windowSize || REPLAY_WINDOW_SIZE;

      let state = this.peerReplayStates.get(peerNodeId);
      if (!state) {
        state = { maxNonce: 0, lastNonce: 0, seenNonces: new Set(), windowSize };
        this.peerReplayStates.set(peerNodeId, state);
      }

      if (strict) {
        if (nonce <= state.lastNonce) {
          throw new Error(`Replay detected: nonce ${nonce} is not strictly greater than last received nonce ${state.lastNonce}`);
        }
        state.lastNonce = nonce;
        state.maxNonce = Math.max(state.maxNonce, nonce);
        state.seenNonces.add(nonce);
        return true;
      }

      // Sliding Window Algorithm (RFC 6479)
      if (nonce > state.maxNonce) {
        state.maxNonce = nonce;
        state.seenNonces.add(nonce);
        const minAcceptable = state.maxNonce - windowSize;
        for (const oldNonce of state.seenNonces) {
          if (oldNonce <= minAcceptable) {
            state.seenNonces.delete(oldNonce);
          }
        }
        return true;
      }

      const minAcceptable = state.maxNonce - windowSize;
      if (nonce <= minAcceptable) {
        throw new Error(`Replay detected: packet nonce ${nonce} is too old (outside sliding window)`);
      }

      if (state.seenNonces.has(nonce)) {
        throw new Error(`Replay detected: duplicate nonce ${nonce} already processed`);
      }

      state.seenNonces.add(nonce);
    }

    return true;
  }

  // Deterministic HMAC-SHA256 Proof-of-Compute Signature
  signProofOfCompute(shardId, resultData, secret = this.publicKey) {
    if (typeof shardId !== 'string' || !shardId) {
      throw new TypeError('Invalid shardId: must be a non-empty string');
    }
    const key = Buffer.isBuffer(secret) ? secret : String(secret);
    return crypto.createHmac('sha256', key).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex');
  }

  // Constant-Time Proof-of-Compute Verification with Length Guards
  verifyProofOfCompute(shardId, resultData, signature, secret = this.publicKey) {
    if (typeof shardId !== 'string' || !shardId) {
      return false;
    }
    if (typeof signature !== 'string' || signature.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(signature)) {
      return false;
    }
    if (!secret) {
      return false;
    }

    try {
      const key = Buffer.isBuffer(secret) ? secret : String(secret);
      const expectedSignature = crypto.createHmac('sha256', key).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex');

      const sigBuf = Buffer.from(signature, 'hex');
      const expectedBuf = Buffer.from(expectedSignature, 'hex');

      if (sigBuf.length !== 32 || expectedBuf.length !== 32) {
        return false;
      }

      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }
}

module.exports = { MeshCryptoEngine };
```

---

## 5. Verification Method

### 5.1 Verification Test Command
To verify that this hardening preserves existing tests and functions correctly:
```powershell
npm test
```
All 5 existing baseline tests must pass cleanly.

### 5.2 Standalone Security Verification Test Suite
The following test script exercises every security edge case and error condition analyzed above:

```javascript
const assert = require('node:assert');
const { MeshCryptoEngine } = require('../src/crypto');

function runSecurityTests() {
  const alice = new MeshCryptoEngine();
  const bob = new MeshCryptoEngine();
  const sessionKey = alice.deriveSessionKey(bob.publicKey);

  // 1. Corrupted ciphertext fails closed
  const pkt = alice.encryptShard({ test: 123 }, sessionKey);
  const corruptedCt = pkt.ciphertext.slice(0, -2) + (pkt.ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa');
  assert.throws(() => {
    bob.decryptShard({ ...pkt, ciphertext: corruptedCt }, sessionKey);
  }, /authentication tag verification failed/);

  // 2. Corrupted authTag fails closed
  const corruptedTag = pkt.authTag.slice(0, -2) + 'ff';
  assert.throws(() => {
    bob.decryptShard({ ...pkt, authTag: corruptedTag }, sessionKey);
  }, /authentication tag verification failed/);

  // 3. Malformed IV (not 24 hex chars)
  assert.throws(() => {
    bob.decryptShard({ ...pkt, iv: 'deadbeef' }, sessionKey);
  }, /malformed IV/);

  // 4. Malformed authTag (not 32 hex chars)
  assert.throws(() => {
    bob.decryptShard({ ...pkt, authTag: 'deadbeef' }, sessionKey);
  }, /malformed authTag/);

  // 5. Anti-Replay: duplicate nonce detection
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 1 }, alice.nodeId);
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now(), nonce: 1 }, alice.nodeId);
  }, /duplicate nonce 1/);

  // 6. Anti-Replay: out-of-order within sliding window
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 4 }, alice.nodeId);
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 2 }, alice.nodeId); // out-of-order accepted
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 3 }, alice.nodeId); // out-of-order accepted
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now(), nonce: 2 }, alice.nodeId); // duplicate out-of-order
  }, /duplicate nonce 2/);

  // 7. Anti-Replay: outside sliding window
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 100 }, alice.nodeId);
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now(), nonce: 5 }, alice.nodeId);
  }, /outside sliding window/);

  // 8. Strict monotonic mode
  const carolId = 'peer-carol';
  bob.validateWirePacket({ timestamp: Date.now(), nonce: 1 }, carolId, { strictMonotonic: true });
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now(), nonce: 1 }, carolId, { strictMonotonic: true });
  }, /not strictly greater/);

  // 9. Timestamp expired past (>60s)
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now() - 65000, nonce: 200 }, 'peer-d');
  }, /Timestamp expired/);

  // 10. Timestamp invalid future (>60s)
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: Date.now() + 65000, nonce: 200 }, 'peer-d');
  }, /Timestamp invalid/);

  // 11. Timestamp NaN / type safety
  assert.throws(() => {
    bob.validateWirePacket({ timestamp: NaN, nonce: 200 }, 'peer-d');
  }, /finite number/);

  // 12. Constant-time PoC verification with length guards
  const sig = alice.signProofOfCompute('shard-1', { out: 42 });
  assert.strictEqual(bob.verifyProofOfCompute('shard-1', { out: 42 }, sig, alice.publicKey), true);
  assert.strictEqual(bob.verifyProofOfCompute('shard-1', { out: 43 }, sig, alice.publicKey), false);
  assert.strictEqual(bob.verifyProofOfCompute('shard-1', { out: 42 }, 'short-sig', alice.publicKey), false);
  assert.strictEqual(bob.verifyProofOfCompute('shard-1', { out: 42 }, null, alice.publicKey), false);

  // 13. HKDF domain separation
  const keyEncryption = alice.deriveSessionKey(bob.publicKey, { info: 'open-side:v1:aes-256-gcm:session-key' });
  const keyControl = alice.deriveSessionKey(bob.publicKey, { info: 'open-side:v1:p2p:handshake-key' });
  assert.notStrictEqual(keyEncryption.toString('hex'), keyControl.toString('hex'));

  console.log('✅ All cryptographic hardening security verification cases passed.');
}

runSecurityTests();
```

### 5.3 Invalidation Conditions
This analysis will be invalidated if:
1. Node.js deprecates `crypto.timingSafeEqual` or changes its Buffer-only parameter requirement.
2. The protocol specification changes the default GCM IV length from 12 bytes to another length.
3. Outbound wire frames transition from JSON-serialized payloads to raw binary protobuf without updating payload validation.
