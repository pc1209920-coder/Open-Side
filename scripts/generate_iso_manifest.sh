#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <release-name> <base-iso-path>"
  exit 1
fi

RELEASE_NAME="$1"
BASE_ISO_PATH="$2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/research/${RELEASE_NAME}"
MANIFEST_PATH="${OUT_DIR}/iso-manifest.txt"

mkdir -p "${OUT_DIR}"

{
  echo "release=${RELEASE_NAME}"
  echo "base_iso=${BASE_ISO_PATH}"
  echo "generated_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -f "${BASE_ISO_PATH}" ]]; then
    echo "base_iso_sha256=$(sha256sum "${BASE_ISO_PATH}" | awk '{print $1}')"
  else
    echo "base_iso_sha256=missing-file"
  fi
} > "${MANIFEST_PATH}"

echo "Manifest written to ${MANIFEST_PATH}"
