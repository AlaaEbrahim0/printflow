#!/usr/bin/env bash
# Start the native worker with the pinned Real-ESRGAN build on a spare port.
# Used by the live pipeline test; not part of the product runtime.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/worker"

export PRINTSHEET_STORAGE_ROOT="${PRINTSHEET_STORAGE_ROOT:-/tmp/printsheet-live-storage}"
export PRINTSHEET_WORKER_KEY="${PRINTSHEET_WORKER_KEY:-dev-worker-key}"
export PRINTSHEET_GPU_ENABLED=true
export PRINTSHEET_RUN_JOBS=false
export PRINTSHEET_REALESRGAN_BINARY="$ROOT/.tools/realesrgan-v0.2.5.0/realesrgan-ncnn-vulkan"
export PRINTSHEET_REALESRGAN_MODEL_DIR="$ROOT/.tools/realesrgan-v0.2.5.0/models"
export PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX="${PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX:-1}"

mkdir -p "$PRINTSHEET_STORAGE_ROOT"
exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "${LIVE_WORKER_PORT:-8001}"
