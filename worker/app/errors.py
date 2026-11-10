"""Typed worker failures with stable machine-readable codes.

Every expected failure inside the worker raises a :class:`WorkerError`. The
pipeline converts those into a ``worker-result.schema.json`` failure envelope,
so the API never receives a traceback and never has to guess whether a retry
could help.

Code stability rules:

* a code is a contract between the worker and the API/UI; rename only together
  with a contract note;
* non-retryable means "the same job with the same parameters fails again"
  (bad parameters, missing engine, traversal attempt);
* retryable means a different attempt could succeed (engine crash, timeout,
  worker shutdown).
"""

from __future__ import annotations

from typing import Any

# --- Stable codes (also documented in worker/README.md) ---------------------

CODE_INVALID_JOB = "invalid-job"
CODE_STORAGE_PATH_INVALID = "storage-path-invalid"
CODE_INPUT_MISSING = "input-missing"
CODE_IMAGE_DECODE_FAILED = "image-decode-failed"
CODE_INPUT_TOO_LARGE = "input-too-large"
CODE_UNSUPPORTED_PARAMETERS = "unsupported-parameters"
CODE_CROP_OUT_OF_BOUNDS = "crop-out-of-bounds"
CODE_FULL_BLEED_NO_AUTO_TRIM = "full-bleed-no-auto-trim"
CODE_MISSING_INPUT_ARTIFACT = "missing-input-artifact"
CODE_MASK_MISMATCH = "mask-mismatch"
CODE_ENGINE_UNAVAILABLE = "engine-unavailable"
CODE_ENGINE_MODE_UNSUPPORTED = "engine-mode-unsupported"
CODE_ENGINE_FAILED = "engine-failed"
CODE_ENGINE_TIMEOUT = "engine-timeout"
CODE_ENGINE_OUTPUT_INVALID = "engine-output-invalid"
CODE_OUTPUT_FORMAT_UNSUPPORTED = "unsupported-output-format"
CODE_OUTPUT_IS_INPUT = "output-overwrites-input"
CODE_RESULT_INVALID = "invalid-result"
CODE_WORKER_SHUTDOWN = "worker-shutdown"
CODE_INTERNAL_ERROR = "internal-error"


class WorkerError(Exception):
    """Base class for every structured worker failure."""

    code: str = CODE_INTERNAL_ERROR
    retryable: bool = False

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        retryable: bool | None = None,
        details: dict[str, Any] | None = None,
        engine: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if retryable is not None:
            self.retryable = retryable
        self.details: dict[str, Any] = dict(details or {})
        self.engine = engine

    def as_error_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            payload["details"] = self.details
        return payload


class JobContractError(WorkerError):
    """The job document does not satisfy ``worker-job.schema.json``."""

    code = CODE_INVALID_JOB
    retryable = False


class ResultContractError(WorkerError):
    """The emitted result does not satisfy ``worker-result.schema.json``."""

    code = CODE_RESULT_INVALID
    retryable = False


class StorageError(WorkerError):
    """A path is absolute, traverses outside the root, or the I/O failed."""

    code = CODE_STORAGE_PATH_INVALID
    retryable = False


class InputUnavailableError(StorageError):
    """The assigned input file is missing or unreadable."""

    code = CODE_INPUT_MISSING
    retryable = True


class ImageDecodeError(WorkerError):
    """The input file exists but cannot be decoded."""

    code = CODE_IMAGE_DECODE_FAILED
    retryable = False


class InputTooLargeError(WorkerError):
    """The input exceeds the configured pixel budget (decompression-bomb guard)."""

    code = CODE_INPUT_TOO_LARGE
    retryable = False


class UnsupportedParameterError(WorkerError):
    """A schema-legal parameter value the worker cannot honour."""

    code = CODE_UNSUPPORTED_PARAMETERS
    retryable = False


class CropOutOfBoundsError(WorkerError):
    """A manual ``cropRect`` does not fit inside the source bounds."""

    code = CODE_CROP_OUT_OF_BOUNDS
    retryable = False


class MissingInputArtifactError(WorkerError):
    """A required ``inputArtifacts`` entry (mask/svg) was not supplied."""

    code = CODE_MISSING_INPUT_ARTIFACT
    retryable = False


class MaskMismatchError(WorkerError):
    """A reused mask does not match the source dimensions it must apply to."""

    code = CODE_MASK_MISMATCH
    retryable = False


class EngineUnavailableError(WorkerError):
    """The configured engine/binary/model is not present on this machine."""

    code = CODE_ENGINE_UNAVAILABLE
    retryable = False


class EngineModeUnsupportedError(WorkerError):
    """The engine cannot process the requested mode."""

    code = CODE_ENGINE_MODE_UNSUPPORTED
    retryable = False


class EngineFailedError(WorkerError):
    """The engine ran and reported failure; a retry may succeed."""

    code = CODE_ENGINE_FAILED
    retryable = True


class EngineTimeoutError(WorkerError):
    """The engine exceeded its configured timeout."""

    code = CODE_ENGINE_TIMEOUT
    retryable = True


class EngineOutputInvalidError(WorkerError):
    """The engine produced no output, or output with the wrong dimensions."""

    code = CODE_ENGINE_OUTPUT_INVALID
    retryable = False


class OutputFormatError(WorkerError):
    """The assigned output path cannot faithfully store the produced pixels."""

    code = CODE_OUTPUT_FORMAT_UNSUPPORTED
    retryable = False


class OutputIsInputError(StorageError):
    """The assigned output path equals a protected input path (never overwrite)."""

    code = CODE_OUTPUT_IS_INPUT
    retryable = False


class ShutdownRequestedError(WorkerError):
    """The worker was asked to stop before the job finished."""

    code = CODE_WORKER_SHUTDOWN
    retryable = True


class LeaseLostError(WorkerError):
    """The API no longer recognises this lease token; stop reporting."""

    code = "lease-lost"
    retryable = False


class JobTransportError(WorkerError):
    """The internal API could not be reached; the loop should back off and retry."""

    code = "api-unreachable"
    retryable = True


class WorkerKeyRejectedError(WorkerError):
    """The API rejected ``X-Worker-Key``; retrying with the same key will not help."""

    code = "worker-key-invalid"
    retryable = False
