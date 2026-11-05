"""Structured logging for the worker.

Every job logs its identifiers, the parameters that produced the pixels and the
outcome, per the observability rules in ARCHITECTURE.md §15. Customer file names
never appear — the paths are opaque UUID-based storage keys, and only the
relative path of the *version* is logged when it is useful for debugging.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from app.config import Settings

LOGGER_NAME = "printsheet.worker"
_REDADED = ("workerKey", "worker_key", "X-Worker-Key")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def setup_logging(settings: Settings) -> logging.Logger:
    """Idempotent configuration of the worker logger."""

    logger = logging.getLogger(LOGGER_NAME)
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logger.setLevel(level)
    logger.propagate = False

    formatter: logging.Formatter
    if settings.log_json:
        formatter = JsonFormatter()
    else:
        formatter = logging.Formatter(
            "%(asctime)s %(levelname)-7s %(name)s %(message)s", datefmt="%H:%M:%S"
        )

    if not logger.handlers:
        handler = logging.StreamHandler(stream=sys.stderr)
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    else:
        for handler in logger.handlers:
            handler.setFormatter(formatter)
    return logger


def get_logger() -> logging.Logger:
    return logging.getLogger(LOGGER_NAME)


def log_event(
    level: int,
    message: str,
    *,
    job: Any = None,
    duration_ms: int | None = None,
    exc_info: bool = False,
    **fields: Any,
) -> None:
    """Log with job identity attached, never with secrets."""

    payload: dict[str, Any] = dict(fields)
    if job is not None:
        payload.update(
            {
                "jobId": getattr(job, "job_id", None),
                "batchId": getattr(job, "batch_id", None),
                "designId": getattr(job, "design_id", None),
                "stepType": getattr(job, "type", None),
            }
        )
    if duration_ms is not None:
        payload["durationMs"] = duration_ms
    cleaned = {key: value for key, value in payload.items() if value is not None}
    for secret in _REDADED:
        cleaned.pop(secret, None)
    get_logger().log(level, message, extra={"fields": cleaned}, exc_info=exc_info)
