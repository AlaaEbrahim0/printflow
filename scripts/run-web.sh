#!/usr/bin/env bash
# Run the Vite dev server against a local API.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/web"

if [[ ! -d node_modules ]]; then
  echo "web/node_modules is missing. Run: make setup" >&2
  exit 1
fi

export VITE_API_PROXY_TARGET="${VITE_API_PROXY_TARGET:-http://localhost:8080}"
exec npm run dev -- --host 0.0.0.0 --port "${WEB_PORT:-5173}"
