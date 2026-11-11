# Open-Side Universal Protocol Standard — Test Infrastructure & 4-Tier E2E Test Suite Specification

## 1. Executive Summary & Test Infrastructure Overview

Open-Side is a hardware-agnostic, decentralized P2P compute backbone designed to pool idle standby compute into a zero-trust, encrypted execution mesh. Because Open-Side coordinates untrusted hardware executing arbitrary sandboxed computation over live networks with economic settlement, the verification architecture must provide non-negotiable guarantees of cryptographic integrity, sandboxed isolation, fail-closed stability, and deterministic execution.

This document establishes the authoritative **Test Infrastructure Architecture, Philosophy, and 4-Tier Test Suite Design** for the Open-Side protocol standard. It governs all verification activities across Milestones M1 through M7 and provides complete, requirement-driven test coverage across all **32 features** defined in `PROJECT.md`.

### Core Architectural Metrics
- **Total Protocol Features in Scope**: 32 features (Features 1 through 32 across Milestones M1–M6)
- **Baseline Invariants Preserved**: 5/5 baseline invariants in `test/mesh.test.js`
- **Verification Assertions Covered**: R1 through R7
- **Tier 1 (Feature Coverage)**: 160 test specifications (5 per feature $\times$ 32 features)
- **Tier 2 (Boundary & Corner Cases)**: 160 test specifications (5 per feature $\times$ 32 features)
- **Tier 3 (Cross-Feature Interactions)**: 16 pairwise and multi-module interaction flows
- **Tier 4 (Real-World Workloads)**: 5 distributed compute grid simulations
- **Test Runtime**: Native Node.js test runner (`node:test`, `node:assert/strict`) with **zero** external npm dependencies

---

## 2. Test Philosophy & Design Principles

### 2.1 Requirement-Driven & Opaque-Box Testing
All test cases are derived strictly from protocol specifications, interface contracts (`PROJECT.md`), and functional requirements (`ORIGINAL_REQUEST.md`). The test harness treats modules as opaque boxes with defined contracts, exercising public APIs, socket streams, wire encodings, and error responses without relying on private implementation internals. This guarantees tests survive internal refactoring while aggressively catching behavioral regressions.

### 2.2 Zero External Test Dependencies
In accordance with R1, Open-Side strictly prohibits third-party npm runtime and test dependencies. The test harness relies exclusively on native Node.js core modules:
- `node:test` (`test`, `describe`, `it`, `before`, `after`, `beforeEach`, `afterEach`) for test lifecycle orchestration and asynchronous test scheduling.
- `node:assert/strict` (`assert.strictEqual`, `assert.deepStrictEqual`, `assert.throws`, `assert.rejects`, `assert.match`, `assert.ok`) for strict invariant assertions.
- Native Node.js core libraries (`node:crypto`, `node:vm`, `node:net`, `node:os`, `node:worker_threads`, `node:buffer`, `node:events`).

### 2.3 Authoritative Expected Output Derivation
For every test case, expected values are derived from mathematical ground truth, cryptographic standards, or reference algorithmic definitions:
1. **Cryptographic Primitives**: NIST SP 800-56A (ECDH `prime256v1`), RFC 5869 (HKDF-SHA512), NIST SP 800-38D (AES-256-GCM with 12-byte IV and 16-byte tag), and RFC 2104 (HMAC-SHA256).
2. **Deterministic Computations**: Monolithic reference execution in standard V8 JavaScript compared directly against sandboxed and partitioned outputs.
3. **Telemetry & Gating**: Fixed mathematical ratios against known system states and injected deterministic telemetry mocks.
4. **Economic Ledger**: Deterministic arithmetic credit formulas: $\text{Credit} = f(T_{\text{ms}}, \text{InputSize})$ validated against ledger balance conservation invariants ($\sum \Delta \text{Balances} = 0$).

### 2.4 Strict Fail-Closed Verification
Where protocol conditions violate bounds (e.g. CPU > 25%, memory floor < 10%, expired timestamps > $\pm 60\text{ s}$, invalid nonces, unauthorized AST tokens, tampered ciphertexts, or insufficient credit balances), the test suite strictly enforces fail-closed behavior: operations must reject, return empty sets, throw explicit domain errors, or pause safely. Silent degradation or permissive fallbacks are treated as critical security failures.

---

## 3. Test Architecture & Runner Harness

### 3.1 Harness Execution Architecture
The test suite is structured to execute directly via the repository's standard npm script:
```bash
npm test
```
Which maps to:
```bash
node --test test/mesh.test.js
```
The test suite can also be executed directly as a standalone script:
```bash
node test/mesh.test.js
```
To achieve dual compatibility, `test/mesh.test.js` imports `test` and `assert` from `node:test` and `node:assert/strict`. When invoked directly or via `node --test`, Node.js's native test runner automatically detects the test definitions and outputs structured TAP/spec reports with appropriate process exit codes (0 for pass, 1 for failure).

### 3.2 Dynamic Resource Isolation & Ephemeral Loopback Binding
To guarantee complete isolation between test runs and prevent port collisions in CI or local developer machines:
- **P2P Node Daemons**: Bind dynamically to `127.0.0.1` on port `0`. The operating system assigns an available ephemeral port, which is retrieved via `server.address().port`.
- **IPC Support**: On Windows environments, named pipe identifiers use randomized UUIDs (`\\.\\pipe\\openside-test-${crypto.randomUUID()}`); on POSIX, temporary domain sockets in `os.tmpdir()` are used.
- **Worker Thread Teardown**: Worker threads spawned for memory-capped shard execution are terminated in `afterEach` hooks or guaranteed termination promises to prevent unhandled process hangs.
- **Deterministic Teardown**: All active sockets and servers implement `node.close()` returning promises that wait for the `close` event, ensuring zero socket leaks.

### 3.3 Preservation of the 5 Baseline Invariants
The 5 foundational baseline assertions established in Open-Side v0.4.2 are retained in their exact semantic form as the initial verification stage:
1. **Invariant 1 (ECDH Exchange)**: `nodeA.deriveSharedKey(nodeB.publicKey).toString('hex') === nodeB.deriveSharedKey(nodeA.publicKey).toString('hex')`
2. **Invariant 2 (Workload Partitioning)**: `router.createTaskPartitions(code, [1, 2, 3, 4], 2).length === 2`
3. **Invariant 3 (AES-256-GCM Transfer)**: `decryptedPacket.inputData` deep equals `[1, 2]`
4. **Invariant 4 (Sandbox Computation)**: `sandbox.executeIsolatedShard(decryptedPacket).output === 3`
5. **Invariant 5 (Proof-of-Compute)**: `nodeB.signProofOfCompute(shardId, output)` returns a 64-character hexadecimal SHA-256 HMAC string

---

## 4. Complete Feature Inventory Coverage Matrix (Features 1–32)

| Feature # | Feature Name | Milestone | Req ID | Target Module | Tier 1 Tests | Tier 2 Tests | Tier 3 Pairs | Tier 4 Scenario |
|---|---|---|---|---|---|---|---|---|
| **F01** | Zero-Dependency Module Architecture | M1 | R1 | CommonJS / Root | 5 | 5 | F01 $\times$ F02, F01 $\times$ F24 | S4.1, S4.5 |
| **F02** | 5-Stage Mesh Protocol Baseline Verification | M1 | R1 | `test/mesh.test.js` | 5 | 5 | F02 $\times$ F03, F02 $\times$ F15 | S4.1 |
| **F03** | Ephemeral ECDH Key Generation | M2 | R3 | `src/crypto.js` | 5 | 5 | F03 $\times$ F04, F03 $\times$ F27 | S4.1, S4.4 |
| **F04** | HKDF-SHA512 Key Derivation & Rotation | M2 | R3 | `src/crypto.js` | 5 | 5 | F04 $\times$ F05, F04 $\times$ F27 | S4.1, S4.4 |
| **F05** | Authenticated AES-256-GCM Encryption | M2 | R3 | `src/crypto.js` | 5 | 5 | F05 $\times$ F06, F05 $\times$ F28 | S4.1, S4.4 |
| **F06** | Authenticated AES-256-GCM Decryption | M2 | R3 | `src/crypto.js` | 5 | 5 | F06 $\times$ F07, F06 $\times$ F28 | S4.4 |
| **F07** | Monotonic Anti-Replay Nonces | M2 | R3 | `src/crypto.js` | 5 | 5 | F07 $\times$ F08, F07 $\times$ F27 | S4.4 |
| **F08** | Timestamp Window Drift Validation | M2 | R3 | `src/crypto.js` | 5 | 5 | F08 $\times$ F07, F08 $\times$ F26 | S4.4 |
| **F09** | Deterministic HMAC-SHA256 PoC Attestation | M2 | R3 | `src/crypto.js` | 5 | 5 | F09 $\times$ F10, F09 $\times$ F29 | S4.1, S4.5 |
| **F10** | Constant-Time PoC Signature Verification | M2 | R3 | `src/crypto.js` | 5 | 5 | F10 $\times$ F09, F10 $\times$ F30 | S4.4 |
| **F11** | Cross-Platform CPU Delta Telemetry | M3 | R2 | `src/router.js` | 5 | 5 | F11 $\times$ F13, F11 $\times$ F16 | S4.2 |
| **F12** | Free Memory Headroom Tracker | M3 | R2 | `src/router.js` | 5 | 5 | F12 $\times$ F14, F12 $\times$ F16 | S4.2 |
| **F13** | Strict 25% CPU Fail-Closed Gating | M3 | R2 | `src/router.js` | 5 | 5 | F13 $\times$ F16, F13 $\times$ F17 | S4.2 |
| **F14** | Memory Floor Fail-Closed Gating | M3 | R2 | `src/router.js` | 5 | 5 | F14 $\times$ F16, F14 $\times$ F17 | S4.2 |
| **F15** | Dynamic Task Partitioning | M3 | R2 | `src/router.js` | 5 | 5 | F15 $\times$ F05, F15 $\times$ F28 | S4.1, S4.5 |
| **F16** | Fail-Closed Peer Selection & Scoring | M3 | R2 | `src/router.js` | 5 | 5 | F16 $\times$ F17, F16 $\times$ F24 | S4.1, S4.2 |
| **F17** | Bounded Task Queue & Rescheduling | M3 | R2 | `src/router.js` | 5 | 5 | F17 $\times$ F16, F17 $\times$ F28 | S4.2 |
| **F18** | AST / Static Token Pre-Validator | M4 | R4 | `src/sandbox.js` | 5 | 5 | F18 $\times$ F19, F18 $\times$ F20 | S4.3 |
| **F19** | Escape Sequence Normalizer | M4 | R4 | `src/sandbox.js` | 5 | 5 | F19 $\times$ F18, F19 $\times$ F20 | S4.3 |
| **F20** | Zero-Privilege VM Isolation Boundary | M4 | R4 | `src/sandbox.js` | 5 | 5 | F20 $\times$ F21, F20 $\times$ F23 | S4.3 |
| **F21** | Millisecond Execution Timeout Guard | M4 | R4 | `src/sandbox.js` | 5 | 5 | F21 $\times$ F20, F21 $\times$ F22 | S4.3 |
| **F22** | Worker Threads Memory Resource Limits | M4 | R4 | `src/sandbox.js` | 5 | 5 | F22 $\times$ F20, F22 $\times$ F21 | S4.3 |
| **F23** | Deterministic State Virtualization | M4 | R4 | `src/sandbox.js` | 5 | 5 | F23 $\times$ F09, F23 $\times$ F20 | S4.1, S4.5 |
| **F24** | Native P2P TCP Daemon (`src/node.js`) | M5 | R5 | `src/node.js` | 5 | 5 | F24 $\times$ F25, F24 $\times$ F26 | S4.1, S4.2 |
| **F25** | Ephemeral Loopback Dynamic Port Binding | M5 | R5 | `src/node.js` | 5 | 5 | F25 $\times$ F24, F25 $\times$ F27 | S4.1 |
| **F26** | Length-Prefixed / Delimited Stream Framing | M5 | R5 | `src/node.js` | 5 | 5 | F26 $\times$ F27, F26 $\times$ F28 | S4.1, S4.4 |
| **F27** | Live Ephemeral ECDH Wire Handshake | M5 | R5 | `src/node.js` | 5 | 5 | F27 $\times$ F04, F27 $\times$ F28 | S4.1, S4.4 |
| **F28** | Encrypted Shard Streaming & Result Return | M5 | R5 | `src/node.js` | 5 | 5 | F28 $\times$ F20, F28 $\times$ F29 | S4.1, S4.5 |
| **F29** | Proof-of-Compute Work Metering | M6 | R6 | `src/ledger.js` | 5 | 5 | F29 $\times$ F30, F29 $\times$ F31 | S4.1, S4.5 |
| **F30** | Anti-Replay Double-Spend Prevention | M6 | R6 | `src/ledger.js` | 5 | 5 | F30 $\times$ F09, F30 $\times$ F31 | S4.4, S4.5 |
| **F31** | Fail-Closed Account Balance Enforcement | M6 | R6 | `src/ledger.js` | 5 | 5 | F31 $\times$ F29, F31 $\times$ F16 | S4.5 |
| **F32** | Comprehensive Verification Suite (100% Pass) | M6 | R7 | Root Runner | 5 | 5 | F32 $\times$ F01-F31 | S4.1-S4.5 |

---

## 5. Tier 1: Feature Coverage Specifications (All 32 Features)

Tier 1 mandates at least 5 distinct, primary-behavior test cases for every feature in the feature inventory.

### Feature 1: Zero-Dependency Module Architecture (CommonJS & Native APIs)
- **T1.F01.01**: Verify `package.json` contains no runtime `dependencies` or external test dependencies.
  - *Input*: `require('../package.json')`
  - *Expected*: `pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0`
  - *Assertion*: `assert.strictEqual(Object.keys(pkg.dependencies || {}).length, 0)`
- **T1.F01.02**: Verify all modules export CommonJS classes and functions cleanly.
  - *Input*: `require('../src/crypto')`, `require('../src/router')`, `require('../src/sandbox')`, `require('../src/node')`, `require('../src/ledger')`
  - *Expected*: Defined constructors `MeshCryptoEngine`, `GridRouter`, `StandbySandbox`, `P2PNode`, `ProofOfComputeLedger`.
  - *Assertion*: `assert.strictEqual(typeof MeshCryptoEngine, 'function')`, etc.
- **T1.F01.03**: Verify core imports utilize exclusively `node:` protocol native modules.
  - *Input*: Inspect source files via AST or regex for non-native require calls.
  - *Expected*: Only `node:crypto`, `node:vm`, `node:net`, `node:os`, `node:worker_threads`, `node:assert`, `node:test`, `node:events`, `node:buffer` imported.
  - *Assertion*: No foreign package imports detected.
