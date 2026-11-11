# Architectural Design, Module Boundaries & Interface Contracts Investigation

## 1. Observation

### 1.1 Filesystem & Repository Root
- Direct inspection via PowerShell confirmed the repository root is `c:\Users\pc120\Documents\REPO` (not a subfolder `Open-Side`).
- Existing files verified:
  - `package.json`: CommonJS, `"engines": { "node": ">=18.0.0" }`, zero dependencies, scripts: `"start": "node src/index.js"`, `"test": "node test/mesh.test.js"`.
  - `src/crypto.js` (42 lines): Implements `MeshCryptoEngine` with ECDH `prime256v1`, SHA-256 shared key derivation, AES-256-GCM encryption/decryption, and HMAC-SHA256 PoC signing.
  - `src/sandbox.js` (48 lines): Implements `StandbySandbox` with `isDeviceInStandby()` (using `os.loadavg()[0]` and `os.freemem() / os.totalmem()`) and `executeIsolatedShard()` using `node:vm` contexts with synchronous timeout.
  - `src/router.js` (42 lines): Implements `GridRouter` with `registerPeer()`, `selectOptimalNodes()`, and `createTaskPartitions()` generating SHA-256 partition IDs.
  - `src/index.js` (30 lines): End-to-end simulation executing 4 tasks across coordinator, worker, sandbox, and crypto engine.
  - `test/mesh.test.js` (48 lines): Contains 5 baseline integrity tests (`npm test` passes 5/5, exit code 0).
  - Target files to be created: `src/node.js` (R5: P2P transport daemon) and `src/ledger.js` (R6: Proof-of-Compute economic ledger).

### 1.2 Node.js Core Runtime Environment
Command:
```powershell
node -e "console.log(JSON.stringify({ version: process.version, hkdfSync: typeof require('node:crypto').hkdfSync, hkdf: typeof require('node:crypto').hkdf, ecdh: typeof require('node:crypto').createECDH, vm: typeof require('node:vm').createContext, net: typeof require('node:net').createServer, osLoadavg: typeof require('node:os').loadavg, osCpus: typeof require('node:os').cpus, worker: typeof require('node:worker_threads').Worker, nodeTest: typeof require('node:test') }))"
```
Output:
```json
{"version":"v24.22.1","hkdfSync":"function","hkdf":"function","ecdh":"function","vm":"function","net":"function","osLoadavg":"function","osCpus":"function","worker":"function","nodeTest":"function"}
```

### 1.3 Native API Behavioral Observations & Constraints

1. **`crypto.hkdfSync` return type constraint**:
   - Command:
     ```javascript
     const key = crypto.hkdfSync('sha512', ikm, salt, info, 32);
     ```
   - Observation: In Node.js, `crypto.hkdfSync` returns an `ArrayBuffer` rather than a `Buffer`.
   - Tool result: `key.length` is `undefined`, type is `[object ArrayBuffer]`.
   - Resolution verified: `Buffer.from(crypto.hkdfSync('sha512', ikm, salt, info, 32))` produces a standard 32-byte `Buffer` accepted by `createCipheriv('aes-256-gcm', key, iv)`.

2. **Windows Telemetry constraint (`os.loadavg()`)**:
   - Command:
     ```javascript
     console.log('loadavg:', os.loadavg(), 'freemem:', os.freemem(), 'totalmem:', os.totalmem(), 'cpus count:', os.cpus().length);
     ```
   - Output: `loadavg: [ 0, 0, 0 ] freemem: 342069248 totalmem: 4180893696 cpus count: 4`
   - Observation: On Windows, `os.loadavg()` always returns `[0, 0, 0]`. Current baseline `isDeviceInStandby()` computes `normalizedLoad = 0` on Windows, which fails to track real CPU load.
   - Resolution verified: Calculating delta ticks across `os.cpus()` (`times.idle` vs `times.total`) provides real-time CPU load (verified: measured delta 39.08% CPU load under activity).

3. **`node:worker_threads` memory limit trapping**:
   - Command tested: `new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 16 } })`
   - Output observed: Worker terminated cleanly on OOM:
     `OOM caught: Worker terminated due to reaching memory limit: JS heap out of memory, exit code: 1`
   - Observation: Worker threads with `resourceLimits` trap heap exhaustion safely without crashing the main Node.js process.

