Execute Phase 1 bug fixes and stability hardening across all 6 core modules of the Open-Side Protocol (CommonJS P2P compute protocol in c:\Users\pc120\Documents\REPO) for [OPEN: Primary purpose of the work].

Working directory: c:\Users\pc120\Documents\REPO
Integrity mode: [OPEN: Which shortcuts should the team NOT be allowed to take?]

## Requirements

### R1. Router Stability and Event Flow (`src/router.js`)
Fix deltaTotal === 0n hysteresis bypass, aggregateResults expectedCount validation, remove duplicate shardId leaks, pruneExpiredQueue on reschedule, and emit memory availability events.

### R2. Cryptographic Session & Transport Security (`src/crypto.js`, `src/node.js`)
Align HKDF domain separation strings ("open-side-v1-session-key-epoch:${epoch}"), add unhandled rejection handlers to ackPromise and resultPromise, verify nodeId-to-publicKey binding, reject self-reflection handshake, add connection salt to prevent cross-connection replay, and clamp remote timeouts.

### R3. Ledger Escrow Accounting & State Serialization (`src/ledger.js`)
Fix releaseEscrow accounting to prevent double-spending and stranded funds, hydrate/export active escrows in fromState/exportState, canonicalize audit trail hashing using AUDIT_BODY_KEYS, guard against complexityFactor <= 0 and subnormal float calculations, and wrap BigInt in safe serialization.

### R4. ComputeSea Lifecycle & Concurrency (`src/index.js`)
Wire up real reserveEscrow/releaseEscrow in ComputeSea, salt shardIds per workload, serialize peer epoch sync, fail pending P2P shards on peer disconnect, handle load-shed retries cleanly, and terminate active sandbox worker threads on cancel/close.

### R5. Verification Suite & Syntax Validation
Maintain green status across all existing 76 tests, run `node --check` across all 6 core source files, and add regression tests for fixed edge cases.

## Acceptance Criteria

### Router Module
- [ ] deltaTotal === 0n hysteresis bypass is resolved.
- [ ] aggregateResults validates expectedCount.
- [ ] Duplicate shardId references are cleaned up.
- [ ] pruneExpiredQueue runs on reschedule.
- [ ] Memory availability events are properly dispatched.

### Crypto & Node Modules
- [ ] HKDF domain separation strings use "open-side-v1-session-key-epoch:${epoch}".
- [ ] Unhandled rejection handlers are attached to ackPromise and resultPromise.
- [ ] nodeId-to-publicKey binding is verified during handshake.
- [ ] Self-reflection handshakes are rejected.
- [ ] Connection salt prevents cross-connection replay.
- [ ] Remote timeouts are clamped.

### Ledger Module
- [ ] releaseEscrow accounting prevents double-spending and stranded funds.
- [ ] Active escrows are hydrated in fromState and exported in exportState.
- [ ] Audit trail hashing is canonicalized with AUDIT_BODY_KEYS.
- [ ] Guards reject complexityFactor <= 0 and subnormal float calculations.
- [ ] BigInt values are safely serialized.

### ComputeSea Engine
- [ ] Real reserveEscrow and releaseEscrow are wired in ComputeSea.
- [ ] ShardIds are salted per workload.
- [ ] Peer epoch sync is serialized.
- [ ] Pending P2P shards fail on peer disconnect.
- [ ] Load-shed retries are handled cleanly.
- [ ] Active sandbox worker threads terminate on cancel/close.

### Verification & Testing
- [ ] All 76 baseline tests pass.
- [ ] `node --check` succeeds on all 6 source files (`src/index.js`, `src/crypto.js`, `src/sandbox.js`, `src/router.js`, `src/node.js`, `src/ledger.js`).
- [ ] [OPEN: How should the regression tests be organized and run?]