- **T1.F01.04**: Verify syntax cleanliness across all source files via `node --check`.
  - *Input*: Spawn `node --check` against `src/*.js`.
  - *Expected*: Exit code 0, empty stderr.
  - *Assertion*: `assert.strictEqual(child.status, 0)`
- **T1.F01.05**: Verify runtime execution under Node.js v18+ without experimental flags.
  - *Input*: Check `process.versions.node` and standard V8 features.
  - *Expected*: Major version $\ge 18$.
  - *Assertion*: `assert.ok(parseInt(process.versions.node.split('.')[0]) >= 18)`

### Feature 2: 5-Stage Mesh Protocol Verification
- **T1.F02.01**: Execute Stage 1 baseline ECDH key exchange.
  - *Input*: Two `MeshCryptoEngine` instances.
  - *Expected*: `keyA.toString('hex') === keyB.toString('hex')`.
  - *Assertion*: Exact match of 32-byte shared secrets.
- **T1.F02.02**: Execute Stage 2 dynamic task partitioning.
  - *Input*: Task `'return data.reduce((a, b) => a + b, 0);'`, dataset `[1, 2, 3, 4]`, chunkSize 2.
  - *Expected*: Array of length 2 with valid `shardId`, `index`, and `inputData`.
  - *Assertion*: `assert.strictEqual(tasks.length, 2)`
- **T1.F02.03**: Execute Stage 3 AES-256-GCM payload encryption and decryption.
  - *Input*: Encrypt `tasks[0]` with `keyA`, decrypt with `keyB`.
  - *Expected*: Decrypted `inputData` strictly equals `[1, 2]`.
  - *Assertion*: `assert.deepStrictEqual(decrypted.inputData, [1, 2])`
- **T1.F02.04**: Execute Stage 4 Isolated V8 VM sandbox execution.
  - *Input*: Run decrypted shard through `StandbySandbox.executeIsolatedShard`.
  - *Expected*: Math sum output equals `3`.
  - *Assertion*: `assert.strictEqual(execResult.output, 3)`
- **T1.F02.05**: Execute Stage 5 HMAC-SHA256 Proof-of-Compute signature.
  - *Input*: `nodeB.signProofOfCompute(tasks[0].shardId, execResult.output)`.
  - *Expected*: 64-character hexadecimal HMAC string.
  - *Assertion*: `assert.strictEqual(proof.length, 64)`

### Feature 3: Ephemeral ECDH Key Generation
- **T1.F03.01**: Verify initialization produces valid uncompressed EC public key on `prime256v1`.
  - *Input*: `new MeshCryptoEngine()`.
  - *Expected*: Hex string starting with `04` having length 130 characters (65 bytes uncompressed).
  - *Assertion*: `assert.strictEqual(engine.publicKey.length, 130)` and `assert.ok(engine.publicKey.startsWith('04'))`
- **T1.F03.02**: Verify deterministic derivation of 40-character `nodeId`.
  - *Input*: `crypto.createHash('sha256').update(engine.publicKey).digest('hex').slice(0, 40)`.
  - *Expected*: Matches `engine.nodeId`.
  - *Assertion*: `assert.strictEqual(engine.nodeId.length, 40)` and hex equality.
- **T1.F03.03**: Verify unique key generation across successive instances (ephemeral property).
  - *Input*: 10 distinct `MeshCryptoEngine` instances.
  - *Expected*: 10 distinct public keys and 10 distinct node IDs.
  - *Assertion*: `new Set(keys).size === 10`.
- **T1.F03.04**: Verify backward compatibility of `deriveSharedKey(peerPublicKey)`.
  - *Input*: Two instances invoking `deriveSharedKey`.
  - *Expected*: Returns 32-byte `Buffer` hashed via SHA-256 over raw ECDH secret.
  - *Assertion*: `assert.strictEqual(key.length, 32)`
- **T1.F03.05**: Verify initial outbound sequence nonce starts at 1.
  - *Input*: `engine.outboundNonce`.
  - *Expected*: Integer `1`.
  - *Assertion*: `assert.strictEqual(engine.outboundNonce, 1)`

### Feature 4: HKDF-SHA512 Key Derivation & Rotation
- **T1.F04.01**: Derive session key with default parameters via HKDF-SHA512.
  - *Input*: `engineA.deriveSessionKey(engineB.publicKey)`.
  - *Expected*: 32-byte `Buffer` matching derivation by `engineB`.
  - *Assertion*: `assert.strictEqual(keyA.length, 32)` and `assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'))`
- **T1.F04.02**: Verify key differentiation across distinct epoch salts.
  - *Input*: Derivations with `salt: 'epoch-1'` vs `salt: 'epoch-2'`.
  - *Expected*: Both produce valid 32-byte keys, but `keyEpoch1` !== `keyEpoch2`.
  - *Assertion*: `assert.notStrictEqual(keyEpoch1.toString('hex'), keyEpoch2.toString('hex'))`
- **T1.F04.03**: Verify context separation via `info` parameter.
  - *Input*: Derivations with `info: 'openside-wire-v1'` vs `info: 'openside-control-v1'`.
  - *Expected*: Cryptographically distinct session keys.
  - *Assertion*: `assert.notStrictEqual(key1.toString('hex'), key2.toString('hex'))`
- **T1.F04.04**: Verify variable session key length support (e.g. 64-byte key).
  - *Input*: `engine.deriveSessionKey(peerPub, { keylen: 64 })`.
  - *Expected*: 64-byte `Buffer`.
  - *Assertion*: `assert.strictEqual(longKey.length, 64)`
- **T1.F04.05**: Verify mathematical agreement with standard native `crypto.hkdfSync`.
  - *Input*: Manual computation using `crypto.hkdfSync('sha512', rawSecret, salt, info, 32)`.
  - *Expected*: Identical byte sequence.
  - *Assertion*: `assert.deepStrictEqual(sessionKey, oracleKey)`

### Feature 5: Authenticated AES-256-GCM Encryption
- **T1.F05.01**: Encrypt JSON object payload with valid 32-byte key.
  - *Input*: `engine.encryptShard({ task: 'compute', data: [1, 2, 3] }, sessionKey)`.
  - *Expected*: Object with hex strings `iv` (24 hex chars = 12 bytes), `authTag` (32 hex chars = 16 bytes), `ciphertext`, `timestamp`, `nonce`.
  - *Assertion*: `assert.strictEqual(packet.iv.length, 24)` and `assert.strictEqual(packet.authTag.length, 32)`
- **T1.F05.02**: Verify fresh random IV per encryption call.
  - *Input*: Encrypt identical payload twice with identical session key.
  - *Expected*: Two different IVs and two different ciphertexts.
  - *Assertion*: `assert.notStrictEqual(pkt1.iv, pkt2.iv)` and `assert.notStrictEqual(pkt1.ciphertext, pkt2.ciphertext)`
- **T1.F05.03**: Verify automatic increment of `outboundNonce`.
  - *Input*: Observe `engine.outboundNonce` before and after encryption.
  - *Expected*: Nonce increases monotonically by 1 per encrypted packet.
  - *Assertion*: `assert.strictEqual(pkt2.nonce, pkt1.nonce + 1)`
- **T1.F05.04**: Verify inclusion of valid wall-clock timestamp.
  - *Input*: `packet.timestamp`.
  - *Expected*: Number within 1000ms of `Date.now()`.
  - *Assertion*: `assert.ok(Math.abs(packet.timestamp - Date.now()) < 1000)`
- **T1.F05.05**: Verify encryption of complex nested structures and UTF-8 strings.
  - *Input*: Payload with unicode emojis, nested arrays, and boolean flags.
  - *Expected*: Valid ciphertext produced without serialization truncation.
  - *Assertion*: Successful encryption return structure.

### Feature 6: Authenticated AES-256-GCM Decryption
- **T1.F06.01**: Decrypt valid encrypted packet and reconstruct exact JSON payload.
  - *Input*: Decrypt packet from T1.F05.01 using recipient session key.
  - *Expected*: Deep equality with original payload object.
  - *Assertion*: `assert.deepStrictEqual(decrypted, originalPayload)`
- **T1.F06.02**: Fail-closed rejection of tampered ciphertext.
  - *Input*: Flip a single hex character in `packet.ciphertext`.
  - *Expected*: Decryption throws error (Bad authentication tag / decipher final failure).
  - *Assertion*: `assert.throws(() => engine.decryptShard(tamperedPacket, key))`
- **T1.F06.03**: Fail-closed rejection of tampered `authTag`.
  - *Input*: Invert byte in `packet.authTag`.
  - *Expected*: Decryption throws authentication failure.
  - *Assertion*: `assert.throws(() => engine.decryptShard(tamperedTagPacket, key))`
- **T1.F06.04**: Fail-closed rejection of mismatched decryption key.
  - *Input*: Decrypt valid packet using a different 32-byte key.
  - *Expected*: Decryption throws authentication failure.
  - *Assertion*: `assert.throws(() => engine.decryptShard(packet, wrongKey))`
- **T1.F06.05**: Decryption with AAD wire header binding verification.
  - *Input*: Encrypt with AAD `${packet.nonce}:${packet.timestamp}`; decrypt with valid AAD.
  - *Expected*: Smooth decryption; throwing if AAD is altered.
  - *Assertion*: Authenticated round-trip succeeds.

### Feature 7: Monotonic Anti-Replay Nonces
- **T1.F07.01**: Accept sequentially increasing nonces from a peer ($1, 2, 3$).
  - *Input*: `engine.validateWirePacket({ nonce: 1, timestamp: Date.now() }, peerId)`, then nonce 2, then nonce 3.
  - *Expected*: All return `true`.
  - *Assertion*: `assert.strictEqual(res, true)`
- **T1.F07.02**: Reject duplicate nonce (replay attack).
  - *Input*: Send nonce 2 again for the same `peerId`.
  - *Expected*: Returns `false` or throws ReplayDetected error.
  - *Assertion*: Replay packet rejected.
- **T1.F07.03**: Reject backward nonce (out-of-order / replay).
  - *Input*: Send nonce 1 after nonce 3 has been processed.
  - *Expected*: Returns `false` or throws error.
  - *Assertion*: Stale nonce rejected.
- **T1.F07.04**: Maintain independent nonce sequence tracking per peer.
  - *Input*: Peer A sends nonce 1, Peer B sends nonce 1.
  - *Expected*: Both valid and accepted independently.
  - *Assertion*: `assert.ok(validA && validB)`
- **T1.F07.05**: Integration with `decryptShard` option `{ validateReplay: true, senderId: peerId }`.
  - *Input*: Decrypt same packet twice with `validateReplay: true`.
  - *Expected*: Second decryption rejected fail-closed.
  - *Assertion*: `assert.throws(() => engine.decryptShard(pkt, key, { validateReplay: true, senderId }))`

### Feature 8: Timestamp Window Drift Validation
- **T1.F08.01**: Accept packet with timestamp within $\pm 60,000\text{ ms}$ window.
  - *Input*: Packet with `timestamp = Date.now() - 5000` (5 seconds past).
  - *Expected*: Validated as `true`.
  - *Assertion*: `assert.strictEqual(isValid, true)`
- **T1.F08.02**: Reject packet with timestamp in the distant past (> 60s).
  - *Input*: `timestamp = Date.now() - 65000`.
  - *Expected*: Validated as `false` or throws TimestampWindowExpired.
  - *Assertion*: `assert.strictEqual(engine.validateWirePacket(pkt, peerId), false)`
- **T1.F08.03**: Reject packet with timestamp in the distant future (> 60s).
  - *Input*: `timestamp = Date.now() + 65000`.
  - *Expected*: Validated as `false` or throws FutureTimestampRejected.
  - *Assertion*: `assert.strictEqual(engine.validateWirePacket(pkt, peerId), false)`
- **T1.F08.04**: Accept slight clock skew within $\pm 30,000\text{ ms}$.
  - *Input*: `timestamp = Date.now() + 25000`.
  - *Expected*: Validated as `true`.
  - *Assertion*: `assert.strictEqual(isValid, true)`
- **T1.F08.05**: Configurable drift window tolerance parameter.
  - *Input*: Set custom drift window to 5,000ms; test with 10,000ms offset.
  - *Expected*: Correctly rejects 10,000ms offset under 5,000ms rule.
  - *Assertion*: Custom threshold respected.

### Feature 9: Deterministic HMAC-SHA256 PoC Attestation
- **T1.F09.01**: Generate PoC signature matching exact format `${shardId}:${JSON.stringify(resultData)}`.
  - *Input*: `shardId = 'shard-101'`, `resultData = { sum: 42 }`.
  - *Expected*: 64-character hex string.
  - *Assertion*: `assert.strictEqual(sig.length, 64)`
- **T1.F09.02**: Verify signature determinism.
  - *Input*: Sign identical `shardId` and `resultData` twice with same key.
  - *Expected*: Exact character-for-character match.
  - *Assertion*: `assert.strictEqual(sig1, sig2)`
- **T1.F09.03**: Verify signature change upon shardId change.
  - *Input*: `shard-101` vs `shard-102` with same data.
  - *Expected*: Completely different HMAC digest.
  - *Assertion*: `assert.notStrictEqual(sigA, sigB)`
- **T1.F09.04**: Verify signature change upon result data change.
  - *Input*: `resultData = { sum: 42 }` vs `{ sum: 43 }`.
  - *Expected*: Completely different HMAC digest.
  - *Assertion*: `assert.notStrictEqual(sigA, sigB)`
- **T1.F09.05**: Backward compatibility: default signing secret is `this.publicKey`.
  - *Input*: Call `signProofOfCompute(shardId, resultData)` with no custom secret.
  - *Expected*: Uses `this.publicKey` matching baseline v0.4.2 behavior.
  - *Assertion*: `assert.strictEqual(sig, crypto.createHmac('sha256', engine.publicKey).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex'))`

### Feature 10: Constant-Time PoC Signature Verification
- **T1.F10.01**: Verify valid signature using `verifyProofOfCompute`.
  - *Input*: Valid signature generated by worker.
  - *Expected*: Returns `true`.
  - *Assertion*: `assert.strictEqual(engine.verifyProofOfCompute(shardId, data, validSig, secret), true)`
- **T1.F10.02**: Reject invalid signature string.
  - *Input*: Flipped character in hex signature.
  - *Expected*: Returns `false`.
  - *Assertion*: `assert.strictEqual(engine.verifyProofOfCompute(shardId, data, badSig, secret), false)`
