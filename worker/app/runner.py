"""The claim → process → heartbeat → complete/fail loop.

Lease handling follows ARCHITECTURE.md §12: the API owns retries, the worker
only ever reports against a lease token it holds.

* heartbeats run on their own task at ``heartbeat_seconds`` while the job is in
  flight, and a lost lease stops all further reporting for that job;
* ``SIGTERM``/``SIGINT`` set the stop event: the loop stops claiming, and the
  job already in flight gets ``shutdown_grace_seconds`` to finish cleanly. If it
  does not, the job is failed with ``worker-shutdown`` (retryable) so the API
  can re-queue it;
* CPU-bound processing runs on a worker thread, so the event loop (and the
  heartbeat) keeps ticking during a long upscale.
"""

from __future__ import annotations

import asyncio
import logging
import signal
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from app.config import Settings
from app.context import Engines
from app.errors import (
    JobTransportError,
    ShutdownRequestedError,
    WorkerError,
    WorkerKeyRejectedError,
)
from app.job_client import (
    STATUS_LEASE_LOST,
    STATUS_RESULT_REJECTED,
    STATUS_UNAUTHORIZED,
    JobAssignment,
    JobClient,
)
from app.logs import log_event
from app.pipeline import ProcessedJob, process_document
from app.storage import StorageRoot

OUTCOME_IDLE = "idle"
OUTCOME_SUCCEEDED = "succeeded"
OUTCOME_FAILED = "failed"
OUTCOME_ABORTED = "aborted"
OUTCOME_SHUTDOWN = "shutdown"
OUTCOME_STOPPED = "stopped"


@dataclass(frozen=True)
class RunReport:
    outcome: str
    job_id: str | None = None
    code: str | None = None
    message: str = ""


