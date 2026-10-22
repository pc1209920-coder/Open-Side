#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOW_PROFILE="${ROOT_DIR}/config/hardware/performance-lite.env"
HIGH_PROFILE="${ROOT_DIR}/config/hardware/gaming-ultra.env"

mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
cores="$(nproc)"

if lspci 2>/dev/null | grep -Eqi 'nvidia|amd/ati'; then
  has_discrete_gpu=1
else
  has_discrete_gpu=0
fi

if [[ "$mem_mb" -le 6144 || "$cores" -le 4 || "$has_discrete_gpu" -eq 0 ]]; then
  echo "$LOW_PROFILE"
else
  echo "$HIGH_PROFILE"
fi