- **T1.F10.03**: Prevent timing side-channels via `crypto.timingSafeEqual`.
  - *Input*: Signatures differing at first byte vs last byte.
  - *Expected*: Uniform constant-time comparison path without early exit.
  - *Assertion*: Buffer conversion and length check before `timingSafeEqual`.
- **T1.F10.04**: Safe handling of malformed signature length (not 64 hex characters).
  - *Input*: 32-character string or empty string.
  - *Expected*: Returns `false` without throwing uncaught exception.
  - *Assertion*: `assert.strictEqual(engine.verifyProofOfCompute(shardId, data, 'short-sig', secret), false)`
- **T1.F10.05**: Support verification against worker's public key as default secret.
  - *Input*: Verify using worker's public key string.
  - *Expected*: Correctly validates baseline signatures.
  - *Assertion*: `assert.strictEqual(engine.verifyProofOfCompute(shardId, data, sig, workerPublicKey), true)`

### Feature 11: Cross-Platform CPU Delta Telemetry
- **T1.F11.01**: Query real-time telemetry via `router.getHardwareTelemetry()`.
  - *Input*: Call `getHardwareTelemetry()`.
  - *Expected*: Object with `cpuLoad` (number $0.0 \le \text{cpuLoad} \le 1.0$), `freeMemBytes`, `totalMemBytes`, `freeMemRatio`, `standbyReady`, `loadShedState`.
  - *Assertion*: `assert.ok(typeof telem.cpuLoad === 'number')`
- **T1.F11.02**: Compute delta across multi-core tick counts (user, nice, sys, idle, irq).
  - *Input*: Two consecutive snapshots of `os.cpus()`.
  - *Expected*: `cpuLoad = 1 - (deltaIdle / deltaTotal)`.
  - *Assertion*: `cpuLoad >= 0.0 && cpuLoad <= 1.0`.
- **T1.F11.03**: Verify telemetry responds dynamically to system state.
  - *Input*: Sample telemetry over 100ms interval.
  - *Expected*: Non-negative numbers for free and total memory.
  - *Assertion*: `assert.ok(telem.freeMemBytes > 0 && telem.totalMemBytes > 0)`
- **T1.F11.04**: Verify `cpuCount` reflects actual host hardware (`os.cpus().length`).
  - *Input*: Compare with `os.cpus().length`.
  - *Expected*: Exact integer equality.
  - *Assertion*: `assert.strictEqual(telem.cpuCount, os.cpus().length)`
- **T1.F11.05**: Telemetry caching and rate-limiting.
  - *Input*: Rapidly call `getHardwareTelemetry()` 100 times in 1ms.
  - *Expected*: Minimal overhead, non-stalling execution.
  - *Assertion*: Execution completes in $< 50\text{ ms}$.

### Feature 12: Free Memory Headroom Tracker
- **T1.F12.01**: Calculate exact memory ratio `freeMemRatio = os.freemem() / os.totalmem()`.
  - *Input*: `router.getHardwareTelemetry().freeMemRatio`.
  - *Expected*: Float between 0.0 and 1.0.
  - *Assertion*: `assert.ok(ratio >= 0.0 && ratio <= 1.0)`
- **T1.F12.02**: Track `freeMemBytes` in bytes and verify megabyte conversion accuracy.
  - *Input*: `telem.freeMemBytes` vs `Math.round(os.freemem() / 1048576)`.
  - *Expected*: Consistency within 5MB fluctuation window.
  - *Assertion*: `assert.ok(Math.abs(telem.freeMemBytes / 1048576 - os.freemem() / 1048576) < 5)`
- **T1.F12.03**: Identify low-memory state flag.
  - *Input*: Mock `os.freemem` returning $< 10\%$ of total.
  - *Expected*: `standbyReady: false` and `loadShedState: 'MEMORY_EXHAUSTED'`.
  - *Assertion*: `assert.strictEqual(telem.standbyReady, false)`
- **T1.F12.04**: Identify adequate memory state flag.
  - *Input*: Mock `os.freemem` returning $> 25\%$ of total.
  - *Expected*: `freeMemRatio > 0.10`.
  - *Assertion*: Memory floor check passes.
- **T1.F12.05**: Zero division protection when total memory is 0 or undefined.
  - *Input*: Injected total memory of 0.
  - *Expected*: Ratio defaults safely to 0.0 without `NaN` or crash.
  - *Assertion*: `assert.strictEqual(telem.freeMemRatio, 0.0)`

### Feature 13: Strict 25% CPU Fail-Closed Gating
- **T1.F13.01**: Accept compute tasks when CPU utilization is below 25% (e.g. 15%).
  - *Input*: Telemetry CPU load = 0.15, memory ratio = 0.40.
  - *Expected*: `standbyReady: true`, `loadShedState: 'NOMINAL'`.
  - *Assertion*: `assert.strictEqual(telem.standbyReady, true)`
- **T1.F13.02**: Fail-closed rejection when CPU load exceeds 25% (e.g. 26%).
  - *Input*: Telemetry CPU load = 0.26.
  - *Expected*: `standbyReady: false`, `loadShedState: 'CPU_OVERLOAD'`.
  - *Assertion*: `assert.strictEqual(telem.standbyReady, false)`
- **T1.F13.03**: Threshold boundary test at exactly 25.0% CPU (0.25).
  - *Input*: CPU load = 0.2500.
  - *Expected*: Rejection or acceptance strictly according to defined invariant ($> 0.25$ rejects).
  - *Assertion*: Boundary evaluated deterministically.
- **T1.F13.04**: Dynamic update of peer availability in `peerTable` upon CPU surge.
  - *Input*: Registered peer reports CPU load spike to 35%.
  - *Expected*: Peer marked `standbyReady: false` in router peer table.
  - *Assertion*: `assert.strictEqual(router.peerTable.get(peerId).standbyReady, false)`
- **T1.F13.05**: Exclude busy peer from `selectOptimalNodes`.
  - *Input*: Two peers registered: Peer 1 (CPU 10%), Peer 2 (CPU 30%).
  - *Expected*: `selectOptimalNodes` returns only Peer 1.
  - *Assertion*: `assert.deepStrictEqual(selected.map(p => p.nodeId), [peer1Id])`

### Feature 14: Memory Floor Fail-Closed Gating
- **T1.F14.01**: Accept incoming shards when free memory is above 10% (0.10).
  - *Input*: Free memory ratio = 0.15.
  - *Expected*: Memory gating check returns pass.
  - *Assertion*: `assert.strictEqual(router.isMemoryAvailable(), true)`
- **T1.F14.02**: Reject incoming shards when free memory drops below 10% (0.09).
  - *Input*: Free memory ratio = 0.09.
  - *Expected*: Memory gating check returns fail-closed `false`.
  - *Assertion*: `assert.strictEqual(router.isMemoryAvailable(), false)`
- **T1.F14.03**: Strict fail-closed routing when all peers breach memory floor.
  - *Input*: All registered peers report free memory $< 10\%$.
  - *Expected*: `selectOptimalNodes` returns `[]`.
  - *Assertion*: `assert.strictEqual(router.selectOptimalNodes('hash', 2).length, 0)`
- **T1.F14.04**: Load shed state reports `MEMORY_PRESSURE`.
  - *Input*: Query state when memory is 8%.
  - *Expected*: `loadShedState` string indicates memory pressure.
  - *Assertion*: `assert.match(telem.loadShedState, /MEM/i)`
- **T1.F14.05**: Recovery when memory clears above 10%.
  - *Input*: Memory recovers from 8% to 20%.
  - *Expected*: Node transitions back to `standbyReady: true`.
  - *Assertion*: Availability restored automatically.

### Feature 15: Dynamic Task Partitioning
- **T1.F15.01**: Partition array into exact chunks of size 2.
  - *Input*: `dataset = [1, 2, 3, 4, 5, 6]`, `chunkSize = 2`.
  - *Expected*: 3 partitions with inputs `[1, 2]`, `[3, 4]`, `[5, 6]`.
  - *Assertion*: `assert.strictEqual(partitions.length, 3)`
- **T1.F15.02**: Handle odd-sized datasets with trailing chunk.
  - *Input*: `dataset = [1, 2, 3, 4, 5]`, `chunkSize = 2`.
  - *Expected*: 3 partitions with sizes 2, 2, and 1.
  - *Assertion*: `assert.deepStrictEqual(partitions[2].inputData, [5])`
- **T1.F15.03**: Generate deterministic 40-character hex `shardId`.
  - *Input*: Partition computation twice with same inputs.
  - *Expected*: Identical `shardId` values derived via SHA-256 prefix.
  - *Assertion*: `assert.strictEqual(p1[0].shardId, p2[0].shardId)` and length is 40.
- **T1.F15.04**: Maintain correct partition index metadata.
  - *Input*: Partitions of 4 chunks.
  - *Expected*: Indices strictly equal 0, 1, 2, 3.
  - *Assertion*: `assert.deepStrictEqual(partitions.map(p => p.index), [0, 1, 2, 3])`
- **T1.F15.05**: Result aggregation reconstructs ordered sequence.
  - *Input*: Unordered results `[{index: 1, output: [3,4]}, {index: 0, output: [1,2]}]`.
  - *Expected*: `router.aggregateResults` produces `[1, 2, 3, 4]`.
  - *Assertion*: `assert.deepStrictEqual(router.aggregateResults(results), [1, 2, 3, 4])`

### Feature 16: Fail-Closed Peer Selection & Scoring
- **T1.F16.01**: Rank peers by lowest latency among standby-ready nodes.
  - *Input*: Peer A (latency 40ms, ready), Peer B (latency 15ms, ready), Peer C (latency 25ms, ready).
  - *Expected*: `selectOptimalNodes('hash', 2)` returns `[Peer B, Peer C]`.
  - *Assertion*: `assert.deepStrictEqual(selected.map(p => p.nodeId), [peerBId, peerCId])`
- **T1.F16.02**: Fail-closed return of empty array when no peers are registered.
  - *Input*: Empty `peerTable`.
  - *Expected*: Returns `[]`.
  - *Assertion*: `assert.deepStrictEqual(router.selectOptimalNodes('hash', 1), [])`
- **T1.F16.03**: Fail-closed return when all registered peers have `standbyReady: false`.
  - *Input*: 3 registered peers, all with `standbyReady: false`.
  - *Expected*: Returns `[]`.
  - *Assertion*: `assert.strictEqual(router.selectOptimalNodes('hash', 1).length, 0)`
- **T1.F16.04**: Respect requested node `count`.
  - *Input*: 5 ready peers, request `count = 3`.
  - *Expected*: Exactly 3 nodes returned.
  - *Assertion*: `assert.strictEqual(selected.length, 3)`
- **T1.F16.05**: Capacity score factor in selection.
  - *Input*: Peers with identical latency but differing capacity scores.
  - *Expected*: Higher capacity node prioritized.
  - *Assertion*: Expected node selected.

### Feature 17: Bounded Task Queue & Rescheduling
- **T1.F17.01**: Queue pending shards when no standby nodes are available.
  - *Input*: Dispatch shard when `selectOptimalNodes` returns `[]`.
  - *Expected*: Shard added to `router.taskQueue`.
  - *Assertion*: `assert.strictEqual(router.taskQueue.length, 1)`
- **T1.F17.02**: FIFO ordering of queued tasks.
  - *Input*: Enqueue Shard 1, then Shard 2.
  - *Expected*: Dequeue returns Shard 1 first, then Shard 2.
  - *Assertion*: `assert.strictEqual(router.dequeueTask().shardId, shard1Id)`
- **T1.F17.03**: Bounded queue capacity enforcement.
  - *Input*: Attempt to enqueue beyond `maxQueueSize` (e.g. 1000 tasks).
  - *Expected*: Queue rejects new tasks fail-closed with QueueFullError.
  - *Assertion*: `assert.throws(() => router.enqueueTask(excessShard))`
- **T1.F17.04**: Automatic rescheduling upon worker node disconnection.
  - *Input*: Worker executing Shard 1 disconnects before returning result.
  - *Expected*: Shard 1 re-inserted at head of queue for reassignment.
  - *Assertion*: `assert.ok(router.taskQueue.some(s => s.shardId === shard1Id))`
- **T1.F17.05**: Queue flush when worker nodes become available.
  - *Input*: Peer registers with `standbyReady: true` while tasks are queued.
  - *Expected*: Queued shards automatically dispatched to available peer.
  - *Assertion*: `router.taskQueue.length === 0`.

### Feature 18: AST / Static Token Pre-Validator
- **T1.F18.01**: Approve benign computational JavaScript code.
  - *Input*: `'return data.map(x => x * 2);'`
  - *Expected*: `validateTaskCode(code)` returns `{ valid: true }`.
  - *Assertion*: `assert.strictEqual(res.valid, true)`
- **T1.F18.02**: Reject `process` global access.
  - *Input*: `'return process.exit(1);'` or `'return process.env;'`
  - *Expected*: `{ valid: false, error: /process/i }`.
  - *Assertion*: `assert.strictEqual(res.valid, false)`
- **T1.F18.03**: Reject `require` and dynamic `import`.
  - *Input*: `'const fs = require("node:fs");'` or `'import("node:fs")'`
  - *Expected*: `{ valid: false, error: /require|import/i }`.
  - *Assertion*: `assert.strictEqual(res.valid, false)`
- **T1.F18.04**: Reject `eval` and `Function` constructors.
  - *Input*: `'eval("1 + 1")'` or `'new Function("return 1")()'`.
  - *Expected*: `{ valid: false, error: /eval|Function/i }`.
  - *Assertion*: `assert.strictEqual(res.valid, false)`
- **T1.F18.05**: Reject prototype pollution tokens (`__proto__`, `constructor`, `prototype`).
  - *Input*: `'data.__proto__.polluted = true;'`
  - *Expected*: `{ valid: false, error: /proto/i }`.
  - *Assertion*: `assert.strictEqual(res.valid, false)`

### Feature 19: Escape Sequence Normalizer
- **T1.F19.01**: Normalize Unicode escape sequences before token validation.
  - *Input*: `'\\u0070\\u0072\\u006f\\u0063\\u0065\\u0073\\u0073'` (escaped `process`).
  - *Expected*: Normalizes to `'process'` and triggers AST rejection.
  - *Assertion*: `assert.strictEqual(sandbox.validateTaskCode(code).valid, false)`
- **T1.F19.02**: Normalize Hex escape sequences.
  - *Input*: `'\\x72\\x65\\x71\\x75\\x69\\x72\\x65'` (escaped `require`).
  - *Expected*: Normalizes to `'require'` and triggers rejection.
  - *Assertion*: `assert.strictEqual(sandbox.validateTaskCode(code).valid, false)`
