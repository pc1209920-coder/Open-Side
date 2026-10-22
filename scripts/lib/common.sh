#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[open-side] %s\n' "$*"
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

ensure_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

safe_mkdir() {
  mkdir -p "$1"
}
