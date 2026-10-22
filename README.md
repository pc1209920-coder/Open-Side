# Open-Side

Open-Side is an open-source operating-system engineering repository focused on a **security-first, gaming-ready, compatibility-driven** Linux distribution workflow.

## v1 Direction

- Base pipeline: **Arch + Debian/Ubuntu hybrid** (`archiso` + `live-build` compatible)
- Kernel baseline: **linux-zen** (Arch path)
- Runtime compatibility: **Distrobox + Flatpak + Wine/Proton + Waydroid profile support**
- License: **GPLv3**

## Repository Layout

- `/home/runner/work/Open-Side/Open-Side/config/` — build, security, gaming, compatibility, package, and hardware profile definitions
- `/home/runner/work/Open-Side/Open-Side/scripts/` — executable local automation for profile detection, build prep, manifesting, verification, and audits
- `/home/runner/work/Open-Side/Open-Side/docs/` — architecture, implementation, release model, workflows, and contributor guidance
- `/home/runner/work/Open-Side/Open-Side/research/` — target-specific analysis and implementation experiments

## Dual-Tier Hardware Profiles

- `Performance-Lite` for low-end systems (aggressive zram, lower animation/latency budget)
- `Gaming-Ultra` for high-end systems (performance governor, low-latency gaming stack)

## Quick Start

1. Run local prep pipeline:
   - `/home/runner/work/Open-Side/Open-Side/scripts/build_local.sh`
2. Optional: force profile:
   - `/home/runner/work/Open-Side/Open-Side/scripts/build_local.sh /home/runner/work/Open-Side/Open-Side/config/hardware/gaming-ultra.env`
3. Build from generated outputs:
   - Arch path: `build/archiso/profile` with `mkarchiso`
   - Debian path: `build/live-build` with `lb build`

## CI/CD

GitHub Actions include:

- shell script linting with ShellCheck
- manifest/security baseline verification
- release artifact bundle generation on tags or manual dispatch

## Core Security Controls

- Hardened sysctl defaults
- Default-deny nftables policy
- AppArmor/Firejail baseline lists
- DNS encryption-ready resolver profile
- SHA256 manifest and artifact verification

## Core Gaming & Compatibility Controls

- GameMode + MangoHud defaults
- PipeWire low-latency profile
- Vulkan/Mesa package sets
- Wine/Proton pre-configuration baseline
- Flatpak remotes and Distrobox container templates