- **T1.F19.03**: Normalize octal escape sequences.
  - *Input*: Octal representation of forbidden tokens.
  - *Expected*: Normalized and rejected.
  - *Assertion*: `assert.strictEqual(sandbox.validateTaskCode(code).valid, false)`
- **T1.F19.04**: Normalize multi-line split string concat tokens.
  - *Input*: `'pro' + 'cess'` or `'this["pro" + "cess"]'`.
  - *Expected*: Static validator detects suspicious property access or normalizes concatenation.
  - *Assertion*: Rejection triggered fail-closed.
- **T1.F19.05**: Preserve valid unicode in string literals without corruption.
  - *Input*: Safe unicode string `'const msg = "\u0048\u0065\u006c\u006c\u006f"; return msg;'`.
  - *Expected*: Allowed because normalized content contains no forbidden identifiers.
  - *Assertion*: `assert.strictEqual(sandbox.validateTaskCode(code).valid, true)`

### Feature 20: Zero-Privilege VM Isolation Boundary
- **T1.F20.01**: Execute math calculations with frozen standard built-ins (`Math`, `JSON`, `Array`).
  - *Input*: Shard executing `Math.sqrt(data[0])` on `[16]`.
  - *Expected*: `output === 4`.
  - *Assertion*: `assert.strictEqual(res.output, 4)`
- **T1.F20.02**: Verify absence of host global objects (`global`, `globalThis`, `process`).
  - *Input*: `'return typeof process === "undefined" && typeof global === "undefined";'`.
  - *Expected*: `output === true`.
  - *Assertion*: `assert.strictEqual(res.output, true)`
- **T1.F20.03**: Prevent modification of frozen built-ins inside sandbox.
  - *Input*: `'Math.floor = () => 0; return Math.floor(1.5);'`.
  - *Expected*: Throws TypeError (cannot assign to read-only property) or has zero effect outside.
  - *Assertion*: Host `Math.floor(1.5)` remains `1`.
- **T1.F20.04**: Context isolation between successive executions.
  - *Input*: Shard 1 sets `leak = 123;`; Shard 2 reads `'return typeof leak;'`.
  - *Expected*: Shard 2 returns `'undefined'`.
  - *Assertion*: `assert.strictEqual(res2.output, 'undefined')`
- **T1.F20.05**: Null prototype sandbox context dictionary.
  - *Input*: Inspect context prototype structure.
  - *Expected*: `Object.getPrototypeOf(context) === null` or prototype-safe proxy.
  - *Assertion*: Prototype pollution vectors neutralized.

### Feature 21: Millisecond Execution Timeout Guard
- **T1.F21.01**: Interrupt synchronous infinite loop (`while(true) {}`).
  - *Input*: Shard with `taskCode: 'while(true) {}'`, timeout configured to 100ms.
  - *Expected*: Execution terminates within $\approx 100\text{ ms}$ throwing timeout error.
  - *Assertion*: `assert.throws(() => sandbox.executeIsolatedShard(shard), /timed? ?out/i)`
- **T1.F21.02**: Interrupt complex nested infinite recursion.
  - *Input*: Recursive function without base case.
  - *Expected*: Terminates with timeout or RangeError without crashing host process.
  - *Assertion*: Process remains alive and operational.
- **T1.F21.03**: Allow long-running but compliant tasks within timeout bound.
  - *Input*: Task taking 50ms with timeout configured to 200ms.
  - *Expected*: Completes successfully with valid output.
  - *Assertion*: `assert.ok(res.output !== undefined)`
- **T1.F21.04**: Record accurate execution duration in `executionTimeMs`.
  - *Input*: Shard executing 10,000 math operations.
  - *Expected*: `res.executionTimeMs` is positive float $> 0.0$.
  - *Assertion*: `assert.ok(res.executionTimeMs > 0)`
- **T1.F21.05**: Enforce timeout in async worker execution path (`executeIsolatedShardAsync`).
  - *Input*: Async execution of infinite loop with `timeoutMs: 150`.
  - *Expected*: Rejected promise with timeout error within 250ms.
  - *Assertion*: `assert.rejects(async () => await sandbox.executeIsolatedShardAsync(shard, { timeoutMs: 150 }))`

### Feature 22: Worker Threads Memory Resource Limits
- **T1.F22.01**: Execute heavy memory task inside worker thread with capped heap.
  - *Input*: Shard executed via `executeIsolatedShardAsync` with `maxOldGenerationSizeMb: 64`.
  - *Expected*: Worker initializes and executes within memory boundary.
  - *Assertion*: Successful execution for normal payload.
- **T1.F22.02**: Trap heap exhaustion (OOM) inside worker without crashing parent host.
  - *Input*: Shard attempting to allocate huge array: `'const arr = []; while(true) arr.push(new Array(1e6));'`.
  - *Expected*: Worker thread triggers OOM exit, promise rejects, parent process survives intact.
  - *Assertion*: `assert.rejects(async () => await sandbox.executeIsolatedShardAsync(shard))`
- **T1.F22.03**: Proper disposal and termination of worker thread after execution.
  - *Input*: Monitor active worker thread handles before and after execution.
  - *Expected*: Thread terminates cleanly with exit code 0.
  - *Assertion*: Zero leaked thread handles.
- **T1.F22.04**: Configurable memory limit parameter (`memoryLimitMb`).
  - *Input*: Set limit to 32MB vs 64MB.
  - *Expected*: Lower limit triggers OOM earlier on controlled allocation sizes.
  - *Assertion*: Memory limit properly configured in `resourceLimits`.
- **T1.F22.05**: Fallback to in-process VM sandbox when worker threads are disabled or unavailable.
  - *Input*: Synchronous fallback execution call `executeIsolatedShard`.
  - *Expected*: Executes in `node:vm` context safely.
  - *Assertion*: Backward compatible execution.

### Feature 23: Deterministic State Virtualization
- **T1.F23.01**: Deep-freeze input data object to prevent in-place mutation.
  - *Input*: Task `'data[0] = 999; return data[0];'`.
  - *Expected*: Input mutation fails (in strict mode throws TypeError) and original array remains untouched.
  - *Assertion*: Original array unchanged: `input[0] === originalVal`.
- **T1.F23.02**: Virtualize `Date.now()` or clock primitives to fixed execution snapshot.
  - *Input*: Two independent executions of `Date.now()` on different nodes.
  - *Expected*: Returns identical deterministic virtual timestamp.
  - *Assertion*: `assert.strictEqual(res1.output, res2.output)`
- **T1.F23.03**: Virtualize pseudo-random number generation (`Math.random`).
  - *Input*: Seeded or deterministic PRNG sequence inside execution context.
  - *Expected*: Re-running task with same seed produces identical sequence.
  - *Assertion*: Identical outputs across runs.
- **T1.F23.04**: Repeatable results across heterogeneous worker nodes.
  - *Input*: Execute deterministic sorting and hash reduction on Node A and Node B.
  - *Expected*: `resA.output === resB.output`.
  - *Assertion*: Deterministic state confirmed.
- **T1.F23.05**: Deterministic serialization of output data.
  - *Input*: Objects with differing key insertion orders.
  - *Expected*: Output canonicalized to deterministic JSON representation.
  - *Assertion*: `JSON.stringify(canonicalize(out1)) === JSON.stringify(canonicalize(out2))`

### Feature 24: Native P2P TCP Daemon (`src/node.js`)
- **T1.F24.01**: Start TCP server listening on configurable host and port.
  - *Input*: `const node = new P2PNode(); await node.listen();`
  - *Expected*: Returns `{ address: '127.0.0.1', port: <number> }` with active server.
  - *Assertion*: `assert.ok(node.server.listening)`
- **T1.F24.02**: Connect client node to listening peer node over TCP.
  - *Input*: `const client = new P2PNode(); const socket = await client.connect({ port });`
  - *Expected*: Socket connected event fires, socket is readable and writable.
  - *Assertion*: `assert.strictEqual(socket.destroyed, false)`
- **T1.F24.03**: Connection pooling and peer map management.
  - *Input*: Register and connect to 3 distinct peers.
  - *Expected*: Internal peer connection map maintains 3 active entries.
  - *Assertion*: `assert.strictEqual(node.peers.size, 3)`
- **T1.F24.04**: Graceful server shutdown on `node.close()`.
  - *Input*: `await node.close()`.
  - *Expected*: Server closes, all child sockets closed, event loop unblocked.
  - *Assertion*: `assert.strictEqual(node.server.listening, false)`
- **T1.F24.05**: IPC connection support via local named pipes or domain sockets.
  - *Input*: `node.listen({ ipcPath: pipeName })`.
  - *Expected*: Binds and accepts local IPC socket connections.
  - *Assertion*: Successful IPC roundtrip.

### Feature 25: Ephemeral Loopback Dynamic Port Binding
- **T1.F25.01**: Bind server to port 0 on loopback address `127.0.0.1`.
  - *Input*: `node.listen({ port: 0, host: '127.0.0.1' })`.
  - *Expected*: OS assigns random available high port (> 1024).
  - *Assertion*: `assert.ok(port > 1024 && port < 65536)`
- **T1.F25.02**: Bind multiple concurrent nodes without port collisions.
  - *Input*: Instantiate 5 `P2PNode` instances simultaneously on port 0.
  - *Expected*: 5 distinct, non-overlapping port numbers allocated.
  - *Assertion*: `new Set(ports).size === 5`
- **T1.F25.03**: Zero external network exposure (strict `127.0.0.1` binding).
  - *Input*: Inspect `node.server.address().address`.
  - *Expected*: Exactly `'127.0.0.1'` (never `0.0.0.0`).
  - *Assertion*: `assert.strictEqual(node.server.address().address, '127.0.0.1')`
- **T1.F25.04**: Dynamic port recycling and release on node close.
  - *Input*: Open port 0, capture port, close server, bind again.
  - *Expected*: No `EADDRINUSE` errors encountered.
  - *Assertion*: Clean socket lifecycle.
- **T1.F25.05**: Fallback to random IPC pipe when port binding fails.
  - *Input*: Simulate port allocation restriction.
  - *Expected*: Node gracefully transitions to local IPC pipe.
  - *Assertion*: Node operational in local test harness.

### Feature 26: Length-Prefixed / Delimited Wire Stream Framing
- **T1.F26.01**: Encode message with 4-byte big-endian length prefix.
  - *Input*: Encode `{ type: 'PING', data: 'hello' }`.
  - *Expected*: Buffer starting with 4-byte uint32 equal to payload length, followed by utf8 JSON.
  - *Assertion*: `assert.strictEqual(buffer.readUInt32BE(0), buffer.length - 4)`
- **T1.F26.02**: Decode full frame received in single TCP chunk.
  - *Input*: Feed complete length-prefixed buffer to frame parser.
  - *Expected*: Emits parsed message object.
  - *Assertion*: `assert.deepStrictEqual(msg.type, 'PING')`
- **T1.F26.03**: Handle TCP chunk fragmentation (partial frames across chunks).
  - *Input*: Split single 100-byte frame into 3 chunks (e.g. 20 bytes, 40 bytes, 40 bytes) fed sequentially.
  - *Expected*: Parser buffers until 4th byte read, then until full length reached; emits single complete message.
  - *Assertion*: Exact message parsed without syntax error.
- **T1.F26.04**: Handle TCP chunk concatenation (multiple frames in single chunk).
  - *Input*: Concatenate Frame A and Frame B into single buffer fed to socket.
  - *Expected*: Parser sequentially emits Message A then Message B.
  - *Assertion*: Two discrete message events emitted.
- **T1.F26.05**: Guard against frame length overflow attacks.
  - *Input*: Injected frame header claiming 2GB payload length (`0x7FFFFFFF`).
  - *Expected*: Parser rejects frame fail-closed with `FrameTooLarge` error, closing socket.
  - *Assertion*: `assert.throws` or socket destruction event.

### Feature 27: Live Ephemeral ECDH Wire Handshake
- **T1.F27.01**: Send `HANDSHAKE` message containing initiator public key and nonce over socket.
  - *Input*: Initiator connects and writes handshake frame.
  - *Expected*: Responder receives frame with valid 130-char public key.
  - *Assertion*: Public key verified.
- **T1.F27.02**: Responder replies with `HANDSHAKE_ACK` containing responder public key.
  - *Input*: Responder handles `HANDSHAKE` and sends `HANDSHAKE_ACK`.
  - *Expected*: Initiator receives valid responder public key.
  - *Assertion*: Two-way exchange verified.
- **T1.F27.03**: Both nodes derive matching HKDF-SHA512 session key upon handshake completion.
  - *Input*: Compare `initiator.getSessionKey(peerId)` with `responder.getSessionKey(peerId)`.
  - *Expected*: Both 32-byte buffers are strictly equal.
  - *Assertion*: `assert.strictEqual(keyInit.toString('hex'), keyResp.toString('hex'))`
- **T1.F27.04**: Transition socket state to `SECURE_ESTABLISHED`.
  - *Input*: Query connection state after handshake.
  - *Expected*: `peerConnection.state === 'ESTABLISHED'`.
  - *Assertion*: Session authenticated.
- **T1.F27.05**: Handshake timeout if peer fails to respond within 3000ms.
  - *Input*: Connect socket but do not reply to `HANDSHAKE`.
  - *Expected*: Handshake promise rejects with timeout; socket closed.
  - *Assertion*: `assert.rejects(handshakePromise)`

### Feature 28: Encrypted Shard Streaming & Result Return
- **T1.F28.01**: Stream AES-256-GCM encrypted shard over live TCP socket.
  - *Input*: Requester dispatches shard to connected worker over established session.
  - *Expected*: Wire data on socket is fully encrypted; worker receives and decrypts payload.
  - *Assertion*: Decrypted shard matches dispatched shard.
- **T1.F28.02**: Worker executes shard and streams back signed PoC result.
  - *Input*: Worker finishes computation, signs PoC HMAC, and sends result frame.
  - *Expected*: Requester receives encrypted result containing output and valid PoC signature.
  - *Assertion*: Result received and signature verified.
- **T1.F28.03**: Simultaneous streaming of multiple shards across peer connections.
  - *Input*: Dispatch 10 shards across 2 worker nodes simultaneously.
  - *Expected*: All 10 results returned cleanly without cross-talk or race conditions.
  - *Assertion*: `results.length === 10`.
- **T1.F28.04**: Wire frame integrity verification on streaming results.
  - *Input*: Validate authTag and sequence counter on incoming result frame.
  - *Expected*: Authentication passes.
  - *Assertion*: No corruption detected.