4. **Windows Sandboxed TCP Socket connect constraint (`EACCES`)**:
   - Command tested: `net.createConnection(port, '127.0.0.1')` without elevated bypass.
   - Verbatim error: `Error: connect EACCES 127.0.0.1:50788` (errno: -4092).
   - Comparative test with IPC Named Pipe: `net.createServer().listen('\\\\.\\pipe\\test-pipe')` and `net.createConnection('\\\\.\\pipe\\test-pipe')`.
   - Result: Connected immediately with exit code 0 (`Pipe connected!`).
   - Resolution: `src/node.js` transport should support both TCP endpoints (`{ host, port }`) and IPC socket/pipe endpoints (`{ path }`), or duplex stream fallback, ensuring reliable test execution in sandboxed Windows environments while maintaining standard TCP for production and Ubuntu CI.

---

## 2. Logic Chain

### 2.1 Backward Compatibility Preservation
- **Observation**: `test/mesh.test.js` asserts 5 invariants using specific synchronous calls:
  1. `const keyA = nodeA.deriveSharedKey(nodeB.publicKey); assert.strictEqual(keyA.toString('hex'), keyB.toString('hex'))`
  2. `const tasks = router.createTaskPartitions('return data.reduce((a, b) => a + b, 0);', [1, 2, 3, 4], 2); assert.strictEqual(tasks.length, 2)`
  3. `const encryptedPacket = nodeA.encryptShard(tasks[0], keyA); const decryptedPacket = nodeB.decryptShard(encryptedPacket, keyB); assert.deepStrictEqual(decryptedPacket.inputData, [1, 2])`
  4. `const sandbox = new StandbySandbox(); const execResult = sandbox.executeIsolatedShard(decryptedPacket); assert.strictEqual(execResult.output, 3)`
  5. `const proof = nodeB.signProofOfCompute(tasks[0].shardId, execResult.output); assert.strictEqual(typeof proof, 'string'); assert.strictEqual(proof.length, 64)`
- **Inference**:
  - `deriveSharedKey(peerPublicKeyHex)` must remain intact and return a 32-byte `Buffer`. New HKDF-SHA512 session rotation can be exposed via `deriveSessionKey(peerPublicKeyHex, options)` while allowing optional salt/info in `deriveSharedKey`.
  - `encryptShard(payloadObj, sharedKeyBuffer)` must accept existing parameters while accepting optional `{ nonce, timestamp }`.
  - `decryptShard(encryptedPacket, sharedKeyBuffer)` must continue returning the decrypted JSON payload directly while supporting optional replay validation.
  - `executeIsolatedShard(shard)` must continue executing synchronously and returning `{ shardId, output, executionTimeMs }`. Async worker thread execution can be exposed via `executeIsolatedShardAsync(shard)`.
  - `signProofOfCompute(shardId, resultData, secret = this.publicKey)` must default to `this.publicKey` to preserve the 64-char hex HMAC baseline assertion while supporting session key secrets.

### 2.2 Architectural Module Boundaries & Responsibilities

| Module | Core Responsibility | Native Core APIs | Boundary Interactions |
|---|---|---|---|
| `src/crypto.js` | Ephemeral ECDH, HKDF-SHA512 key rotation, AES-256-GCM authenticated cipher, HMAC-SHA256 PoC signatures, anti-replay nonces & timestamp validation | `node:crypto` | Provides crypto primitives to `node.js` (wire crypto), `router.js` (shard ID hashing & encryption), and `ledger.js` (PoC attestation verification) |
| `src/sandbox.js` | Zero-trust execution sandbox, AST / static token pre-validation, frozen determinism, memory caps & execution timeouts | `node:vm`, `node:worker_threads` | Invoked by worker node daemon (`node.js` / `router.js`) to execute decrypted shard code safely |
| `src/router.js` | Real-time hardware telemetry (`os.cpus()` deltas & memory), fail-closed load-shedding states, deterministic task partitioning & result aggregation | `node:os`, `node:crypto` | Manages node state, decides whether to accept or shed compute shards, partitions data into shards, feeds worker nodes, aggregates outputs |
| `src/node.js` | P2P daemon, length-prefixed JSON wire framing, connection lifecycle, ephemeral ECDH handshakes, encrypted shard streaming over TCP/IPC | `node:net`, `node:events` | Uses `crypto.js` for packet encryption/handshake, interacts with `router.js` for peer scoring and shard routing, invokes `sandbox.js` upon shard arrival |
| `src/ledger.js` | Proof-of-Compute economic ledger, credit metering, anti-replay attestation tracking, balance verification & double-spend prevention | `node:crypto` | Verifies worker PoC signatures, meters credits based on execution time and complexity, gates dispatch when requester has insufficient balance |
| `src/index.js` | Full simulation entrypoint orchestrating crypto, router, sandbox, P2P node, and economic ledger | `node:*` | High-level orchestration and demonstration of normal and fail-closed flows |
| `test/mesh.test.js` | 100% test coverage suite preserving 5 baseline invariants and validating R1-R7 extensions | `node:test`, `node:assert` | Automated verification of all modules |

