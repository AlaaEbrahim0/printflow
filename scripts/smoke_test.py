#!/usr/bin/env python3
"""Wait for and verify a Compose (or native) PrintSheet stack.

Checks:
- API /healthz is Healthy and the database check is Healthy;
- API /api/v1/info reports contract 2.0.0;
- worker /health reports ok, writable shared storage and maxGpuJobs = 1;
- web / serves an HTML page containing "PrintSheet".

Usage:
    ./scripts/smoke_test.py
    API_URL=http://localhost:8080 WORKER_URL=http://localhost:8000 \
        WEB_URL=http://localhost:5173 ./scripts/smoke_test.py
    TIMEOUT_SECONDS=180 ./scripts/smoke_test.py

Exit code 0 means every check passed. This script only uses the standard
library so it works before any venv exists.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("API_URL", "http://localhost:8080").rstrip("/")
WORKER_URL = os.environ.get("WORKER_URL", "http://localhost:8000").rstrip("/")
WEB_URL = os.environ.get("WEB_URL", "http://localhost:5173").rstrip("/")
TIMEOUT_SECONDS = float(os.environ.get("TIMEOUT_SECONDS", "120"))


def fetch(url: str) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.status, response.read().decode("utf-8", errors="replace")


def fetch_json(url: str) -> tuple[int, object]:
    status, body = fetch(url)
    return status, json.loads(body)


def wait_for(name: str, probe) -> None:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            probe()
            print(f"  ok   {name}")
            return
        except Exception as exc:  # noqa: BLE001 - retry every failure
            last_error = exc
            time.sleep(2)
    raise SystemExit(f"FAIL {name}: {last_error}")


def check_api_health() -> None:
    status, payload = fetch_json(f"{API_URL}/healthz")
    assert status == 200, f"expected 200, got {status}"
    assert isinstance(payload, dict), "expected a JSON object"
    assert str(payload.get("status", "")).lower() == "healthy", f"status={payload.get('status')}"
    checks = payload.get("checks") or []
    database = next((c for c in checks if c.get("name") == "database"), None)
    assert database is not None, "database health check missing"
    assert str(database.get("status", "")).lower() == "healthy", f"database={database}"


def check_api_info() -> None:
    status, payload = fetch_json(f"{API_URL}/api/v1/info")
    assert status == 200, f"expected 200, got {status}"
    assert isinstance(payload, dict), "expected a JSON object"
    assert payload.get("contractVersion") == "2.0.0", payload
    assert payload.get("service") == "printsheet-api", payload
    assert payload.get("phase") == 2, payload


def check_worker() -> None:
    status, payload = fetch_json(f"{WORKER_URL}/health")
    assert status == 200, f"expected 200, got {status}"
    assert isinstance(payload, dict), "expected a JSON object"
    assert payload.get("status") == "ok", payload
    assert payload.get("storageWritable") is True, payload
    assert payload.get("maxGpuJobs") == 1, payload


def check_web() -> None:
    status, body = fetch(f"{WEB_URL}/")
    assert status == 200, f"expected 200, got {status}"
    assert "printsheet" in body.lower(), "web page does not mention PrintSheet"


def main() -> int:
    print(f"Smoke testing API={API_URL} worker={WORKER_URL} web={WEB_URL}")
    try:
        wait_for("api /healthz + database", check_api_health)
        wait_for("api /api/v1/info", check_api_info)
        wait_for("worker /health", check_worker)
        wait_for("web /", check_web)
    except urllib.error.URLError as exc:
        print(f"FAIL network error: {exc}", file=sys.stderr)
        return 1
    print("Smoke test passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
