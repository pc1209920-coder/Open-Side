# Release Model

## Hybrid Strategy

Open-Side follows:

- Stable core ISO milestones (`v1.0.0`, `v1.1.0`, ...)
- Rolling update cadence for security definitions, GPU stack updates, and gaming compatibility layers

## Stable Milestone Requirements

- security baseline checks pass
- manifest and checksum artifacts generated
- profile detection + application scripts validated
- Arch and Debian build staging outputs generated

## Rolling Channels

Rolling updates should be limited to:

- hardened security policy files
- GPU driver and Vulkan package lists
- game compatibility layer adjustments (Wine/Proton/GameMode/MangoHud)
