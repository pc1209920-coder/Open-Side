# Milestone 2 Integration Points & Wire Format Contracts Report

**Document Reference**: `.agents/teamwork/explorer_m2_3/handoff.md`  
**Author**: `explorer_m2_3` (Explorer Track)  
**Target File**: `src/crypto.js`  
**Downstream Modules**: `src/router.js`, `src/node.js`, `src/ledger.js`, `src/index.js`, `test/mesh.test.js`  
**Date**: 2026-11-10T05:38:00Z  
**Status**: COMPLETE (Hard Handoff)  

---

## 1. Observation

Direct observations and evidence gathered from the codebase and runtime environment:

### 1.1 Baseline Implementation Analysis (`src/crypto.js`)
Inspection of `c:\Users\pc120\Documents\REPO\src\crypto.js` (lines 1–42) revealed the following existing baseline implementation:
```javascript
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

### 1.2 Baseline Test Suite Expectations (`test/mesh.test.js`)
Inspection of `c:\Users\pc120\Documents\REPO\test\mesh.test.js` (lines 9–42) verified the exact invocations and assertions that MUST remain 100% backward compatible without regressions:
1. **Assertion 1 (ECDH Key Exchange)**:
   - Line 10–14:
     ```javascript
     const nodeA = new MeshCryptoEngine();
     const nodeB = new MeshCryptoEngine();
     const keyA = nodeA.deriveSharedKey(nodeB.publicKey);
     const keyB = nodeB.deriveSharedKey(nodeA.publicKey);
     assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'), 'Shared keys must match between peers');
     ```
   - *Requirement*: `deriveSharedKey(peerPublicKeyHex)` must accept single hex string parameter and return a 32-byte `Buffer`.
2. **Assertion 2 (Workload Partitioning)**:
   - Line 18–20: Uses `nodeA.nodeId` (40-char hex string) to instantiate `GridRouter`.
3. **Assertion 3 (AES-256-GCM Encryption/Decryption)**:
   - Line 24–26:
     ```javascript
     const encryptedPacket = nodeA.encryptShard(tasks[0], keyA);
     const decryptedPacket = nodeB.decryptShard(encryptedPacket, keyB);
     assert.deepStrictEqual(decryptedPacket.inputData, [1, 2], 'Decrypted payload must match input data');
     ```
   - *Requirement*: `encryptShard(payloadObj, sharedKeyBuffer)` must accept 2 arguments and return `{ iv, authTag, ciphertext, timestamp }`. Adding `nonce` or `epoch` to the returned object is non-breaking. `decryptShard(encryptedPacket, sharedKeyBuffer)` must accept 2 arguments and return the exact parsed JSON payload (`tasks[0]`).
4. **Assertion 5 (Proof-of-Compute)**:
   - Line 36–38:
     ```javascript
     const proof = nodeB.signProofOfCompute(tasks[0].shardId, execResult.output);
     assert.strictEqual(typeof proof, 'string', 'Proof must be an HMAC string');
     assert.strictEqual(proof.length, 64, 'SHA-256 HMAC must be 64 characters hex');
     ```
   - *Requirement*: `signProofOfCompute(shardId, resultData)` must accept 2 arguments and return a 64-character lowercase hex string.

### 1.3 Baseline Router Usages (`src/router.js`)
Inspection of `c:\Users\pc120\Documents\REPO\src\router.js` shows:
- Line 29: Shard ID generation uses SHA-256 truncated to 40 characters:
  `crypto.createHash('sha256').update(`${taskCode}:${JSON.stringify(chunk)}:${i}`).digest('hex').slice(0, 40)`
- Line 9–17: `registerPeer(peerNodeId, publicKey, telemetry)` expects `peerNodeId` to be a 40-char string matching `crypto.nodeId`, and `publicKey` to be a 130-char hex string.

### 1.4 End-to-End Simulation Usages (`src/index.js`)
Inspection of `c:\Users\pc120\Documents\REPO\src\index.js` shows:
- Lines 16–23: Directly calls `deriveSharedKey`, `encryptShard`, `decryptShard`, and `signProofOfCompute`.

### 1.5 Node.js Runtime Cryptographic Behavior Verification
Direct verification of Node.js v24.22.1 using `run_command`:
```powershell
node -e "const crypto = require('node:crypto'); const res = crypto.hkdfSync('sha512', Buffer.from('secret'), Buffer.from('salt'), 'info', 32); console.log(res.constructor.name, Buffer.isBuffer(res), Buffer.from(res) instanceof Buffer);"
```
Output:
`ArrayBuffer false true`
*Observation*: `crypto.hkdfSync` returns an `ArrayBuffer`, NOT a `Buffer`. To satisfy the contract requirement ("Returns 32-byte `Buffer` via `crypto.hkdfSync('sha512', ...)`"), the result MUST be wrapped with `Buffer.from(derived)`.

---

## 2. Logic Chain

From the observations, the integration points and wire contracts are synthesized through the following deductive steps:

### 2.1 Backward Compatibility Invariant
1. In `test/mesh.test.js` and `src/index.js`, calls to `deriveSharedKey(peerPublicKeyHex)`, `encryptShard(payloadObj, sharedKeyBuffer)`, `decryptShard(encryptedPacket, sharedKeyBuffer)`, and `signProofOfCompute(shardId, resultData)` pass baseline argument lists without optional parameters.
2. Therefore:
   - `deriveSharedKey(peerPublicKeyHex)` must remain untouched and return `crypto.createHash('sha256').update(rawSecret).digest()`.
   - `deriveSessionKey(peerPublicKeyHex, options)` is introduced as a dedicated additive method for HKDF-SHA512 session derivation.
   - `encryptShard(payloadObj, sharedKeyBuffer, options = {})` retains its first two positional parameters. If `options.nonce` is omitted, it automatically assigns `this.outboundNonce++`. If `options.timestamp` is omitted, it assigns `Date.now()`.
   - `decryptShard(encryptedPacket, sharedKeyBuffer, options = {})` retains its first two positional parameters. Replay validation via `validateWirePacket` is opt-in via `options.validateReplay === true` (or when `options.senderId` is supplied). If `options` is omitted (baseline mode), it performs decryption without throwing replay errors.
   - `signProofOfCompute(shardId, resultData, secret = this.publicKey)` defaults `secret` to `this.publicKey`, guaranteeing that two-argument calls produce the identical HMAC as baseline.

### 2.2 Wire Architecture & Framing Protocol
1. TCP provides an unstructured byte stream. In live P2P networking (`src/node.js`), chunks may arrive fragmented or concatenated.
2. To prevent framing corruptions without external binary serializers, the wire protocol establishes a two-layer structure:
   - **Outer Wire Message (`WireMessage`)**: JSON-encoded, terminated by newline delimiter `\n` (`NDJSON`). Carries transport routing metadata (`version`, `type`, `senderId`, `recipientId`, `nonce`, `timestamp`, `payload`).
   - **Inner Encrypted Payload (`EncryptedShardEnvelope` / `EncryptedResultEnvelope`)**: Placed inside `payload` when `type` is `SHARD_DISPATCH` or `SHARD_RESULT`. Contains AES-256-GCM fields (`iv`, `authTag`, `ciphertext`, `nonce`, `timestamp`, `epoch`).

### 2.3 Ephemeral ECDH & HKDF-SHA512 Session Key Rotation Contract
1. During P2P connection establishment (`HANDSHAKE` / `HANDSHAKE_ACK`):
   - Node A exchanges its uncompressed EC public key (`04...`, 130 hex characters) with Node B.
   - Both nodes compute the identical raw ECDH shared secret:
     $$S_{\text{raw}} = \text{ECDH}_{\text{prime256v1}}(\text{priv}_A, \text{pub}_B) = \text{ECDH}_{\text{prime256v1}}(\text{priv}_B, \text{pub}_A)$$
2. To achieve cryptographic domain separation and allow seamless key rotation across epochs without new handshakes:
   - Salt: Computed symmetrically as `crypto.createHash('sha256').update([nodeA.nodeId, nodeB.nodeId].sort().join(':')).digest()`. Because both nodes sort their IDs lexically, both sides compute the exact same 32-byte salt regardless of who initiated the connection.
   - Info: Formatted as `open-side-v1-session-key-epoch:${epoch}` where `epoch` is an integer ($0, 1, 2, \dots$).
   - Output Keying Material: 32 bytes derived via `crypto.hkdfSync('sha512', rawSecret, salt, info, 32)`.
   - Wrapping: `Buffer.from(derived)` ensures standard Node.js `Buffer` compatibility for AES-256-GCM ciphers.

### 2.4 Monotonic Anti-Replay Nonce & Timestamp Window Contract
1. To defeat packet injection and replay attacks:
   - Each `MeshCryptoEngine` maintains `this.outboundNonce = 1`.
   - Every outgoing wire packet increments this counter: `nonce = this.outboundNonce++`.
   - The engine maintains per-peer replay states: `this.peerReplayWindows = new Map<string, { lastNonce: number, seenNonces: Set<number> }>()`.
2. Validation via `validateWirePacket(packet, peerNodeId)`:
   - **Timestamp Check**: Rejects if `typeof packet.timestamp !== 'number'`, `isNaN(packet.timestamp)`, or $|t_{\text{now}} - packet.timestamp| > 60,000 \text{ ms}$ ($\pm 60 \text{ s}$ clock skew window).
   - **Nonce Integrity**: Rejects if `!Number.isSafeInteger(packet.nonce)` or `packet.nonce < 1`.
   - **Replay / Monotonicity**: Rejects if `packet.nonce <= peerState.lastNonce` (or duplicate within sliding window).
   - Returns `true` if valid and updates `peerState.lastNonce = packet.nonce`; returns `false` (or throws `Error` if called in strict mode) if validation fails.

### 2.5 Proof-of-Compute Verification & Ledger Settlement Contract
1. Workers compute HMAC-SHA256 over `${shardId}:${JSON.stringify(resultData)}` using `signProofOfCompute(shardId, resultData, workerPublicKey)`.
2. The economic ledger (`src/ledger.js`) verifies the attestation prior to settling credits:
   - `verifyProofOfCompute(shardId, resultData, signature, secret)`:
     - Input guard: `if (typeof signature !== 'string' || signature.length !== 64) return false;`
     - Computes `expectedHmac = crypto.createHmac('sha256', secret).update(...).digest('hex')`.
     - Length check: `expectedBuf.length !== actualBuf.length` (guard against `RangeError` in `crypto.timingSafeEqual`).
     - Constant-time equality: `crypto.timingSafeEqual(Buffer.from(expectedHmac, 'hex'), Buffer.from(signature, 'hex'))`.
3. Double-Spend Defense:
   - Ledger checks `this.settledAttestations.has(attestationKey)` where `attestationKey = crypto.createHash('sha256').update(`${workerNodeId}:${shardId}:${proofOfCompute}`).digest('hex')`.
   - Re-submission of an identical attestation throws `DoubleSpendError` and results in 0 credits issued.

---

## 3. Caveats

1. **AAD (Additional Authenticated Data) Compatibility**:
   - AES-256-GCM supports AAD via `cipher.setAAD()` and `decipher.setAAD()`. If AAD is set on encryption, the exact same AAD must be provided on decryption, or decryption fails with `Unsupported state or unable to authenticate data`.
   - To preserve backward compatibility with baseline tests (`test/mesh.test.js`) where no AAD is passed, AAD support must be **optional**: only apply `cipher.setAAD()` if `options.aad` is explicitly provided.
2. **Node.js `crypto.hkdfSync` Return Type**:
   - `crypto.hkdfSync` in Node.js returns an `ArrayBuffer`, not a `Buffer`. Directly passing an `ArrayBuffer` into `crypto.createCipheriv` can fail or produce runtime type errors. Always wrap with `Buffer.from(hkdfResult)`.
3. **Clock Skew in Distributed Environments**:
   - The $\pm 60,000 \text{ ms}$ timestamp validation window relies on basic NTP synchronization between peers. For unit testing, `Date.now()` is synchronous, but mock timestamp testing must respect the 60-second boundary.
4. **Safe Integer Range for Sequence Nonces**:
   - While `outboundNonce` starts at 1 and increases by 1 per packet, JavaScript `Number` precision degrades beyond `Number.MAX_SAFE_INTEGER` ($2^{53} - 1$). The validator must verify `Number.isSafeInteger(nonce)`.

---

## 4. Conclusion & Concrete Wire Specification

### 4.1 Updated `src/crypto.js` Public API Blueprint

```typescript
class MeshCryptoEngine {
  ecdh: crypto.ECDH;
  publicKey: string;              // 130-char hex uncompressed EC point ('04...')
  nodeId: string;                 // 40-char hex (sha256(publicKey).slice(0, 40))
  outboundNonce: number;          // Monotonic sequence counter starting at 1
  peerReplayWindows: Map<string, { lastNonce: number, seenNonces: Set<number> }>;

