#!/usr/bin/env bash
# Run the API natively with SQLite. Development only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/api"

# Pin the storage root to the repo, the same one `run-worker.sh` and the packer
# read. `appsettings.Development.json` says "storage", which is relative to the
# process working directory — and `dotnet run` puts that at
# `api/src/PrintSheet.Api`, so uploads landed in `api/src/PrintSheet.Api/storage`
# while the worker looked in `storage/` at the repo root. Every job then failed
# with "input file is missing" even though the file had been written.
export Storage__Root="${Storage__Root:-$ROOT/storage}"
mkdir -p "$Storage__Root"

exec dotnet run --project src/PrintSheet.Api --launch-profile http
