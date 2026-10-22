#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/build/merge"
INPUT_DIR="${ROOT_DIR}/inputs"

mkdir -p "$OUT_DIR"

if [[ ! -d "$INPUT_DIR" ]]; then
  echo "Expected input directory at ${INPUT_DIR}" >&2
  exit 1
fi

find "$INPUT_DIR" -maxdepth 1 -type f \( -name '*.iso' -o -name '*.img' -o -name '*.squashfs' -o -name '*.tar.*' \) | sort > "${OUT_DIR}/input-files.txt"

if [[ ! -s "${OUT_DIR}/input-files.txt" ]]; then
  echo "No mergeable input files found in ${INPUT_DIR}" >&2
  exit 1
fi

while IFS= read -r file; do
  sha256sum "$file"
done < "${OUT_DIR}/input-files.txt" > "${OUT_DIR}/input-checksums.sha256"

echo "Prepared merge index at ${OUT_DIR}/input-files.txt"
