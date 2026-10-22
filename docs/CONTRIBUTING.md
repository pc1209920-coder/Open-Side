# Contributing to Open-Side

## Local Validation

Run before submitting changes:

1. `/home/runner/work/Open-Side/Open-Side/scripts/lint.sh`
2. `/home/runner/work/Open-Side/Open-Side/scripts/ci_verify.sh`
3. `bash -n scripts/*.sh scripts/lib/*.sh`

## Change Policy

- Keep changes modular under `config/` and `scripts/`
- Update docs for any profile, package, or security rule changes
- Add hashes/checksums for all generated release artifacts

## Security Policy

- Do not disable baseline hardening controls without explicit rationale
- Keep inbound network policy default-deny
- Prefer least-privilege defaults for every new component
