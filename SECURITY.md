# Security Policy

## Supported Versions

Currently supported protocol versions receiving cryptographic and sandbox isolation patches:

| Version | Supported          |
| ------- | ------------------ |
| 0.4.x   | :white_check_mark: |
| < 0.4.0 | :x:                |

## Zero-Trust Architecture Guarantees
Open-Side enforces strict execution boundaries across all standby worker nodes:
1. **Ephemeral Key Exchange**: Every P2P session negotiates fresh `prime256v1` ECDH keys.
2. **Authenticated Encryption**: All task partitions require valid `AES-256-GCM` authentication tags prior to deserialization.
3. **VM Isolation**: Payloads execute inside frozen V8 contexts (`node:vm`) with zero access to host `fs`, `net`, `child_process`, or `process.env`.

## Reporting a Vulnerability
If you discover a sandbox escape vector, cryptographic side-channel, or routing vulnerability, please open a draft security advisory under the **Security** tab or contact the maintainer directly via GitHub prior to public disclosure.
