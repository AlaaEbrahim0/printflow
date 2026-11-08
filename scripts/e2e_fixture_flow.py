#!/usr/bin/env python3
"""Exercise intake through PNG export against a running native or Compose stack.

Generate fixtures first, then start the API, worker job loop and packer runner.
The script creates a persistent batch so the result can be inspected in the UI.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
API_URL = os.environ.get("API_URL", "http://localhost:8080").rstrip("/")
TIMEOUT_SECONDS = float(os.environ.get("E2E_TIMEOUT_SECONDS", "240"))
FIXTURE_NAME = os.environ.get("E2E_FIXTURE_NAME", "Sticker with fringe")


class FlowError(RuntimeError):
    pass


def api(
    path: str,
    *,
    method: str = "GET",
    payload: object | None = None,
    body: bytes | None = None,
    content_type: str = "application/json",
) -> tuple[int, bytes]:
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = content_type
    elif body is not None:
        headers["Content-Type"] = content_type
    request = Request(f"{API_URL}{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=15) as response:
            return response.status, response.read()
    except HTTPError as error:
        response_body = error.read()
        try:
            details = json.dumps(json.loads(response_body), ensure_ascii=False)
        except (UnicodeDecodeError, json.JSONDecodeError):
            details = response_body[:1000].decode("utf-8", errors="replace")
        raise FlowError(f"{method} {path} returned HTTP {error.code}: {details}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise FlowError(f"{method} {path} failed: {error}") from error


def json_request(path: str, *, method: str = "GET", payload: object | None = None) -> dict:
    _status, body = api(path, method=method, payload=payload)
    if not body:
        return {}
    try:
        result = json.loads(body)
    except json.JSONDecodeError as error:
        raise FlowError(f"{method} {path} returned invalid JSON") from error
    if not isinstance(result, dict):
        raise FlowError(f"{method} {path} did not return a JSON object")
    return result


def upload_fixture(batch_id: str, design: dict) -> dict:
    fixture_path = ROOT / "fixtures" / "generated" / design["file"]
    if not fixture_path.is_file():
        raise FlowError(f"fixture is missing: {fixture_path}; run `make fixtures` first")
    boundary = f"PrintSheetE2E{uuid.uuid4().hex}"
    parts: list[bytes] = []
    fields = {
        "name": design["name"],
        "garmentColorKind": "light",
        "targetWidthCm": str(design["targetWidthCm"]),
        "targetHeightCm": str(design["targetHeightCm"]),
    }
    for name, value in fields.items():
        parts.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    parts.extend(
        [
            f"--{boundary}\r\n".encode(),
            (
                f'Content-Disposition: form-data; name="file"; filename="{fixture_path.name}"\r\n'
            ).encode(),
            b"Content-Type: image/png\r\n\r\n",
            fixture_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    _status, body = api(
        f"/api/v1/batches/{batch_id}/designs",
        method="POST",
        body=b"".join(parts),
        content_type=f"multipart/form-data; boundary={boundary}",
    )
    result = json.loads(body)
    if not isinstance(result, dict):
        raise FlowError("intake did not return a design object")
    return result


def wait_for_job(job_id: str, label: str) -> dict:
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        job = json_request(f"/api/v1/jobs/{job_id}")
        status = job.get("status")
        if status == "succeeded":
            result = job.get("result")
            if not isinstance(result, dict):
                raise FlowError(f"{label} succeeded without a result object")
            return result
        if status in {"failed", "cancelled"}:
            raise FlowError(
                f"{label} ended with status {status}: {job.get('error') or job.get('result')}"
            )
        time.sleep(1)
    raise FlowError(f"timed out waiting for {label} job {job_id}")


def accepted_job(response: dict) -> str:
    job_id = response.get("jobId")
    if not isinstance(job_id, str):
        raise FlowError(f"API did not return a jobId: {response}")
    return job_id


def file_hash(path: str) -> str:
    _status, body = api(path)
    return hashlib.sha256(body).hexdigest()


def run() -> None:
    manifest_path = ROOT / "fixtures" / "generated" / "manifest.json"
    if not manifest_path.is_file():
        raise FlowError("fixture manifest is missing; run `make fixtures` first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    design = next((item for item in manifest["designs"] if item["name"] == FIXTURE_NAME), None)
    if design is None:
        raise FlowError(f"fixture {FIXTURE_NAME!r} is not in the generated manifest")

    batch = json_request(
        "/api/v1/batches/",
        method="POST",
        payload={
            "name": f"Fixture E2E {uuid.uuid4().hex[:8]}",
            "rollWidthCm": manifest["batch"]["rollWidthCm"],
            "marginMm": 2,
            "edgeMarginMm": 2,
            "workingDpi": manifest["batch"]["workingDpi"],
        },
    )
    batch_id = batch.get("id")
    if not isinstance(batch_id, str):
        raise FlowError(f"API did not return a batch id: {batch}")

    uploaded = upload_fixture(batch_id, design)
    design_id = uploaded.get("id")
    current = uploaded.get("currentVersion")
    original_version_id = current.get("id") if isinstance(current, dict) else None
    if not isinstance(design_id, str) or not isinstance(original_version_id, str):
        raise FlowError(f"intake response is missing design/version ids: {uploaded}")
    original_path = f"/api/v1/designs/{design_id}/versions/{original_version_id}/file"
    original_hash = file_hash(original_path)

    resize = json_request(
        f"/api/v1/designs/{design_id}/steps/resize",
        method="POST",
        payload={
            "targetWidthCm": design["targetWidthCm"],
            "targetHeightCm": design["targetHeightCm"],
            "fitMode": "contain",
            "dpi": manifest["batch"]["workingDpi"],
        },
    )
    resize_job = accepted_job(resize)
    resize_result = wait_for_job(resize_job, "resize")
    proposed_version_id = resize_result.get("outputVersionId")
    if not isinstance(proposed_version_id, str):
        raise FlowError(f"resize result is missing outputVersionId: {resize_result}")
    json_request(
        f"/api/v1/designs/{design_id}/versions/{proposed_version_id}/approve",
        method="POST",
    )
    if file_hash(original_path) != original_hash:
        raise FlowError("original upload changed during resize/approval")

    pack = json_request(
        f"/api/v1/batches/{batch_id}/sheet/pack",
        method="POST",
        payload={"seed": 20261105, "randomizedOrderings": 2, "timeBudgetMs": 4000},
    )
    pack_result = wait_for_job(accepted_job(pack), "pack")
    packed_sheet = json_request(f"/api/v1/batches/{batch_id}/sheet")
    placements = packed_sheet.get("placements")
    placement_count = pack_result.get("metadata", {}).get("placementCount")
    if not isinstance(placements, list) or not placements:
        raise FlowError(f"packed sheet has no placements: {packed_sheet}")
    if placement_count != len(placements):
        raise FlowError(
            f"pack job reported {placement_count} placements but sheet has {len(placements)}"
        )

    integrity = json_request(
        f"/api/v1/batches/{batch_id}/sheet/integrity-check",
        method="POST",
    )
    integrity_result = wait_for_job(accepted_job(integrity), "integrity")
    report = integrity_result.get("integrityReport")
    if not isinstance(report, dict) or report.get("passed") is not True:
        raise FlowError(f"fixture sheet failed integrity: {report}")

    export = json_request(
        f"/api/v1/batches/{batch_id}/exports",
        method="POST",
        payload={"format": "flat-png", "includePreview": True},
    )
    export_result = wait_for_job(accepted_job(export), "export")
    export_id = export_result.get("exportId")
    if not isinstance(export_id, str):
        raise FlowError(f"export result is missing exportId: {export_result}")
    artifacts = json_request(f"/api/v1/exports/{export_id}")
    artifact_names = {
        artifact.get("name")
        for artifact in artifacts.get("artifacts", [])
        if isinstance(artifact, dict)
    }
    if not {"flat", "preview"}.issubset(artifact_names):
        raise FlowError(f"export is missing flat/preview artifacts: {artifacts}")
    for artifact in ("flat", "preview"):
        _status, data = api(
            f"/api/v1/exports/{export_id}/download?{urlencode({'artifact': artifact})}"
        )
        if not data:
            raise FlowError(f"downloaded {artifact} artifact is empty")

    print(
        "Fixture E2E passed: "
        f"batch={batch_id}, design={design_id}, placements={len(placements)}, "
        f"integrity=passed, export={export_id}"
    )


def main() -> int:
    try:
        run()
    except (FlowError, KeyError, TypeError, ValueError) as error:
        print(f"Fixture E2E failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
