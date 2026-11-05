#!/usr/bin/env bash
# Run the worker natively against a local API and storage directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/worker"

if [[ ! -x .venv/bin/python ]]; then
  echo "worker/.venv is missing. Run: make setup" >&2
  exit 1
fi

export PRINTSHEET_API_BASE_URL="${PRINTSHEET_API_BASE_URL:-http://localhost:8080}"
export PRINTSHEET_STORAGE_ROOT="${PRINTSHEET_STORAGE_ROOT:-$ROOT/storage}"
export PRINTSHEET_WORKER_KEY="${PRINTSHEET_WORKER_KEY:-dev-worker-key}"
export PRINTSHEET_WORKER_ID="${PRINTSHEET_WORKER_ID:-worker-native}"
export PRINTSHEET_GPU_ENABLED="${PRINTSHEET_GPU_ENABLED:-false}"

mkdir -p "$PRINTSHEET_STORAGE_ROOT"
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${WORKER_PORT:-8000}"
