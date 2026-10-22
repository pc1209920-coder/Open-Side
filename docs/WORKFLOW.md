# Reverse Engineering Workflow

## 1) Define Target and Boundaries

- State what component you are analyzing.
- Confirm legal permission and environment boundaries.
- Define expected outputs (report, notes, script, diff).

## 2) Prepare Analysis Environment

- Isolated VM snapshot
- Debugger/disassembler setup
- Logging and artifact capture path

## 3) Baseline Collection

- File metadata and hashes
- Binary sections/imports/exports
- Version and build identifiers

## 4) Static Analysis

- Entry points and control flow mapping
- Key data structures and constants
- Candidate privileged paths or trust boundaries

## 5) Dynamic Analysis

- Runtime behavior tracing
- API/system call observation
- Memory/state inspection at critical branches

## 6) Findings and Validation

- Record confirmed behavior with evidence
- Separate hypothesis from verified facts
- Reproduce key observations at least once

## 7) Documentation

- Summarize findings clearly
- Capture limitations and open questions
- Add remediation guidance for defensive issues
