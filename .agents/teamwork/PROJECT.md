# Project: Open-Side Universal Protocol Standard (Single Compute Sea)

## Architecture
Open-Side is a hardware-agnostic, zero-dependency, decentralized P2P standby compute grid pooling idle hardware into a zero-trust, encrypted execution mesh using native Node.js core APIs (`node:crypto`, `node:vm`, `node:net`, `node:os`, `node:worker_threads`).

### System Topology & Data Flow
```
[Requester / Coordinator Node]
          │
          │ 1. Telemetry Query & Shard Partitioning (src/router.js)
          │ 2. ECDH prime256v1 Handshake & HKDF-SHA512 Key Rotation (src/crypto.js)
          │ 3. Authenticated AES-256-GCM Streaming over P2P TCP / IPC (src/node.js)
          ▼
   [Worker Node]
          │
          │ 4. Telemetry Load-Shedding Check (CPU > 25% ceiling or memory floor)
          │ 5. Static AST Pre-Validation & Token Rejection (src/sandbox.js)
          │ 6. Isolated Execution with VM / WorkerThread Resource Limits & Determinism
          │ 7. HMAC-SHA256 Proof-of-Compute Signature Generation (src/crypto.js)
          ▼
[Proof-of-Compute Economic Ledger (src/ledger.js)]
          │
          │ 8. Anti-Replay Nonce Validation & Double-Spend Prevention
          │ 9. Execution Work Metering (Duration + Payload Complexity)
          │ 10. Balance Debit / Credit Settlement (Fail-Closed Account Check)
```

