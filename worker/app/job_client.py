"""httpx client for the API's internal job endpoints.

Shapes come straight from ``contracts/openapi/printsheet-api.yaml``:

``POST /api/v1/internal/jobs/claim``     ClaimJobsRequest  -> JobAssignment | 204
``POST /api/v1/internal/jobs/{id}/heartbeat`` HeartbeatRequest -> 204
``POST /api/v1/internal/jobs/{id}/complete``  WorkerCompletion -> 204
``POST /api/v1/internal/jobs/{id}/fail``      JobFailure       -> 204

Every request carries ``X-Worker-Key``. An empty queue is a *normal* outcome
(204) and is never logged as a failure. Expected rejections (409 lease lost,
422 result rejected) are returned as typed outcomes so the runner decides what
to do; unreachable API and a rejected worker key raise, because the loop must
either back off or stop.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from app.errors import JobTransportError, WorkerKeyRejectedError

CLAIM_PATH = "/api/v1/internal/jobs/claim"
HEARTBEAT_PATH = "/api/v1/internal/jobs/{job_id}/heartbeat"
COMPLETE_PATH = "/api/v1/internal/jobs/{job_id}/complete"
FAIL_PATH = "/api/v1/internal/jobs/{job_id}/fail"

STATUS_ACCEPTED = "accepted"
STATUS_EXTENDED = "extended"
STATUS_LEASE_LOST = "lease-lost"
STATUS_RESULT_REJECTED = "result-rejected"
STATUS_UNAUTHORIZED = "unauthorized"

HEARTBEAT_MIN_SECONDS = 15
HEARTBEAT_MAX_SECONDS = 900


@dataclass(frozen=True)
class JobAssignment:
    """A claimed job plus the lease the API expects on every later call."""

    lease_token: str
    lease_expires_at: str | None
    job: Mapping[str, Any]


@dataclass(frozen=True)
class ReportOutcome:
    status: str
    message: str
    status_code: int | None = None
    details: Mapping[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.status in (STATUS_ACCEPTED, STATUS_EXTENDED)


class JobClient:
    """Async client bound to one worker identity."""

    def __init__(
        self,
        *,
        base_url: str,
        worker_key: str,
        worker_id: str,
        capabilities: list[str],
        lease_seconds: int = 120,
        timeout_seconds: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.worker_id = worker_id
        self.capabilities = list(capabilities)
        self.lease_seconds = int(lease_seconds)
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=timeout_seconds,
            transport=transport,
            headers={
                "X-Worker-Key": worker_key,
                "Content-Type": "application/json",
                "User-Agent": f"printsheet-worker/{worker_id}",
            },
        )

    # --- lifecycle -----------------------------------------------------------
    async def __aenter__(self) -> JobClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    # --- calls ---------------------------------------------------------------
    async def claim(self) -> JobAssignment | None:
        """Claim the next job, or ``None`` when the queue is empty."""

        payload = {
            "workerId": self.worker_id,
            "capabilities": self.capabilities,
            "leaseSeconds": self._bounded_lease(self.lease_seconds),
        }
        response = await self._post(CLAIM_PATH, payload, context="claim")
        if response.status_code == 204:
            return None
        self._require_success(response, context="claim")
        document = response.json()
        return self._parse_assignment(document)

    async def heartbeat(
        self, job_id: str, lease_token: str, extend_seconds: int | None = None
    ) -> ReportOutcome:
        payload = {
            "leaseToken": lease_token,
            "extendSeconds": self._bounded_lease(extend_seconds or self.lease_seconds),
        }
        path = HEARTBEAT_PATH.format(job_id=job_id)
        response = await self._post(path, payload, context="heartbeat")
        if response.status_code == 204:
            return ReportOutcome(STATUS_EXTENDED, "lease extended", response.status_code)
        return self._outcome(response, context="heartbeat")

    async def complete(
        self, job_id: str, lease_token: str, result: Mapping[str, Any]
    ) -> ReportOutcome:
        payload = {"leaseToken": lease_token, "result": dict(result)}
        path = COMPLETE_PATH.format(job_id=job_id)
        response = await self._post(path, payload, context="complete")
        if response.status_code == 204:
            return ReportOutcome(STATUS_ACCEPTED, "result accepted", response.status_code)
        return self._outcome(response, context="complete")

    async def fail(self, job_id: str, lease_token: str, error: Mapping[str, Any]) -> ReportOutcome:
        payload = {"leaseToken": lease_token, "error": dict(error)}
        response = await self._post(FAIL_PATH.format(job_id=job_id), payload, context="fail")
        if response.status_code == 204:
            return ReportOutcome(STATUS_ACCEPTED, "failure accepted", response.status_code)
        return self._outcome(response, context="fail")

    # --- helpers -------------------------------------------------------------
    async def _post(self, path: str, payload: Mapping[str, Any], *, context: str) -> httpx.Response:
        try:
            return await self._client.post(path, json=dict(payload))
        except httpx.HTTPError as exc:
            raise JobTransportError(
                f"internal API is unreachable during {context}: {exc.__class__.__name__}",
                details={"path": path},
            ) from exc

    @staticmethod
    def _bounded_lease(seconds: int) -> int:
        return max(HEARTBEAT_MIN_SECONDS, min(int(seconds), HEARTBEAT_MAX_SECONDS))

    @staticmethod
    def _require_success(response: httpx.Response, *, context: str) -> None:
        if response.status_code == 401:
            raise WorkerKeyRejectedError(
                f"the API rejected X-Worker-Key during {context} (401)",
                details={"path": response.request.url.path},
            )
        if response.status_code >= 400:
            raise JobTransportError(
                f"internal API returned {response.status_code} during {context}",
                details={
                    "path": response.request.url.path,
                    "body": response.text[:500] if response.text else "",
                },
            )

    def _outcome(self, response: httpx.Response, *, context: str) -> ReportOutcome:
        if response.status_code == 401:
            return ReportOutcome(STATUS_UNAUTHORIZED, "worker key rejected", response.status_code)
        if response.status_code == 409:
            return ReportOutcome(STATUS_LEASE_LOST, "lease is no longer held", response.status_code)
        if response.status_code == 422:
            return ReportOutcome(
                STATUS_RESULT_REJECTED, "result rejected by the API", response.status_code
            )
        if response.status_code >= 400:
            return ReportOutcome(
                "api-error",
                f"unexpected {response.status_code} during {context}",
                response.status_code,
                {"body": response.text[:500] if response.text else ""},
            )
        return ReportOutcome(STATUS_ACCEPTED, "accepted", response.status_code)

    @staticmethod
    def _parse_assignment(document: Any) -> JobAssignment:
        if not isinstance(document, Mapping):
            raise JobTransportError("claim returned a non-object JobAssignment")
        lease_token = document.get("leaseToken")
        job = document.get("job")
        if not isinstance(lease_token, str) or not isinstance(job, Mapping):
            raise JobTransportError(
                "JobAssignment is missing leaseToken or job",
                details={"keys": sorted(str(key) for key in document)},
            )
        return JobAssignment(
            lease_token=lease_token,
            lease_expires_at=document.get("leaseExpiresAt"),
            job=job,
        )