---

## 3. Explicit Interface Contracts

### 3.1 `crypto.js` Interface Contract
```typescript
class MeshCryptoEngine {
  curve: string;                 // 'prime256v1'
  ecdh: crypto.ECDH;
  publicKey: string;             // 130-char hex uncompressed EC public key
  nodeId: string;                // 40-char hex sha256 prefix
  outboundNonce: number;         // monotonically increasing counter (starts at 1)
  inboundNonces: Map<string, { lastNonce: number, seenNonces: Set<number> }>;

  constructor(options?: { curve?: string, maxTimeDriftMs?: number });

  // Baseline compatibility
  deriveSharedKey(peerPublicKeyHex: string): Buffer;

  // R3 HKDF-SHA512 session key rotation
  deriveSessionKey(peerPublicKeyHex: string, options?: {
    salt?: Buffer | string,
    info?: Buffer | string,
    keylen?: number              // default 32
  }): Buffer;

  // Authenticated encryption with fresh 12-byte IV and anti-replay nonce
  encryptShard(payloadObj: any, sharedKeyBuffer: Buffer, options?: {
    nonce?: number,
    timestamp?: number
  }): {
    iv: string,                  // 24-char hex
    authTag: string,             // 32-char hex
    ciphertext: string,          // hex string
    timestamp: number,           // unix epoch ms
    nonce: number                // sequence number
  };

  // Authenticated decryption with optional anti-replay validation
  decryptShard(encryptedPacket: {
    iv: string,
    authTag: string,
    ciphertext: string,
    timestamp?: number,
    nonce?: number
  }, sharedKeyBuffer: Buffer, options?: {
    validateReplay?: boolean,
    senderId?: string
  }): any;

  // Anti-replay validation helper
  validateWirePacket(packet: { timestamp: number, nonce: number }, peerNodeId: string): boolean;

  // HMAC-SHA256 Proof-of-Compute signature
  signProofOfCompute(shardId: string, resultData: any, secret?: string | Buffer): string;

  // Constant-time HMAC verification
  verifyProofOfCompute(shardId: string, resultData: any, signature: string, secret?: string | Buffer): boolean;
}
```
**Error Handling**:
- Throws `Error('Authentication tag verification failed')` if ciphertext or authTag is tampered.
- Throws `Error('Replay attack detected: stale timestamp')` if packet timestamp is older than `maxTimeDriftMs`.
- Throws `Error('Replay attack detected: invalid nonce')` if packet nonce $\le$ `lastNonce` or already seen.

---

