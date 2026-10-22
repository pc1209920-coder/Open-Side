#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_files=(
  "config/security/sysctl.conf"
  "config/security/nftables.conf"
  "config/network/doh-resolved.conf"
  "config/security/apparmor-profiles.list"
  "config/security/firejail-apps.list"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "${ROOT_DIR}/${f}" ]]; then
    echo "Missing required security file: ${f}" >&2
    exit 1
  fi
  echo "ok: ${f}"
done

echo "Security audit baseline passed"
