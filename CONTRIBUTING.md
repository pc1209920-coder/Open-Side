# Contributing to Open-Side 🌐

Thank you for helping scale the **Open-Side Decentralized Standby Compute Grid**!

## Developer Setup

1. Clone the repository:

    git clone [https://github.com/pc1209920-coder/Open-Side.git](https://github.com/pc1209920-coder/Open-Side.git)
    cd Open-Side

2. Run the local grid simulation:

    npm start

3. Run the cryptographic & sandbox test suite:

    npm test

## Core Focus Areas
- **Sandbox Hardening (`src/sandbox.js`)**: Enhancing memory limits, execution timeouts, and WebAssembly (WASM) isolation.
- **Mesh Routing (`src/router.js`)**: Improving peer latency scoring and NAT traversal.
- **Cryptographic Attestation (`src/crypto.js`)**: Deterministic Proof-of-Compute verification.

## Pull Request Checklist
- Ensure all code passes `node --check` syntax validation.
- Verify that `npm test` passes all 5 protocol assertions in GitHub Actions CI.