class JobRunner:
    """Sequential job executor for one worker identity (GPU jobs stay serialized)."""

    def __init__(
        self,
        *,
        settings: Settings,
        client: JobClient,
        storage: StorageRoot | None = None,
        engines: Engines | None = None,
        processor: Callable[..., ProcessedJob] | None = None,
    ) -> None:
        self.settings = settings
        self.client = client
        self.storage = storage
        self.engines = engines
        self.processor = processor or process_document

    # --- single job ----------------------------------------------------------
    @property
    def heartbeat_interval(self) -> float:
        """Never later than a third of the lease, never sooner than 0.05s."""

        ceiling = max(self.settings.lease_seconds / 3, 0.05)
        return min(max(float(self.settings.heartbeat_seconds), 0.05), ceiling)

    async def run_once(self, stop_event: asyncio.Event | None = None) -> RunReport:
        """Claim and process at most one job. ``idle`` when the queue is empty."""

        stopped = stop_event or asyncio.Event()
        try:
            assignment = await self.client.claim()
        except WorkerKeyRejectedError as error:
            log_event(
                logging.ERROR, "worker key rejected by the API; stopping loop", reason=error.message
            )
            return RunReport(OUTCOME_STOPPED, code=error.code, message=error.message)
        except JobTransportError as error:
            log_event(logging.WARNING, "claim failed", reason=error.message)
            return RunReport(OUTCOME_IDLE, code=error.code, message=error.message)
        if assignment is None:
            log_event(logging.DEBUG, "no job available")
            return RunReport(OUTCOME_IDLE)
        return await self._process_assignment(assignment, stopped)

    async def _process_assignment(
        self, assignment: JobAssignment, stop_event: asyncio.Event
    ) -> RunReport:
        job_id = _job_id(assignment.job)
        lease_lost = asyncio.Event()
        finished = asyncio.Event()

        heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(job_id, assignment.lease_token, finished, lease_lost),
            name=f"heartbeat-{job_id}",
        )
        work_task = asyncio.create_task(
            self._run_processor(assignment.job), name=f"process-{job_id}"
        )
        stop_waiter = asyncio.create_task(stop_event.wait(), name="stop-waiter")

        try:
            done, _ = await asyncio.wait(
                {work_task, stop_waiter}, return_when=asyncio.FIRST_COMPLETED
            )
            if work_task not in done:
                # Shutdown was requested while the job was in flight.
                processed = await self._await_grace(work_task, job_id, assignment.lease_token)
                if processed is None:
                    return RunReport(OUTCOME_SHUTDOWN, job_id=job_id, code="worker-shutdown")
            else:
                processed = work_task.result()
        finally:
            finished.set()
            stop_waiter.cancel()
            await asyncio.gather(heartbeat_task, stop_waiter, return_exceptions=True)

        if lease_lost.is_set() or processed is None:
            return RunReport(OUTCOME_ABORTED, job_id=job_id, message="lease lost during processing")

        return await self._report(job_id, assignment.lease_token, processed)

    async def _await_grace(
        self, work_task: asyncio.Task[Any], job_id: str | None, lease_token: str
    ):
        processed = None
        try:
            processed = await asyncio.wait_for(
                asyncio.shield(work_task), timeout=self.settings.shutdown_grace_seconds
            )
            log_event(
                logging.INFO,
                "job finished during shutdown grace",
                job_id=job_id,
                duration_ms=processed.duration_ms if processed else None,
            )
        except TimeoutError:
            log_event(
                logging.WARNING,
                "grace period expired; failing the job as worker-shutdown",
                job_id=job_id,
            )
            await self._safe_fail(
                job_id,
                lease_token,
                ShutdownRequestedError(
                    "the worker was asked to stop before this job finished",
                    details={"graceSeconds": self.settings.shutdown_grace_seconds},
                ),
            )
            processed = None
        return processed

    async def _run_processor(self, document: Mapping[str, Any]):
        return await asyncio.to_thread(
            self.processor,
            document,
            self.settings,
            storage=self.storage,
            engines=self.engines,
        )

    async def _heartbeat_loop(
        self,
        job_id: str | None,
        lease_token: str,
        finished: asyncio.Event,
        lease_lost: asyncio.Event,
    ) -> None:
        if not job_id:
            return
        interval = self.heartbeat_interval
        while not finished.is_set():
            try:
                await asyncio.wait_for(finished.wait(), timeout=interval)
                return
            except TimeoutError:
                pass
            try:
                outcome = await self.client.heartbeat(job_id, lease_token)
            except JobTransportError as error:
                log_event(
                    logging.WARNING,
                    "heartbeat could not be delivered",
                    job_id=job_id,
                    reason=error.message,
                )
                continue
            if not outcome.ok:
                lease_lost.set()
                log_event(
                    logging.ERROR,
                    "lease lost; the API owns this job now",
                    job_id=job_id,
                    status=outcome.status,
                )
                return

    async def _report(
        self, job_id: str | None, lease_token: str, processed: ProcessedJob
    ) -> RunReport:
        if not job_id:
            log_event(logging.ERROR, "claimed job carried no jobId; nothing to report")
            return RunReport(OUTCOME_ABORTED, message="job payload has no jobId")
        result = processed.result
        if processed.succeeded:
            outcome = await self.client.complete(job_id, lease_token, result)
        else:
            outcome = await self.client.fail(job_id, lease_token, result.get("error") or {})
        if outcome.ok:
            return RunReport(
                OUTCOME_SUCCEEDED if processed.succeeded else OUTCOME_FAILED,
                job_id=job_id,
                code=(processed.error or {}).get("code"),
            )
        if outcome.status == STATUS_RESULT_REJECTED:
            # The API refused a schema-valid envelope (e.g. stale source): report
            # the failure instead of leaving the lease hanging.
            await self._safe_fail(
                job_id,
                lease_token,
                WorkerError(
                    f"the API rejected the completion: {outcome.message}",
                    code="result-rejected",
                    retryable=False,
                    details=result.get("error") or {},
                ),
            )
        elif outcome.status in (STATUS_LEASE_LOST, STATUS_UNAUTHORIZED):
            log_event(logging.ERROR, "cannot report job", job_id=job_id, status=outcome.status)
        else:
            log_event(
                logging.WARNING,
                "job report not accepted",
                job_id=job_id,
                status=outcome.status,
                reason=outcome.message,
            )
        return RunReport(
            OUTCOME_FAILED if processed.succeeded is False else OUTCOME_ABORTED,
            job_id=job_id,
            code=outcome.status,
            message=outcome.message,
        )

    async def _safe_fail(self, job_id: str | None, lease_token: str, error: WorkerError) -> None:
        if not job_id:
            return
        try:
            await self.client.fail(job_id, lease_token, error.as_error_payload())
        except JobTransportError as transport_error:
            log_event(
                logging.WARNING,
                "shutdown failure could not be reported",
                job_id=job_id,
                reason=transport_error.message,
            )

    # --- loop ----------------------------------------------------------------
    async def run_loop(self, stop_event: asyncio.Event) -> None:
        """Poll until ``stop_event`` is set. Empty queues and transient API
        errors back off; they are not failures."""

        consecutive_errors = 0
        started = time.monotonic()
        log_event(
            logging.INFO,
            "job loop started",
            workerId=self.settings.worker_id,
            capabilities=self.settings.capability_list,
            leaseSeconds=self.settings.lease_seconds,
            heartbeatSeconds=self.settings.heartbeat_seconds,
        )
        while not stop_event.is_set():
            report = await self.run_once(stop_event)
            if report.outcome == OUTCOME_STOPPED:
                break
            if report.code == "api-unreachable":
                consecutive_errors += 1
            elif report.outcome != OUTCOME_IDLE:
                consecutive_errors = 0

            if consecutive_errors >= self.settings.max_consecutive_claim_errors:
                log_event(
                    logging.ERROR,
                    "giving up after repeated claim failures",
                    consecutiveErrors=consecutive_errors,
                )
                break

            delay = self.settings.poll_seconds
            if report.outcome == OUTCOME_IDLE and consecutive_errors:
                delay = self.settings.claim_backoff_seconds
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=delay)
            except TimeoutError:
                continue

        log_event(
            logging.INFO,
            "job loop stopped",
            runtimeSeconds=round(time.monotonic() - started, 3),
        )


def _job_id(document: Mapping[str, Any]) -> str | None:
    value = document.get("jobId") if isinstance(document, Mapping) else None
    return value if isinstance(value, str) and value else None


async def install_signal_handlers(stop_event: asyncio.Event) -> None:
    """Translate SIGTERM/SIGINT into the shared stop event."""

    loop = asyncio.get_running_loop()
    for signature in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(signature, stop_event.set)
        except (NotImplementedError, RuntimeError):  # pragma: no cover - Windows
            signal.signal(signature, lambda *_: stop_event.set())
