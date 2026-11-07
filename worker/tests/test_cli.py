"""CLI: how this track is verified without an API (process / run / classify)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

from app.cli import EXIT_JOB_FAILED, EXIT_OK, EXIT_USAGE, main
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    gray_screenshot,
    job_document,
    version_path,
)


@pytest.fixture
def workspace(tmp_path: Path) -> tuple[StorageRoot, Path]:
    root = tmp_path / "storage"
    storage = StorageRoot(root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    source = put_source_image(storage)
    return storage, source


def put_source_image(storage: StorageRoot) -> Path:
    relative = version_path("source")
    absolute = storage.resolve(relative)
    absolute.parent.mkdir(parents=True, exist_ok=True)
    gray_screenshot().save(absolute)
    return absolute


def write_job(path: Path, document: dict) -> Path:
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def cli_args(storage: StorageRoot, *rest: str) -> list[str]:
    return [
        "--storage-root",
        str(storage.resolved_root),
        "--contracts-dir",
        str(CONTRACTS_DIR),
        *rest,
    ]


def test_process_runs_a_trim_job_end_to_end(workspace, capsys) -> None:
    storage, source = workspace
    job_file = write_job(
        storage.resolved_root / "job.json",
        job_document(
            "trim",
            version_path("source"),
            output_relative=version_path("trimmed"),
            parameters={"mode": "auto", "paddingPx": 6},
        ),
    )
    result_file = storage.resolved_root / "result.json"

    code = main(cli_args(storage, "process", "--job", str(job_file), "--result", str(result_file)))

    assert code == EXIT_OK
    payload = json.loads(result_file.read_text(encoding="utf-8"))
    assert payload["status"] == "succeeded"
    assert payload["outputPath"] == version_path("trimmed")
    with Image.open(storage.resolve(payload["outputPath"])) as trimmed:
        assert trimmed.size == (232, 132)
    printed = json.loads(capsys.readouterr().out)
    assert printed["metadata"]["engine"] == "pillow"


def test_process_exits_non_zero_and_still_writes_a_valid_failure(workspace, capsys) -> None:
    storage, _ = workspace
    job_file = write_job(
        storage.resolved_root / "bad.json",
        job_document(
            "upscale",
            version_path("source"),
            output_relative=version_path("up"),
            parameters={"model": "realesrgan-x4plus", "scale": 2},
        ),
    )
    result_file = storage.resolved_root / "failure.json"

    code = main(
        cli_args(
            storage,
            "process",
            "--job",
            str(job_file),
            "--result",
            str(result_file),
            "--quiet",
        )
    )
    captured = capsys.readouterr()

    assert code == EXIT_JOB_FAILED
    assert captured.out == "", "--quiet suppresses the echoed result"
    assert "job failed" in captured.err, "structured logging goes to stderr"
    payload = json.loads(result_file.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["error"]["code"] == "engine-unavailable"
    assert payload["error"]["retryable"] is False


def test_process_rejects_a_job_that_breaks_the_contract(workspace, capsys) -> None:
    storage, _ = workspace
    document = job_document("classify", version_path("source"))
    del document["designId"]
    job_file = write_job(storage.resolved_root / "invalid.json", document)

    code = main(cli_args(storage, "process", "--job", str(job_file)))

    assert code == EXIT_JOB_FAILED
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == "invalid-job"


def test_validate_only_checks_without_processing(workspace) -> None:
    storage, _ = workspace
    job_file = write_job(
        storage.resolved_root / "job.json",
        job_document("classify", version_path("source")),
    )

    assert main(cli_args(storage, "process", "--job", str(job_file), "--validate-only")) == EXIT_OK


def test_missing_job_file_is_a_usage_error(workspace) -> None:
    storage, _ = workspace

    code = main(cli_args(storage, "process", "--job", str(storage.resolved_root / "nope.json")))

    assert code == EXIT_USAGE


def test_non_object_job_file_is_rejected(workspace) -> None:
    storage, _ = workspace
    job_file = storage.resolved_root / "array.json"
    job_file.write_text("[1, 2, 3]", encoding="utf-8")

    code = main(cli_args(storage, "process", "--job", str(job_file)))

    assert code == EXIT_USAGE


def test_classify_ad_hoc_prints_result_to_stdout(workspace, capsys) -> None:
    storage, source = workspace

    code = main(cli_args(storage, "classify", str(source), "--dpi", "300"))

    assert code == EXIT_OK
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "succeeded"
    assert payload["suggestions"]["features"]["sampledBackground"]["kind"] == "gray"
    assert payload["metadata"]["hasAlpha"] is False
    # A synthetic job must still satisfy the frozen request envelope.
    assert "outputPath" not in payload


def test_classify_refuses_an_image_outside_the_storage_root(tmp_path, workspace) -> None:
    storage, _ = workspace
    stranger = tmp_path / "elsewhere.png"
    gray_screenshot(size=(40, 30)).save(stranger)

    code = main(cli_args(storage, "classify", str(stranger)))

    assert code == EXIT_USAGE


def test_run_requires_once_or_loop(workspace) -> None:
    storage, _ = workspace

    assert main(cli_args(storage, "run")) == EXIT_USAGE
    assert main(cli_args(storage, "run", "--once", "--loop")) == EXIT_USAGE


def test_module_entry_point_is_executable(workspace) -> None:
    storage, _ = workspace

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "app.cli",
            "--storage-root",
            str(storage.resolved_root),
            "classify",
            str(storage.resolve(version_path("source"))),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        cwd=str(Path(__file__).resolve().parents[1]),
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["status"] == "succeeded"
    assert payload["suggestions"]["features"]["sampledBackground"]["kind"] == "gray"


class IdleClient:
    """Replaces the HTTP client so `run` can be tested without an API."""

    def __init__(self, **kwargs) -> None:
        self.closed = False

    async def claim(self):
        return None

    async def aclose(self) -> None:
        self.closed = True


def test_run_once_claims_and_reports_idle(workspace, monkeypatch, capsys) -> None:
    import app.cli as cli_module

    monkeypatch.setattr(cli_module, "JobClient", IdleClient)
    storage, _ = workspace

    code = main(cli_args(storage, "run", "--once"))

    assert code == EXIT_OK
    summary = json.loads(capsys.readouterr().out)
    assert summary == {"outcome": "idle", "jobId": None, "code": None}
