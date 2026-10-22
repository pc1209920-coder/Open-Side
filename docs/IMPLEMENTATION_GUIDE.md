# Open-Side Implementation Guide

## Base Architecture

Open-Side uses a modular dual pipeline:

- `archiso` path for Arch-based builds with `linux-zen`
- `live-build` path for Debian/Ubuntu-compatible builds

Core package/runtime compatibility is achieved using:

- Distrobox for cross-distro user-space containers
- Flatpak for universal app packaging
- Wine/Proton stack for Windows game/application compatibility
- Waydroid profile placeholders for Android app support

## Build Steps

1. Run `/home/runner/work/Open-Side/Open-Side/scripts/build_local.sh`
2. Use generated `build/archiso/profile` with `mkarchiso`
3. Use generated `build/live-build` with `lb build`
4. Use `/home/runner/work/Open-Side/Open-Side/scripts/verify_iso.sh` to verify release ISOs with SHA256 files

## Hardware Adaptation

- `Performance-Lite` targets low-end systems (higher zram, lower animation level)
- `Gaming-Ultra` targets gaming rigs (performance governor, lower latency quantum)

Profiles are auto-detected by `/home/runner/work/Open-Side/Open-Side/scripts/detect_hardware_profile.sh` and applied by `/home/runner/work/Open-Side/Open-Side/scripts/apply_profile.sh`.

## Security Baseline

- Hardened sysctl (`config/security/sysctl.conf`)
- nftables default deny inbound profile (`config/security/nftables.conf`)
- DoH/DoT resolved config (`config/network/doh-resolved.conf`)
- AppArmor + Firejail app baselines
