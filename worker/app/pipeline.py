"""Job execution: validate, dispatch, time, re-validate — never a traceback.

Both entry points (the HTTP-less CLI and the polling runner) go through
:func:`process_document`, so a job that works with ``python -m app.cli process``
behaves identically when the API claims it.

The function returns a result envelope in every case:

* success → the processor's result with ``metadata.durationMs`` stamped and
  re-validated against ``worker-result.schema.json``;
* any :class:`app.errors.WorkerError` (including a contract violation of our own
  output) → a ``failed`` envelope with a stable code and ``retryable``.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Any

import numpy as np

from app.config import Settings
from app.context import Engines, JobScope, default_engines
from app.contracts import resolve_contracts_dir, validate_job, validate_result
from app.errors import WorkerError
from app.job_models import WorkerJob
from app.logs import log_event
from app.processors import processor_for
from app.storage import StorageRoot

NIL_JOB_ID = "00000000-0000-0000-0000-000000000000"
MAX_SUMMARY_ITEMS = 12


def _scalar_or_type(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return type(value).__name__


@dataclass(frozen=True)
class ProcessedJob:
    """The outcome of one execution, with the parsed job when the input was usable."""

    job: WorkerJob | None
    result: dict[str, Any]
    duration_ms: int
    contracts_dir: Path

    @property
    def succeeded(self) -> bool:
        return self.result.get("status") == "succeeded"

    @property
    def error(self) -> dict[str, Any] | None:
        error = self.result.get("error")
        return error if isinstance(error, dict) else None


def _json_default(value: Any) -> Any:
    """Keep numeric scalars numeric; everything else degrades to text."""

    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, PurePath):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def sanitize(document: Any) -> Any:
    """Round-trip through JSON so numpy scalars and Paths never break validation."""

    return json.loads(json.dumps(document, default=_json_default))


def summarize_parameters(parameters: Mapping[str, Any]) -> dict[str, Any]:
    """A log-safe view of the job parameters (long lists become counts)."""

    summary: dict[str, Any] = {}
    for key, value in parameters.items():
        if isinstance(value, (list, tuple)):
            summary[key] = {"items": len(value)}
        elif isinstance(value, Mapping):
            summary[key] = {
                name: _scalar_or_type(item)
                for name, item in list(value.items())[:MAX_SUMMARY_ITEMS]
            }
        else:
            summary[key] = value
    return summary


def failure_envelope(
    document: Any,
    error: WorkerError,
    duration_ms: int,
    *,
    engine: str | None = None,
) -> dict[str, Any]:
    job_id = NIL_JOB_ID
    if isinstance(document, Mapping):
        candidate = document.get("jobId")
        if isinstance(candidate, str) and candidate:
            job_id = candidate
    metadata: dict[str, Any] = {"durationMs": max(0, int(duration_ms))}
    resolved_engine = engine or error.engine
    if resolved_engine:
        metadata["engine"] = str(resolved_engine)
    payload: dict[str, Any] = {
        "code": str(error.code),
        "message": str(error.message)[:2000] or error.code,
        "retryable": bool(error.retryable),
    }
    if error.details:
        payload["details"] = sanitize(error.details)
    return {
        "schemaVersion": "1.0",
        "jobId": job_id,
        "status": "failed",
        "metadata": metadata,
        "error": payload,
    }


def build_scope(
    document: Any,
    settings: Settings,
    *,
    storage: StorageRoot | None,
    engines: Engines | None,
    contracts_dir: Path,
) -> JobScope:
    validated = validate_job(document, contracts_dir)
    job = WorkerJob.from_document(validated)
    return JobScope(
        job=job,
        settings=settings,
        storage=storage or StorageRoot(settings.storage_root),
        engines=engines or default_engines(settings),
        contracts_dir=contracts_dir,
    )


def process_document(
    document: Any,
    settings: Settings,
    *,
    storage: StorageRoot | None = None,
    engines: Engines | None = None,
    contracts_dir: Path | None = None,
    logger: logging.Logger | None = None,
) -> ProcessedJob:
    """Run one job document end to end and always return a result envelope."""

    started = time.perf_counter()
    resolved_contracts = contracts_dir or resolve_contracts_dir(settings.contracts_dir)
    scope: JobScope | None = None
    job: WorkerJob | None = None

    def elapsed_ms() -> int:
        return max(0, int(round((time.perf_counter() - started) * 1000)))

    try:
        scope = build_scope(
            document,
            settings,
            storage=storage,
            engines=engines,
            contracts_dir=resolved_contracts,
        )
        job = scope.job
        log_event(
            logging.INFO,
            "job started",
            job=job,
            parameters=summarize_parameters(job.parameters),
            workingDpi=job.context.working_dpi,
        )
        result = processor_for(job.type)(job, scope)
        duration = elapsed_ms()
        if not isinstance(result, dict):
            raise WorkerError(
                f"processor for {job.type} returned {type(result).__name__}, not an object",
                code="internal-error",
                retryable=True,
            )
        metadata = result.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
            result["metadata"] = metadata
        metadata["durationMs"] = duration
        result = sanitize(result)
        validate_result(result, resolved_contracts)
        log_event(
            logging.INFO,
            "job succeeded",
            job=job,
            duration_ms=duration,
            outputPath=result.get("outputPath"),
        )
        return ProcessedJob(
            job=job,
            result=result,
            duration_ms=duration,
            contracts_dir=resolved_contracts,
        )
    except WorkerError as error:
        duration = elapsed_ms()
        result = sanitize(failure_envelope(document, error, duration))
        log_event(
            logging.WARNING,
            "job failed",
            job=job,
            duration_ms=duration,
            code=error.code,
            retryable=error.retryable,
            reason=error.message,
        )
        return ProcessedJob(
            job=job,
            result=result,
            duration_ms=duration,
            contracts_dir=resolved_contracts,
        )
    except Exception as error:  # unexpected: still report structurally, never a traceback body
        duration = elapsed_ms()
        wrapped = WorkerError(
            f"unexpected worker error: {type(error).__name__}: {error}",
            code="internal-error",
            retryable=True,
            details={"exceptionType": type(error).__name__},
        )
        log_event(logging.ERROR, "job crashed", job=job, duration_ms=duration, exc_info=True)
        result = sanitize(failure_envelope(document, wrapped, duration))
        return ProcessedJob(
            job=job,
            result=result,
            duration_ms=duration,
            contracts_dir=resolved_contracts,
        )
    finally:
        if scope is not None:
            try:
                scope.cleanup_scratch()
            except OSError:  # pragma: no cover - scratch cleanup is best effort
                log_event(logging.WARNING, "scratch cleanup failed", job=job)
