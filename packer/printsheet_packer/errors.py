"""Typed failures shared by every packer module.

The API surfaces these codes, so they are part of the packer's contract with
its callers even though the frozen JSON contracts do not describe them.
"""

from __future__ import annotations

from typing import Any

DESIGN_EXCEEDS_ROLL = "design-exceeds-roll"
EXPORT_FORMAT_UNAVAILABLE = "export-format-unavailable"
CONTRACT_INVALID = "contract-invalid"
PATH_UNSAFE = "path-unsafe"
INPUT_IMMUTABLE = "input-immutable"
SOURCE_MISSING = "source-missing"
INTEGRITY_FAILED = "integrity-failed"
PACK_FAILED = "pack-failed"
MASK_EMPTY = "mask-empty"


class PackerError(Exception):
    """Base class for every structured packer failure."""

    code = "packer-error"

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.message = message
        self.details = details

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            payload["details"] = self.details
        return payload

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


class ContractValidationError(PackerError):
    code = CONTRACT_INVALID

    def __init__(self, message: str, errors: list[str] | None = None, **details: Any) -> None:
        super().__init__(message, errors=sorted(errors or []), **details)
        self.errors = errors or []


class UnsafePathError(PackerError):
    code = PATH_UNSAFE


class OutputExistsError(PackerError):
    """An artifact already sits at the requested destination."""

    code = "output-exists"


class InputImmutableError(PackerError):
    code = INPUT_IMMUTABLE


class MissingSourceError(PackerError):
    code = SOURCE_MISSING


class SourceDimensionError(PackerError):
    """The approved file does not match the geometry the request declared."""

    code = "source-dimension-mismatch"


class DesignExceedsRollError(PackerError):
    """A design cannot fit the usable roll width in any allowed rotation."""

    code = DESIGN_EXCEEDS_ROLL


class PackPlacementError(PackerError):
    """No feasible layout was found within the request parameters."""

    code = PACK_FAILED


class IntegrityFailedError(PackerError):
    code = INTEGRITY_FAILED

    def __init__(self, message: str, report: dict[str, Any]) -> None:
        failures = [failure["checkId"] for failure in report.get("failures", [])]
        super().__init__(message, failures=failures)
        self.report = report


class ExportFormatUnavailableError(PackerError):
    code = EXPORT_FORMAT_UNAVAILABLE
