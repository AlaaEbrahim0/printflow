"""Processor registry for supported worker job types."""

from __future__ import annotations

from collections.abc import Callable

from app.context import JobScope
from app.errors import UnsupportedParameterError
from app.job_models import WorkerJob
from app.processors import background, classify, resize, trim, upscale

Processor = Callable[[WorkerJob, JobScope], dict]

PROCESSORS: dict[str, Processor] = {
    "classify": classify.process,
    "trim": trim.process,
    "upscale": upscale.process,
    "resize": resize.process,
    "background-removal": background.process,
}


def processor_for(job_type: str) -> Processor:
    try:
        return PROCESSORS[job_type]
    except KeyError as exc:
        raise UnsupportedParameterError(
            f"no processor is registered for job type {job_type!r}",
            details={
                "registered": sorted(PROCESSORS),
                "retired": ["vectorize"],
            },
        ) from exc


__all__ = ["PROCESSORS", "Processor", "processor_for"]
