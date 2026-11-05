"""Runner: claim → process → heartbeat → complete/fail sequencing and shutdown."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

from app.config import Settings
from app.errors import (
    CODE_ENGINE_UNAVAILABLE,
    CODE_WORKER_SHUTDOWN,
    JobTransportError,
    ShutdownRequestedError,
    WorkerKeyRejectedError,
)
from app.job_client import (
    STATUS_ACCEPTED,
    STATUS_EXTENDED,
    STATUS_LEASE_LOST,
    STATUS_RESULT_REJECTED,
    JobAssignment,
    ReportOutcome,
)
from app.pipeline import ProcessedJob
from app.runner import (
    OUTCOME_ABORTED,
    OUTCOME_FAILED,
    OUTCOME_IDLE,
    OUTCOME_SHUTDOWN,
    OUTCOME_SUCCEEDED,
    JobRunner,
)
from tests.conftest import CONTRACTS_DIR, job_document, make_settings


class FakeClient:
    """Stands in for JobClient and records the exact call sequence."""

    def __init__(
        self,
        assignments: list[JobAssignment | None] | None = None,
        *,
        heartbeat_outcome: ReportOutcome | None = None,
        complete_outcome: ReportOutcome | None = None,
        fail_outcome: ReportOutcome | None = None,
        claim_error: Exception | None = None,
    ) -> None:
        self.assignments = list(assignments or [None])
        self.calls: list[str] = []
        self.heartbeats: list[tuple[str, str]] = []
        self.completions: list[tuple[str, dict[str, Any]]] = []
        self.failures: list[tuple[str, dict[str, Any]]] = []
        self.heartbeat_outcome = heartbeat_outcome or ReportOutcome(STATUS_EXTENDED, "ok")
        self.complete_outcome = complete_outcome or ReportOutcome(STATUS_ACCEPTED, "ok")
        self.fail_outcome = fail_outcome or ReportOutcome(STATUS_ACCEPTED, "ok")
        self.claim_error = claim_error

    async def claim(self) -> JobAssignment | None:
        self.calls.append("claim")
        if self.claim_error is not None:
            raise self.claim_error
        return self.assignments.pop(0) if self.assignments else None

    async def heartbeat(
        self, job_id: str, lease_token: str, extend_seconds: int | None = None
    ) -> ReportOutcome:
        self.calls.append("heartbeat")
        self.heartbeats.append((job_id, lease_token))
        return self.heartbeat_outcome

    async def complete(
        self, job_id: str, lease_token: str, result: dict[str, Any]
    ) -> ReportOutcome:
        self.calls.append("complete")
        self.completions.append((job_id, dict(result)))
        return self.complete_outcome

    async def fail(self, job_id: str, lease_token: str, error: dict[str, Any]) -> ReportOutcome:
        self.calls.append("fail")
        self.failures.append((job_id, dict(error)))
        return self.fail_outcome


def assignment_for(document: dict[str, Any] | None = None) -> JobAssignment:
    return JobAssignment(
        lease_token="lease-1",
        lease_expires_at="2026-11-05T12:02:00Z",
        job=document or job_document("classify", "batches/a/designs/b/versions/c.png"),
    )


def processed_success(job_id: str, duration_ms: int = 5) -> ProcessedJob:
    return ProcessedJob(
        job=None,
        result={
            "schemaVersion": "1.0",
            "jobId": job_id,
            "status": "succeeded",
            "suggestions": {},
            "metadata": {"durationMs": duration_ms},
        },
        duration_ms=duration_ms,
        contracts_dir=CONTRACTS_DIR,
    )


def processed_failure(job_id: str, code: str = CODE_ENGINE_UNAVAILABLE) -> ProcessedJob:
    return ProcessedJob(
        job=None,
        result={
            "schemaVersion": "1.0",
            "jobId": job_id,
            "status": "failed",
            "metadata": {"durationMs": 2},
            "error": {"code": code, "message": "no engine", "retryable": False},
        },
        duration_ms=2,
        contracts_dir=CONTRACTS_DIR,
    )


def build_runner(
    client: FakeClient,
    processor,  # noqa: ANN001
    tmp_path: Path | None = None,
    **overrides: Any,
) -> JobRunner:
    settings = make_settings(tmp_path or Path("/tmp"), **overrides)
    storage = None
    if tmp_path is not None:
        from app.storage import StorageRoot

        storage = StorageRoot(settings.storage_root)
    return JobRunner(
        settings=settings,
        client=client,  # type: ignore[arg-type]
        storage=storage,
        processor=processor,
    )


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def test_successful_job_is_claimed_then_completed() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    assignment = assignment_for(document)
    client = FakeClient([assignment])
    seen: list[dict[str, Any]] = []

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        seen.append(dict(payload))
        return processed_success(payload["jobId"])

    report = run(build_runner(client, processor).run_once())

    assert report.outcome == OUTCOME_SUCCEEDED
    assert report.job_id == document["jobId"]
    assert client.calls[:1] == ["claim"]
    assert "complete" in client.calls
    assert "fail" not in client.calls
    assert client.completions[0][0] == document["jobId"]
    assert client.completions[0][1]["status"] == "succeeded"
    assert seen and seen[0]["jobId"] == document["jobId"]


def test_empty_queue_reports_idle_without_reporting_a_failure() -> None:
    client = FakeClient([None])

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        raise AssertionError("must not run")

    report = run(build_runner(client, processor).run_once())

    assert report.outcome == OUTCOME_IDLE
    assert client.calls == ["claim"]
    assert client.completions == []
    assert client.failures == []


def test_failed_job_is_reported_through_fail_with_stable_code() -> None:
    document = job_document(
        "upscale", "batches/a/designs/b/versions/c.png", output_relative="x/y.png"
    )
    client = FakeClient([assignment_for(document)])

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        return processed_failure(payload["jobId"])

    report = run(build_runner(client, processor).run_once())

    assert report.outcome == OUTCOME_FAILED
    assert report.code == CODE_ENGINE_UNAVAILABLE
    error = client.failures[0][1]
    assert error["code"] == CODE_ENGINE_UNAVAILABLE
    assert error["retryable"] is False


def test_heartbeats_fire_while_a_job_is_in_flight() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    client = FakeClient([assignment_for(document)])

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        import time

        time.sleep(0.2)
        return processed_success(payload["jobId"])

    run(build_runner(client, processor, heartbeat_seconds=0.05, lease_seconds=15).run_once())

    assert len(client.heartbeats) >= 2
    assert {token for _, token in client.heartbeats} == {"lease-1"}


def test_lost_lease_stops_reporting() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    client = FakeClient(
        [assignment_for(document)],
        heartbeat_outcome=ReportOutcome(STATUS_LEASE_LOST, "lease is no longer held"),
    )

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        import time

        time.sleep(0.12)
        return processed_success(payload["jobId"])

    report = run(
        build_runner(client, processor, heartbeat_seconds=0.05, lease_seconds=15).run_once()
    )

    assert report.outcome == OUTCOME_ABORTED
    assert client.completions == []
    assert client.failures == []


def test_rejected_completion_is_followed_up_by_a_failure() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    client = FakeClient(
        [assignment_for(document)],
        complete_outcome=ReportOutcome(STATUS_RESULT_REJECTED, "stale"),
    )

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        return processed_success(payload["jobId"])

    report = run(build_runner(client, processor).run_once())

    assert report.code == STATUS_RESULT_REJECTED
    assert client.failures, "the API needs a terminal report either way"
    assert client.failures[0][1]["code"] == "result-rejected"


def test_shutdown_finishes_a_quick_job_within_grace() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    client = FakeClient([assignment_for(document)])

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        return processed_success(payload["jobId"])

    async def scenario() -> tuple[Any, asyncio.Event]:
        runner = build_runner(client, processor, tmp_path=None, shutdown_grace_seconds=5.0)
        stop = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            stop.set()

        watcher = asyncio.create_task(trigger())
        report = await runner.run_once(stop)
        await watcher
        return report, stop

    report, _stop = run(scenario())
    assert report.outcome == OUTCOME_SUCCEEDED
    assert "complete" in client.calls


def test_shutdown_beyond_grace_fails_the_job_as_retryable() -> None:
    document = job_document("classify", "batches/a/designs/b/versions/c.png")
    client = FakeClient([assignment_for(document)])
    release = threading.Event()

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        release.wait(5)
        return processed_success(payload["jobId"])

    async def scenario() -> Any:
        runner = build_runner(client, processor, shutdown_grace_seconds=0.05)
        stop = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            stop.set()

        watcher = asyncio.create_task(trigger())
        report = await runner.run_once(stop)
        await watcher
        return report

    try:
        report = run(scenario())
    finally:
        release.set()

    assert report.outcome == OUTCOME_SHUTDOWN
    assert report.code == CODE_WORKER_SHUTDOWN
    assert client.failures[0][1] == {
        "code": CODE_WORKER_SHUTDOWN,
        "message": "the worker was asked to stop before this job finished",
        "retryable": True,
        "details": {"graceSeconds": 0.05},
    }
    assert client.completions == []


def test_unreachable_api_backs_off_instead_of_crashing() -> None:
    client = FakeClient(claim_error=JobTransportError("api down", details={}))

    def processor(payload, settings, **kwargs):  # noqa: ANN001
        raise AssertionError("must not run")

    report = run(build_runner(client, processor).run_once())

    assert report.outcome == OUTCOME_IDLE
    assert report.code == "api-unreachable"


def test_bad_worker_key_stops_the_loop() -> None:
    client = FakeClient(claim_error=WorkerKeyRejectedError("401"))
    runner = build_runner(client, lambda *a, **k: None)

    async def scenario() -> Any:
        stop = asyncio.Event()
        return await runner.run_loop(stop)

    run(scenario())
    assert client.calls == ["claim"]


def test_loop_keeps_polling_until_stopped() -> None:
    client = FakeClient([None, None, None, None, None])
    runner = build_runner(client, lambda *a, **k: processed_success("x"), poll_seconds=0.1)

    async def scenario() -> None:
        stop = asyncio.Event()

        async def stopper() -> None:
            await asyncio.sleep(0.35)
            stop.set()

        watcher = asyncio.create_task(stopper())
        await runner.run_loop(stop)
        await watcher

    run(scenario())
    assert client.calls.count("claim") >= 3


def test_loop_gives_up_after_repeated_claim_failures() -> None:
    client = FakeClient(claim_error=JobTransportError("api down"))
    runner = build_runner(
        client,
        lambda *a, **k: processed_success("x"),
        max_consecutive_claim_errors=2,
        poll_seconds=0.1,
        claim_backoff_seconds=0.1,
    )

    async def scenario() -> None:
        await runner.run_loop(asyncio.Event())

    run(scenario())
    assert client.calls.count("claim") == 2


def test_shutdown_error_carries_retryable_true() -> None:
    error = ShutdownRequestedError("stopping")
    assert error.as_error_payload()["retryable"] is True
    assert error.code == CODE_WORKER_SHUTDOWN


def test_health_app_does_not_start_the_loop_by_default(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings: Settings = make_settings(tmp_path)
    assert settings.run_jobs is False
    app = create_app(settings)

    with TestClient(app) as client:
        assert client.get("/health").json()["runJobs"] is False
