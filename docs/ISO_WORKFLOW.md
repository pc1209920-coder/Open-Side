# ISO and Image Workflow

## Input Types

- base upstream ISO
- package repositories
- local overlay files
- configuration manifests

## Build Flow

1. verify source integrity and checksums
2. unpack and stage base image
3. apply package and config overlays
4. inject hardening and policy defaults
5. rebuild image and boot artifacts
6. generate checksums and signature files
7. run smoke tests in VM and bare-metal candidates

## Merge Rules for Multiple Inputs

- never merge unsigned or unverified image inputs
- prefer declarative manifests over ad-hoc binary edits
- track all overlays as versioned files in repository
- keep one merge log per image build

## Required Artifacts

- build manifest
- software bill of materials reference
- SHA256 checksums
- release notes and known issue list