### 3.2 `sandbox.js` Interface Contract
```typescript
class StandbySandbox {
  maxExecutionMs: number;        // default 1500
  maxMemoryMb: number;           // default 64
  maxCpuLoadThreshold: number;   // default 0.25 (25% ceiling)
  forbiddenTokens: string[];     // ['process', 'require', 'eval', 'Function', '__proto__', 'constructor', 'prototype', ...]

  constructor(config?: {
    maxExecutionMs?: number,
    maxMemoryMb?: number,
    maxCpuLoadThreshold?: number,
    forbiddenTokens?: string[]
  });

  // Baseline compatibility
  isDeviceInStandby(): {
    standbyReady: boolean,
    metrics: { cpuCount: number, normalizedLoad: number, freeMemoryMB: number }
  };

  // AST / static token pre-validation
  validateTaskCode(taskCode: string): { valid: boolean, error?: string };

  // Synchronous execution (baseline compatibility)
  executeIsolatedShard(shard: {
    shardId: string,
    taskCode: string,
    inputData: any[]
  }): {
    shardId: string,
    output: any,
    executionTimeMs: number
  };

  // Async WorkerThread execution with memory caps (R4)
  executeIsolatedShardAsync(shard: {
    shardId: string,
    taskCode: string,
    inputData: any[]
  }, options?: { timeoutMs?: number, memoryLimitMb?: number }): Promise<{
    shardId: string,
    output: any,
    executionTimeMs: number
  }>;
}
```
**Error Handling**:
- Throws `Error('Task rejected: forbidden token detected [...]')` on malicious code injection.
- Throws `Error('Execution timed out')` on infinite loops.
- Rejects with `Error('Worker terminated due to reaching memory limit: JS heap out of memory')` on OOM.

---

### 3.3 `router.js` Interface Contract
```typescript
interface PeerInfo {
  nodeId: string;
  publicKey: string;
  standbyReady: boolean;
  latencyMs: number;
  capacityScore: number;
  cpuLoad?: number;
  freeMemBytes?: number;
}

interface Shard {
  shardId: string;               // 40-char hex
  index: number;                 // 0-indexed
  taskCode: string;
  inputData: any[];
}

interface TelemetryMetrics {
  cpuLoad: number;               // 0.0 to 1.0
  freeMemBytes: number;
  totalMemBytes: number;
  freeMemRatio: number;          // 0.0 to 1.0
  cpuCores: number;
  standbyReady: boolean;
  loadShedState: 'NORMAL' | 'SHED_CPU_HIGH' | 'SHED_MEM_LOW';
}

class GridRouter {
  localNodeId: string;
  maxCpuThreshold: number;       // 0.25 (25% ceiling)
  minFreeMemRatio: number;       // 0.05
  peerTable: Map<string, PeerInfo>;
  taskQueue: Shard[];

  constructor(localNodeId: string, options?: { maxCpuThreshold?: number, minFreeMemRatio?: number });

  // Real OS telemetry using os.cpus() deltas
  getHardwareTelemetry(): TelemetryMetrics;

  // Peer management
  registerPeer(peerNodeId: string, publicKey: string, telemetry: { standbyReady: boolean, latencyMs?: number }): void;
  updatePeerTelemetry(peerNodeId: string, telemetry: Partial<PeerInfo>): void;

  // Peer selection with fail-closed load shedding
  selectOptimalNodes(taskHash: string, count?: number): PeerInfo[];

  // Task partitioning
  createTaskPartitions(taskCode: string, datasetArray: any[], chunkSize?: number): Shard[];

  // Deterministic result aggregation
  aggregateResults(results: Array<{ shardId: string, index: number, output: any }>): any[];
}
```
**Error Handling**:
- When host CPU load exceeds 25% or memory is below operational thresholds: transitions to `SHED_CPU_HIGH` or `SHED_MEM_LOW`, safely queueing or rejecting shards fail-closed without stalling.
- When `selectOptimalNodes()` finds 0 standby peers: returns empty array `[]` and reports `FAIL_CLOSED_NO_NODES` status instead of throwing unhandled exceptions.
- `aggregateResults()` throws `Error('Incomplete shard aggregation: missing shard index [i]')` if any partition is missing.

---

