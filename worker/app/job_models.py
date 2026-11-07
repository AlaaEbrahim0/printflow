"""Typed view over a job document that already passed the frozen schema.

The JSON Schema is the single source of truth for what a job may contain; this
module only gives processors ergonomic, non-repeating access to it. Field names
here mirror `contracts/jsonschema/worker-job.schema.json` exactly
(``camelCase``), and every default value comes from :mod:`app.config`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.errors import UnsupportedParameterError

JOB_TYPES = frozenset(
    {"classify", "trim", "background-removal", "upscale", "vectorize", "resize"}
)
IMAGE_JOB_TYPES = JOB_TYPES - {"classify"}
ARTIFACT_NAMES = ("mask", "svg")


@dataclass(frozen=True)
class JobContextView:
    """``context`` of the job envelope: DPI, target box, provenance, garment."""

    working_dpi: int
    target_width_cm: float | None = None
    target_height_cm: float | None = None
    source_version_id: str | None = None
    original_path: str | None = None
    garment_color: Mapping[str, Any] | None = None

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> JobContextView:
        return cls(
            working_dpi=int(document["workingDpi"]),
            target_width_cm=document.get("targetWidthCm"),
            target_height_cm=document.get("targetHeightCm"),
            source_version_id=document.get("sourceVersionId"),
            original_path=document.get("originalPath"),
            garment_color=document.get("garmentColor"),
        )


@dataclass(frozen=True)
class WorkerJob:
    """A validated worker job."""

    document: Mapping[str, Any]
    job_id: str
    type: str
    batch_id: str
    design_id: str
    input_path: str
    output_path: str | None
    input_artifacts: Mapping[str, str]
    output_artifacts: Mapping[str, str]
    parameters: Mapping[str, Any]
    context: JobContextView

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> WorkerJob:
        if document.get("schemaVersion") != "1.0":
            raise UnsupportedParameterError(
                f"unsupported job schemaVersion {document.get('schemaVersion')!r}",
                details={"expected": "1.0"},
            )
        job_type = document["type"]
        if job_type not in JOB_TYPES:
            raise UnsupportedParameterError(
                f"unknown job type {job_type!r}",
                details={"supported": sorted(JOB_TYPES)},
            )
        return cls(
            document=document,
            job_id=document["jobId"],
            type=job_type,
            batch_id=document["batchId"],
            design_id=document["designId"],
            input_path=document["inputPath"],
            output_path=document.get("outputPath"),
            input_artifacts=document.get("inputArtifacts") or {},
            output_artifacts=document.get("outputArtifacts") or {},
            parameters=document.get("parameters") or {},
            context=JobContextView.from_document(document.get("context") or {}),
        )

    @property
    def produces_raster(self) -> bool:
        return self.type in IMAGE_JOB_TYPES

    def require_output_path(self) -> str:
        if not self.output_path:
            raise UnsupportedParameterError(
                f"a {self.type} job must carry outputPath",
                details={"jobType": self.type},
            )
        return self.output_path

    def artifact_input(self, name: str) -> str | None:
        return self.input_artifacts.get(name)

    def artifact_output(self, name: str) -> str | None:
        return self.output_artifacts.get(name)

    def protected_inputs(self) -> tuple[str, ...]:
        """Every path the worker must never overwrite (rule: originals are immutable)."""

        paths = [self.input_path]
        paths.extend(self.input_artifacts.values())
        if self.context.original_path:
            paths.append(self.context.original_path)
        return tuple(dict.fromkeys(paths))

    # --- parameter access ----------------------------------------------------
    def param(self, name: str, default: Any = None) -> Any:
        value = self.parameters.get(name)
        return default if value is None else value

    def param_int(self, name: str, default: int) -> int:
        value = self.parameters.get(name)
        return int(value) if value is not None else default

    def param_float(self, name: str, default: float) -> float:
        value = self.parameters.get(name)
        return float(value) if value is not None else default

    def param_bool(self, name: str, default: bool) -> bool:
        value = self.parameters.get(name)
        return bool(value) if value is not None else default
