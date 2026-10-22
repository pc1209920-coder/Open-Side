#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_PATH="${1:-}"

if [[ -z "$PROFILE_PATH" ]]; then
  PROFILE_PATH="$("${ROOT_DIR}"/scripts/detect_hardware_profile.sh)"
fi

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "Profile not found: $PROFILE_PATH" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$PROFILE_PATH"

mkdir -p "${ROOT_DIR}/build/runtime"
cat > "${ROOT_DIR}/build/runtime/active-profile.env" <<EOF_PROFILE
PROFILE_NAME=${PROFILE_NAME}
CPU_GOVERNOR=${CPU_GOVERNOR}
ANIMATION_LEVEL=${ANIMATION_LEVEL}
ZRAM_PERCENT=${ZRAM_PERCENT}
PIPEWIRE_QUANTUM=${PIPEWIRE_QUANTUM}
GPU_MODE=${GPU_MODE}
EOF_PROFILE

echo "Applied profile: ${PROFILE_NAME}"
