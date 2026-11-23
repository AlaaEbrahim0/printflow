"""refine-mono: reduce mono-type artwork to print-ready hard ink.

This processor is the thin seam between a worker job and :mod:`app.mono`. It
reads parameters, decides whether the job is allowed to binarize, writes the
plate, and reports the classifier's measurements so the operator can see why a
design was or was not reduced.

Three behaviours are deliberate and worth stating:

* A **photograph is not a failure.** The job succeeds, writes the input through
  unchanged, and reports ``skipped: true`` with the classifier's reason. Failing
  would make every non-mono design look broken in the queue.
* A **flat-colour illustration is not binarized by default.** Forcing a
  multi-colour logo to one ink is irreversible, so the job writes the colours
  through untouched unless ``binarizeFlatColour`` was explicitly set.
* A **preset can only narrow the gate.** An operator cannot binarize a photo by
  choosing the ``logo`` preset; the classifier's kind decides first.

Output format
-------------
The plate is written as RGBA PNG with exactly two pixel states — opaque black ink
on fully transparent paper — and the result metadata records the ink and paper
counts so the API can prove the two-state guarantee without re-reading the file.

It is not a mode-``1`` PNG on purpose: measured, a mode-``1`` file converts to
RGBA with alpha 255 on every pixel, and the packer decides occupancy from alpha,
so a mode-``1`` design would be packed as a solid white rectangle.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import numpy as np
from PIL import Image

from app.context import JobScope
from app.errors import UnsupportedParameterError
from app.imaging import build_metadata, image_has_alpha, make_warning
from app.job_models import WorkerJob
from app.mono import (
    PRESETS,
    MonoConfig,
    MonoStageError,
    MonoVerdict,
    classify_mono,
    resolve_preset,
    run_refinement,
)
from app.mono.types import DenoiseMode, ThresholdMode, TwoStateViolation

ENGINE_NAME = "mono-refine-v1"
JOB_TYPE = "refine-mono"

# Parameters the API may send. Anything not listed here is refused rather than
# ignored, so a typo cannot silently do nothing.
_ALLOWED = frozenset(
    {
        "preset",
        "binarizeFlatColour",
        "thresholdMode",
        "fixedThreshold",
        "adaptiveBlock",
        "adaptiveConstant",
        "denoiseMode",
        "denoiseKernel",
        "despeckleMaxPx",
        "fillHoleMaxPx",
        "morphologyOpen",
        "morphologyClose",
        "upscaleFactor",
        "monoEtaMin",
    }
)

# Integer job parameters and the :class:`MonoConfig` field each one sets.
_INTEGER_PARAMETERS = (
    ("fixedThreshold", "fixed_threshold"),
    ("adaptiveBlock", "adaptive_block"),
    ("denoiseKernel", "denoise_kernel"),
    ("despeckleMaxPx", "despeckle_max_px"),
    ("fillHoleMaxPx", "fill_hole_max_px"),
    ("morphologyOpen", "morphology_open"),
    ("morphologyClose", "morphology_close"),
    ("upscaleFactor", "upscale_factor"),
)


def _reject_unknown_parameters(job: WorkerJob) -> None:
    unknown = sorted(set(job.parameters) - _ALLOWED)
    if unknown:
        raise UnsupportedParameterError(
            f"refine-mono does not understand parameter(s) {unknown!r}",
            details={"unknown": unknown, "supported": sorted(_ALLOWED)},
        )


def _enum(enum_type, value: Any, name: str):
    """Coerce a job parameter to an enum, naming the alternatives when it fails."""

    try:
        return enum_type(value)
    except ValueError:
        raise UnsupportedParameterError(
            f"{name} must be one of {[item.value for item in enum_type]}, got {value!r}",
            details={"parameter": name, "supported": [item.value for item in enum_type]},
        ) from None


def build_config(job: WorkerJob, preset_name: str | None) -> MonoConfig:
    """Layer the job's parameters over the preset's defaults.

    Order matters: the preset is the starting point, then the job's explicit
    parameters win. That way a preset can be tuned per job without editing it.
    """

    config = resolve_preset(preset_name).config()
    overrides: dict[str, Any] = {}

    if job.param("thresholdMode") is not None:
        overrides["threshold_mode"] = _enum(
            ThresholdMode, job.param("thresholdMode"), "thresholdMode"
        )
    if job.param("denoiseMode") is not None:
        overrides["denoise_mode"] = _enum(
            DenoiseMode, job.param("denoiseMode"), "denoiseMode"
        )
    for parameter, field in _INTEGER_PARAMETERS:
        value = job.param(parameter)
        if value is not None:
            overrides[field] = int(value)
    if job.param("adaptiveConstant") is not None:
        overrides["adaptive_constant"] = float(job.param("adaptiveConstant"))
    if job.param("monoEtaMin") is not None:
        overrides["mono_eta_min"] = float(job.param("monoEtaMin"))

    if not overrides:
        return config
    # ``replace`` re-runs ``__post_init__``, so an out-of-range override fails
    # here with the parameter named rather than producing a strange plate.
    return replace(config, **overrides)


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != JOB_TYPE:
        raise UnsupportedParameterError(
            f"refine-mono processor cannot run job type {job.type!r}",
            details={"jobType": job.type},
        )

    _reject_unknown_parameters(job)
    preset_name = job.param("preset")
    preset = resolve_preset(preset_name)
    config = build_config(job, preset_name)

    # An explicit operator opt-in for binarizing flat colour, which is otherwise
    # irreversible and therefore refused.
    binarize_flat = job.param_bool("binarizeFlatColour", False)

    # ``clean-only`` is defined by keeping the colours, so consenting to binarize
    # in the same job is a contradiction. Refusing beats silently dropping one of
    # the two instructions: either choice would override something the operator
    # asked for. The API rejects this pair too; this is the second layer, because
    # a WorkerJob can be built from any mapping.
    if binarize_flat and not preset.binarizes:
        raise UnsupportedParameterError(
            f"the {preset.name!r} preset keeps the artwork's colours and cannot be "
            "combined with binarizeFlatColour",
            details={"preset": preset.name, "binarizeFlatColour": True},
        )

    source = scope.open_input()
    image = source.image
    warnings: list[dict[str, Any]] = list(source.warnings)
    output_relative = job.require_output_path()

    verdict = classify_mono(image, config)

    # The classifier's gate comes first, so a photograph always reports the same
    # reason whatever preset was chosen. A preset then narrows what is allowed;
    # it can never widen it.
    if not verdict.eligible:
        warnings.append(
            make_warning(
                "mono-skipped",
                "info",
                f"No mono refinement was applied. {verdict.reason}",
                details={"kind": verdict.kind.value, "preset": preset.name},
            )
        )
        return _write_unchanged(
            job, scope, source, verdict, warnings, output_relative
        )

    if verdict.kind not in preset.allowed_kinds:
        warnings.append(
            make_warning(
                "mono-preset-skipped",
                "info",
                f"The {preset.label} preset does not apply to {verdict.kind.value} "
                f"artwork, so the pixels were left unchanged. {verdict.reason}",
                details={
                    "preset": preset.name,
                    "kind": verdict.kind.value,
                    "allowedKinds": [kind.value for kind in preset.allowed_kinds],
                },
            )
        )
        return _write_unchanged(
            job, scope, source, verdict, warnings, output_relative
        )

    # An explicit operator opt-in for binarizing flat colour, which is otherwise
    # irreversible and therefore refused.
    binarize_flat = job.param_bool("binarizeFlatColour", False)

    result = run_refinement(
        image,
        config,
        preset=preset,
        binarize_flat_colour=binarize_flat or config.allow_binarize_flat_colour,
    )

    if not result.ran:
        warnings.append(
            make_warning(
                "mono-skipped",
                "info",
                f"No mono refinement was applied. {result.verdict.reason}",
                details={"kind": result.verdict.kind.value, "preset": preset.name},
            )
        )
        return _write_unchanged(
            job, scope, source, result.verdict, warnings, output_relative
        )

    plate = result.plate
    if result.binarized:
        # Checked here as well as inside the chain, because this is the array
        # that actually reaches disk.
        _assert_two_state(plate)

    saved = Image.fromarray(plate, "RGBA")
    warnings.extend(
        scope.save_image_with_dpi(output_relative, saved, job.context.working_dpi)
    )

    if result.binarized:
        warnings.append(
            make_warning(
                "mono-binarized",
                "info",
                "The artwork was reduced to a single ink: every pixel is now either "
                "opaque black or fully transparent. Approving this replaces the "
                "colour version for good.",
                details={"preset": preset.name, "kind": result.verdict.kind.value},
            )
        )

    metadata = build_metadata(
        saved,
        duration_ms=0,
        engine=ENGINE_NAME,
        model=preset.name,
        warnings=warnings,
        has_alpha=image_has_alpha(saved),
    )
    metadata["mono"] = {
        "classification": result.verdict.as_dict(),
        "preset": preset.name,
        "binarized": result.binarized,
        "stages": result.trace_dicts(),
    }
    if result.binarized:
        metadata["mono"]["twoState"] = _two_state_counts(plate)

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "metadata": metadata,
    }


def _write_unchanged(
    job: WorkerJob,
    scope: JobScope,
    source,
    verdict: MonoVerdict,
    warnings: list[dict[str, Any]],
    output_relative: str,
) -> dict[str, Any]:
    """Copy the input through untouched, recording why nothing was done.

    Writing the file rather than leaving the output path empty keeps the job
    contract uniform: every job that carries an ``outputPath`` produces a file.
    The pixels are identical; only the container is re-encoded as PNG.
    """

    saved = source.image
    warnings.extend(
        scope.save_image_with_dpi(output_relative, saved, job.context.working_dpi)
    )
    metadata = build_metadata(
        saved,
        duration_ms=0,
        engine=ENGINE_NAME,
        warnings=warnings,
        has_alpha=source.has_alpha,
    )
    metadata["mono"] = {
        "classification": verdict.as_dict(),
        "binarized": False,
        "skipped": True,
        "stages": [],
    }
    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "metadata": metadata,
    }


def _two_state_counts(plate: np.ndarray) -> dict[str, int]:
    alpha = plate[..., 3]
    ink = int((alpha > 0).sum())
    return {"inkPx": ink, "paperPx": int(alpha.size - ink)}


def _assert_two_state(plate: np.ndarray) -> None:
    """Assert the plate really is two states before it is written.

    Cheap, and it is the last line of defence: a future stage that writes a
    greyscale value would be caught here rather than at the press.
    """

    if plate.dtype != np.uint8 or plate.ndim != 3 or plate.shape[2] != 4:
        raise TwoStateViolation(
            f"the plate must be uint8 RGBA, got {plate.dtype} {plate.shape}",
            details={"dtype": str(plate.dtype), "shape": list(plate.shape)},
        )
    ink = plate[..., 3] > 0
    if not ink.any():
        raise TwoStateViolation("the plate contains no ink")
    if ink.all():
        raise TwoStateViolation("the plate is solid ink")
    # Exactly two RGBA tuples may appear.
    distinct = np.unique(plate.reshape(-1, 4), axis=0)
    if len(distinct) != 2:
        raise TwoStateViolation(
            f"the plate has {len(distinct)} distinct pixel values; exactly 2 are allowed",
            details={"distinct": len(distinct)},
        )


# ``PRESETS`` and ``MonoStageError`` are re-exported for tests and for the
# registry's benefit; the processor itself never needs to catch a stage error,
# because an unhandled one becomes a failed job with the stage's own message.
__all__ = ["ENGINE_NAME", "JOB_TYPE", "PRESETS", "MonoStageError", "build_config", "process"]
