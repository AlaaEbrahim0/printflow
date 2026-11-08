"""Tests for the API-backed packer job runner."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.request import Request

import pytest

from printsheet_packer.runner import ApiJobClient, PackerJobRunner, RunnerError


class FakeClient:
    lease_seconds = 120

    def __init__(self, job: dict[str, Any]) -> None:
        self.assignment = {
            "job": job,
            "leaseToken": "lease-token",
        }
        self.completed: list[tuple[str, str, dict[str, Any]]] = []
        self.failed: list[tuple[str, str, RunnerError]] = []
        self.heartbeats = 0

    def claim(self):
        return self.assignment

    def heartbeat(self, _job_id: str, _lease_token: str) -> bool:
        self.heartbeats += 1
        return True

    def complete(self, job_id: str, lease_token: str, result: dict[str, Any]) -> bool:
        self.completed.append((job_id, lease_token, result))
        return True

    def fail(self, job_id: str, lease_token: str, error: RunnerError) -> bool:
        self.failed.append((job_id, lease_token, error))
        return True


def job(job_type: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "jobId": "f59eb79b-4409-4ad3-b7bd-c66e4bd4a723",
        "type": job_type,
        "parameters": parameters,
    }


def test_pack_result_with_failed_integrity_is_completed(tmp_path: Path) -> None:
    client = FakeClient(job("pack-sheet", {"batchId": "batch"}))
    response = {
        "requestId": client.assignment["job"]["jobId"],
        "stats": {"durationMs": 15},
        "integrityReport": {"passed": False},
        "sheet": {},
        "placements": [],
    }
    commands: list[list[str]] = []

    def command(argv, _job_id, _interval, _heartbeat):
        commands.append(argv)
        return 1, json.dumps(response).encode(), b"integrity-failed"

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert len(commands) == 1
    assert commands[0][2:4] == ["printsheet_packer", "pack"]
    assert client.failed == []
    result = client.completed[0][2]
    assert result["status"] == "succeeded"
    assert result["metadata"]["durationMs"] == 15
    assert result["metadata"]["packerResponse"] == response


def test_integrity_report_failure_is_reported_as_a_completed_check(tmp_path: Path) -> None:
    manifest = tmp_path / "batch" / "sheet" / "placements.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text("{}", encoding="utf-8")
    client = FakeClient(job("integrity-check", {"manifestPath": "batch/sheet/placements.json"}))
    report = {"passed": False, "checks": [], "metrics": {"durationMs": 7}}

    def command(argv, _job_id, _interval, _heartbeat):
        assert argv[2:4] == ["printsheet_packer", "verify"]
        return 1, json.dumps(report).encode(), b"integrity-failed"

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert client.failed == []
    assert client.completed[0][2]["metadata"]["report"] == report


def test_flat_tiff_export_uses_file_path_and_reports_artifact(tmp_path: Path) -> None:
    output_directory = "batch/exports/export-1"
    client = FakeClient(
        job(
            "export",
            {
                "manifestPath": "batch/sheet/placements.json",
                "outputDirectory": output_directory,
                "format": "flat-tiff",
            },
        )
    )
    manifest = tmp_path / "batch" / "sheet" / "placements.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text("{}", encoding="utf-8")

    def command(argv, _job_id, _interval, _heartbeat):
        output_path = Path(argv[argv.index("--out") + 1])
        assert output_path == tmp_path / output_directory / "sheet.tiff"
        output_path.parent.mkdir(parents=True)
        output_path.write_bytes(b"TIFF")
        return 0, b"wrote artifact", b""

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert client.failed == []
    assert client.completed[0][2]["outputArtifacts"] == {"flat": f"{output_directory}/sheet.tiff"}


def test_requested_preview_is_included_only_when_present(tmp_path: Path) -> None:
    output_directory = "batch/exports/export-1"
    preview_path = "batch/sheets/sheet-1/preview.png"
    client = FakeClient(
        job(
            "export",
            {
                "manifestPath": "batch/sheets/sheet-1/placements.json",
                "outputDirectory": output_directory,
                "format": "flat-png",
                "includePreview": True,
            },
        )
    )
    manifest = tmp_path / "batch/sheets/sheet-1/placements.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"outputs": {"previewPath": preview_path}}), encoding="utf-8")
    preview = tmp_path / preview_path
    preview.write_bytes(b"preview")

    def command(argv, _job_id, _interval, _heartbeat):
        output_path = Path(argv[argv.index("--out") + 1])
        output_path.parent.mkdir(parents=True)
        output_path.write_bytes(b"PNG")
        return 0, b"wrote artifact", b""

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert client.completed[0][2]["outputArtifacts"] == {
        "flat": f"{output_directory}/sheet.png",
        "preview": preview_path,
    }


def test_unsafe_manifest_path_fails_without_invoking_packer(tmp_path: Path) -> None:
    client = FakeClient(
        job(
            "integrity-check",
            {"manifestPath": "../outside/placements.json"},
        )
    )

    def command(*_args):
        pytest.fail("unsafe paths must be rejected before starting the CLI")

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert client.completed == []
    assert client.failed[0][2].code == "unsafe-storage-path"


def test_missing_requested_preview_fails_export(tmp_path: Path) -> None:
    manifest = tmp_path / "batch" / "sheet" / "placements.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"outputs": {}}), encoding="utf-8")
    client = FakeClient(
        job(
            "export",
            {
                "manifestPath": "batch/sheet/placements.json",
                "outputDirectory": "batch/exports/export-1",
                "format": "flat-png",
                "includePreview": True,
            },
        )
    )

    def command(argv, _job_id, _interval, _heartbeat):
        output_path = Path(argv[argv.index("--out") + 1])
        output_path.parent.mkdir(parents=True)
        output_path.write_bytes(b"PNG")
        return 0, b"wrote artifact", b""

    runner = PackerJobRunner(client, tmp_path, command=command)
    assert runner.run_once()

    assert client.completed == []
    assert client.failed[0][2].code == "missing-preview"


def test_api_client_claim_sends_authenticated_packer_capabilities(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class Response:
        status = 204

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit: int) -> bytes:
            return b""

    def fake_urlopen(request: Request, timeout: float):
        captured["request"] = request
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("printsheet_packer.runner.urlopen", fake_urlopen)
    client = ApiJobClient("http://api:8080", "secret", "packer-test")

    assert client.claim() is None

    request = captured["request"]
    assert request.full_url == "http://api:8080/api/v1/internal/jobs/claim"
    assert request.get_header("X-worker-key") == "secret"
    assert json.loads(request.data) == {
        "workerId": "packer-test",
        "capabilities": ["packer", "export"],
        "leaseSeconds": 120,
    }
    assert captured["timeout"] == 15


def test_api_client_heartbeat_reports_lease_loss(monkeypatch) -> None:
    statuses = iter((204, 409))

    class Response:
        def __init__(self, status: int) -> None:
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit: int) -> bytes:
            return b""

    monkeypatch.setattr(
        "printsheet_packer.runner.urlopen",
        lambda _request, timeout: Response(next(statuses)),
    )
    client = ApiJobClient("http://api:8080", "secret", "packer-test")

    assert client.heartbeat("job-id", "lease-token")
    assert not client.heartbeat("job-id", "lease-token")


def test_running_cli_is_terminated_when_heartbeat_loses_lease(tmp_path: Path) -> None:
    runner = PackerJobRunner(FakeClient(job("integrity-check", {})), tmp_path)

    with pytest.raises(RunnerError, match="lease was lost") as error:
        runner._run_command(
            [sys.executable, "-c", "import time; time.sleep(10)"],
            "job-id",
            0.05,
            lambda: False,
        )

    assert error.value.code == "lease-lost"