### 3.4 `node.js` Interface Contract
```typescript
interface WireMessage {
  type: 'HANDSHAKE_INIT' | 'HANDSHAKE_ACK' | 'SHARD_DISPATCH' | 'SHARD_RESULT' | 'HEARTBEAT';
  senderId: string;
  nonce: number;
  timestamp: number;
  payload: any;
}

class P2PNode extends EventEmitter {
  nodeId: string;
  crypto: MeshCryptoEngine;
  server: net.Server | null;
  peers: Map<string, { socket: net.Socket, sessionKey: Buffer, lastNonce: number }>;

  constructor(nodeId: string, cryptoEngine: MeshCryptoEngine, options?: {
    port?: number,
    host?: string,
    ipcPath?: string
  });

  listen(): Promise<{ address: string, port: number, ipcPath?: string }>;
  connect(endpoint: { host?: string, port?: number, ipcPath?: string }): Promise<net.Socket>;
  initiateHandshake(socket: net.Socket, peerPublicKey: string): Promise<Buffer>;
  sendEncryptedMessage(peerId: string, type: string, payload: any): Promise<void>;
  close(): Promise<void>;
}
```
**Wire Framing**:
- Messages are framed using 4-byte big-endian unsigned integers (`header.writeUInt32BE(payloadBuffer.length)`) followed by the UTF-8 JSON buffer.
- Socket incoming stream maintains an internal accumulation buffer to gracefully handle TCP fragmentation and coalesced packets.

---

### 3.5 `ledger.js` Interface Contract
```typescript
interface LedgerAccount {
  nodeId: string;
  balance: number;
  totalEarned: number;
  totalSpent: number;
}

interface SettlementResult {
  settled: boolean;
  attestationKey: string;
  cost: number;
  requesterBalance: number;
  workerBalance: number;
}

class ProofOfComputeLedger {
  baseRatePerMs: number;         // default 0.01
  baseRatePerItem: number;       // default 0.05
  accounts: Map<string, LedgerAccount>;
  settledAttestations: Set<string>;

  constructor(options?: { baseRatePerMs?: number, baseRatePerItem?: number, initialBalance?: number });

  getOrCreateAccount(nodeId: string, initialBalance?: number): LedgerAccount;
  getBalance(nodeId: string): number;
  calculateCredit(executionTimeMs: number, inputSize: number): number;

  verifyAndSettle(params: {
    requesterId: string,
    workerId: string,
    shardId: string,
    resultData: any,
    proofOfCompute: string,
    executionMetrics: { executionTimeMs: number, inputSize: number },
    workerPublicKey: string
  }): SettlementResult;
}
```
**Error Handling**:
- Throws `Error('Anti-replay violation: attestation already settled (double-spend attempt)')` if `shardId + proofOfCompute` was previously processed.
- Throws `Error('Invalid Proof-of-Compute attestation signature')` if HMAC verification fails.
- Throws `Error('Fail-closed: insufficient requester credit balance')` if requester balance < calculated cost.

---

## 4. Proposed Milestone Decomposition

We propose a clean, 6-milestone engineering sequence strictly aligned with R1–R7:

```
[Milestone 1: Baseline Integrity & Scaffolding (R1)]
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
[M2: Ultra Crypto]  [M3: Sandbox]  [M4: Telemetry]
   (R3: HKDF/Nonces)   (R4: AST/OOM)  (R2: CPU Deltas)
       │                               │
       └───────────────┬───────────────┘
                       ▼
       [M5: Live P2P Transport Layer (R5)]
                       │
                       ▼
       [M6: PoC Economic Ledger & E2E Test Suite (R6, R7)]
```

### Milestone 1: Baseline Integrity & Scaffolding (R1)
- **Scope**:
  - Authoritative repository root confirmed at `c:\Users\pc120\Documents\REPO`.
  - Zero external dependencies in `package.json`.
  - Verify baseline 5 tests pass cleanly (`npm test`).
  - Scaffold module interfaces for upcoming `src/node.js` and `src/ledger.js`.
- **Dependencies**: None.

### Milestone 2: Ultra Cryptography Engine & Anti-Replay Protocol (R3)
- **Scope**:
  - Implement HKDF-SHA512 session key rotation (`deriveSessionKey` via `crypto.hkdfSync`).
  - Implement monotonically increasing anti-replay wire nonces and timestamp drift validation (5-minute window).
  - Authenticated AES-256-GCM encryption with 12-byte IVs and 16-byte authTags.
  - Constant-time HMAC Proof-of-Compute verification (`crypto.timingSafeEqual`).
  - Retain 100% backward compatibility with baseline `deriveSharedKey`, `encryptShard`, `decryptShard`, and `signProofOfCompute`.
- **Dependencies**: Milestone 1.