  constructor();

  // Baseline backward-compatible (SHA-256 raw secret)
  deriveSharedKey(peerPublicKeyHex: string): Buffer;

  // Ultra Cryptography M2: HKDF-SHA512 key derivation & rotation
  deriveSessionKey(
    peerPublicKeyHex: string,
    options?: {
      epoch?: number;
      salt?: Buffer | string;
      info?: Buffer | string;
      keylen?: number;
    }
  ): Buffer;

  // Authenticated encryption (backward-compatible + options)
  encryptShard(
    payloadObj: any,
    sharedKeyBuffer: Buffer,
    options?: {
      nonce?: number;
      timestamp?: number;
      epoch?: number;
      aad?: Buffer | string;
    }
  ): {
    iv: string;         // 24-char hex (12 bytes)
    authTag: string;    // 32-char hex (16 bytes)
    ciphertext: string; // Hex string
    timestamp: number;  // Epoch ms
    nonce: number;      // Sequence integer
    epoch: number;      // Rotation epoch (default: 0)
  };

  // Authenticated decryption (backward-compatible + options)
  decryptShard(
    encryptedPacket: {
      iv: string;
      authTag: string;
      ciphertext: string;
      timestamp?: number;
      nonce?: number;
      epoch?: number;
    },
    sharedKeyBuffer: Buffer,
    options?: {
      validateReplay?: boolean;
      senderId?: string;
      aad?: Buffer | string;
    }
  ): any;

