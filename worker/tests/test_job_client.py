"""Job client against ``httpx.MockTransport`` — no live API in the tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from app.errors import JobTransportError, WorkerKeyRejectedError
from app.job_client import (
    CLAIM_PATH,
    COMPLETE_PATH,
    HEARTBEAT_PATH,
    STATUS_ACCEPTED,
    STATUS_EXTENDED,
    STATUS_LEASE_LOST,
    STATUS_RESULT_REJECTED,
    STATUS_UNAUTHORIZED,
    JobClient,
)
from tests.conftest import BATCH_ID, DESIGN_ID

JOB_DOCUMENT = {
    "schemaVersion": "1.0",
    "jobId": "11111111-1111-4111-8111-111111111111",
    "type": "classify",
    "batchId": BATCH_ID,
    "designId": DESIGN_ID,
    "inputPath": "batches/a/designs/b/versions/c.png",
    "parameters": {},
    "context": {"workingDpi": 300},
}


Handler = Callable[[httpx.Request], httpx.Response]


def client_with(handler: Handler) -> JobClient:
    return JobClient(
        base_url="http://api.internal",
        worker_key="sekret",
        worker_id="worker-test",
        capabilities=["classify", "trim"],
        lease_seconds=120,
        transport=httpx.MockTransport(handler),
    )


def run(coroutine: Any) -> Any:
    return asyncio.run(coroutine)


def recording_client(
    responses: list[httpx.Response] | httpx.Response | Handler,
) -> tuple[JobClient, list[httpx.Request]]:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return responses.pop(0) if isinstance(responses, list) else responses

    return client_with(handler), captured


def test_claim_parses_a_job_assignment() -> None:
    body = json.dumps(
        {
            "leaseToken": "lease-1",
            "leaseExpiresAt": "2026-11-05T12:00:00Z",
            "job": JOB_DOCUMENT,
        }
    )
    client, captured = recording_client([httpx.Response(200, content=body)])

    assignment = run(client.claim())

    assert assignment is not None
    assert assignment.lease_token == "lease-1"
    assert assignment.lease_expires_at == "2026-11-05T12:00:00Z"
    assert assignment.job["jobId"] == JOB_DOCUMENT["jobId"]

    request = captured[0]
    assert request.method == "POST"
    assert request.url.path == CLAIM_PATH
    assert request.headers["X-Worker-Key"] == "sekret"
    payload = json.loads(request.content)
    assert payload == {
        "workerId": "worker-test",
        "capabilities": ["classify", "trim"],
        "leaseSeconds": 120,
    }


def test_empty_queue_is_not_a_failure() -> None:
    client, _ = recording_client([httpx.Response(204)])

    assert run(client.claim()) is None


def test_lease_seconds_are_clamped_to_the_contract_range() -> None:
    client = JobClient(
        base_url="http://api.internal",
        worker_key="k",
        worker_id="w",
        capabilities=["classify"],
        lease_seconds=5000,
        transport=httpx.MockTransport(lambda request: httpx.Response(204)),
    )

    run(client.claim())
    assert JobClient._bounded_lease(5) == 15
    assert JobClient._bounded_lease(5000) == 900
    assert client.lease_seconds == 5000
    run(client.aclose())


def test_unauthorized_claim_stops_the_loop() -> None:
    client, _ = recording_client([httpx.Response(401)])

    with pytest.raises(WorkerKeyRejectedError) as excinfo:
        run(client.claim())
    assert excinfo.value.code == "worker-key-invalid"
    assert excinfo.value.retryable is False


def test_server_error_on_claim_is_retryable_transport_failure() -> None:
    client, _ = recording_client([httpx.Response(503, text="db down")])

    with pytest.raises(JobTransportError) as excinfo:
        run(client.claim())
    assert excinfo.value.retryable is True
    assert "503" in excinfo.value.message


def test_connection_error_is_reported_as_unreachable_api() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nothing listening")

    client = client_with(handler)

    with pytest.raises(JobTransportError) as excinfo:
        run(client.claim())
    assert excinfo.value.code == "api-unreachable"


def test_malformed_assignment_is_rejected() -> None:
    client, _ = recording_client([httpx.Response(200, json={"leaseToken": "x"})])

    with pytest.raises(JobTransportError):
        run(client.claim())


def test_heartbeat_reports_extended_and_lost_leases() -> None:
    ok_client, captured = recording_client([httpx.Response(204)])
    outcome = run(ok_client.heartbeat("job-1", "lease-1", extend_seconds=90))
    assert outcome.status == STATUS_EXTENDED
    assert outcome.ok
    payload = json.loads(captured[0].content)
    assert payload == {"leaseToken": "lease-1", "extendSeconds": 90}
    assert captured[0].url.path == HEARTBEAT_PATH.format(job_id="job-1")

    gone_client, _ = recording_client([httpx.Response(409)])
    lost = run(gone_client.heartbeat("job-1", "lease-1"))
    assert lost.status == STATUS_LEASE_LOST
    assert lost.ok is False

    bad_key_client, _ = recording_client([httpx.Response(401)])
    assert run(bad_key_client.heartbeat("job-1", "lease-1")).status == STATUS_UNAUTHORIZED


def test_complete_accepts_and_rejects_results() -> None:
    result = {
        "schemaVersion": "1.0",
        "jobId": JOB_DOCUMENT["jobId"],
        "status": "succeeded",
        "suggestions": {},
        "metadata": {"durationMs": 12},
    }
    client, captured = recording_client([httpx.Response(204)])
    outcome = run(client.complete("job-1", "lease-1", result))
    assert outcome.status == STATUS_ACCEPTED
    assert json.loads(captured[0].content) == {"leaseToken": "lease-1", "result": result}
    assert captured[0].url.path == COMPLETE_PATH.format(job_id="job-1")

    rejected_client, _ = recording_client([httpx.Response(422)])
    rejected = run(rejected_client.complete("job-1", "lease-1", result))
    assert rejected.status == STATUS_RESULT_REJECTED
    assert rejected.ok is False


def test_fail_posts_the_job_error() -> None:
    error = {"code": "engine-unavailable", "message": "no binary", "retryable": False}
    client, captured = recording_client([httpx.Response(204)])

    outcome = run(client.fail("job-1", "lease-1", error))

    assert outcome.status == STATUS_ACCEPTED
    assert json.loads(captured[0].content) == {"leaseToken": "lease-1", "error": error}


def test_unexpected_status_codes_become_api_errors() -> None:
    client, _ = recording_client([httpx.Response(418, text="teapot")])
    outcome = run(client.fail("job-1", "lease-1", {}))
    assert outcome.status == "api-error"
    assert outcome.details["body"] == "teapot"


def test_client_is_an_async_context_manager() -> None:
    seen = {}

    async def scenario() -> None:
        async with client_with(lambda request: httpx.Response(204)) as client:
            seen["idle"] = await client.claim()

    run(scenario())
    assert seen["idle"] is None