### Milestone 3: Zero-Trust Sandbox Hardening & Deterministic Virtualization (R4)
- **Scope**:
  - Implement static token and AST pre-validation in `src/sandbox.js` rejecting forbidden globals (`eval`, `process`, `require`, `__proto__`, `constructor`, etc.).
  - Implement memory ceiling enforcement via `node:worker_threads` with `resourceLimits` (`maxOldGenerationSizeMb: 64`) trapping OOM without host crash.
  - Implement millisecond execution timeout termination.
  - Implement deterministic state virtualization (frozen inputs and globals, reproducible outputs).
- **Dependencies**: Milestone 1.

### Milestone 4: Hardware Telemetry, Strict Fail-Closed States & Load-Shedding (R2)
- **Scope**:
  - In `src/router.js`, implement cross-platform real-time CPU delta tracking using `os.cpus()` (solving Windows `os.loadavg()` limitation).
  - Track free memory headroom (`os.freemem() / os.totalmem()`).
  - Enforce 25% host CPU ceiling and memory floor load-shedding.
  - Implement fail-closed state transitions (`SHED_CPU_HIGH`, `SHED_MEM_LOW`, `FAIL_CLOSED_NO_NODES`) safely queueing or rejecting tasks without stalling.
- **Dependencies**: Milestone 1.

### Milestone 5: Live P2P Transport Layer (R5)
- **Scope**:
  - Create `src/node.js` with `P2PNode` daemon using native `node:net`.
  - Implement 4-byte length-prefixed JSON wire framing.
  - Support ephemeral ECDH handshakes, HKDF-SHA512 session keys, encrypted shard dispatch, and PoC result delivery.
  - Support local loopback (`127.0.0.1` ephemeral ports) and IPC named pipe fallback for Windows sandbox test execution.
- **Dependencies**: Milestone 2, Milestone 4.

### Milestone 6: Anti-Replay PoC Economic Ledger & Expanded Verification Suite (R6, R7)
- **Scope**:
  - Create `src/ledger.js` implementing Proof-of-Compute economic ledger.
  - Credit metering based on execution duration and shard complexity.
  - Anti-replay attestation cache preventing duplicate claims and double-spending.
  - Fail-closed requester balance gating.
  - Update `src/index.js` end-to-end simulation.
  - Expand `test/mesh.test.js` to cover all new protocol invariants while preserving the original 5 baseline tests.
  - Ensure `npm test` passes with exit code 0 and `node --check` succeeds on all source files.
- **Dependencies**: Milestone 2, Milestone 3, Milestone 5.

---

## 5. Caveats
1. **Windows Sandbox Network Limitation**: Direct TCP `net.createConnection(port, '127.0.0.1')` encounters `EACCES` when running inside the restricted sandbox without `BypassSandbox`. Implementing IPC named pipes (`\\.\pipe\...`) or an in-memory duplex transport fallback within `src/node.js` guarantees that local test runs succeed in the sandboxed agent environment while full TCP networking works in standard environments and Linux CI.
2. **Synchronous Baseline Invariant**: The baseline test suite invokes `sandbox.executeIsolatedShard()` synchronously. Therefore, synchronous execution via hardened `node:vm` contexts must be preserved for backward compatibility, while asynchronous execution with hard memory caps via `node:worker_threads` is exposed as `executeIsolatedShardAsync()`.

---

## 6. Conclusion
The Open-Side protocol architecture has been thoroughly investigated across all 7 target modules. The current v0.4.2 baseline is located directly in `c:\Users\pc120\Documents\REPO` and passes all 5 baseline tests. The architectural boundaries, interface contracts, Node.js core API constraints (HKDF ArrayBuffer conversion, Windows CPU delta calculation, worker thread OOM trapping, socket IPC fallback), and a 6-milestone dependency plan are fully defined and ready for execution.

---

## 7. Verification Method
1. **Baseline Invariants Verification**:
   ```powershell
   npm test
   ```
   Must pass with 5/5 tests green.
2. **Syntax Validation**:
   ```powershell
   node --check src/index.js src/crypto.js src/sandbox.js src/router.js
   ```
3. **Core API Verification Command**:
   ```powershell
   node -e "const crypto = require('node:crypto'); const os = require('node:os'); const { Worker } = require('node:worker_threads'); console.log('All required native modules are functional');"
   ```
