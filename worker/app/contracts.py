"""Loading and validation against the frozen JSON Schemas.

The canonical contracts live in ``contracts/jsonschema/`` at the repository
root. This module finds them without a hard-coded absolute path:

1. ``Settings.contracts_dir`` (``PRINTSHEET_CONTRACTS_DIR``) when set;
2. the first ``contracts/jsonschema`` directory found by walking upward from the
   worker package (development and editable installs);
3. the copy vendored in ``app/_contracts`` (container images, whose build
   context is ``worker/`` only).

``format`` keywords are treated as annotations, exactly like the repository's
own contract validator: the API is authoritative for UUID/date-time formats,
while the worker re-checks the parts that are security-relevant (relative
paths) itself in :mod:`app.storage`.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from app.errors import JobContractError, ResultContractError

WORKER_JOB_SCHEMA = "worker-job.schema.json"
WORKER_RESULT_SCHEMA = "worker-result.schema.json"
CONTRACT_SCHEMA_VERSION = "1.0"

_PACKAGE_DIR = Path(__file__).resolve().parent
_VENDED_DIR = _PACKAGE_DIR / "_contracts"
_MAX_PATH_DEPTH = 12

_lock = threading.Lock()
_validator_cache: dict[tuple[str, str], Draft202012Validator] = {}


class ContractsNotFoundError(RuntimeError):
    """No readable copy of the worker contracts could be located."""


def _has_worker_schemas(directory: Path) -> bool:
    return all((directory / name).is_file() for name in (WORKER_JOB_SCHEMA, WORKER_RESULT_SCHEMA))


def candidate_directories(configured: Path | None = None) -> list[Path]:
    """Ordered list of directories that may hold the frozen schemas."""

    candidates: list[Path] = []
    if configured is not None:
        candidates.append(Path(configured))
    directory = _PACKAGE_DIR
    for _ in range(_MAX_PATH_DEPTH):
        candidates.append(directory / "contracts" / "jsonschema")
        parent = directory.parent
        if parent == directory:
            break
        directory = parent
    candidates.append(_VENDED_DIR)
    return candidates


def resolve_contracts_dir(configured: Path | None = None) -> Path:
    for candidate in candidate_directories(configured):
        if _has_worker_schemas(candidate):
            return candidate
    raise ContractsNotFoundError(
        "worker contracts not found; set PRINTSHEET_CONTRACTS_DIR to the directory "
        "containing worker-job.schema.json and worker-result.schema.json"
    )


def _load_registry(directory: Path) -> Registry:
    resources = []
    for path in sorted(directory.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        if "$id" in schema:
            resources.append((schema["$id"], Resource.from_contents(schema)))
    return Registry().with_resources(resources)


def _validator(schema_name: str, directory: Path) -> Draft202012Validator:
    key = (str(directory), schema_name)
    with _lock:
        cached = _validator_cache.get(key)
    if cached is not None:
        return cached
    schema = json.loads((directory / schema_name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, registry=_load_registry(directory))
    with _lock:
        _validator_cache[key] = validator
    return validator


def describe_document(schema_name: str, document: Any, directory: Path) -> list[str]:
    """Human-readable schema violations, ordered by document path."""

    validator = _validator(schema_name, directory)
    collected = sorted(
        validator.iter_errors(document),
        key=lambda error: list(error.absolute_path),
    )
    messages = []
    for error in collected:
        location = "/".join(str(part) for part in error.absolute_path) or "<root>"
        messages.append(f"{location}: {error.message}")
    return messages


def validate_job(document: Any, contracts_dir: Path | None = None) -> dict[str, Any]:
    """Return the job document unchanged, or raise a structured failure."""

    directory = resolve_contracts_dir(contracts_dir)
    problems = describe_document(WORKER_JOB_SCHEMA, document, directory)
    if problems:
        raise JobContractError(
            "job does not satisfy worker-job.schema.json",
            details={"errors": problems, "schema": WORKER_JOB_SCHEMA},
        )
    return document


def validate_result(document: Any, contracts_dir: Path | None = None) -> dict[str, Any]:
    directory = resolve_contracts_dir(contracts_dir)
    problems = describe_document(WORKER_RESULT_SCHEMA, document, directory)
    if problems:
        raise ResultContractError(
            "worker result does not satisfy worker-result.schema.json",
            details={"errors": problems, "schema": WORKER_RESULT_SCHEMA},
        )
    return document
