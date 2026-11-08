"""Lease-based adapter from the API job queue to the standalone packer CLI."""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

LOG = logging.getLogger("printsheet_packer.runner")
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
SUPPORTED_JOB_TYPES = {"pack-sheet", "integrity-check", "export"}


class RunnerError(RuntimeError):
    """A stable runner failure that can be reported to the API."""

    def __init__(self, message: str, *, code: str = "packer-runner-error", retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class ApiJobClient:
    """Small client for the API's authenticated internal job protocol."""

    def __init__(
        self,
        base_url: str,
        worker_key: str,
        worker_id: str,
        *,
        lease_seconds: int = 120,
        timeout_seconds: float = 15,
    ) -> None:
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("API base URL must use http or https")
        if not worker_key.strip():
            raise ValueError("worker key must not be empty")
        self.base_url = base_url.rstrip("/") + "/"
        self.worker_key = worker_key
        self.worker_id = worker_id
        self.lease_seconds = max(15, min(int(lease_seconds), 900))
        self.timeout_seconds = timeout_seconds

    def _post(self, path: str, payload: Mapping[str, Any]) -> tuple[int, bytes]:
        request = Request(
            urljoin(self.base_url, path.lstrip("/")),
            data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Worker-Key": self.worker_key,
                "User-Agent": f"printsheet-packer/{self.worker_id}",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return response.status, response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            return error.code, error.read(MAX_RESPONSE_BYTES + 1)
        except (URLError, TimeoutError, OSError) as error:
            raise RunnerError(
                f"API request failed: {error.__class__.__name__}",
                code="api-unreachable",
                retryable=True,
            ) from error

    def claim(self) -> Mapping[str, Any] | None:
        status, body = self._post(
            "/api/v1/internal/jobs/claim",
            {
                "workerId": self.worker_id,
                "capabilities": ["packer", "export"],
                "leaseSeconds": self.lease_seconds,
            },
        )
        if status == 204:
            return None
        if status == 401:
            raise RunnerError("API rejected the configured worker key", code="worker-key-invalid")
        if status != 200:
            raise RunnerError(
                f"API claim returned HTTP {status}", code="api-claim-failed", retryable=True
            )
        document = _parse_json_object(body, "claim response")
        if not isinstance(document.get("job"), Mapping) or not isinstance(
            document.get("leaseToken"), str
        ):
            raise RunnerError(
                "API claim response is missing job or leaseToken", code="invalid-claim"
            )
        return document

    def heartbeat(self, job_id: str, lease_token: str) -> bool:
        status, _ = self._post(
            f"/api/v1/internal/jobs/{job_id}/heartbeat",
            {"leaseToken": lease_token, "extendSeconds": self.lease_seconds},
        )
        if status == 204:
            return True
        if status == 401:
            raise RunnerError("API rejected the configured worker key", code="worker-key-invalid")
        return False

    def complete(self, job_id: str, lease_token: str, result: Mapping[str, Any]) -> bool:
        status, _ = self._post(
            f"/api/v1/internal/jobs/{job_id}/complete",
            {"leaseToken": lease_token, "result": dict(result)},
        )
        if status == 204:
            return True
        if status == 401:
            raise RunnerError("API rejected the configured worker key", code="worker-key-invalid")
        return False

    def fail(self, job_id: str, lease_token: str, error: RunnerError) -> bool:
        status, _ = self._post(
            f"/api/v1/internal/jobs/{job_id}/fail",
            {
                "leaseToken": lease_token,
                "error": {
                    "code": error.code,
                    "message": str(error),
                    "retryable": error.retryable,
                    "details": None,
                },
            },
        )
        if status == 204:
            return True
        if status == 401:
            raise RunnerError("API rejected the configured worker key", code="worker-key-invalid")
        return False


def _parse_json_object(body: bytes, description: str) -> dict[str, Any]:
    if len(body) > MAX_RESPONSE_BYTES:
        raise RunnerError(
            f"{description} exceeded the response-size limit", code="invalid-api-response"
        )
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RunnerError(
            f"{description} was not valid JSON", code="invalid-api-response"
        ) from error
    if not isinstance(document, dict):
        raise RunnerError(f"{description} must be a JSON object", code="invalid-api-response")
    return document


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RunnerError(f"claimed job is missing its {label} object", code="invalid-job")
    return value


def _storage_path(root: Path, relative: Any, label: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise RunnerError(f"job is missing {label}", code="invalid-job")
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise RunnerError(
            f"job {label} must be a safe relative storage path", code="unsafe-storage-path"
        )
    resolved_root = root.resolve()
    resolved = (resolved_root / candidate).resolve()
    if not resolved.is_relative_to(resolved_root):
        raise RunnerError(f"job {label} escapes the storage root", code="unsafe-storage-path")
    return resolved


def _relative_storage_path(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise RunnerError(
            "packer output escaped the storage root", code="unsafe-storage-path"
        ) from error


class PackerJobRunner:
    """Sequential runner; the API owns retries and leases."""

    def __init__(
        self,
        client: ApiJobClient,
        storage_root: Path | str,
        *,
        poll_seconds: float = 2,
        stop_event: threading.Event | None = None,
        command: Callable[[list[str], str, float, Callable[[], bool]], tuple[int, bytes, bytes]]
        | None = None,
    ) -> None:
        self.client = client
        self.storage_root = Path(storage_root).resolve()
        self.poll_seconds = max(0.1, poll_seconds)
        self.stop_event = stop_event or threading.Event()
        self.command = command or self._run_command

    @property
    def heartbeat_interval(self) -> float:
        return max(1.0, self.client.lease_seconds / 3)

    def run_once(self) -> bool:
        assignment = self.client.claim()
        if assignment is None:
            return False
        job = _mapping(assignment["job"], "job")
        job_id = job.get("jobId")
        lease_token = assignment.get("leaseToken")
        if not isinstance(job_id, str) or not isinstance(lease_token, str):
            raise RunnerError("claimed job is missing jobId or leaseToken", code="invalid-claim")

        job_type = job.get("type")
        try:
            if job_type not in SUPPORTED_JOB_TYPES:
                raise RunnerError(
                    f"unsupported packer job type {job_type!r}", code="unsupported-job"
                )
            result = self._process(job, job_type, lease_token)
            if not self.client.complete(job_id, lease_token, result):
                LOG.warning(
                    "API did not accept completion for job %s; lease may have expired", job_id
                )
        except RunnerError as error:
            LOG.error("packer job %s failed: %s", job_id, error)
            if not self.client.fail(job_id, lease_token, error):
                LOG.warning(
                    "API did not accept failure report for job %s; lease may have expired", job_id
                )
        return True

    def run_forever(self) -> None:
        while not self.stop_event.is_set():
            try:
                did_work = self.run_once()
            except RunnerError as error:
                if error.code == "worker-key-invalid":
                    raise
                LOG.warning("packer runner could not claim or report a job: %s", error)
                did_work = False
            if not did_work:
                self.stop_event.wait(self.poll_seconds)

    def _process(self, job: Mapping[str, Any], job_type: str, lease_token: str) -> dict[str, Any]:
        job_id = job.get("jobId")
        if not isinstance(job_id, str):
            raise RunnerError("jobId must be a string", code="invalid-job")
        parameters = _mapping(job.get("parameters"), "parameters")

        with tempfile.TemporaryDirectory(prefix="printsheet-packer-") as temporary:
            request_path = Path(temporary) / "pack-request.json"
            if job_type == "pack-sheet":
                request = dict(parameters)
                request_path.write_text(json.dumps(request), encoding="utf-8")
                argv = [
                    sys.executable,
                    "-m",
                    "printsheet_packer",
                    "pack",
                    "--request",
                    str(request_path),
                    "--storage-root",
                    str(self.storage_root),
                    "--force",
                ]
            elif job_type == "integrity-check":
                manifest = _storage_path(
                    self.storage_root, parameters.get("manifestPath"), "manifestPath"
                )
                argv = [
                    sys.executable,
                    "-m",
                    "printsheet_packer",
                    "verify",
                    "--manifest",
                    str(manifest),
                    "--storage-root",
                    str(self.storage_root),
                ]
            else:
                manifest_relative = parameters.get("manifestPath")
                manifest = _storage_path(self.storage_root, manifest_relative, "manifestPath")
                output_directory = _storage_path(
                    self.storage_root, parameters.get("outputDirectory"), "outputDirectory"
                )
                export_format = parameters.get("format")
                if not isinstance(export_format, str):
                    raise RunnerError("export format is missing", code="invalid-job")
                if export_format not in {"flat-png", "flat-tiff", "psd-bundle"}:
                    raise RunnerError(
                        f"unsupported export format {export_format!r}",
                        code="unsupported-export",
                    )
                output_path = output_directory
                if export_format == "flat-png":
                    output_path /= "sheet.png"
                elif export_format == "flat-tiff":
                    output_path /= "sheet.tiff"
                argv = [
                    sys.executable,
                    "-m",
                    "printsheet_packer",
                    "export",
                    "--manifest",
                    str(manifest),
                    "--storage-root",
                    str(self.storage_root),
                    "--format",
                    export_format,
                    "--out",
                    str(output_path),
                    "--force",
                ]

            return_code, stdout, stderr = self.command(
                argv,
                job_id,
                self.heartbeat_interval,
                lambda: self.client.heartbeat(job_id, lease_token),
            )
            if job_type == "pack-sheet":
                if return_code not in (0, 1):
                    raise RunnerError(
                        _decode_error(stderr, return_code),
                        code="packer-pack-failed",
                        retryable=return_code < 0,
                    )
                response = _parse_cli_json(stdout, stderr, "packer response", return_code)
                if response.get("requestId") != job_id:
                    raise RunnerError(
                        "packer response requestId does not match jobId",
                        code="invalid-packer-result",
                    )
                return {
                    "schemaVersion": "1.0",
                    "jobId": job_id,
                    "status": "succeeded",
                    "metadata": {
                        "durationMs": _nested_int(response, "stats", "durationMs"),
                        "packerResponse": response,
                    },
                }
            if job_type == "integrity-check":
                if return_code not in (0, 1):
                    raise RunnerError(
                        _decode_error(stderr, return_code),
                        code="packer-integrity-failed",
                        retryable=return_code < 0,
                    )
                report = _parse_cli_json(stdout, stderr, "integrity report", return_code)
                return {
                    "schemaVersion": "1.0",
                    "jobId": job_id,
                    "status": "succeeded",
                    "metadata": {
                        "durationMs": _nested_int(report, "metrics", "durationMs"),
                        "report": report,
                    },
                }

            if return_code != 0:
                raise RunnerError(
                    _decode_error(stderr, return_code),
                    code="packer-export-failed",
                    retryable=return_code < 0,
                )
            artifacts = self._export_artifacts(parameters)
            return {
                "schemaVersion": "1.0",
                "jobId": job_id,
                "status": "succeeded",
                "outputArtifacts": artifacts,
                "metadata": {"durationMs": 0},
            }

    def _export_artifacts(self, parameters: Mapping[str, Any]) -> dict[str, str]:
        output_directory = _storage_path(
            self.storage_root, parameters.get("outputDirectory"), "outputDirectory"
        )
        export_format = parameters.get("format")
        artifacts: dict[str, str] = {}
        if export_format == "flat-png":
            artifacts["flat"] = _relative_storage_path(
                self.storage_root, output_directory / "sheet.png"
            )
        elif export_format == "flat-tiff":
            artifacts["flat"] = _relative_storage_path(
                self.storage_root, output_directory / "sheet.tiff"
            )
        elif export_format == "psd-bundle":
            artifacts.update(
                {
                    "flat": _relative_storage_path(
                        self.storage_root, output_directory / "sheet.png"
                    ),
                    "manifest": _relative_storage_path(
                        self.storage_root, output_directory / "placements.json"
                    ),
                    "jsx": _relative_storage_path(
                        self.storage_root, output_directory / "rebuild.jsx"
                    ),
                }
            )
        else:
            raise RunnerError(
                f"unsupported export format {export_format!r}", code="unsupported-export"
            )

        if parameters.get("includePreview"):
            manifest_path = _storage_path(
                self.storage_root, parameters.get("manifestPath"), "manifestPath"
            )
            try:
                manifest = _parse_json_object(manifest_path.read_bytes(), "placement manifest")
            except OSError as error:
                raise RunnerError(
                    "could not read sheet manifest for preview artifact",
                    code="missing-manifest",
                ) from error
            outputs = _mapping(manifest.get("outputs"), "manifest outputs")
            preview = outputs.get("previewPath")
            if not isinstance(preview, str):
                raise RunnerError(
                    "requested preview is missing from the sheet manifest",
                    code="missing-preview",
                )
            preview_path = _storage_path(self.storage_root, preview, "previewPath")
            if not preview_path.is_file():
                raise RunnerError(
                    "requested sheet preview is missing from storage",
                    code="missing-preview",
                )
            artifacts["preview"] = _relative_storage_path(self.storage_root, preview_path)
        return artifacts

    def _run_command(
        self,
        argv: list[str],
        job_id: str,
        heartbeat_interval: float,
        heartbeat: Callable[[], bool],
    ) -> tuple[int, bytes, bytes]:
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            try:
                process = subprocess.Popen(argv, stdout=stdout_file, stderr=stderr_file)
            except OSError as error:
                raise RunnerError(
                    f"could not start packer CLI: {error.__class__.__name__}",
                    code="packer-start-failed",
                    retryable=True,
                ) from error
            while process.poll() is None:
                try:
                    process.wait(timeout=heartbeat_interval)
                except subprocess.TimeoutExpired:
                    try:
                        lease_active = heartbeat()
                    except BaseException:
                        _stop_process(process)
                        raise
                    if not lease_active:
                        _stop_process(process)
                        raise RunnerError(
                            "job lease was lost while the packer was running",
                            code="lease-lost",
                        ) from None
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout = stdout_file.read(MAX_RESPONSE_BYTES + 1)
            stderr = stderr_file.read(MAX_RESPONSE_BYTES + 1)
            if len(stdout) > MAX_RESPONSE_BYTES or len(stderr) > MAX_RESPONSE_BYTES:
                raise RunnerError(
                    "packer CLI output exceeded the response-size limit",
                    code="packer-output-too-large",
                )
            return process.returncode, stdout, stderr


def _nested_int(value: Mapping[str, Any], outer: str, inner: str) -> int:
    nested = value.get(outer)
    candidate = nested.get(inner) if isinstance(nested, Mapping) else None
    return candidate if isinstance(candidate, int) and not isinstance(candidate, bool) else 0


def _parse_cli_json(
    stdout: bytes, stderr: bytes, description: str, return_code: int
) -> dict[str, Any]:
    try:
        return _parse_json_object(stdout, description)
    except RunnerError as error:
        raise RunnerError(
            _decode_error(stderr, return_code)
            if stderr.strip() or return_code != 0
            else str(error),
            code="invalid-packer-result",
        ) from error


def _decode_error(stderr: bytes, return_code: int) -> str:
    message = stderr[:2000].decode("utf-8", errors="replace").strip()
    return message or f"packer CLI exited with status {return_code}"


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def _handle_signal(stop_event: threading.Event, _signum: int, _frame: Any) -> None:
    stop_event.set()


def runner_main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="printsheet-packer runner")
    parser.add_argument(
        "--api-base-url",
        default=os.environ.get("PRINTSHEET_PACKER_API_BASE_URL", "http://localhost:8080"),
    )
    parser.add_argument("--worker-key", default=os.environ.get("PRINTSHEET_PACKER_WORKER_KEY", ""))
    parser.add_argument(
        "--worker-id", default=os.environ.get("PRINTSHEET_PACKER_WORKER_ID", "packer-local")
    )
    parser.add_argument(
        "--storage-root",
        type=Path,
        default=Path(os.environ.get("PRINTSHEET_STORAGE_ROOT", "storage")),
    )
    parser.add_argument("--lease-seconds", type=int, default=120)
    parser.add_argument("--poll-seconds", type=float, default=2)
    parser.add_argument("--timeout-seconds", type=float, default=15)
    parser.add_argument("--once", action="store_true", help="Claim and process at most one job")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("PRINTSHEET_PACKER_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        client = ApiJobClient(
            args.api_base_url,
            args.worker_key,
            args.worker_id,
            lease_seconds=args.lease_seconds,
            timeout_seconds=args.timeout_seconds,
        )
    except ValueError as error:
        parser.error(str(error))

    stop_event = threading.Event()
    if not args.once:
        signal.signal(
            signal.SIGINT, lambda signum, frame: _handle_signal(stop_event, signum, frame)
        )
        signal.signal(
            signal.SIGTERM, lambda signum, frame: _handle_signal(stop_event, signum, frame)
        )
    runner = PackerJobRunner(
        client,
        args.storage_root,
        poll_seconds=args.poll_seconds,
        stop_event=stop_event,
    )
    try:
        if args.once:
            runner.run_once()
        else:
            runner.run_forever()
    except RunnerError as error:
        LOG.error("%s", error)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(runner_main())
