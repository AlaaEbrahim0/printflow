#!/usr/bin/env bash
# Run the worker natively with GPU processing enabled.
#
# The Compose worker is CPU-only. On the workstation, Real-ESRGAN runs through
# realesrgan-ncnn-vulkan; Phase 1 B wires the binary path and tile sizing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export PRINTSHEET_GPU_ENABLED=true
export PRINTSHEET_STORAGE_ROOT="${PRINTSHEET_STORAGE_ROOT:-$ROOT/storage}"
export PRINTSHEET_API_BASE_URL="${PRINTSHEET_API_BASE_URL:-http://localhost:8080}"

exec "$ROOT/scripts/run-worker.sh"