- **T1.F28.05**: Handle unexpected peer disconnection during shard transfer.
  - *Input*: Destroy socket while shard is mid-stream.
  - *Expected*: Requester detects socket error, flags shard for rescheduling.
  - *Assertion*: Requester router reschedules task.

### Feature 29: Proof-of-Compute Work Metering
- **T1.F29.01**: Calculate compute credit from execution time and input size: $\text{Credit} = f(T_{\text{ms}}, S)$.
  - *Input*: `ledger.calculateCredit(100, 10)` (100ms execution, 10 items).
  - *Expected*: Deterministic positive integer or float credit amount.
  - *Assertion*: `assert.ok(credit > 0)`
- **T1.F29.02**: Proportional increase with execution time.
  - *Input*: $T = 200\text{ ms}$ vs $T = 100\text{ ms}$ with same input size.
  - *Expected*: $\text{Credit}(200) > \text{Credit}(100)$.
  - *Assertion*: `assert.ok(c2 > c1)`
- **T1.F29.03**: Proportional increase with input dataset complexity.
  - *Input*: $S = 50$ vs $S = 10$ with same execution time.
  - *Expected*: $\text{Credit}(50) > \text{Credit}(10)$.
  - *Assertion*: `assert.ok(c2 > c1)`
- **T1.F29.04**: Minimum baseline credit floor for valid verified shards.
  - *Input*: Shard with 1ms execution and 1 item.
  - *Expected*: Earns at least minimum unit credit (e.g. 1 credit).
  - *Assertion*: `assert.ok(credit >= 1)`
- **T1.F29.05**: Zero credit for 0 duration or failed/aborted execution.
  - *Input*: `ledger.calculateCredit(0, 0)`.
  - *Expected*: Returns 0 credits.
  - *Assertion*: `assert.strictEqual(credit, 0)`

### Feature 30: Anti-Replay Double-Spend Prevention
- **T1.F30.01**: Settle verified Proof-of-Compute attestation once.
  - *Input*: `ledger.verifyAndSettle({ requesterId, workerId, shardId, resultData, proofOfCompute, ... })`.
  - *Expected*: Returns `{ settled: true, cost: <number> }`, attestation added to `settledAttestations`.
  - *Assertion*: `assert.strictEqual(res.settled, true)`
- **T1.F30.02**: Reject duplicate submission of settled attestation (double-spend).
  - *Input*: Call `verifyAndSettle` with identical `shardId` and `proofOfCompute` again.
  - *Expected*: Throws `DoubleSpendAttemptError` or returns `{ settled: false, error: /already settled/i }`.
  - *Assertion*: Double-spend rejected fail-closed.
- **T1.F30.03**: Prevent credit duplication across different requesters for same proof.
  - *Input*: Malicious worker attempts to claim credit from Requester B using proof from Requester A.
  - *Expected*: Rejected fail-closed.
  - *Assertion*: Settlement refused.
- **T1.F30.04**: Maintain persistent set of settled attestation hashes.
  - *Input*: Query `ledger.settledAttestations.has(attestationKey)`.
  - *Expected*: Returns `true` after settlement.
  - *Assertion*: `assert.strictEqual(ledger.settledAttestations.has(key), true)`
- **T1.F30.05**: Reject settlement when PoC signature does not verify.
  - *Input*: Invalidate signature before calling `verifyAndSettle`.
  - *Expected*: Settlement rejected, zero balances adjusted.
  - *Assertion*: `assert.strictEqual(res.settled, false)`

### Feature 31: Fail-Closed Account Balance Enforcement
- **T1.F31.01**: Credit worker node upon valid verified settlement.
  - *Input*: Settle shard earning 15 credits for `workerNode`.
  - *Expected*: `workerNode` balance increases by 15.
  - *Assertion*: `assert.strictEqual(ledger.getBalance(workerId), initialWorkerBal + 15)`
- **T1.F31.02**: Debit requester node upon valid verified settlement.
  - *Input*: Requester with initial balance 100 settles shard costing 15 credits.
  - *Expected*: Requester balance decreases to 85.
  - *Assertion*: `assert.strictEqual(ledger.getBalance(reqId), 85)`
- **T1.F31.03**: Enforce strict pre-dispatch debit check (fail-closed if balance insufficient).
  - *Input*: Requester with balance 5 attempts to dispatch workload requiring 20 credits.
  - *Expected*: Dispatch rejected fail-closed with `InsufficientCreditBalanceError`.
  - *Assertion*: `assert.throws(() => ledger.checkCreditAvailable(reqId, 20))`
- **T1.F31.04**: Zero negative balances permitted under any condition.
  - *Input*: Verify invariant: `forall acc in ledger.accounts: acc.balance >= 0`.
  - *Expected*: Invariant holds across all transactions.
  - *Assertion*: `assert.ok(Array.from(ledger.accounts.values()).every(a => a.balance >= 0))`
- **T1.F31.05**: Ledger balance conservation: $\Delta \text{WorkerBalance} == \Delta \text{RequesterBalance}$.
  - *Input*: Calculate sum of all balances in system before and after settlement.
  - *Expected*: System-wide balance delta is zero.
  - *Assertion*: `assert.strictEqual(sumBefore, sumAfter)`

### Feature 32: Comprehensive Verification Suite (100% E2E Pass)
- **T1.F32.01**: Execute all baseline invariants and new feature suites cleanly via single entrypoint.
  - *Input*: Spawn `node test/mesh.test.js`.
  - *Expected*: Exit code 0, all tests pass.
  - *Assertion*: `assert.strictEqual(exitCode, 0)`
- **T1.F32.02**: Execute test suite via `npm test`.
  - *Input*: Spawn `npm test`.
  - *Expected*: Process exits with code 0.
  - *Assertion*: `assert.strictEqual(exitCode, 0)`
- **T1.F32.03**: Execute test suite via `node --test test/mesh.test.js`.
  - *Input*: Spawn `node --test test/mesh.test.js`.
  - *Expected*: Native test runner reports 0 failed tests and clean exit code 0.
  - *Assertion*: `assert.strictEqual(exitCode, 0)`
- **T1.F32.04**: Validate syntax check across all codebase modules.
  - *Input*: `node --check src/index.js src/crypto.js src/sandbox.js src/router.js src/node.js src/ledger.js`.
  - *Expected*: All files compile cleanly with exit code 0.
  - *Assertion*: Zero syntax errors.
- **T1.F32.05**: Verify end-to-end simulation entrypoint executes without error.
  - *Input*: `node src/index.js`.
  - *Expected*: Console logs simulation success, exit code 0.
  - *Assertion*: `assert.strictEqual(code, 0)`

---

## 6. Tier 2: Boundary & Corner Cases Specifications (All 32 Features)

Tier 2 mandates at least 5 adversarial, boundary, or corner test cases for every feature in the inventory.

### Feature 1: Zero-Dependency Module Architecture
- **T2.F01.01**: Attempt to load non-existent module simulating missing package.
  - *Vector*: `require('external-dep-mock')`.
  - *Expected*: Handled via module check without crashing core runtime.
- **T2.F01.02**: Circular dependency resilience between modules.
  - *Vector*: `src/node.js` requiring `src/crypto.js` and vice versa.
  - *Expected*: CommonJS exports resolve without `undefined` prototype references.
- **T2.F01.03**: Path traversal injection in module require paths.
  - *Vector*: Resolving paths with `../../` outside repository root.
  - *Expected*: Blocked by strict path resolution.
- **T2.F01.04**: Freeze export objects to prevent prototype tampering.
  - *Vector*: `MeshCryptoEngine.prototype = null;`.
  - *Expected*: Core engine preserves integrity or fails gracefully.
- **T2.F01.05**: Check behavior under Node.js process warnings or restricted permissions.
  - *Vector*: Run with strict mode and warnings treated as errors.
  - *Expected*: Zero deprecation or runtime warnings emitted.

### Feature 2: 5-Stage Mesh Protocol Verification
- **T2.F02.01**: Execute baseline test with maximum integer values in dataset (`[Number.MAX_SAFE_INTEGER, 0]`).
  - *Vector*: Extreme math operations in baseline shard.
  - *Expected*: Correct math reduction without precision truncation.
- **T2.F02.02**: Execute baseline test with empty dataset `[]`.
  - *Vector*: `router.createTaskPartitions(code, [], 2)`.
  - *Expected*: Returns `[]` partitions cleanly without throwing uncaught error.
- **T2.F02.03**: Execute baseline test with chunkSize 0.
  - *Vector*: `chunkSize = 0`.
  - *Expected*: Throws descriptive RangeError or defaults safely to 1.
- **T2.F02.04**: Tamper ciphertext in baseline step 3.
  - *Vector*: Mutate `encryptedPacket.ciphertext`.
  - *Expected*: Step 3 fails cleanly; assert catches decrypt failure.
- **T2.F02.05**: Execute baseline test concurrently across 50 simulated pairs.
  - *Vector*: 50 concurrent `testMeshProtocol()` runs.
  - *Expected*: 100% pass without memory leaks or race conditions.

### Feature 3: Ephemeral ECDH Key Generation
- **T2.F03.01**: Invalid curve injection attack.
  - *Vector*: Inject public key from mismatched curve (e.g. `secp256k1` instead of `prime256v1`).
  - *Expected*: `computeSecret` throws invalid key error fail-closed.
- **T2.F03.02**: Malformed public key hex string (invalid characters).
  - *Vector*: `peerPublicKey = '04zzzz...'`.
  - *Expected*: Throws TypeError / CryptoError fail-closed.
- **T2.F03.03**: Truncated public key hex string (< 130 characters).
  - *Vector*: 64-character hex string.
  - *Expected*: Throws invalid key length error fail-closed.
- **T2.F03.04**: Point at infinity or degenerate public key.
  - *Vector*: All-zero public key `000000...`.
  - *Expected*: Throws invalid elliptic curve point error.
- **T2.F03.05**: Null, undefined, or number passed as `peerPublicKeyHex`.
  - *Vector*: `deriveSharedKey(null)`.
  - *Expected*: Throws TypeError fail-closed.

### Feature 4: HKDF-SHA512 Key Derivation & Rotation
- **T2.F04.01**: Empty string or zero-length salt.
  - *Vector*: `deriveSessionKey(peerPub, { salt: '' })`.
  - *Expected*: Handled cleanly using RFC 5869 zero-salt fallback (string of zeros).
- **T2.F04.02**: Extreme salt length (1MB buffer).
  - *Vector*: Large salt buffer.
  - *Expected*: Computes without memory explosion or stack overflow.
- **T2.F04.03**: Extreme info string length.
  - *Vector*: 64KB info string.
  - *Expected*: Hashes successfully via HKDF.
- **T2.F04.04**: Requested key length of 0 bytes (`keylen: 0`).
  - *Vector*: `keylen = 0`.
  - *Expected*: Throws RangeError fail-closed.
- **T2.F04.05**: Requested key length exceeding RFC 5869 maximum ($255 \times 64 = 16320$ bytes).
  - *Vector*: `keylen = 20000`.
  - *Expected*: Throws RangeError.

### Feature 5: Authenticated AES-256-GCM Encryption
- **T2.F05.01**: Encrypt massive payload (10MB JSON object).
  - *Vector*: 10MB array of records.
  - *Expected*: Encrypts successfully without heap exhaustion.
- **T2.F05.02**: Encrypt empty payload (`{}` or `null`).
  - *Vector*: `encryptShard({}, key)`.
  - *Expected*: Valid ciphertext generated; decrypts back to `{}`.
- **T2.F05.03**: Integer overflow on sequence `outboundNonce` ($2^{53} - 1$).
  - *Vector*: Initialized nonce at `Number.MAX_SAFE_INTEGER`.
  - *Expected*: Transitions safely to BigInt or triggers safe re-keying rotation.
- **T2.F05.04**: IV collision prevention verification.
  - *Vector*: Generate $10,000$ packets.
  - *Expected*: Zero IV collisions observed across the entire sample.
- **T2.F05.05**: Encryption with corrupted key buffer (31 bytes instead of 32).
  - *Vector*: 31-byte key buffer.
  - *Expected*: Throws InvalidKeyLength error fail-closed.

### Feature 6: Authenticated AES-256-GCM Decryption
- **T2.F06.01**: Truncated ciphertext (empty string `""`).
  - *Vector*: `ciphertext: ''`.
  - *Expected*: Throws authentication error fail-closed.
- **T2.F06.02**: Malformed hex characters in `iv` or `authTag`.
  - *Vector*: Non-hex characters `'0g1234...'`.
  - *Expected*: Throws parsing or decipher error fail-closed.
- **T2.F06.03**: AuthTag length alteration (8 bytes or 32 bytes instead of 16).
  - *Vector*: `authTag` with 16 hex chars (8 bytes).
  - *Expected*: Decryption rejected fail-closed.
- **T2.F06.04**: Bit-flip attack on first byte of ciphertext.
  - *Vector*: Invert least significant bit of first ciphertext byte.
  - *Expected*: Decryption throws authTag verification failure.
- **T2.F06.05**: Decryption of payload containing JSON injection exploit string.
  - *Vector*: Payload containing `{"__proto__": {"admin": true}}`.
  - *Expected*: Decrypted without polluting host prototype.

### Feature 7: Monotonic Anti-Replay Nonces
- **T2.F07.01**: Replay identical packet within milliseconds (rapid burst replay).
  - *Vector*: Send same packet 100 times concurrently in `Promise.all`.
  - *Expected*: Exactly 1 accepted, 99 rejected fail-closed.
- **T2.F07.02**: Nonce gap handling (out-of-order arrival due to UDP/network reordering).
  - *Vector*: Receive nonce 1, then nonce 5, then nonce 3.
  - *Expected*: If strict monotonic, nonce 3 rejected; if sliding window, handled according to window rule.
- **T2.F07.03**: Extreme nonce jump ($1 \to 1,000,000$).
  - *Vector*: Nonce jumps by 1 million.
  - *Expected*: Accepted if monotonic, or rejected if gap exceeds maximum allowable drift.
- **T2.F07.04**: Negative nonce or fractional nonce injection.
  - *Vector*: `nonce = -1` or `nonce = 1.5`.
  - *Expected*: Rejected fail-closed.
- **T2.F07.05**: Nonce memory cleanup on peer disconnect.
  - *Vector*: Disconnect peer; verify tracking memory reclaimed without memory leak.
  - *Expected*: Peer nonce tracker cleared.

### Feature 8: Timestamp Window Drift Validation
- **T2.F08.01**: Timestamp boundary at exactly $-59,999\text{ ms}$ (inside window).
  - *Vector*: `timestamp = Date.now() - 59999`.
  - *Expected*: Accepted.
