#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-name>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_NAME="$1"
TARGET_DIR="${ROOT_DIR}/research/${TARGET_NAME}"
TEMPLATE_DIR="${ROOT_DIR}/research/templates/base"

if [[ -d "${TARGET_DIR}" ]]; then
  echo "Target already exists: ${TARGET_DIR}"
  exit 1
fi

mkdir -p "${TARGET_DIR}/artifacts"
cp "${TEMPLATE_DIR}/README.md" "${TARGET_DIR}/README.md"
cp "${TEMPLATE_DIR}/notes.md" "${TARGET_DIR}/notes.md"
cp "${TEMPLATE_DIR}/references.md" "${TARGET_DIR}/references.md"

echo "Created target scaffold at ${TARGET_DIR}"
