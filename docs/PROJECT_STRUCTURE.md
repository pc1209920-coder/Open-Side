# Project Structure

## Directory Standards

### `research/`
Use one folder per target, for example:

- `research/windows-kernel-basics/`
- `research/linux-syscall-tracing/`

Recommended contents:

- `README.md` — objective, environment, legal scope
- `notes.md` — analysis notes and timeline
- `artifacts/` — non-sensitive output files
- `references.md` — papers, docs, links

### `samples/`
Store only legally obtained binaries or stripped samples, with:

- source information
- license/usage status
- hash values (SHA256)

### `scripts/`
Reusable scripts for:

- unpacking and metadata extraction
- symbol and section inspection
- binary comparison tasks

### `docs/`
Shared process docs:

- workflow definitions
- setup instructions
- analysis checklists
