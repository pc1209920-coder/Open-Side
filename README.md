# Open-Side

Open-Side is a starter repository for learning and practicing operating system reverse engineering in a structured and responsible way.

## Goals

- Document reverse engineering workflows for OS internals.
- Organize notes, findings, and references in one place.
- Provide reproducible steps for static and dynamic analysis labs.
- Keep work focused on legal, defensive, and educational research.

## Scope

This repository is intended for:

- Kernel and boot process analysis
- System call and driver behavior research
- Binary format and memory layout investigation
- VM-based experiments and debugging notes

## Repository Layout

- `docs/` — process documentation, workflows, and study notes
- `research/` — per-target analysis projects and findings
- `samples/` — legally obtained sample binaries and metadata
- `scripts/` — helper scripts for repeatable local analysis tasks

See `/home/runner/work/Open-Side/Open-Side/docs/PROJECT_STRUCTURE.md` for details.

## Getting Started

1. Work inside an isolated virtual machine.
2. Create a new target folder under `research/`.
3. Record all assumptions, steps, and outputs in that folder.
4. Keep scripts deterministic and versioned in `scripts/`.
5. Track references and conclusions in `docs/`.

## Responsible Use

- Analyze only software and systems you are legally allowed to inspect.
- Do not use this repository for unauthorized access or disruption.
- Prefer disclosure and defensive remediation when vulnerabilities are found.

## Next Steps

- Fill in target-specific templates under `research/`.
- Add tool setup instructions for your environment.
- Add automation scripts for symbol extraction and diff workflows.