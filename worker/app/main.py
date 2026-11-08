"""FastAPI worker service: liveness plus the optional job loop.

``/health`` stays dependency-free so container orchestration can probe the
worker even when the API is down. The claim loop only starts when
``PRINTSHEET_RUN_JOBS=true``; the default is false so health checks and tests
never need an API. Shutdown sets the stop event and gives the in-flight job the
configured grace period before cancelling the loop task.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import CONTRACT_API_VERSION, __version__
from app.config import Settings, get_settings
from app.job_client import JobClient
from app.logs import setup_logging
from app.runner import JobRunner
from app.storage import StorageRoot


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resolved.storage_root.mkdir(parents=True, exist_ok=True)
        logger = setup_logging(resolved)
        app.state.settings = resolved
        app.state.job_task = None
        app.state.stop_event = None

        client = None
        if resolved.run_jobs:
            storage = StorageRoot(resolved.storage_root)
            client = JobClient(
                base_url=resolved.api_base_url,
                worker_key=resolved.worker_key.get_secret_value(),
                worker_id=resolved.worker_id,
                capabilities=resolved.capability_list,
                lease_seconds=resolved.lease_seconds,
                timeout_seconds=resolved.api_timeout_seconds,
            )
            runner = JobRunner(settings=resolved, client=client, storage=storage)
            stop_event = asyncio.Event()
            app.state.stop_event = stop_event
            app.state.job_task = asyncio.create_task(
                runner.run_loop(stop_event), name="printsheet-job-loop"
            )
            logger.info("job loop started for %s", resolved.worker_id)

        try:
            yield
        finally:
            stop_event = app.state.stop_event
            task = app.state.job_task
            if task is not None and stop_event is not None:
                stop_event.set()
                try:
                    await asyncio.wait_for(task, timeout=resolved.shutdown_grace_seconds)
                except (TimeoutError, asyncio.CancelledError):
                    logger.warning("job loop did not stop within grace; cancelling")
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            if client is not None:
                await client.aclose()

    app = FastAPI(
        title="PrintSheet Worker",
        version=__version__,
        description=(
            "Image-processing worker for active crop, enhancement and resize jobs, "
            "claimed from internal API endpoints or executed through app.cli."
        ),
        lifespan=lifespan,
    )

    @app.get("/")
    def root() -> dict[str, object]:
        return {
            "service": resolved.service_name,
            "version": __version__,
            "phase": 2,
            "contractVersion": CONTRACT_API_VERSION,
            "jobTypes": resolved.capability_list,
        }

    @app.get("/health")
    def health() -> dict[str, object]:
        writable = os.access(resolved.storage_root, os.W_OK)
        return {
            "status": "ok" if writable else "degraded",
            "service": resolved.service_name,
            "version": __version__,
            "workerId": resolved.worker_id,
            "capabilities": resolved.capability_list,
            "gpuEnabled": resolved.gpu_enabled,
            "maxGpuJobs": resolved.max_gpu_jobs,
            "storageRoot": str(resolved.storage_root),
            "storageWritable": writable,
            "runJobs": resolved.run_jobs,
            "apiBaseUrl": resolved.api_base_url,
            "leaseSeconds": resolved.lease_seconds,
            "heartbeatSeconds": resolved.heartbeat_seconds,
            "contractVersion": CONTRACT_API_VERSION,
        }

    return app


app = create_app()
