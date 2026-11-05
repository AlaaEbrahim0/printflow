#!/usr/bin/env bash
# Run the API natively with SQLite. Development only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/api"
exec dotnet run --project src/PrintSheet.Api --launch-profile http
