#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <iso-path> <sha256-file>"
  exit 1
fi

ISO_PATH="$1"
SHA_FILE="$2"

if [[ ! -f "$ISO_PATH" ]]; then
  echo "ISO not found: $ISO_PATH" >&2
  exit 1
fi

if [[ ! -f "$SHA_FILE" ]]; then
  echo "Checksum file not found: $SHA_FILE" >&2
  exit 1
fi

( cd "$(dirname "$SHA_FILE")" && sha256sum -c "$(basename "$SHA_FILE")" )
echo "Verification passed for ${ISO_PATH}"
