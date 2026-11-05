from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resolved.storage_root.mkdir(parents=True, exist_ok=True)
        app.state.settings = resolved
        yield

    app = FastAPI(
        title="PrintSheet Worker",
        version=__version__,
        description=(
            "Image-processing worker. Phase 0 exposes liveness only; job execution "
            "arrives in Phase 1 track B."
        ),
        lifespan=lifespan,
    )

    @app.get("/")
    def root() -> dict[str, object]:
        return {
            "service": resolved.service_name,
            "version": __version__,
            "phase": 0,
            "contractVersion": "1.0.0",
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
        }

    return app


app = create_app()
