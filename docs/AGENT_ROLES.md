# Agent Roles and Ownership

## Agent Model

Each agent owns one area and produces versioned outputs in this repository.

## Core Agents

1. **Kernel Agent**
   - owns kernel configuration baseline and hardening toggles
2. **ISO Agent**
   - owns ISO build definitions, image composition, integrity artifacts
3. **Security Agent**
   - owns threat model, hardening checklist, vulnerability triage
4. **Compatibility Agent**
   - owns app/runtime compatibility matrix and regression tracking
5. **Gaming Agent**
   - owns game runtime stack, graphics drivers profile, performance checks
6. **Entertainment Agent**
   - owns audio/video codec and media pipeline profile
7. **UX Agent**
   - owns desktop profile, animation standards, and accessibility gates
8. **QA Agent**
   - owns test plans, release criteria, and bug acceptance rules
9. **Release Agent**
   - owns release manifests, signing metadata, and rollout documentation

## Required Output Per Agent

- one source-of-truth spec in `docs/`
- one executable checklist in `research/`
- one change log entry per release candidate
