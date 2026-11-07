"""trim: auto content crop and the manual crop tool, one job type.

Manual crop is a ``trim`` job with ``mode = manual`` and an explicit
``cropRect``; the API records the resulting version with step type ``crop``
(domain model §6.2). The worker honours the rectangle exactly.

Auto mode:

1. classify the border to learn what "background" means here (transparent,
   black, white, gray, custom) — or take the ``backgroundSample`` the API
   already derived from the classifier;
2. mark every pixel within ``tolerance`` of that background as trimmable;
3. take the content bounding box; if content sits on **all four** outer edges
   the design is full-bleed and **no crop is made**: the input is passed through
   to the new version path and ``full-bleed-no-auto-trim`` is returned as a
   warning (product rule 12 — never silently cut a full-bleed design);
4. otherwise crop to the box expanded by ``paddingPx`` (clamped to the canvas)
   and warn for every side where content still touches the chosen edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from PIL import Image

from app.analysis import (
    BackgroundSample,
    background_matches,
    content_bbox,
    sample_background,
    to_arrays,
    touches_all_edges,
)
from app.config import Settings
from app.context import JobScope
from app.errors import CropOutOfBoundsError, UnsupportedParameterError
from app.imaging import (
    build_metadata,
    dpi_warnings,
    effective_dpi_at_target,
    image_has_alpha,
    make_warning,
)
from app.job_models import WorkerJob

ENGINE_NAME = "pillow"
FULL_BLEED_WARNING = "full-bleed-no-auto-trim"
NO_CONTENT_WARNING = "no-content-detected"
EDGE_WARNING = "content-touches-crop-edge"


@dataclass
class CropOutcome:
    image: Image.Image
    warnings: list[dict[str, Any]] = field(default_factory=list)
    passthrough: bool = False


def _background_sample(
    job: WorkerJob, arrays, settings: Settings
) -> tuple[BackgroundSample, int]:
    """Use the API-supplied sample when present, else measure the border."""

    supplied = job.parameters.get("backgroundSample") or {}
    alpha_threshold = int(supplied.get("alphaThreshold", settings.alpha_threshold))
    measured = sample_background(arrays, settings)
    kind = supplied.get("kind") or measured.kind
    hex_value = supplied.get("hex") or measured.hex
    # A sample recorded by an earlier classification can disagree with what is on
    # the border now. Trust the kind/colour the API was shown, but keep the
    # freshly measured confidence so the warning text stays honest.
    return (
        BackgroundSample(kind=kind, hex=hex_value, confidence=measured.confidence),
        alpha_threshold,
    )


def _crop_edge_warnings(crop_content: np.ndarray) -> list[dict[str, Any]]:
    """Warn per side where artwork reaches the crop boundary (it may be cut off)."""

    if crop_content.size == 0:
        return []
    edges = []
    if bool(crop_content[:, 0].any()):
        edges.append("left")
    if bool(crop_content[:, -1].any()):
        edges.append("right")
    if bool(crop_content[0, :].any()):
        edges.append("top")
    if bool(crop_content[-1, :].any()):
        edges.append("bottom")
    return [
        make_warning(
            EDGE_WARNING,
            "warning",
            f"Trimmed content touches the {edge} edge; verify that no artwork is "
            "cut off.",
            details={"edge": edge},
        )
        for edge in edges
    ]


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "trim":
        raise UnsupportedParameterError(
            f"trim processor cannot run job type {job.type!r}", details={"jobType": job.type}
        )

    source = scope.open_input()
    warnings: list[dict[str, Any]] = list(source.warnings)
    arrays = to_arrays(source.image)
    output_relative = job.require_output_path()

    mode = job.param("mode", "auto")
    if mode == "manual":
        outcome = _manual_crop(job, scope, source.image, arrays)
    elif mode == "auto":
        outcome = _auto_crop(job, scope, source.image, arrays)
    else:
        raise UnsupportedParameterError(
            f"unknown trim mode {mode!r}", details={"supported": ["auto", "manual"]}
        )
    warnings.extend(outcome.warnings)

    if outcome.passthrough and _same_format(scope, job.input_path, output_relative):
        # Uncropped pass-through: copy the bytes so no extra lossy generation is
        # added to a design we deliberately did not touch.
        scope.write_bytes(output_relative, scope.storage.read_bytes(job.input_path))
    else:
        warnings.extend(scope.save_image(output_relative, outcome.image))

    result_image = outcome.image
    effective_dpi = effective_dpi_at_target(
        result_image.width,
        result_image.height,
        job.context.target_width_cm,
        job.context.target_height_cm,
    )
    warnings.extend(dpi_warnings(effective_dpi, scope.settings))

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "metadata": build_metadata(
            result_image,
            duration_ms=0,
            engine=ENGINE_NAME,
            effective_dpi=effective_dpi,
            warnings=warnings,
            has_alpha=image_has_alpha(result_image),
        ),
    }


def _same_format(scope: JobScope, left: str, right: str) -> bool:
    return scope.storage.resolve(left).suffix.lower() == scope.storage.resolve(right).suffix.lower()


def _auto_crop(job: WorkerJob, scope: JobScope, image: Image.Image, arrays) -> CropOutcome:
    settings = scope.settings
    tolerance = job.param_int("tolerance", settings.trim_tolerance)
    padding = job.param_int("paddingPx", settings.trim_padding_px)
    sample, alpha_threshold = _background_sample(job, arrays, settings)

    background = background_matches(
        arrays, sample, tolerance=tolerance, alpha_threshold=alpha_threshold
    )
    content = ~background

    if not bool(content.any()):
        warning = make_warning(
            NO_CONTENT_WARNING,
            "warning",
            f"Every pixel is within tolerance {tolerance} of the sampled "
            f"{sample.kind} background; the input is passed through uncropped.",
            details={"tolerance": tolerance, "backgroundKind": sample.kind},
        )
        return CropOutcome(image=image, warnings=[warning], passthrough=True)

    if touches_all_edges(content):
        warning = make_warning(
            FULL_BLEED_WARNING,
            "warning",
            "Content touches all four edges (full bleed); auto-trim was skipped and "
            "the input was passed through unchanged. Use the manual crop tool if you "
            "really want to cut into the artwork.",
            details={"tolerance": tolerance, "backgroundKind": sample.kind},
        )
        return CropOutcome(image=image, warnings=[warning], passthrough=True)

    box = content_bbox(content, padding_px=padding)
    if box is None:  # pragma: no cover - content.any() already proved a box exists
        raise UnsupportedParameterError("auto-trim could not compute a content box")
    x, y, width, height = box
    cropped = image.crop((x, y, x + width, y + height))
    crop_content = content[y : y + height, x : x + width]
    return CropOutcome(image=cropped, warnings=_crop_edge_warnings(crop_content))


def _manual_crop(job: WorkerJob, scope: JobScope, image: Image.Image, arrays) -> CropOutcome:
    rect = job.parameters.get("cropRect")
    if not rect:
        raise UnsupportedParameterError("manual trim requires cropRect", details={"mode": "manual"})
    x = int(rect["x"])
    y = int(rect["y"])
    width = int(rect["width"])
    height = int(rect["height"])
    if x + width > image.width or y + height > image.height:
        raise CropOutOfBoundsError(
            f"cropRect at {x},{y} with size {width}x{height} does not fit a "
            f"{image.width}x{image.height} source",
            details={
                "cropRect": rect,
                "sourceWidthPx": image.width,
                "sourceHeightPx": image.height,
            },
        )
    cropped = image.crop((x, y, x + width, y + height))

    # Honest guidance only: the operator's rectangle is respected exactly, but we
    # measure the background the same way auto mode does and warn where artwork
    # runs up against the chosen cut line.
    settings = scope.settings
    sample = sample_background(arrays, settings)
    background = background_matches(
        arrays,
        sample,
        tolerance=settings.trim_tolerance,
        alpha_threshold=settings.alpha_threshold,
    )
    content = ~background
    crop_content = content[y : y + height, x : x + width]
    return CropOutcome(image=cropped, warnings=_crop_edge_warnings(crop_content))
