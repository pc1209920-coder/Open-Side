#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/build/live-build"

mkdir -p "${OUT_DIR}/config/includes.chroot/etc/sysctl.d" "${OUT_DIR}/config/package-lists"
mkdir -p "${OUT_DIR}/auto"
cp "${ROOT_DIR}/config/build/live-build.auto.config" "${OUT_DIR}/auto/config"
cp "${ROOT_DIR}/config/security/sysctl.conf" "${OUT_DIR}/config/includes.chroot/etc/sysctl.d/99-open-side-security.conf"
cp "${ROOT_DIR}/config/packages/common-packages.txt" "${OUT_DIR}/config/package-lists/common.list.chroot"
cp "${ROOT_DIR}/config/packages/debian-packages.txt" "${OUT_DIR}/config/package-lists/debian.list.chroot"

echo "Prepared live-build profile at ${OUT_DIR}"
