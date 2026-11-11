# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4.0 | :x:                |

## Zero-Trust Architecture & Fail-Closed Guarantees

Open-Side (**Single Compute Sea**) enforces fail-closed security boundaries across cryptography, host resource gating, code sandboxing, P2P wire framing, and economic settlement using exclusively native Node.js core APIs (`node:crypto`, `node:vm`, `node:worker_threads`, `node:net`, `node:os`).

### 1. Transport & Session Cryptography (`src/crypto.js`)
- **Ephemeral ECDH Key Exchange (`prime256v1`)**: Sessions negotiate fresh ephemeral keypairs (`130`-char uncompressed hex public keys) with `40`-char SHA-256 node identifiers. Mismatched curves, invalid EC points, and malformed keys fail closed.
- **RFC 5869 HKDF-SHA512 Key Derivation & Rotation**: Session keys are derived via `crypto.hkdfSync('sha512', ...)` with per-epoch `salt` / `epoch` isolation and domain-separated `info` labels (supporting lengths up to `16,320` bytes and SHA-512 compression for `info > 1024` bytes).
- **Authenticated AES-256-GCM**: Every packet uses a fresh 12-byte CSPRNG IV (`crypto.randomBytes(12)`), a 16-byte authentication tag, optional AAD wire header binding, monotonic `outboundNonce` counters guarded against `Number.MAX_SAFE_INTEGER` overflow, and strict hex/length validation prior to decryption.
- **Anti-Replay & Timestamp Drift Enforcement**: Wire validation enforces `±60,000 ms` timestamp drift bounds (`maxTimeDriftMs`) and per-peer sequence nonces via an RFC 6479 sliding window (`slidingWindowSize = 64`) or strict monotonic ordering (`allowOutOfOrder: false`). Decryption commits replay-window state **only after** GCM authentication tag verification and JSON parsing succeed, preventing forged packets from poisoning replay tracking.
- **Constant-Time Proof-of-Compute Verification**: HMAC-SHA256 attestations are verified with `crypto.timingSafeEqual` after strict 32-byte / 64-hex length validation.

### 2. Fail-Closed Hardware Telemetry & Load-Shedding (`src/router.js`)
- **Host Resource Protection**: Real-time OS telemetry computes multi-core `os.cpus()` `BigInt` tick deltas and `os.freemem()` / `os.totalmem()` ratios, shedding load fail-closed whenever CPU exceeds **25%** (`maxCpuThreshold = 0.25`), free memory drops below **10%** (`minFreeMemRatio = 0.10`), or OS telemetry reads fail (`TELEMETRY_INVALID`).
- **Hysteresis & Bounded Queuing**: Schmitt-trigger recovery hysteresis (`cpuHysteresisMargin = 0.03`, `cpuRecoveryStreakRequired = 2`) prevents flapping, while bounded queues (`maxQueueSize`), TTL expiration (`maxQueueTimeMs`), and retry caps (`maxRetries`) prevent memory exhaustion or infinite reschedule loops.

### 3. Zero-Privilege Sandbox Isolation (`src/sandbox.js`)
- **Static AST / Token Pre-Validation**: Normalizes Unicode/hex/octal escape sequences prior to scanning and rejects forbidden host/prototype tokens (`process`, `require`, `import`, `eval`, `Function`, `__proto__`, `constructor`, `prototype`) before compilation.
- **Zero-Privilege V8 VM & Worker Thread Resource Caps**: Untrusted code executes inside isolated `node:vm` contexts (null-prototype context, frozen built-ins, no `fs`/`net`/`child_process`/`process`) and `node:worker_threads` workers constrained by `resourceLimits` (heap memory cap) and strict millisecond execution timeouts so infinite loops and OOM allocations terminate without impacting the host process.
- **Deterministic State Virtualization**: Deep-freezes input data and virtualizes non-deterministic primitives so computations cannot mutate host state or leak side-channel environment state.

### 4. P2P Wire Framing & Transport Security (`src/node.js`)
- **Length-Prefixed Binary Framing**: Native `node:net` TCP and local IPC transport frames messages with 4-byte big-endian unsigned lengths, rejecting oversized frames (`maxFrameSize = 16 MB`, `FrameTooLargeError`) and malformed JSON fail-closed before buffering payloads.
- **Session-Gated Dispatch & Timeouts**: Enforces two-way ephemeral ECDH handshakes (`handshakeTimeoutMs = 5000 ms`, `HandshakeTimeoutError`), seen handshake nonce tracking, and HKDF-SHA512 session key establishment before accepting encrypted shard or PoC frames; destroyed or disconnected sockets fail closed (`SocketDestroyedError`) and trigger shard rescheduling.

### 5. Proof-of-Compute Ledger Integrity (`src/ledger.js`)
- **Double-Spend & Replay Prevention**: `verifyAndSettle()` validates HMAC-SHA256 Proof-of-Compute attestations in constant time before mutating any state, enforcing `settledAttestations`, shard-proof uniqueness, per-worker `usedNonces`, and anti-self-settlement checks (`DoubleSpendAttemptError`).
- **Exact Fixed-Point Accounting, Escrow & Audit Trail**: Uses integer `BigInt` micro-credit accounting (`1e-6` resolution, capped at `Number.MAX_SAFE_INTEGER` via `CreditOverflowError`), fail-closed balance and escrow checks (`InsufficientCreditBalanceError`, `UnknownAccountError`), non-negative balance conservation, and a SHA-256 hash-chained audit log verifiable from genesis via `verifyAuditLog()`.

### 6. Supply-Chain & Zero-Dependency Policy
- `package.json` enforces zero runtime `dependencies` and zero `devDependencies`, eliminating third-party npm supply-chain exposure.

## Reporting a Vulnerability
Please report any sandbox escape vectors, cryptographic flaws, anti-replay bypasses, wire framing bugs, or ledger double-spend issues via the GitHub **Security** tab (Security Advisories). Include:
- Affected module (`src/crypto.js`, `src/router.js`, `src/sandbox.js`, `src/node.js`, `src/ledger.js`, or `src/index.js`)
- Minimal reproducible proof-of-concept and Node.js version
- Expected fail-closed behavior vs. observed behavior

