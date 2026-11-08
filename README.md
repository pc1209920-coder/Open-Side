# 🌐 Open-Side: Decentralized Standby Compute Grid

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Architecture](https://img.shields.io/badge/Architecture-Distributed%20Mesh%20v0.4-purple.svg)]()
[![Security](https://img.shields.io/badge/Crypto-ECDH%20%2B%20AES--256--GCM-red.svg)]()

**Open-Side** is a decentralized peer-to-peer compute grid that pools global idle hardware. By aggregating standby consumer devices into a zero-trust, encrypted mesh network, Open-Side distributes compute workloads securely without relying on centralized data centers.

---

## 🧠 System Architecture

```mermaid
graph TD
    A[Task Dispatcher / Client] -->|Decomposes Job into Micro-Workloads| B(Grid Coordinator)
    B -->|ECDH Ephemeral Handshake| C[Standby Node A - Desktop]
    B -->|ECDH Ephemeral Handshake| D[Standby Node B - Laptop]
    B -->|ECDH Ephemeral Handshake| E[Standby Node C - Edge Server]
    C -->|AES-256-GCM Authenticated Payload| F[Isolated V8 Worker Sandbox]
    D -->|AES-256-GCM Authenticated Payload| G[Isolated V8 Worker Sandbox]
    F -->|HMAC-SHA256 Proof of Execution| A
    G -->|HMAC-SHA256 Proof of Execution| A
```

### Core Architecture
1. **Dynamic Task Decomposition (`src/router.js`)**: Workloads are broken down into deterministic micro-shards and scheduled across nodes based on latency and idle telemetry.
2. **End-to-End Cryptography (`src/crypto.js`)**: Ephemeral Elliptic Curve Diffie-Hellman (ECDH) key exchanges and AES-256-GCM encryption prevent payload tampering.
3. **Telemetry-Gated Execution Sandbox (`src/sandbox.js`)**: Tasks run strictly inside isolated memory contexts and pause if the host device leaves standby mode.

---

## 🚀 Quick Start

### 1. Run Local Node
```bash
git clone [https://github.com/pc1209920-coder/Open-Side.git](https://github.com/pc1209920-coder/Open-Side.git)
cd Open-Side
npm start
```

### 2. Run Test Suite
```bash
npm test
```

## 📜 License
MIT License © 2026 Pratyush Chaudhary
