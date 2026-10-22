#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/scripts/apply_profile.sh" "${1:-}"
"${ROOT_DIR}/scripts/generate_package_manifest.sh"
"${ROOT_DIR}/scripts/prepare_archiso.sh"
"${ROOT_DIR}/scripts/prepare_live_build.sh"
"${ROOT_DIR}/scripts/security_audit.sh"

echo "Open-Side local prep pipeline complete."
echo "Next: run archiso/live-build on a host with required toolchains."