  // Replay & timestamp validator
  validateWirePacket(
    packet: { timestamp: number; nonce: number },
    peerNodeId: string
  ): boolean;

  // Deterministic PoC signature (defaults to this.publicKey)
  signProofOfCompute(
    shardId: string,
    resultData: any,
    secret?: string | Buffer
  ): string;

  // Constant-time PoC verification with length guard
  verifyProofOfCompute(
    shardId: string,
    resultData: any,
    signature: string,
    secret?: string | Buffer
  ): boolean;
}
```

### 4.2 Exact Wire Envelopes (JSON Schemas)

#### Envelope 1: Live P2P Transport Framing (`WireMessage<T>`)
Every TCP message sent over the wire is terminated with `\n` (NDJSON):
```json
{
  "version": "1.0.0",
  "type": "HANDSHAKE | HANDSHAKE_ACK | SHARD_DISPATCH | SHARD_RESULT | HEARTBEAT | ERROR",
  "senderId": "<40-char hex string>",
  "recipientId": "<40-char hex string>",
  "nonce": 1,
  "timestamp": 1762752740000,
  "payload": {}
}
```

#### Envelope 2: `HANDSHAKE` / `HANDSHAKE_ACK` Payload
```json
{
  "publicKey": "<130-char hex uncompressed EC public key>",
  "epoch": 0
}
```

#### Envelope 3: `SHARD_DISPATCH` Payload (`EncryptedShardEnvelope`)
```json
{
  "iv": "3a4b5c6d7e8f9a0b1c2d3e4f",
  "authTag": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "ciphertext": "8f3a9b2c...",
  "nonce": 2,
  "timestamp": 1762752740050,
  "epoch": 0
}
```
*Decrypted Plaintext Structure*:
```json
{
  "shardId": "7c9f2a4b1d3e5f6a8b0c2d4e6f8a0b2c4d6e8f0a",
  "index": 0,
  "taskCode": "return data.reduce((a, b) => a + b, 0);",
  "inputData": [1, 2]
}
```

#### Envelope 4: `SHARD_RESULT` Payload (`EncryptedResultEnvelope`)
```json
{
  "iv": "5f6e7d8c9b0a1f2e3d4c5b6a",
  "authTag": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c",
  "ciphertext": "e4d3c2b1...",
  "nonce": 2,
  "timestamp": 1762752740120,
  "epoch": 0
}
```
*Decrypted Plaintext Structure*:
```json
{
  "shardId": "7c9f2a4b1d3e5f6a8b0c2d4e6f8a0b2c4d6e8f0a",
  "index": 0,
  "output": 3,
  "executionMetrics": {
    "executionTimeMs": 14.5,
    "inputSize": 2
  },
  "proofOfCompute": "b1a2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
  "workerNodeId": "b8e1f2a3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
  "workerPublicKey": "04f9e8d7c6b5a4...",
  "nonce": 2,
  "timestamp": 1762752740120
}
```

### 4.3 Downstream Consumer Integration Matrix

| Consumer File | Method / Field Called | Argument Contract | Invariant & Handling |
|---|---|---|---|
| `test/mesh.test.js` | `deriveSharedKey(pubKey)` | `(string)` | Returns 32-byte Buffer; identical keys for paired peers. |
| `test/mesh.test.js` | `encryptShard(task, key)` | `(object, Buffer)` | Returns `{ iv, authTag, ciphertext, timestamp, nonce, epoch }`. |
| `test/mesh.test.js` | `decryptShard(packet, key)` | `(object, Buffer)` | Decrypts without error; matches input. |
| `test/mesh.test.js` | `signProofOfCompute(id, res)` | `(string, any)` | Returns 64-char hex HMAC using `this.publicKey`. |
| `src/router.js` | `nodeId`, `publicKey` | Properties on instance | Used for peer registration and telemetry matching. |
| `src/node.js` | `deriveSessionKey(pubKey, opts)` | `(string, object)` | Symmetrical HKDF-SHA512 session key rotation per epoch. |
| `src/node.js` | `validateWirePacket(pkt, peerId)` | `(object, string)` | Drops packet if timestamp drift >60s or nonce $\le$ last seen. |
| `src/ledger.js` | `verifyProofOfCompute(id, res, sig, key)` | `(string, any, string, string)` | Uses `timingSafeEqual` with length check to verify attestation. |
| `src/ledger.js` | Double-spend prevention | SHA-256 hash | Attestation key `sha256(workerId + shardId + proof)` tracked in `Set`. |

---

## 5. Verification Method

To independently verify the observations, wire format contracts, and backward compatibility invariants:

1. **Verify Baseline Test Suite Execution**:
   ```powershell
   npm test
   ```
   *Expected Result*: All 5 baseline tests pass with exit code 0.

2. **Verify Node Syntax on Core Files**:
   ```powershell
   node --check src/index.js src/crypto.js src/sandbox.js src/router.js
   ```
   *Expected Result*: Exit code 0, no syntax errors.

3. **Verify Symmetrical HKDF-SHA512 Session Derivation**:
   ```powershell
   node -e "const crypto = require('node:crypto');
   const a = crypto.createECDH('prime256v1'); a.generateKeys();
   const b = crypto.createECDH('prime256v1'); b.generateKeys();
   const aPub = a.getPublicKey('hex'); const bPub = b.getPublicKey('hex');
   const aId = crypto.createHash('sha256').update(aPub).digest('hex').slice(0, 40);
   const bId = crypto.createHash('sha256').update(bPub).digest('hex').slice(0, 40);
   const saltA = crypto.createHash('sha256').update([aId, bId].sort().join(':')).digest();
   const saltB = crypto.createHash('sha256').update([bId, aId].sort().join(':')).digest();
   const secA = a.computeSecret(bPub, 'hex');
   const secB = b.computeSecret(aPub, 'hex');
   const keyA = Buffer.from(crypto.hkdfSync('sha512', secA, saltA, 'open-side-v1-session-key-epoch:0', 32));
   const keyB = Buffer.from(crypto.hkdfSync('sha512', secB, saltB, 'open-side-v1-session-key-epoch:0', 32));
   assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'), 'Keys must match symmetrically');
   assert.strictEqual(keyA.length, 32, 'Key must be 32 bytes');
   console.log('✔ Symmetrical HKDF-SHA512 session key derivation verified');"
   ```

4. **Verify Wire Envelope Roundtrip with Fresh 12-byte IV & 16-byte Tag**:
   ```powershell
   node -e "const crypto = require('node:crypto');
   const key = crypto.randomBytes(32);
   const iv = crypto.randomBytes(12);
   const payload = { shardId: 'shard-001', inputData: [1, 2] };
   const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
   let ct = cipher.update(JSON.stringify(payload), 'utf8', 'hex') + cipher.final('hex');
   const tag = cipher.getAuthTag();
   const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
   decipher.setAuthTag(tag);
   let pt = decipher.update(ct, 'hex', 'utf8') + decipher.final('utf8');
   assert.deepStrictEqual(JSON.parse(pt), payload);
   console.log('✔ AES-256-GCM wire envelope roundtrip verified');"
   ```

5. **Verify Constant-Time PoC Verification with Length Guards**:
   ```powershell
   node -e "const crypto = require('node:crypto');
   const secret = 'test-secret';
   const hmac = crypto.createHmac('sha256', secret).update('shard-1:{\"output\":42}').digest('hex');
   const buf1 = Buffer.from(hmac, 'hex');
   const buf2 = Buffer.from(hmac, 'hex');
   assert.strictEqual(buf1.length === buf2.length && crypto.timingSafeEqual(buf1, buf2), true);
   const forged = Buffer.from('deadbeef', 'hex');
   assert.strictEqual(buf1.length === forged.length && crypto.timingSafeEqual(buf1, forged), false);
   console.log('✔ Constant-time PoC verification with length guards verified');"
   ```