## Feature Inventory
Every feature identified during the survey phase is recorded below with its assigned milestone.
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Zero-Dependency Module Architecture | Pure CommonJS architecture utilizing native Node.js core APIs (`node:crypto`, `node:vm`, `node:net`, `node:os`, `node:worker_threads`). | M1 | R1, survey |
| 2 | 5-Stage Mesh Protocol Verification | Strict preservation of 5 baseline protocol assertions in `test/mesh.test.js` without regressions. | M1 | R1, survey |
| 3 | Ephemeral ECDH Key Generation | Ephemeral `prime256v1` curve keypair generation with 40-character hex `nodeId`. | M2 | R3, survey |
| 4 | HKDF-SHA512 Key Derivation & Rotation | Derivation of 32-byte symmetric session keys from ECDH shared secret using HKDF-SHA512 with per-epoch info/salt. | M2 | R3, survey |
| 5 | Authenticated AES-256-GCM Encryption | Payload encryption with fresh 12-byte random IV, 16-byte authTag, and AAD wire header binding. | M2 | R3, survey |
| 6 | Authenticated AES-256-GCM Decryption | Authenticated decryption rejecting tampered ciphertext or altered authTags fail-closed. | M2 | R3, survey |
| 7 | Monotonic Anti-Replay Nonces | Sequence counter validation rejecting replayed, duplicate, or out-of-order wire nonces. | M2 | R3, survey |
| 8 | Timestamp Window Drift Validation | Verification that message timestamps fall within $\pm 60,000 \text{ ms}$ of receiver clock. | M2 | R3, survey |
| 9 | Deterministic HMAC-SHA256 PoC Attestation | Deterministic signature generation over `${shardId}:${JSON.stringify(resultData)}`. | M2 | R3, survey |
| 10 | Constant-Time PoC Signature Verification | Cryptographic verification of PoC signatures using `crypto.timingSafeEqual`. | M2 | R3, survey |
| 11 | Cross-Platform CPU Delta Telemetry | Real-time calculation of host CPU load delta across `os.cpus()` multi-core tick counts (user, nice, sys, idle, irq). | M3 | R2, survey |
| 12 | Free Memory Headroom Tracker | Precise tracking of free system memory and memory ratio via `os.freemem()` / `os.totalmem()`. | M3 | R2, survey |
| 13 | Strict 25% CPU Fail-Closed Gating | Rejection of standby compute acceptance if host CPU utilization exceeds 25% (0.25). | M3 | R2, survey |
| 14 | Memory Floor Fail-Closed Gating | Rejection of incoming shards if free memory ratio falls below operational threshold (10%). | M3 | R2, survey |
| 15 | Dynamic Task Partitioning | Deterministic splitting of arbitrary tasks and datasets into balanced micro-shards with SHA-256 IDs. | M3 | R2, survey |
| 16 | Fail-Closed Peer Selection & Scoring | Optimal standby peer selection scoring by latency and telemetry; fails closed safely if no peers available. | M3 | R2, survey |
| 17 | Bounded Task Queue & Rescheduling | FIFO queueing of pending shards when grid nodes are busy, and rescheduling on node disconnection. | M3 | R2, survey |
| 18 | AST / Static Token Pre-Validator | Static analysis of untrusted task code prior to execution, rejecting forbidden identifiers (`process`, `require`, `eval`, `__proto__`, etc.). | M4 | R4, survey |
| 19 | Escape Sequence Normalizer | Normalization of unicode and hex escape sequences (`\u00xx`, `\x00`) to prevent scanner evasion. | M4 | R4, survey |
| 20 | Zero-Privilege VM Isolation Boundary | Hardened execution context with null prototypes, explicit global deny-list, and frozen primitives. | M4 | R4, survey |
| 21 | Millisecond Execution Timeout Guard | Synchronous execution interruption enforcing strict millisecond timeouts against infinite loops. | M4 | R4, survey |
| 22 | Worker Threads Memory Resource Limits | Execution of untrusted shards in `node:worker_threads` with `resourceLimits` (`maxOldGenerationSizeMb: 64`) trapping OOM. | M4 | R4, survey |
| 23 | Deterministic State Virtualization | Deep freezing of inputs and virtualization of non-deterministic primitives to guarantee reproducible outputs. | M4 | R4, survey |
| 24 | Native P2P TCP Daemon (`src/node.js`) | Lightweight peer-to-peer daemon using `node:net` with configurable host/port and connection pooling. | M5 | R5, survey |
| 25 | Ephemeral Loopback Dynamic Port Binding | Port 0 dynamic binding to `127.0.0.1` eliminating port collision during automated test runs, with IPC fallback. | M5 | R5, survey |
| 26 | Length-Prefixed / Delimited Wire Stream Framing | Wire message framing (4-byte length prefix or NDJSON) preventing TCP chunk fragmentation and concatenation issues. | M5 | R5, survey |
| 27 | Live Ephemeral ECDH Wire Handshake | Two-way handshake over live socket (`HANDSHAKE` -> `HANDSHAKE_ACK`) establishing session keys. | M5 | R5, survey |
| 28 | Encrypted Shard Streaming & Result Return | Live transmission of AES-256-GCM encrypted shards and return of signed Proof-of-Compute results over sockets. | M5 | R5, survey |
| 29 | Proof-of-Compute Work Metering | Quantified compute credit calculation based on execution time ($T_{\text{ms}}$) and input complexity ($S$). | M6 | R6, survey |
| 30 | Anti-Replay Double-Spend Prevention | Spent attestation tracking rejecting duplicate Proof-of-Compute credit claims. | M6 | R6, survey |
| 31 | Fail-Closed Account Balance Enforcement | Node balance accounting enforcing mandatory pre-dispatch debit checks with zero negative balances permitted. | M6 | R6, survey |
| 32 | Comprehensive Verification Suite (100% E2E Pass) | Expanded `test/mesh.test.js` validating all R1–R7 invariants cleanly via `npm test` and `node --check`. | M6 | R7, survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Baseline Integrity & Scaffolding | Verify baseline repository state, zero external dependencies, and all 5 baseline tests passing cleanly. | None | DONE |
| M2 | Ultra Cryptography Engine & Anti-Replay Protocol | Ephemeral ECDH `prime256v1`, HKDF-SHA512 key rotation, AES-256-GCM, monotonic wire nonces, timestamp drift checks, HMAC-SHA256 PoC in `src/crypto.js`. | M1 | IN_PROGRESS |
| M3 | Hardware Telemetry, Strict Fail-Closed States & Load-Shedding | Multi-core CPU delta calculation across `os.cpus()`, memory headroom tracking, 25% CPU fail-closed ceiling, task queueing in `src/router.js`. | M1 | PLANNED |
| M4 | Zero-Trust Sandbox Hardening & Deterministic Virtualization | Static token pre-validation, forbidden global rejection, worker threads memory capping, timeout guards, deterministic state virtualization in `src/sandbox.js`. | M1 | PLANNED |
| M5 | Live P2P Transport Layer | Native `node:net` P2P node daemon in `src/node.js`, wire stream framing, ephemeral ECDH handshakes, loopback & IPC fallback support. | M2, M3 | PLANNED |
| M6 | Anti-Replay Economic Ledger & E2E Verification Suite | PoC credit metering, double-spend rejection, balance enforcement in `src/ledger.js`, simulation update in `src/index.js`, expanded `test/mesh.test.js` passing 100% tests. | M2, M3, M4, M5 | PLANNED |

## Interface Contracts

