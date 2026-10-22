#!/usr/bin/env bash
set -euo pipefail

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is required" >&2
  exit 1
fi

find "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts" -type f -name '*.sh' -print0 | xargs -0 shellcheck
