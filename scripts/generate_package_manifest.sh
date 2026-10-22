#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/artifacts/manifests"
mkdir -p "$OUT_DIR"

cat \
  "$ROOT_DIR/config/packages/common-packages.txt" \
  "$ROOT_DIR/config/packages/arch-packages.txt" \
  "$ROOT_DIR/config/packages/debian-packages.txt" \
  | awk 'NF && !seen[$0]++' > "$OUT_DIR/open-side-v1-packages.txt"

sha256sum "$OUT_DIR/open-side-v1-packages.txt" > "$OUT_DIR/open-side-v1-packages.txt.sha256"
echo "Generated package manifest in ${OUT_DIR}"
