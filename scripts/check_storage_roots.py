#!/usr/bin/env python3
"""Assert the native API and worker resolve the same storage root.

They must: the API writes version files and the worker reads them, and the
exchange is a relative path inside one shared root. A mismatch is silent at
upload time and surfaces later as `input file is missing` on every job, which is
exactly what happened when `Storage:Root` was left as the relative `storage` and
`dotnet run` moved the API's working directory into the project folder.

The scripts are the single place that decides the root, so this reads them
rather than starting either service.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def default_root(script: str, variable: str) -> str:
    text = (ROOT / "scripts" / script).read_text()
    match = re.search(rf'{re.escape(variable)}="\$\{{[^}}]*:-\$ROOT/([^"}}]+)\}}"', text)
    if match is None:
        raise SystemExit(f"{script}: could not find a $ROOT-anchored default for {variable}")
    return match.group(1)


def main() -> int:
    api = default_root("run-api.sh", "Storage__Root")
    worker = default_root("run-worker.sh", "PRINTSHEET_STORAGE_ROOT")
    if api != worker:
        print(f"storage root split: API uses {api!r}, worker uses {worker!r}", file=sys.stderr)
        return 1
    # A relative root would be resolved against whatever directory each process
    # happens to start in, which is the original defect.
    if pathlib.PurePosixPath(api).is_absolute():
        print(f"storage root must stay $ROOT-relative, got {api!r}", file=sys.stderr)
        return 1
    print(f"storage root ok: both scripts use $ROOT/{api}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
