"""Frozen contract loading, validation and typed request/response models.

The schemas are the repository's frozen ``contracts/jsonschema`` documents.
They are discovered relative to this package (walking up towards the
repository root) or from ``$PRINTSHEET_CONTRACT_DIR``; the packer never ships
a copy of them and never edits them.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from printsheet_packer.errors import ContractValidationError
from printsheet_packer.units import centimeters_for_pixels, pixels_for_centimeters

PACKER_REQUEST = "packer-request"
PACKER_RESPONSE = "packer-response"
INTEGRITY_REPORT = "integrity-report"

_ENV_OVERRIDE = "PRINTSHEET_CONTRACT_DIR"


def discover_schema_dir(start: Path | None = None) -> Path:
    """Locate ``contracts/jsonschema`` without hardcoding an absolute path."""
    override = os.environ.get(_ENV_OVERRIDE)
    if override:
        candidate = Path(override).expanduser().resolve()
        if (candidate / f"{PACKER_REQUEST}.schema.json").is_file():
            return candidate
        raise ContractValidationError(
            f"{_ENV_OVERRIDE}={override} does not contain {PACKER_REQUEST}.schema.json"
        )

    here = (start or Path(__file__).resolve()).resolve()
    for parent in [here, *here.parents]:
        candidate = parent / "contracts" / "jsonschema"
        if (candidate / f"{PACKER_REQUEST}.schema.json").is_file():
            return candidate
    raise ContractValidationError(
        "Could not find contracts/jsonschema above the packer package. "
        f"Searched from {here}. Set {_ENV_OVERRIDE} to the schema directory."
    )


def load_registry(schema_dir: Path) -> Registry:
    """All schemas in ``schema_dir``, keyed by ``$id``, so ``$ref`` resolves."""
    resources = []
    for path in sorted(schema_dir.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        if "$id" in schema:
            resources.append((schema["$id"], Resource.from_contents(schema)))
    return Registry().with_resources(resources)


class ContractStore:
    """Validated access to the frozen contracts."""

    def __init__(self, schema_dir: Path | None = None) -> None:
        self.schema_dir = schema_dir or discover_schema_dir()
        self._schemas: dict[str, dict[str, Any]] = {}
        for path in sorted(self.schema_dir.glob("*.schema.json")):
            schema = json.loads(path.read_text(encoding="utf-8"))
            self._schemas[path.name.removesuffix(".schema.json")] = schema
        self._registry = load_registry(self.schema_dir)

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._schemas))

    def schema(self, name: str) -> dict[str, Any]:
        try:
            return self._schemas[name]
        except KeyError as exc:
            raise ContractValidationError(f"Unknown contract schema: {name}") from exc

    def validator(self, name: str) -> Draft202012Validator:
        return Draft202012Validator(self.schema(name), registry=self._registry)

    def validate(self, name: str, document: Any) -> list[str]:
        validator = self.validator(name)
        paths = sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path))
        return [_describe_error(error) for error in paths]

    def require_valid(self, name: str, document: Any) -> Any:
        errors = self.validate(name, document)
        if errors:
            raise ContractValidationError(
                f"{name} is not valid against the frozen contract", errors=errors
            )
        return document

    def check(self, name: str, document: Any) -> list[str]:
        """Non-raising validation, used by ``verify`` and the CLI."""
        return self.validate(name, document)


def _describe_error(error: Any) -> str:
    location = "/".join(str(part) for part in error.absolute_path) or "<root>"
    return f"{location}: {error.message}"


# ----------------------------------------------------------------------
# typed request model
# ----------------------------------------------------------------------


@dataclass(frozen=True)
class DesignInput:
    design_id: str
    version_id: str
    file_path: str
    width_px: int
    height_px: int
    allow_rotation: bool
    display_name: str | None = None
    target_width_cm: float | None = None
    target_height_cm: float | None = None

    @property
    def label(self) -> str:
        return self.display_name or self.design_id


@dataclass(frozen=True)
class OutputSpec:
    directory: str
    manifest_path: str
    preview_path: str | None = None


@dataclass(frozen=True)
class PackRequest:
    schema_version: str
    request_id: str
    roll_width_cm: float
    margin_mm: float
    edge_margin_mm: float
    dpi: int
    alpha_threshold: int
    cell_mm: float
    randomized_orderings: int
    time_budget_ms: int
    seed: int
    no_interlocking: bool
    designs: tuple[DesignInput, ...]
    output: OutputSpec
    source: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    @property
    def sheet_width_px(self) -> int:
        return pixels_for_centimeters(self.roll_width_cm, self.dpi)


def parse_pack_request(document: Any) -> PackRequest:
    """Schema-validate then narrow into :class:`PackRequest`."""
    ContractStore().require_valid(PACKER_REQUEST, document)
    designs = []
    for index, raw in enumerate(document["designs"]):
        try:
            design = DesignInput(
                design_id=raw["designId"],
                version_id=raw["versionId"],
                file_path=raw["filePath"],
                width_px=raw["widthPx"],
                height_px=raw["heightPx"],
                allow_rotation=raw["allowRotation"],
                display_name=raw.get("displayName"),
                target_width_cm=raw.get("targetWidthCm"),
                target_height_cm=raw.get("targetHeightCm"),
            )
        except KeyError as exc:  # pragma: no cover - schema already enforces this
            raise ContractValidationError(f"designs[{index}] is missing {exc.args[0]}") from exc
        designs.append(design)

    output = document["output"]
    return PackRequest(
        schema_version=document["schemaVersion"],
        request_id=document["requestId"],
        roll_width_cm=document["rollWidthCm"],
        margin_mm=document["marginMm"],
        edge_margin_mm=document["edgeMarginMm"],
        dpi=document["dpi"],
        alpha_threshold=document["alphaThreshold"],
        cell_mm=document["cellMm"],
        randomized_orderings=document["randomizedOrderings"],
        time_budget_ms=document["timeBudgetMs"],
        seed=document["seed"],
        no_interlocking=document["noInterlocking"],
        designs=tuple(designs),
        output=OutputSpec(
            directory=output["directory"],
            manifest_path=output["manifestPath"],
            preview_path=output.get("previewPath"),
        ),
        source=json.loads(json.dumps(document)),
    )


def load_pack_request(path: os.PathLike[str] | str) -> PackRequest:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    return parse_pack_request(document)


# ----------------------------------------------------------------------
# typed placement model
# ----------------------------------------------------------------------


@dataclass(frozen=True)
class Placement:
    """One placed design. ``x_px``/``y_px`` are the rotated image's top-left."""

    design_id: str
    version_id: str
    x_px: int
    y_px: int
    width_px: int
    height_px: int
    rotation_deg: int
    display_name: str | None = None

    def to_json(self, dpi: int) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "designId": self.design_id,
            "versionId": self.version_id,
            "xCm": centimeters_for_pixels(self.x_px, dpi),
            "yCm": centimeters_for_pixels(self.y_px, dpi),
            "widthCm": centimeters_for_pixels(self.width_px, dpi),
            "heightCm": centimeters_for_pixels(self.height_px, dpi),
            "widthPx": self.width_px,
            "heightPx": self.height_px,
            "rotationDeg": self.rotation_deg,
        }
        if self.display_name:
            payload["displayName"] = self.display_name
        return payload


