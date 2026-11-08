"""resize: the one and only resample, to the physical print size.

The domain model is strict about this step: it resamples **exactly once** with
Lanczos, and the pixel target comes from
``round_half_away_from_zero(cm * dpi / 2.54)`` — the same rule the API's
``PrintUnits`` applies (58 cm at 300 DPI is 6850 px).

Fit modes are honest about what they do:

``width``    width = ``targetWidthPx``; height = ``round(sourceH * targetWidthPx / sourceW)``.
``height``   height = ``targetHeightPx``; width = ``round(sourceW * targetHeightPx / sourceH)``.
``contain``  the canvas is exactly ``targetWidthPx x targetHeightPx``; the artwork
             keeps its aspect ratio, is scaled to fit inside, and is centred on
             transparent padding. It never stretches and never crops.

"""

from __future__ import annotations

from typing import Any

from PIL import Image

from app.context import JobScope
from app.errors import UnsupportedParameterError
from app.imaging import (
    build_metadata,
    dpi_warnings,
    effective_dpi_at_target,
    image_has_alpha,
    make_warning,
    pixels_for_centimeters,
    round_half_away_from_zero,
    scale_to_fit,
)
from app.job_models import WorkerJob

ENGINE_NAME = "pillow"
FIT_MODES = ("width", "height", "contain")


def _declared_targets(job: WorkerJob) -> tuple[float, float, int, int, int]:
    parameters = job.parameters
    try:
        target_width_cm = float(parameters["targetWidthCm"])
        target_height_cm = float(parameters["targetHeightCm"])
        target_width_px = int(parameters["targetWidthPx"])
        target_height_px = int(parameters["targetHeightPx"])
        dpi = int(parameters["dpi"])
    except KeyError as exc:
        raise UnsupportedParameterError(
            f"resize parameters are missing {exc.args[0]!r}",
            details={"required": [
                "targetWidthCm",
                "targetHeightCm",
                "targetWidthPx",
                "targetHeightPx",
                "dpi",
                "fitMode",
            ]},
        ) from exc
    return target_width_cm, target_height_cm, target_width_px, target_height_px, dpi


def _px_consistency_warnings(
    target_width_cm: float,
    target_height_cm: float,
    target_width_px: int,
    target_height_px: int,
    dpi: int,
) -> list[dict[str, Any]]:
    """Warn when the px target the API sent is not what PrintUnits would produce."""

    warnings: list[dict[str, Any]] = []
    axes = (
        ("width", target_width_cm, target_width_px),
        ("height", target_height_cm, target_height_px),
    )
    for axis, centimeters, provided_px in axes:
        computed = pixels_for_centimeters(centimeters, dpi)
        if provided_px != computed:
            warnings.append(
                make_warning(
                    "target-px-cm-mismatch",
                    "warning",
                    f"Target {axis} is {provided_px}px, but "
                    f"round({centimeters} cm * {dpi} DPI / 2.54) is {computed}px. The "
                    "explicit pixel target wins; the version may fail the readiness "
                    "check in the API.",
                    details={
                        "axis": axis,
                        "providedPx": provided_px,
                        "printUnitsPx": computed,
                        "centimeters": centimeters,
                        "dpi": dpi,
                    },
                )
            )
    return warnings


def _target_size(
    fit_mode: str,
    source_width: int,
    source_height: int,
    target_width_px: int,
    target_height_px: int,
) -> tuple[int, int]:
    if fit_mode == "width":
        height = round_half_away_from_zero(source_height * target_width_px / source_width)
        return target_width_px, max(1, height)
    if fit_mode == "height":
        width = round_half_away_from_zero(source_width * target_height_px / source_height)
        return max(1, width), target_height_px
    if fit_mode == "contain":
        return scale_to_fit(source_width, source_height, target_width_px, target_height_px)
    raise UnsupportedParameterError(
        f"unknown fitMode {fit_mode!r}", details={"supported": list(FIT_MODES)}
    )


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "resize":
        raise UnsupportedParameterError(
            "resize processor cannot run this job", details={"jobType": job.type}
        )

    settings = scope.settings
    (
        target_width_cm,
        target_height_cm,
        target_width_px,
        target_height_px,
        dpi,
    ) = _declared_targets(job)
    fit_mode = str(job.param("fitMode", ""))
    if fit_mode not in FIT_MODES:
        raise UnsupportedParameterError(
            f"unknown fitMode {fit_mode!r}", details={"supported": list(FIT_MODES)}
        )
    resample = str(job.param("resample", "lanczos"))
    if resample != "lanczos":
        raise UnsupportedParameterError(
            f"resize resample must be lanczos, got {resample!r}",
            details={"resample": resample},
        )

    warnings = _px_consistency_warnings(
        target_width_cm, target_height_cm, target_width_px, target_height_px, dpi
    )
    if job.param_bool("rasterizeFromVector", False):
        raise UnsupportedParameterError(
            "resizing directly from SVG artifacts is no longer supported",
            details={"parameter": "rasterizeFromVector"},
        )
    output_relative = job.require_output_path()

    source = scope.open_input()
    warnings = list(source.warnings) + warnings
    reference = source.image

    image = source.image
    width, height = _target_size(
        fit_mode, image.width, image.height, target_width_px, target_height_px
    )
    if fit_mode == "contain" and image.mode != "RGBA":
        warnings.append(
            make_warning(
                "contain-padding-alpha",
                "info",
                "Contain fit needs transparent padding, so the output is widened "
                "to RGBA.",
                details={"fromMode": image.mode, "toMode": "RGBA"},
            )
        )
        image = image.convert("RGBA")
    # Exactly one resample; centring afterwards never touches pixels.
    resized = image.resize((width, height), Image.Resampling.LANCZOS)
    engine = ENGINE_NAME
    canvas = (
        _center(resized, target_width_px, target_height_px)
        if fit_mode == "contain"
        else resized
    )

    if fit_mode == "contain":
        canvas = canvas.convert("RGBA")
    save_warnings = scope.save_image_with_dpi(output_relative, canvas, dpi)
    warnings.extend(save_warnings)

    # DPI honesty is about the source: how much real detail exists at the target size.
    source_dpi = effective_dpi_at_target(
        reference.width, reference.height, target_width_cm, target_height_cm
    )
    warnings.extend(dpi_warnings(source_dpi, settings))

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "metadata": build_metadata(
            canvas,
            duration_ms=0,
            engine=engine,
            model=fit_mode,
            effective_dpi=source_dpi,
            warnings=warnings,
            has_alpha=image_has_alpha(canvas),
        ),
    }


def _center(image: Image.Image, width: int, height: int) -> Image.Image:
    """Centre ``image`` on an exactly ``width x height`` transparent canvas."""

    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    offset = (max((width - image.width) // 2, 0), max((height - image.height) // 2, 0))
    canvas.paste(image, offset, image)
    return canvas
