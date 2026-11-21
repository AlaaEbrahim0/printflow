#!/usr/bin/env bash
# Start the native worker with the pinned Real-ESRGAN build on a spare port and
# without the job loop, so the live pipeline test has a real upscaler to call.
# Not part of the product runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/worker"

if [[ ! -x .venv/bin/python ]]; then
  echo "worker/.venv is missing. Run: make setup" >&2
  exit 1
fi

ENGINE_DIR="$ROOT/.tools/realesrgan-v0.2.5.0"
if [[ ! -x "$ENGINE_DIR/realesrgan-ncnn-vulkan" ]]; then
  echo "Real-ESRGAN is missing at $ENGINE_DIR. Run: make worker-gpu-setup" >&2
  exit 1
fi

export PRINTSHEET_STORAGE_ROOT="${PRINTSHEET_STORAGE_ROOT:-/tmp/printsheet-live-storage}"
export PRINTSHEET_WORKER_KEY="${PRINTSHEET_WORKER_KEY:-dev-worker-key}"
export PRINTSHEET_GPU_ENABLED=true
export PRINTSHEET_RUN_JOBS=false
export PRINTSHEET_REALESRGAN_BINARY="$ENGINE_DIR/realesrgan-ncnn-vulkan"
export PRINTSHEET_REALESRGAN_MODEL_DIR="$ENGINE_DIR/models"
# This workstation enumerates Intel UHD as Vulkan device 0 and the GTX as 1.
export PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX="${PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX:-1}"

mkdir -p "$PRINTSHEET_STORAGE_ROOT"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${WORKER_GPU_PORT:-8001}"
