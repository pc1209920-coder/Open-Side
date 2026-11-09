# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4.0 | :x:                |

## Zero-Trust Sandbox & Cryptographic Guarantees
Open-Side enforces strict isolation across all standby compute nodes:
1. **Ephemeral ECDH Handshakes**: Every peer session negotiates fresh `prime256v1` keys.
2. **AES-256-GCM Authenticated Payloads**: All task partitions are verified via GCM auth tags before execution.
3. **Zero-Privilege V8 VM**: Workloads execute inside frozen `node:vm` contexts with no access to `fs`, `net`, or `child_process`.

## Reporting a Vulnerability
Please report any sandbox escape vectors or cryptographic issues via the GitHub **Security** tab.
