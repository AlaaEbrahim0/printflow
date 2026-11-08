#!/usr/bin/env bash
# Run the worker natively with GPU processing enabled.
#
# The Compose worker is CPU-only. On the workstation, Real-ESRGAN runs through
# realesrgan-ncnn-vulkan.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PRINTSHEET_GPU_ENABLED=true
export PRINTSHEET_CAPABILITIES="${PRINTSHEET_CAPABILITIES:-gpu}"
export PRINTSHEET_LOG_JSON="${PRINTSHEET_LOG_JSON:-true}"
export PRINTSHEET_STORAGE_ROOT="${PRINTSHEET_STORAGE_ROOT:-$ROOT/storage}"
export PRINTSHEET_API_BASE_URL="${PRINTSHEET_API_BASE_URL:-http://localhost:8080}"
# This workstation enumerates Intel UHD as Vulkan device 0 and the GTX as 1.
export PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX="${PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX:-1}"
export WORKER_PORT="${WORKER_PORT:-8001}"

ENGINE_DIR="$ROOT/.tools/realesrgan-v0.2.5.0"
if [[ -x "$ENGINE_DIR/realesrgan-ncnn-vulkan" ]]; then
  export PRINTSHEET_REALESRGAN_BINARY="${PRINTSHEET_REALESRGAN_BINARY:-$ENGINE_DIR/realesrgan-ncnn-vulkan}"
  export PRINTSHEET_REALESRGAN_MODEL_DIR="${PRINTSHEET_REALESRGAN_MODEL_DIR:-$ENGINE_DIR/models}"
fi

exec "$ROOT/scripts/run-worker.sh"