def sheet_geometry(width_px: int, height_px: int, dpi: int) -> dict[str, Any]:
    return {
        "widthPx": int(width_px),
        "heightPx": int(height_px),
        "widthCm": centimeters_for_pixels(width_px, dpi),
        "heightCm": centimeters_for_pixels(height_px, dpi),
        "dpi": int(dpi),
    }


def new_report_id() -> str:
    return str(uuid.uuid4())


def utc_timestamp(moment: datetime | None = None) -> str:
    stamp = moment or datetime.now(UTC)
    return stamp.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_response(store: ContractStore, response: Mapping[str, Any]) -> list[str]:
    return store.validate(PACKER_RESPONSE, response)


def require_response_valid(store: ContractStore, response: Mapping[str, Any]) -> None:
    errors = validate_response(store, response)
    if errors:
        raise ContractValidationError("packer response is not valid", errors=errors)



__all__ = [
    "ContractStore",
    "DesignInput",
    "INTEGRITY_REPORT",
    "OutputSpec",
    "PACKER_REQUEST",
    "PACKER_RESPONSE",
    "PackRequest",
    "Placement",
    "new_report_id",
    "parse_pack_request",
    "load_pack_request",
    "require_response_valid",
    "sheet_geometry",
    "utc_timestamp",
    "validate_response",
]