- **T2.F08.02**: Timestamp boundary at exactly $-60,001\text{ ms}$ (outside window).
  - *Vector*: `timestamp = Date.now() - 60001`.
  - *Expected*: Rejected fail-closed.
- **T2.F08.03**: Future timestamp boundary at exactly $+59,999\text{ ms}$.
  - *Vector*: `timestamp = Date.now() + 59999`.
  - *Expected*: Accepted.
- **T2.F08.04**: Future timestamp boundary at exactly $+60,001\text{ ms}$.
  - *Vector*: `timestamp = Date.now() + 60001`.
  - *Expected*: Rejected fail-closed.
- **T2.F08.05**: Non-numeric or NaN timestamp injection.
  - *Vector*: `timestamp = "now"` or `NaN` or `Infinity`.
  - *Expected*: Rejected fail-closed.

### Feature 9: Deterministic HMAC-SHA256 PoC Attestation
- **T2.F09.01**: Empty `shardId` string.
  - *Vector*: `shardId = ''`.
  - *Expected*: Deterministic HMAC computed over `:${JSON.stringify(data)}`.
- **T2.F09.02**: Result data with circular reference.
  - *Vector*: `const obj = {}; obj.self = obj;`.
  - *Expected*: Handled safely (throws serialization error instead of hanging host).
- **T2.F09.03**: Result data with `undefined` values.
  - *Vector*: `{ a: 1, b: undefined }`.
  - *Expected*: Deterministic JSON serialization ignores undefined keys consistently.
- **T2.F09.04**: Extremely large result dataset (100,000 items).
  - *Vector*: Array of 100k items.
  - *Expected*: Generates valid 64-char hex signature without crash.
- **T2.F09.05**: Null result data.
  - *Vector*: `resultData = null`.
  - *Expected*: Generates HMAC over `${shardId}:null`.

### Feature 10: Constant-Time PoC Signature Verification
- **T2.F10.01**: Signature string containing uppercase hex characters (`A-F` vs `a-f`).
  - *Vector*: Normalized comparison.
  - *Expected*: Validates successfully after case normalization.
- **T2.F10.02**: Signature with trailing or leading whitespace.
  - *Vector*: `'  ' + validSig + '  '`.
  - *Expected*: Rejected or trimmed safely.
- **T2.F10.03**: Non-hex characters inside 64-character signature string.
  - *Vector*: 64 characters containing `'g'`, `'z'`.
  - *Expected*: Verification returns `false` fail-closed.
- **T2.F10.04**: Buffer vs string input for signature.
  - *Vector*: Pass `Buffer.from(validSig, 'hex')`.
  - *Expected*: Supports both string and Buffer representations.
- **T2.F10.05**: High-concurrency verification under simulated timing measurement.
  - *Vector*: Measure verification latency across 1,000 invalid signatures differing at varying positions.
  - *Expected*: Constant-time distribution without statistical divergence.

### Feature 11: Cross-Platform CPU Delta Telemetry
- **T2.F11.01**: Synthetic 0 tick delta (two samples taken at identical millisecond).
  - *Vector*: Injected `deltaTotal = 0`.
  - *Expected*: Guard against division by zero; returns 0.0 or last valid reading.
- **T2.F11.02**: Multi-core system with heterogeneous tick rates.
  - *Vector*: Mock 64-core system where core 0 is 100% busy and cores 1-63 are idle.
  - *Expected*: Accurately averages across all 64 cores ($1/64 \approx 1.56\%$ load).
- **T2.F11.03**: Windows vs Linux/macOS `os.cpus()` schema difference.
  - *Vector*: Handle presence or absence of `irq` or `nice` fields across platforms.
  - *Expected*: Gracefully handles missing tick fields without NaN.
- **T2.F11.04**: Overflowing tick counters (system uptime > 100 days).
  - *Vector*: Tick count exceeding $2^{53} - 1$.
  - *Expected*: Modulo subtraction or BigInt delta calculation handles roll-over.
- **T2.F11.05**: Negative tick delta due to core re-enumeration.
  - *Vector*: Mock delta returning negative.
  - *Expected*: Clamped safely to 0.0.

### Feature 12: Free Memory Headroom Tracker
- **T2.F12.01**: Free memory reports 0 bytes (`os.freemem() === 0`).
  - *Vector*: Simulated complete memory exhaustion.
  - *Expected*: `freeMemRatio = 0.0`, `standbyReady: false`, load-shedding active.
- **T2.F12.02**: Free memory exceeds total memory (aberrant OS reporting).
  - *Vector*: `freemem > totalmem`.
  - *Expected*: Clamped to 1.0 without crash.
- **T2.F12.03**: Total memory reports 0 bytes.
  - *Vector*: `totalmem === 0`.
  - *Expected*: Ratio defaults safely to 0.0.
- **T2.F12.04**: Rapid memory churn (100MB allocated and freed rapidly).
  - *Vector*: Sample tracker during violent memory fluctuation.
  - *Expected*: Tracker produces stable readings without crashing.
- **T2.F12.05**: Negative free memory value (signed integer bug in OS).
  - *Vector*: Negative number from mock.
  - *Expected*: Clamped to 0 bytes.

### Feature 13: Strict 25% CPU Fail-Closed Gating
- **T2.F13.01**: CPU load at 24.999% (just below 25% ceiling).
  - *Vector*: `cpuLoad = 0.24999`.
  - *Expected*: `standbyReady: true`.
- **T2.F13.02**: CPU load at 25.001% (just above 25% ceiling).
  - *Vector*: `cpuLoad = 0.25001`.
  - *Expected*: `standbyReady: false`, load-shedding triggered.
- **T2.F13.03**: Sustained CPU load above 90%.
  - *Vector*: `cpuLoad = 0.95`.
  - *Expected*: Immediate fail-closed rejection of all incoming shards.
- **T2.F13.04**: Oscillation / flapping prevention (rapid switching around 25%).
  - *Vector*: CPU load alternates 24% and 26% every 10ms.
  - *Expected*: Hysteresis or conservative fail-closed rejection prevents task thrashing.
- **T2.F13.05**: Malformed CPU load value (e.g. `NaN`, `null`, `undefined`).
  - *Vector*: Injected invalid telemetry.
  - *Expected*: Fails closed: treats invalid telemetry as unready (`standbyReady: false`).

### Feature 14: Memory Floor Fail-Closed Gating
- **T2.F14.01**: Memory ratio at exactly 9.99% (just below 10% floor).
  - *Vector*: `freeMemRatio = 0.0999`.
  - *Expected*: Rejection fail-closed (`standbyReady: false`).
- **T2.F14.02**: Memory ratio at exactly 10.01% (just above 10% floor).
  - *Vector*: `freeMemRatio = 0.1001`.
  - *Expected*: Gating check passes.
- **T2.F14.03**: Absolute memory threshold check (< 100MB free regardless of ratio).
  - *Vector*: System has 1GB total, 90MB free (ratio 9%).
  - *Expected*: Fail-closed rejection.
- **T2.F14.04**: Memory allocation spike during active shard execution.
  - *Vector*: Memory drops below 10% while worker is running task.
  - *Expected*: Worker completes current task if possible, but rejects all new incoming shards.
- **T2.F14.05**: Non-numeric memory ratio injection.
  - *Vector*: `freeMemRatio = undefined`.
  - *Expected*: Fails closed (`standbyReady: false`).

### Feature 15: Dynamic Task Partitioning
- **T2.F15.01**: Dataset with 1,000,000 items partitioned with chunkSize 50,000.
  - *Vector*: 1M item array.
  - *Expected*: Produces exactly 20 shards efficiently without memory exhaustion.
- **T2.F15.02**: Single item dataset with chunkSize 10.
  - *Vector*: `dataset = [42]`, `chunkSize = 10`.
  - *Expected*: Exactly 1 partition containing `[42]`.
- **T2.F15.03**: Chunk size larger than dataset length.
  - *Vector*: `dataset = [1, 2]`, `chunkSize = 100`.
  - *Expected*: Exactly 1 partition containing `[1, 2]`.
- **T2.F15.04**: Non-array dataset input (object or string).
  - *Vector*: `createTaskPartitions(code, "not-array", 2)`.
  - *Expected*: Throws TypeError fail-closed.
- **T2.F15.05**: Negative or non-integer chunkSize.
  - *Vector*: `chunkSize = -5` or `chunkSize = 2.7`.
  - *Expected*: Throws RangeError fail-closed.

### Feature 16: Fail-Closed Peer Selection & Scoring
- **T2.F16.01**: All peers report identical latency and identical capacity.
  - *Vector*: 10 identical peers.
  - *Expected*: Deterministic tie-breaking by `nodeId` hash sorting.
- **T2.F16.02**: Peer reporting negative latency (-10ms due to clock skew).
  - *Vector*: `latencyMs = -10`.
  - *Expected*: Clamped to 0 or flagged as anomalous.
- **T2.F16.03**: Request count greater than total available nodes.
  - *Vector*: 2 nodes ready, request `count = 5`.
  - *Expected*: Returns all 2 available nodes without throwing error.
- **T2.F16.04**: Rapid peer table churn (100 peers registering and unregistering).
  - *Vector*: Concurrent registration during selection.
  - *Expected*: Selection operates on consistent snapshot without throwing iteration error.
- **T2.F16.05**: Selection with empty task hash string.
  - *Vector*: `selectOptimalNodes('', 1)`.
  - *Expected*: Handled cleanly without error.

### Feature 17: Bounded Task Queue & Rescheduling
- **T2.F17.01**: Max queue overflow attack (flood with 10,000 shards).
  - *Vector*: Exceed queue limit.
  - *Expected*: Bounded queue refuses new tasks, dropping or rejecting cleanly with explicit error.
- **T2.F17.02**: Multiple rescheduling cycles for flaky worker.
  - *Vector*: Worker disconnects 3 times consecutively on same shard.
  - *Expected*: Maximum retry count reached; task marked failed to prevent infinite retry loop.
- **T2.F17.03**: Prioritization of rescheduled tasks over newly queued tasks.
  - *Vector*: Rescheduled task re-inserted at head of queue (LIFO / priority).
  - *Expected*: Rescheduled task dispatched before newer tasks.
- **T2.F17.04**: Task expiration in queue (TTL).
  - *Vector*: Task sits in queue for longer than `maxQueueTimeMs`.
  - *Expected*: Expired task purged, returning timeout to requester.
- **T2.F17.05**: Dequeue from empty queue.
  - *Vector*: `dequeueTask()` when `taskQueue.length === 0`.
  - *Expected*: Returns `null` or `undefined` safely.

### Feature 18: AST / Static Token Pre-Validator
- **T2.F18.01**: Obfuscated global access via `this['pro' + 'cess']`.
  - *Vector*: Dynamic property indexing.
  - *Expected*: Static scanner detects suspicious bracket property access or forbids dynamic member syntax.
- **T2.F18.02**: Access via `Function('return this')()`.
  - *Vector*: Function constructor invocation.
  - *Expected*: Rejected fail-closed by `Function` token check.
- **T2.F18.03**: Access via `Reflect.get(globalThis, 'process')`.
  - *Vector*: Reflect API usage.
  - *Expected*: `Reflect` token forbidden or intercepted.
- **T2.F18.04**: Deep prototype traversal `data.__proto__.__proto__`.
  - *Vector*: Multiple prototype hops.
  - *Expected*: Rejected by `__proto__` detector.
- **T2.F18.05**: Syntax error in task code string.
  - *Vector*: `'return data.map( => );'`.
  - *Expected*: Pre-validator returns `{ valid: false, error: /syntax/i }` before passing to VM.

### Feature 19: Escape Sequence Normalizer
- **T2.F19.01**: Mixed unicode and hex escaping in single token (`\u0070\x72\u006f\x63ess`).
  - *Vector*: Alternating escape styles.
  - *Expected*: Decodes to `'process'` and rejected.
- **T2.F19.02**: Malformed escape sequence (`\u00z1`).
  - *Vector*: Invalid unicode sequence.
  - *Expected*: Fails validation fail-closed due to syntax invalidity.
- **T2.F19.03**: Zero-width space insertion inside forbidden token (`proc\u200Bess`).
  - *Vector*: Zero-width characters (`\u200B`, `\u200C`, `\uFEFF`).
  - *Expected*: Normalizer strips zero-width invisibles before scanner analysis.
- **T2.F19.04**: Null-byte injection inside code string (`process\x00.exit()`).
  - *Vector*: Embedded `\x00`.
  - *Expected*: Stripped or rejected as dangerous character.
- **T2.F19.05**: Overlong UTF-8 sequence.
  - *Vector*: Non-standard UTF-8 encoding.
  - *Expected*: Rejected fail-closed.

### Feature 20: Zero-Privilege VM Isolation Boundary
- **T2.F20.01**: Host object prototype pollution via `Object.prototype.polluted = true`.
  - *Vector*: Code attempting to pollute `Object.prototype`.
  - *Expected*: Fails in sandbox; host `Object.prototype.polluted` remains `undefined`.
- **T2.F20.02**: Escape via `arguments.callee.caller`.
  - *Vector*: Invoking caller chain.
  - *Expected*: Strict mode enforcement blocks `arguments.callee.caller` (throws TypeError).
- **T2.F20.03**: Memory exhaustion inside VM context via string duplication (`'a'.repeat(1e9)`).
  - *Vector*: Allocate giant string.
  - *Expected*: Trapped by VM/V8 heap limits without bringing down Node process.
- **T2.F20.04**: Access to `Symbol.species` or `Symbol.toPrimitive` manipulation.
  - *Vector*: Overriding standard symbols.
  - *Expected*: Context symbols isolated from host V8 environment.
- **T2.F20.05**: Re-entrant execution within sandbox callback.
  - *Vector*: Malicious callback invoking nested VM execution.
  - *Expected*: Execution cleanly isolated.

### Feature 21: Millisecond Execution Timeout Guard
- **T2.F21.01**: Timeout set to 1ms on complex compute.
  - *Vector*: `maxExecutionMs = 1` on factorial of 100,000.
  - *Expected*: Immediate timeout error within 5ms.
- **T2.F21.02**: Regular expression catastrophic backtracking (ReDoS).
  - *Vector*: `'/(x+x+)+y/.test("xxxxxxxxxxxxxxxxxxxxxxxxxxxx")'`.
  - *Expected*: Interrupted cleanly by timeout guard.
- **T2.F21.03**: Infinite loop inside synchronous array reduction (`data.reduce(() => { while(true); })`).
  - *Vector*: Infinite loop in callback.
  - *Expected*: Timeout interrupt fires cleanly.
