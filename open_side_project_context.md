# Open-Side Architecture & Developer Context

## 1. Project Overview
**Open-Side** is a production-grade, decentralized peer-to-peer (P2P) standby compute grid. It pools idle consumer hardware into a zero-trust, encrypted execution mesh without relying on centralized cloud data centers.

- **Repository**: `https://github.com/pc1209920-coder/Open-Side`
- **Current Release**: `v0.4.2`
- **Runtime**: Node.js `>= 18.0.0` (CommonJS module system)
- **License**: MIT
- **CI/CD Status**: Passing (`Open-Side CI` via GitHub Actions on Ubuntu/Node 20 LTS)
- **Community Health Score**: 100% (8/8 GitHub Community Standards verified)

---

## 2. Core Architecture & Protocol Stack

### A. Cryptographic Engine (`src/crypto.js`)
- **Key Exchange**: Ephemeral Elliptic Curve Diffie-Hellman (**ECDH**) using the `prime256v1` curve. Every P2P session generates fresh keypairs and derives a shared secret hashed via SHA-256 into a 32-byte symmetric session key.
- **Payload Encryption**: Authenticated **AES-256-GCM** encryption utilizing a 12-byte random Initialization Vector (`iv`) and a mandatory 16-byte authentication tag (`authTag`) to prevent ciphertext tampering in transit.
- **Proof-of-Compute (PoC)**: Deterministic `HMAC-SHA256` attestation signatures generated over `shardId + result` using the session key to verify workload integrity upon return.

### B. Zero-Trust Standby Sandbox (`src/sandbox.js`)
- **Isolation Engine**: Built on Node.js `node:vm` isolated V8 contexts.
- **Security Boundaries**: Explicit denial of host privileges—zero access to `fs`, `net`, `child_process`, `process.env`, or global system constructors.
- **Execution Guards**: Enforces strict millisecond execution timeouts (`timeout`) and checks host CPU idle telemetry before accepting compute shards.

### C. Mesh Router & Task Orchestration (`src/router.js`)
- **Task Partitioning**: Deterministically splits large input arrays/workloads into balanced compute shards (`shardId`, `script`, `data`).
- **Telemetry-Based Peer Selection**: Scores and filters available standby peers based on network latency, idle CPU headroom, and active status.
- **Result Aggregation**: Reassembles verified worker outputs in deterministic shard order.

### D. Simulation & Test Suite (`src/index.js`, `test/mesh.test.js`)
- Zero external test runner dependencies (uses native Node.js `assert` and `node --test`).
- Validates 5 core protocol invariants:
  1. Bidirectional ECDH shared secret equivalence.
  2. Deterministic workload sharding.
  3. AES-256-GCM authenticated encryption/decryption roundtrip.
  4. Isolated V8 VM execution and telemetry gating.
  5. HMAC-SHA256 Proof-of-Compute signature verification.

---

## 3. Repository File Tree

```text
Open-Side/
├── .github/
│   ├── workflows/
│   │   └── ci.yml                     # Automated syntax & test suite workflow
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md              # Standardized bug report template
│   │   └── feature_request.md         # Standardized feature request template
│   └── pull_request_template.md       # PR checklist & security verification
├── src/
│   ├── crypto.js                      # ECDH prime256v1 + AES-256-GCM + HMAC PoC
│   ├── sandbox.js                     # Zero-privilege V8 VM execution engine
│   ├── router.js                      # Peer scoring, sharding, and aggregation
│   └── index.js                       # End-to-end local mesh protocol simulation
├── test/
│   └── mesh.test.js                   # 5-stage cryptographic & sandbox test suite
├── CODE_OF_CONDUCT.md                 # Contributor Covenant Code of Conduct
├── CONTRIBUTING.md                    # Developer setup & PR guidelines
├── LICENSE                            # MIT License
├── package.json                       # CommonJS config, scripts (start, test)
├── README.md                          # Architecture docs & quickstart guide
└── SECURITY.md                        # Zero-trust guarantees & disclosure policy
```

---

## 4. Active Engineering Roadmap (Next Implementation Phases)

When continuing development in **Antigravity**, focus on the following three core modules (matching the open GitHub Issues):

### Phase 1: Real Hardware Telemetry & Load-Shedding (`feat(orchestration)`)
- **Objective**: Replace mock idle checks with real OS-level telemetry (`node:os` + platform battery/thermal checks).
- **Requirements**:
  - Calculate real-time CPU load deltas across `os.cpus()`.
  - Check free system memory (`os.freemem() / os.totalmem()`).
  - Automatically reject or pause incoming shards if host CPU usage exceeds 25% or memory headroom drops below threshold.

### Phase 2: Sandbox Hardening & WASM Isolation (`sec(sandbox)`)
- **Objective**: Harden `src/sandbox.js` against memory exhaustion and prototype pollution.
- **Requirements**:
  - Implement strict memory allocation caps (`worker_threads` with `resourceLimits` or WebAssembly micro-runtimes).
  - Add AST/static code pre-validation to reject forbidden tokens before V8 context compilation.

### Phase 3: Live P2P Transport Layer (`feat(network)`)
- **Objective**: Upgrade `src/router.js` from in-memory simulation to live TCP/WebSocket P2P transport.
- **Requirements**:
  - Create a lightweight P2P node daemon (`src/node.js`) using native `node:net` or WebSockets.
  - Implement live JSON-framed wire protocol for ECDH public key handshakes, encrypted shard dispatch, and PoC return packets across local/LAN ports.

---

## 5. Development Commands & Standards
- **Run Simulation**: `npm start` (`node src/index.js`)
- **Run Test Suite**: `npm test` (`node test/mesh.test.js`)
- **Syntax Check**: `node --check src/index.js src/crypto.js src/sandbox.js src/router.js`
- **Code Style**: Zero bloated external dependencies where native Node.js APIs (`node:crypto`, `node:vm`, `node:os`, `node:net`, `node:worker_threads`) suffice. Every new feature must include unit assertions in `test/mesh.test.js` so GitHub Actions CI remains green.