### `src/crypto.js` Contract
- `class MeshCryptoEngine`
  - `publicKey: string` (130-char hex uncompressed EC public key)
  - `nodeId: string` (40-char hex sha256 prefix)
  - `outboundNonce: number` (Monotonically increasing sequence counter starting at 1)
  - `deriveSharedKey(peerPublicKeyHex: string): Buffer` (Baseline backward compatible)
  - `deriveSessionKey(peerPublicKeyHex: string, options?: { salt?: Buffer | string, info?: Buffer | string, keylen?: number }): Buffer` (Returns 32-byte `Buffer` via `crypto.hkdfSync('sha512', ...)`)
  - `encryptShard(payloadObj: any, sharedKeyBuffer: Buffer, options?: { nonce?: number, timestamp?: number }): { iv: string, authTag: string, ciphertext: string, timestamp: number, nonce: number }`
  - `decryptShard(encryptedPacket: { iv: string, authTag: string, ciphertext: string, timestamp?: number, nonce?: number }, sharedKeyBuffer: Buffer, options?: { validateReplay?: boolean, senderId?: string }): any`
  - `validateWirePacket(packet: { timestamp: number, nonce: number }, peerNodeId: string): boolean`
  - `signProofOfCompute(shardId: string, resultData: any, secret?: string | Buffer): string` (Defaults to `this.publicKey` for baseline compatibility)
  - `verifyProofOfCompute(shardId: string, resultData: any, signature: string, secret?: string | Buffer): boolean`

### `src/router.js` Contract
- `class GridRouter`
  - `localNodeId: string`
  - `maxCpuThreshold: number` (0.25 = 25% ceiling)
  - `minFreeMemRatio: number` (0.10 = 10% floor)
  - `peerTable: Map<string, PeerInfo>`
  - `taskQueue: Array<Shard>`
  - `getHardwareTelemetry(): { cpuLoad: number, freeMemBytes: number, totalMemBytes: number, freeMemRatio: number, standbyReady: boolean, loadShedState: string }`
  - `registerPeer(peerNodeId: string, publicKey: string, telemetry: { standbyReady: boolean, latencyMs?: number }): void`
  - `selectOptimalNodes(taskHash: string, count?: number): Array<PeerInfo>` (Returns `[]` fail-closed when no standby nodes available)
  - `createTaskPartitions(taskCode: string, datasetArray: any[], chunkSize?: number): Array<Shard>`
  - `aggregateResults(results: Array<{ shardId: string, index: number, output: any }>): any[]`

### `src/sandbox.js` Contract
- `class StandbySandbox`
  - `maxExecutionMs: number` (1500)
  - `maxMemoryMb: number` (64)
  - `isDeviceInStandby(): { standbyReady: boolean, metrics: object }` (Baseline backward compatible)
  - `validateTaskCode(taskCode: string): { valid: boolean, error?: string }`
  - `executeIsolatedShard(shard: { shardId: string, taskCode: string, inputData: any[] }): { shardId: string, output: any, executionTimeMs: number }`
  - `executeIsolatedShardAsync(shard: { shardId: string, taskCode: string, inputData: any[] }, options?: { timeoutMs?: number, memoryLimitMb?: number }): Promise<{ shardId: string, output: any, executionTimeMs: number }>`

### `src/node.js` Contract
- `class P2PNode extends EventEmitter`
  - `nodeId: string`
  - `crypto: MeshCryptoEngine`
  - `server: net.Server | null`
  - `listen(): Promise<{ address: string, port: number, ipcPath?: string }>`
  - `connect(endpoint: { host?: string, port?: number, ipcPath?: string }): Promise<net.Socket>`
  - `initiateHandshake(socket: net.Socket, peerPublicKey: string): Promise<Buffer>`
  - `sendEncryptedMessage(peerId: string, type: string, payload: any): Promise<void>`
  - `close(): Promise<void>`

### `src/ledger.js` Contract
- `class ProofOfComputeLedger`
  - `accounts: Map<string, { nodeId: string, balance: number, totalEarned: number, totalSpent: number }>`
  - `settledAttestations: Set<string>`
  - `calculateCredit(executionTimeMs: number, inputSize: number): number`
  - `getBalance(nodeId: string): number`
  - `verifyAndSettle(params: { requesterId: string, workerId: string, shardId: string, resultData: any, proofOfCompute: string, executionMetrics: { executionTimeMs: number, inputSize: number }, workerPublicKey: string }): { settled: boolean, cost: number, requesterBalance: number, workerBalance: number }`

## Code Layout
Authoritative Codebase Root: `c:\Users\pc120\Documents\REPO`
```
c:\Users\pc120\Documents\REPO\
├── .github/
│   └── workflows/ci.yml
├── src/
│   ├── crypto.js          # M2: Ultra E2E cryptography & anti-replay wire protocol
│   ├── sandbox.js         # M4: Zero-trust sandbox & deterministic virtualization
│   ├── router.js          # M3: Hardware telemetry & fail-closed load-shedding
│   ├── node.js            # M5: Native P2P TCP / IPC daemon
│   ├── ledger.js          # M6: Proof-of-Compute economic ledger
│   └── index.js           # M6: End-to-end simulation entrypoint
├── test/
│   └── mesh.test.js       # M6: 100% E2E test suite (baseline + R2-R6)
└── package.json           # CommonJS, zero external dependencies
```