- **T2.F21.04**: Zero timeout value (`timeout: 0`).
  - *Vector*: `timeout = 0`.
  - *Expected*: Defaults safely to standard minimum (e.g. 1500ms) or rejects.
- **T2.F21.05**: Timeout execution under heavy host CPU load.
  - *Vector*: Test timeout enforcement while host is executing concurrent compute.
  - *Expected*: Timeout interrupt fires reliably within margin of error.

### Feature 22: Worker Threads Memory Resource Limits
- **T2.F22.01**: Rapid creation and destruction of 50 worker threads.
  - *Vector*: Burst of 50 short-lived workers.
  - *Expected*: All workers terminate cleanly; zero leaked threads or handles.
- **T2.F22.02**: Worker allocation right at the 64MB boundary.
  - *Vector*: Allocate 63MB vs 65MB.
  - *Expected*: 63MB succeeds; 65MB triggers OOM rejection without parent crash.
- **T2.F22.03**: Abrupt worker thread termination during active message transfer.
  - *Vector*: Terminate worker thread while reading output buffer.
  - *Expected*: Handled via error event on worker without uncaught promise rejection.
- **T2.F22.04**: Worker thread deadlock via synchronous blocking syscall.
  - *Vector*: Worker thread in infinite loop.
  - *Expected*: Force-terminated via `worker.terminate()` when timeout elapses.
- **T2.F22.05**: Worker serialization error on complex circular output.
  - *Vector*: Worker returns un-serializable output.
  - *Expected*: Caught and converted to descriptive error.

### Feature 23: Deterministic State Virtualization
- **T2.F23.01**: Attempt to call `Math.random()` 100 times in deterministic shard.
  - *Vector*: Shard calling `Math.random()`.
  - *Expected*: Returns either fixed constant or seeded PRNG sequence identical on repeated runs.
- **T2.F23.02**: Mutate nested frozen sub-properties (`data[0].nested.val = 123`).
  - *Vector*: Deep property mutation.
  - *Expected*: Deep freeze prevents alteration at any level of nesting.
- **T2.F23.03**: Host timezone dependency (`new Date().getTimezoneOffset()`).
  - *Vector*: Execute in different simulated timezone offsets.
  - *Expected*: Virtualized to UTC (offset 0) to ensure cross-node determinism.
- **T2.F23.04**: Object key order invariance.
  - *Vector*: Output `{ z: 1, a: 2 }` vs `{ a: 2, z: 1 }`.
  - *Expected*: Canonicalized serialization treats as identical.
- **T2.F23.05**: Floating point math variance across platforms.
  - *Vector*: IEEE 754 precision boundary calculations.
  - *Expected*: Consistent 64-bit float math results across runs.

### Feature 24: Native P2P TCP Daemon (`src/node.js`)
- **T2.F24.01**: Connect to unreachable host/port (connection refused).
  - *Vector*: `client.connect({ host: '127.0.0.1', port: 1 })`.
  - *Expected*: Promise rejects cleanly with `ECONNREFUSED` error; no uncaught exceptions.
- **T2.F24.02**: Half-open TCP connection (remote terminates abruptly).
  - *Vector*: Socket emits `end` or `close` before handshake.
  - *Expected*: Peer removed from active map; resources freed.
- **T2.F24.03**: Rapid TCP connection spam (SYN flood simulation).
  - *Vector*: Open 100 connections in 10ms.
  - *Expected*: Server accepts or queues within backlog without crashing.
- **T2.F24.04**: Sending data on closed or destroyed socket.
  - *Vector*: `socket.destroy(); node.sendEncryptedMessage(...)`.
  - *Expected*: Rejects cleanly with SocketDestroyed error.
- **T2.F24.05**: IPv4 vs IPv6 loopback binding resolution.
  - *Vector*: Binding to `localhost` vs `127.0.0.1`.
  - *Expected*: Explicit `127.0.0.1` prevents IPv4/IPv6 dual-stack resolution ambiguities.

### Feature 25: Ephemeral Loopback Dynamic Port Binding
- **T2.F25.01**: Bind to already-bound static port (e.g. port 80 or conflict).
  - *Vector*: Port collision simulation.
  - *Expected*: `EADDRINUSE` caught and handled cleanly.
- **T2.F25.02**: Port 0 allocation on system with exhausted ephemeral port range.
  - *Vector*: Mock server `listen` error.
  - *Expected*: Gracefully attempts retry or transitions to local IPC pipe.
- **T2.F25.03**: Accessing port before `listen` promise resolves.
  - *Vector*: Query `node.port` synchronously before listen finishes.
  - *Expected*: Returns null or undefined until resolved; no invalid port returned.
- **T2.F25.04**: Multiple consecutive listen calls on same node instance.
  - *Vector*: Call `node.listen()` twice.
  - *Expected*: Second call returns existing address or throws `AlreadyListeningError`.
- **T2.F25.05**: Named pipe path collision in IPC mode.
  - *Vector*: Two instances attempting to bind to identical pipe path.
  - *Expected*: Random UUID suffix ensures zero pipe collision.

### Feature 26: Length-Prefixed / Delimited Wire Stream Framing
- **T2.F26.01**: Zero-length payload frame (`length = 0`).
  - *Vector*: 4 bytes of `0x00000000`.
  - *Expected*: Handled cleanly (ignored or treated as keepalive heartbeat).
- **T2.F26.02**: Incomplete length header (only 2 bytes received before connection drop).
  - *Vector*: Send 2 bytes and close socket.
  - *Expected*: Socket closes cleanly; partial buffer discarded without memory leak.
- **T2.F26.03**: Giant frame payload claim (4GB length).
  - *Vector*: Claim length $2^{32} - 1$.
  - *Expected*: Exceeds max message size; socket destroyed fail-closed.
- **T2.F26.04**: Malformed JSON inside valid length-prefixed frame.
  - *Vector*: Valid 4-byte header followed by `{ invalid json...`.
  - *Expected*: Frame parser catches JSON parse error; emits error or drops frame safely.
- **T2.F26.05**: Continuous single-byte streaming (slowloris framing test).
  - *Vector*: Feed 1 byte every 10ms.
  - *Expected*: Frame accumulates correctly until full length received.

### Feature 27: Live Ephemeral ECDH Wire Handshake
- **T2.F27.01**: Invalid handshake message type (send `DATA` before `HANDSHAKE`).
  - *Vector*: Send shard payload prior to completing handshake.
  - *Expected*: Rejected fail-closed; unauthenticated packet dropped.
- **T2.F27.02**: Handshake with corrupt public key bytes over wire.
  - *Vector*: Send random 130 bytes.
  - *Expected*: Handshake fails; socket closed.
- **T2.F27.03**: Simultaneous bidirectional handshake (both nodes initiate concurrently).
  - *Vector*: Node A connects to Node B while Node B connects to Node A.
  - *Expected*: Deterministic tie-breaking (e.g. higher `nodeId` wins) prevents dual connection deadlock.
- **T2.F27.04**: Replayed `HANDSHAKE` message with stale timestamp.
  - *Vector*: Send previously captured handshake frame.
  - *Expected*: Stale timestamp rejected; new ephemeral key required.
- **T2.F27.05**: Man-in-the-middle public key replacement over wire.
  - *Vector*: Intercept and swap public key with Attacker key.
  - *Expected*: Shared secret divergence prevents any subsequent authenticated decryption.

### Feature 28: Encrypted Shard Streaming & Result Return
- **T2.F28.01**: Bit-flipped ciphertext injected during socket transit.
  - *Vector*: Proxy flips 1 bit in transit.
  - *Expected*: Worker decryption fails authentication tag; error returned.
- **T2.F28.02**: Worker returns result for wrong `shardId`.
  - *Vector*: Worker signs and returns result with mismatched `shardId`.
  - *Expected*: Requester rejects result due to shard correlation mismatch.
- **T2.F28.03**: Extremely slow worker execution (execution hangs).
  - *Vector*: Worker takes longer than requester's shard timeout.
  - *Expected*: Requester times out shard, marks worker unresponsive, and reschedules.
- **T2.F28.04**: Worker crashes mid-shard execution (SIGTERM / abrupt exit).
  - *Vector*: Worker process killed during compute.
  - *Expected*: Requester detects socket disconnect and reschedules shard.
- **T2.F28.05**: Concurrent streaming of 1,000 micro-shards across loopback.
  - *Vector*: Stress test streaming pipeline with 1,000 shards.
  - *Expected*: 100% of shards delivered, executed, signed, and collected.

### Feature 29: Proof-of-Compute Work Metering
- **T2.F29.01**: Negative execution time injection ($T = -50\text{ ms}$).
  - *Vector*: `calculateCredit(-50, 10)`.
  - *Expected*: Clamped to 0 or throws RangeError fail-closed.
- **T2.F29.02**: Fractional milliseconds ($T = 0.0001\text{ ms}$).
  - *Vector*: Sub-millisecond compute.
  - *Expected*: Rounded or calculated with standard float precision.
- **T2.F29.03**: Huge execution time ($T = 1,000,000,000\text{ ms}$).
  - *Vector*: Multi-day compute claim.
  - *Expected*: Capped by maximum allowable shard execution ceiling ($1500\text{ ms}$).
- **T2.F29.04**: Huge input size ($S = 10^9$ items).
  - *Vector*: Massive claimed input size.
  - *Expected*: Validated against actual partition record count before credit assignment.
- **T2.F29.05**: Non-numeric arguments to `calculateCredit`.
  - *Vector*: `calculateCredit("fast", {})`.
  - *Expected*: Throws TypeError fail-closed.

### Feature 30: Anti-Replay Double-Spend Prevention
- **T2.F30.01**: Concurrent double-spend attempt (race condition).
  - *Vector*: Submit same verified attestation in 50 concurrent async promises.
  - *Expected*: Exactly 1 settlement succeeds; 49 reject fail-closed.
- **T2.F30.02**: Replay settled attestation after ledger restart / reload.
  - *Vector*: Restart ledger instance with persisted settled set.
  - *Expected*: Previously settled attestation remains rejected.
- **T2.F30.03**: Attestation with modified `resultData` but identical `shardId` and signature.
  - *Vector*: Tamper result data.
  - *Expected*: HMAC verification fails before settlement.
- **T2.F30.04**: Attestation with modified `shardId` but identical result data.
  - *Vector*: Alter shard ID.
  - *Expected*: HMAC verification fails.
- **T2.F30.05**: Empty string or null attestation key.
  - *Vector*: `attestationKey = ''`.
  - *Expected*: Rejected fail-closed.

### Feature 31: Fail-Closed Account Balance Enforcement
- **T2.F31.01**: Requester balance exactly equals workload cost.
  - *Vector*: Balance = 50, Cost = 50.
  - *Expected*: Dispatch permitted; balance reduces to exactly 0.
- **T2.F31.02**: Requester balance is 1 unit below workload cost.
  - *Vector*: Balance = 49, Cost = 50.
  - *Expected*: Dispatch rejected fail-closed; zero debited.
- **T2.F31.03**: Floating point balance precision test (avoid 0.1 + 0.2 != 0.3 bug).
  - *Vector*: Balance operations with fractional credits.
  - *Expected*: Decimal or integer-scaled math prevents precision drift.
- **T2.F31.04**: Debit non-existent requester account.
  - *Vector*: Unknown `nodeId`.
  - *Expected*: Throws UnknownAccountError fail-closed.
- **T2.F31.05**: Credit overflow test (worker balance reaches `Number.MAX_SAFE_INTEGER`).
  - *Vector*: Balance approaching maximum safe integer.
  - *Expected*: Capped or handled via BigInt safely.

### Feature 32: Comprehensive Verification Suite (100% Pass)
- **T2.F32.01**: Test execution under simulated resource constraint.
  - *Vector*: Run test suite with `--max-old-space-size=128`.
  - *Expected*: Test suite passes without memory exhaustion.
- **T2.F32.02**: Test execution with zero network connectivity (offline air-gap).
  - *Vector*: Disable external socket calls (strict loopback only).
  - *Expected*: 100% of tests pass without requiring WAN access.
- **T2.F32.03**: Rapid sequential execution of test suite 5 times.
  - *Vector*: Loop `npm test` 5 times in CI script.
  - *Expected*: 5/5 passes with zero flaky failures.
- **T2.F32.04**: Interrupted test run SIGINT handling.
  - *Vector*: Send SIGINT during test run.
  - *Expected*: Active servers and child processes clean up gracefully.
- **T2.F32.05**: Syntax verification on empty file or commented-out file.
  - *Vector*: `node --check` edge cases.
  - *Expected*: Accurately differentiates valid from invalid syntax.

---

## 7. Tier 3: Cross-Feature Interactions (Pairwise & Multi-Module Combinations)

Tier 3 validates integration contracts across module boundaries.

### Interaction Flow 3.1: Ultra Crypto $\times$ Grid Router (Encrypted Shard Pipeline)
- **Features Tested**: F03, F04, F05, F06, F15, F16
- **Test Objective**: Verify that partitions generated by `GridRouter` are seamlessly encrypted using `MeshCryptoEngine` session keys derived via ECDH + HKDF, routed to scored peers, and decrypted without data loss.
- **Execution Steps**:
  1. Initialize `coordinator` and `worker` crypto engines.
  2. Derive shared HKDF session keys on both nodes.
  3. Router on coordinator partitions dataset `[10, 20, 30, 40]` into 2 shards.
  4. Encrypt Shard 0 using session key.
  5. Decrypt Shard 0 on worker.
  6. Assert decrypted payload matches original partitioned shard data.
- **Assertion**:
  ```js
  assert.deepStrictEqual(decryptedShard.inputData, [10, 20]);
  assert.strictEqual(decryptedShard.shardId, originalShard.shardId);
  ```

### Interaction Flow 3.2: Grid Router $\times$ Standby Sandbox (Telemetry-Gated Execution)
- **Features Tested**: F11, F12, F13, F14, F20, F21
- **Test Objective**: Verify that the router rejects task dispatch whenever the sandbox reports host CPU load > 25% or memory ratio < 10%, but permits execution when nominal.
- **Execution Steps**:
  1. Initialize `GridRouter` and `StandbySandbox`.
  2. In nominal conditions (CPU < 25%), router accepts shard and sandbox executes it.
  3. Inject simulated CPU load spike (35%) into telemetry engine.
  4. Router attempts to select worker node; receives empty array `[]` fail-closed.
  5. Shard is queued instead of dropped; sandbox is never invoked with unready state.
- **Assertion**:
  ```js
  assert.strictEqual(router.selectOptimalNodes('task-hash', 1).length, 0);
  assert.strictEqual(router.taskQueue.length, 1);
  ```

