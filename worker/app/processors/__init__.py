"""Processor registry: one entry per frozen worker job type.

Every job type in ``worker-job.schema.json`` has a real implementation here;
there is no stubbed processor.
"""

from __future__ import annotations

from collections.abc import Callable

from app.context import JobScope
from app.errors import UnsupportedParameterError
from app.job_models import WorkerJob
from app.processors import (
    background,
    classify,
    resize,
    trim,
    upscale,
    vectorize,
)

Processor = Callable[[WorkerJob, JobScope], dict]

PROCESSORS: dict[str, Processor] = {
    "classify": classify.process,
    "trim": trim.process,
    "background-removal": background.process,
    "upscale": upscale.process,
    "vectorize": vectorize.process,
    "resize": resize.process,
}


def processor_for(job_type: str) -> Processor:
    try:
        return PROCESSORS[job_type]
    except KeyError as exc:
        raise UnsupportedParameterError(
            f"no processor is registered for job type {job_type!r}",
            details={"registered": sorted(PROCESSORS)},
        ) from exc


__all__ = ["PROCESSORS", "Processor", "processor_for"]
