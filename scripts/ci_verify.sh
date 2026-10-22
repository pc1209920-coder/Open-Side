#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/scripts/generate_package_manifest.sh"
"${ROOT_DIR}/scripts/security_audit.sh"

if [[ -f "${ROOT_DIR}/artifacts/manifests/open-side-v1-packages.txt.sha256" ]]; then
  ( cd "${ROOT_DIR}/artifacts/manifests" && sha256sum -c open-side-v1-packages.txt.sha256 )
fi

echo "CI verification checks completed"