### Interaction Flow 3.3: Standby Sandbox $\times$ Proof-of-Compute $\times$ Economic Ledger (Verified Settlement)
- **Features Tested**: F09, F10, F20, F23, F29, F30, F31
- **Test Objective**: Verify that deterministic sandbox execution produces verified PoC signatures that are validated by the economic ledger to settle credit debits and credits accurately.
- **Execution Steps**:
  1. Initialize sandbox, crypto engine, and ledger with Requester balance 100.
  2. Sandbox executes shard `'return data.reduce((a, b) => a + b, 0);'` on `[5, 15]`.
  3. Worker signs PoC HMAC over `shardId` and output `20`.
  4. Ledger verifies PoC signature using worker's public key.
  5. Ledger credits worker and debits requester.
  6. Attempt to submit identical attestation again; assert double-spend rejection.
- **Assertion**:
  ```js
  assert.strictEqual(settleResult.settled, true);
  assert.strictEqual(ledger.getBalance(workerId), initialWorkerBal + settleResult.cost);
  assert.strictEqual(ledger.getBalance(reqId), 100 - settleResult.cost);
  assert.throws(() => ledger.verifyAndSettle(settleParams)); // Double spend
  ```

### Interaction Flow 3.4: Live P2P Node $\times$ Wire Protocol $\times$ ECDH Handshake
- **Features Tested**: F24, F25, F26, F27, F04, F07
- **Test Objective**: Establish live TCP connection over loopback dynamic port 0, execute full ECDH handshake with HKDF-SHA512 session key rotation, and stream length-prefixed encrypted packets with anti-replay nonce tracking.
- **Execution Steps**:
  1. Node A (Requester) and Node B (Worker) bind to dynamic port 0 on `127.0.0.1`.
  2. Node A connects to Node B's ephemeral port.
  3. Perform live two-way `HANDSHAKE` / `HANDSHAKE_ACK` exchange.
  4. Node A sends length-prefixed encrypted message.
  5. Node B parses frame, validates nonce, decrypts message, and verifies content.
  6. Replay identical raw wire buffer; verify Node B rejects wire frame due to anti-replay nonce.
- **Assertion**:
  ```js
  assert.strictEqual(decryptedWireMsg.text, 'secure-payload');
  assert.strictEqual(replayValidationResult, false);
  ```

### Interaction Flow 3.5: Full End-to-End Mesh Grid Pipeline (All Modules)
- **Features Tested**: F01 through F32
- **Test Objective**: Execute full end-to-end grid compute cycle: dataset partitioning, peer discovery, live TCP ECDH session establishment, encrypted shard streaming, sandbox execution with AST pre-validation, PoC attestation, result streaming, and ledger settlement.
- **Execution Steps**:
  1. Setup Coordinator Node, 2 Standby Worker Nodes, and 1 Ledger.
  2. Start P2P daemons on dynamic ports.
  3. Handshake and session key derivation over live sockets.
  4. Coordinator partitions dataset `[10, 20, 30, 40, 50, 60]` into 3 shards.
  5. Dispatch shards over encrypted TCP streams to Worker 1 and Worker 2.
  6. Workers pre-validate code (AST), execute in isolated sandboxes, sign PoC HMACs.
  7. Workers stream back encrypted results over TCP.
  8. Coordinator decrypts results, aggregates outputs: `[100, 400, 900, 1600, 2500, 3600]`.
  9. Ledger settles credit debits from Coordinator to Workers; anti-replay verified.
  10. Graceful teardown of all P2P nodes.
- **Assertion**:
  ```js
  assert.deepStrictEqual(finalAggregatedOutput, [100, 400, 900, 1600, 2500, 3600]);
  assert.ok(ledger.getBalance(worker1Id) > 0);
  assert.ok(ledger.getBalance(worker2Id) > 0);
  ```

---

## 8. Tier 4: Real-World Workload Scenarios & Grid Simulations

Tier 4 exercises multi-node distributed grid dynamics, failure modes, adversarial attacks, and scale.

### Scenario 4.1: Heterogeneous 5-Node Distributed Compute Grid
- **Cluster Architecture**:
  - 1 Coordinator / Requester Node (Client)
  - 3 Standby Worker Nodes (Worker A: low latency 10ms; Worker B: medium latency 25ms; Worker C: higher latency 45ms)
  - 1 Proof-of-Compute Ledger
- **Workload**: Map-reduce matrix computation across 1,000 dataset elements.
- **Expected Dynamics**:
  - Coordinator dynamically partitions workload into 50 micro-shards.
  - Router ranks peers and dispatches shards proportionally according to latency and capacity.
  - All 50 shards are executed in isolated sandboxes, signed, returned, and aggregated.
  - Output matches monolithic reference computation exactly:
    $$\sum_{i=1}^{1000} (\text{item}_i^2 + 42)$$
  - Ledger balance conservation strictly preserved:
    $$\Delta \text{CoordinatorBalance} = -(\Delta \text{WorkerA} + \Delta \text{WorkerB} + \Delta \text{WorkerC})$$

### Scenario 4.2: Dynamic Load-Shedding, Churn & Worker Failover
- **Cluster Architecture**:
  - 1 Coordinator Node
  - 2 Worker Nodes (Worker 1 and Worker 2)
- **Workload**: Batch of 20 shards dispatched sequentially.
- **Perturbation**:
  - During execution of Shard 5, Worker 1 simulates a sudden CPU load surge (CPU utilization jumps to 85% via telemetry injector).
  - Telemetry heartbeat informs router of load-shedding state.
  - During execution of Shard 10, Worker 2 socket is abruptly terminated (hard network failure).
- **Expected Behavior**:
  - Router immediately marks Worker 1 `standbyReady: false`, diverting subsequent shards away from Worker 1.
  - Shards assigned to Worker 2 when it abruptly disconnects are automatically recovered and rescheduled to the bounded FIFO queue.
  - Coordinator queues shards safely without dropping any task or hanging.
  - Once Worker 1 CPU cools below 25%, router detects availability and resumes dispatch.
  - 100% of the 20 shards eventually complete successfully with zero task loss.

### Scenario 4.3: Adversarial AST Injection & Sandbox Containment
- **Cluster Architecture**:
  - 1 Coordinator Node
  - 1 Worker Node running zero-trust sandbox
- **Attack Vectors**:
  - Injected Shard 1: Code attempting to read `process.env`.
  - Injected Shard 2: Code using obfuscated unicode escape sequences (`\u0070\u0072\u006f\u0063\u0065\u0073\u0073`).
  - Injected Shard 3: Code attempting prototype pollution on `Object.prototype`.
  - Injected Shard 4: Code entering synchronous infinite loop (`while(true){}`).
  - Injected Shard 5: Code attempting memory exhaustion via array expansion.
- **Expected Behavior**:
  - Shards 1 and 2: Static pre-validator rejects code before VM invocation with explicit error.
  - Shard 3: Trapped by frozen VM context; host prototype remains clean.
  - Shard 4: Interrupted by 1500ms timeout guard; worker returns timeout error.
  - Shard 5: Trapped by worker thread memory limit (64MB) without parent crash.
  - In all cases, the worker node remains healthy, stable, and ready to process subsequent legitimate tasks.

### Scenario 4.4: Wire Packet Tampering, Nonce Replay & Man-in-the-Middle Defense
- **Cluster Architecture**:
  - Requester Node, Worker Node, Adversary Proxy Tap on Loopback Socket.
- **Attack Vectors**:
  - Adversary captures encrypted shard frame from wire and replays it 500ms later.
  - Adversary flips 1 bit in encrypted payload ciphertext.
  - Adversary tampers with the 16-byte authentication tag.
  - Adversary manipulates the frame timestamp to $T - 120\text{ seconds}$.
- **Expected Behavior**:
  - Replay Attack: Rejected fail-closed by monotonic sequence nonce validator.
  - Ciphertext & Tag Tampering: Decryption throws authentication tag mismatch; socket remains uncorrupted.
  - Stale Timestamp: Rejected fail-closed by timestamp window validator ($\pm 60\text{ s}$).
  - Zero unauthenticated computations executed; zero credit disbursed.

### Scenario 4.5: High-Throughput Burst Grid with Ledger Settlement
- **Cluster Architecture**:
  - 1 Coordinator, 4 Worker Nodes, 1 Economic Ledger.
- **Workload**:
  - Burst dispatch of 200 concurrent micro-shards across all 4 worker nodes.
- **Expected Behavior**:
  - High-throughput asynchronous TCP streaming over loopback connections.
  - All 200 shards executed, signed, and results collected within $< 5\text{ seconds}$.
  - 200 distinct Proof-of-Compute attestations submitted to the ledger.
  - Zero double-spend collisions; all 200 settled cleanly.
  - Total debited from Coordinator equals exact sum of credits earned by the 4 workers.
  - System verifies 100% data fidelity and zero memory leakage.

---

## 9. Baseline Invariant Preservation & R1–R7 Verification Assertion Mapping

### 9.1 Baseline Invariant Preservation Matrix
The 5 foundational assertions from v0.4.2 are mapped directly into the suite architecture:

| Baseline Assertion | Location in `test/mesh.test.js` | Verification Method | Preservation Status |
|---|---|---|---|
| **Invariant 1** | Lines 9–15 | `assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'))` | Preserved verbatim in Stage 1 / Feature 2 |
| **Invariant 2** | Lines 17–21 | `assert.strictEqual(tasks.length, 2)` | Preserved verbatim in Stage 2 / Feature 2 |
| **Invariant 3** | Lines 23–27 | `assert.deepStrictEqual(decryptedPacket.inputData, [1, 2])` | Preserved verbatim in Stage 3 / Feature 2 |
| **Invariant 4** | Lines 29–33 | `assert.strictEqual(execResult.output, 3)` | Preserved verbatim in Stage 4 / Feature 2 |
| **Invariant 5** | Lines 35–39 | `assert.strictEqual(proof.length, 64)` | Preserved verbatim in Stage 5 / Feature 2 |

### 9.2 Requirements Verification Assertion Mapping (R1–R7)

```
========================================================================================
REQUIREMENT  MODULE / TARGET          KEY ASSERTION SUITE IN TEST ARCHITECTURE
========================================================================================
R1           Root / package.json      - 0 external dependencies in package.json
Baseline                              - node --check passes on all src/*.js
Integrity                             - All 5 baseline invariants in test/mesh.test.js pass
----------------------------------------------------------------------------------------
R2           src/router.js            - os.cpus() tick delta calculation across cores
Telemetry &                           - Free memory ratio and headroom tracking
Fail-Closed                           - Strict fail-closed rejection at CPU > 25% (0.25)
Gating                                - Fail-closed rejection at memory ratio < 10% (0.10)
                                      - Optimal peer selection scoring & empty return fail-closed
                                      - Bounded FIFO task queue and disconnect rescheduling
----------------------------------------------------------------------------------------
R3           src/crypto.js            - Ephemeral prime256v1 ECDH keypair & 40-char nodeId
Ultra Crypto                          - HKDF-SHA512 key derivation & per-epoch session rotation
& Wire                                - Authenticated AES-256-GCM (12-byte IV, 16-byte tag)
Protocol                              - Monotonically increasing anti-replay wire nonces
                                      - Timestamp window drift validation (±60,000 ms)
                                      - Deterministic HMAC-SHA256 PoC attestation
                                      - Constant-time verification via crypto.timingSafeEqual
----------------------------------------------------------------------------------------
R4           src/sandbox.js           - AST / static token rejection (process, require, eval, ...)
Zero-Trust                            - Unicode and hex escape sequence normalization
Sandbox                               - Zero-privilege VM context with null/frozen prototypes
Hardening                             - Millisecond execution timeout guard against infinite loops
                                      - Worker threads memory caps (64MB) trapping OOM safely
                                      - Deterministic state virtualization & deep freeze
----------------------------------------------------------------------------------------
R5           src/node.js              - Native node:net P2PNode daemon on configurable host/port
Live P2P                              - Dynamic port 0 ephemeral loopback binding (127.0.0.1)
Transport                             - Length-prefixed 4-byte big-endian wire stream framing
                                      - Live two-way ECDH handshake establishing session keys
                                      - AES-256-GCM encrypted shard streaming & result return
----------------------------------------------------------------------------------------
R6           src/ledger.js            - Proof-of-Compute work metering: Credit = f(T_ms, S)
Economic                              - Anti-replay double-spend rejection of settled proofs
Ledger                                - Fail-closed balance enforcement & pre-dispatch debit check
                                      - Zero negative balance invariant across all accounts
----------------------------------------------------------------------------------------
R7           test/mesh.test.js        - Unified test runner passes 100% assertions
Verification                          - Execution via `npm test` and `node --test`
Suite                                 - Clean exit code 0 under standard Node.js v18+
========================================================================================
```

---

## 10. Test Execution, CI Integration & Syntax Validation

### 10.1 Execution Commands
Developers and CI pipelines execute the verification suite using the following standard commands:

1. **Full Verification Suite**:
   ```bash
   npm test
   ```
2. **Native Node.js Test Runner Execution**:
   ```bash
   node --test test/mesh.test.js
   ```
3. **Direct Script Execution**:
   ```bash
   node test/mesh.test.js
   ```
4. **Codebase Syntax Cleanliness Check**:
   ```bash
   node --check src/index.js src/crypto.js src/sandbox.js src/router.js src/node.js src/ledger.js
   ```
5. **Simulation Sanity Check**:
   ```bash
   node src/index.js
   ```

### 10.2 CI / CD Integration Pipeline
In `.github/workflows/ci.yml`, the pipeline runs on Ubuntu, macOS, and Windows runners across Node.js versions 18, 20, and 24:
```yaml
name: Open-Side Protocol CI
on: [push, pull_request]

jobs:
  verify:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node-version: [18.x, 20.x, 22.x, 24.x]
    steps:
      - uses: actions/checkout@v4
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - name: Syntax Check
        run: node --check src/index.js src/crypto.js src/sandbox.js src/router.js src/node.js src/ledger.js
      - name: Run E2E Verification Suite
        run: npm test
```

### 10.3 Defect Escalation & QA Protocols
- When any test fails during milestone implementation:
  1. Determine whether the failure indicates an implementation defect or a test specification error.
  2. If implementation code violates the interface contract, create an explicit defect escalation report documenting:
     - Exact failing test ID and invariant.
     - Observed vs. Expected output derivation.
     - Minimal reproduction script.
  3. Under strict QA rules, the test writer does **not** modify `src/` implementation files; fixes must be applied by the implementing agent.
  4. Once resolved, re-run `npm test` to verify zero regression across baseline and new feature tiers.

---
*Open-Side Protocol Universal Standard — Authoritative Test Infrastructure Architecture v1.0.0*
