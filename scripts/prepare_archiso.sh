#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/build/archiso"
PROFILE_DIR="${OUT_DIR}/profile"

mkdir -p "${PROFILE_DIR}/airootfs/etc" "${PROFILE_DIR}/packages"
cp "${ROOT_DIR}/config/build/archiso.profiledef.sh" "${PROFILE_DIR}/profiledef.sh"
cp "${ROOT_DIR}/config/security/sysctl.conf" "${PROFILE_DIR}/airootfs/etc/99-open-side-security.conf"
cp "${ROOT_DIR}/config/packages/common-packages.txt" "${PROFILE_DIR}/packages/common.txt"
cp "${ROOT_DIR}/config/packages/arch-packages.txt" "${PROFILE_DIR}/packages/arch.txt"

cat "${PROFILE_DIR}/packages/common.txt" "${PROFILE_DIR}/packages/arch.txt" | awk 'NF && !seen[$0]++' > "${PROFILE_DIR}/packages.x86_64"

echo "Prepared archiso profile at ${PROFILE_DIR}"
