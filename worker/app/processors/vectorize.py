"""vectorize: trace flat artwork to SVG and render an honest raster preview.

Two engines, chosen by the job:

* **potrace** (binary) — bitmap tracer. The design is composited over the
  garment colour, reduced to grayscale, and potrace thresholds it with
  ``--blacklevel = threshold / 255``. On a dark garment the light artwork
  becomes the ink via ``--invert``. potrace has no PNG backend, so the preview
  comes from its antialiased PGM backend and is painted into RGBA here.
  *Colour tracing is not available in the potrace CLI* and fails with
  ``engine-mode-unsupported`` rather than pretending.
* **vtracer** (optional Python dependency) — colour-capable. Its SVG is then
  rasterized through the :mod:`app.engines.raster` boundary.

The SVG is the deliverable (the final resize can rasterize it at print
resolution); the raster at ``outputPath`` is only a preview for the review UI.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image

from app.context import JobScope
from app.engines.raster import unavailable
from app.errors import (
    EngineModeUnsupportedError,
    EngineOutputInvalidError,
    UnsupportedParameterError,
)
from app.imaging import (
    build_metadata,
    dpi_warnings,
    effective_dpi_at_target,
    make_warning,
    round_half_away_from_zero,
    scale_to_fit,
    to_rgba,
)
from app.job_models import WorkerJob
from app.processors.background import parse_hex

POTRACE_ENGINE = "potrace"
VTRACER_ENGINE = "vtracer"
BLACK_INK = (0, 0, 0)
WHITE_INK = (255, 255, 255)
_GARMENT_DEFAULT_HEX = {"light": "#FFFFFF", "dark": "#000000"}


def garment_background(job: WorkerJob) -> tuple[str, bool]:
    """(hex, invert) — the colour the design will be printed on, and whether the
    artwork is lighter than it."""

    garment = job.context.garment_color or {}
    kind = garment.get("kind", "light")
    hex_value = garment.get("hex") or _GARMENT_DEFAULT_HEX.get(kind, "#FFFFFF")
    key = parse_hex(hex_value)
    luminance = float(0.299 * key[0] + 0.587 * key[1] + 0.114 * key[2])
    return hex_value, luminance < 128.0


def composite_over_background(image: Image.Image, hex_value: str) -> Image.Image:
    """Flatten RGBA onto the garment colour — the view the tracer must threshold."""

    background = parse_hex(hex_value).astype(np.uint8)
    rgba = to_rgba(image)
    base = Image.fromarray(np.tile(background, (rgba.height, rgba.width, 1)), "RGB")
    base.putalpha(255)
    return Image.alpha_composite(base.convert("RGBA"), rgba).convert("RGB")


def _pgm_to_preview(
    pgm_path, box: tuple[int, int], ink: tuple[int, int, int]
) -> Image.Image:
    """potrace's antialiased PGM: black ink on white paper → RGBA with alpha."""

    try:
        with Image.open(pgm_path) as opened:
            greyscale = opened.convert("L")
    except OSError as exc:
        raise EngineOutputInvalidError(
            f"potrace preview could not be decoded: {exc}",
            details={"engine": POTRACE_ENGINE},
            engine=POTRACE_ENGINE,
        ) from exc
    values = np.asarray(greyscale, dtype=np.uint8)
    alpha = np.clip(255 - values.astype(np.int16), 0, 255).astype(np.uint8)
    ink_layer = np.zeros((alpha.shape[0], alpha.shape[1], 3), dtype=np.uint8)
    ink_layer[..., 0] = ink[0]
    ink_layer[..., 1] = ink[1]
    ink_layer[..., 2] = ink[2]
    traced = Image.fromarray(np.dstack((ink_layer, alpha)), "RGBA")
    return pad_to_box(traced, box)


def pad_to_box(image: Image.Image, box: tuple[int, int]) -> Image.Image:
    """Centre ``image`` in an RGBA ``box`` canvas with transparent padding."""

    width, height = box
    if (image.width, image.height) == (width, height):
        return image.convert("RGBA")
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    offset = ((width - image.width) // 2, (height - image.height) // 2)
    canvas.paste(image.convert("RGBA"), offset, image.convert("RGBA"))
    return canvas


def _preview_boxes(
    job: WorkerJob, source: Image.Image
) -> tuple[tuple[int, int], tuple[int, int], bool]:
    """(traced size, canvas size, whether a target box was given).

    The trace is rendered at the largest aspect-correct size that fits the target
    box, then centred on a canvas of exactly that box — the same contain semantics
    the final resize applies, so the preview and the print occupy the same area.
    """

    width = job.param("targetWidthPx")
    height = job.param("targetHeightPx")
    if width and height:
        fit = scale_to_fit(source.width, source.height, int(width), int(height))
        return fit, (int(width), int(height)), True
    if width:
        derived = max(1, round_half_away_from_zero(source.height * int(width) / source.width))
        return (int(width), derived), (int(width), derived), False
    if height:
        derived = max(1, round_half_away_from_zero(source.width * int(height) / source.height))
        return (derived, int(height)), (derived, int(height)), False
    return (source.width, source.height), (source.width, source.height), False


def _assert_svg(path, engine: str) -> None:
    if not path.is_file() or path.stat().st_size == 0:
        raise EngineOutputInvalidError(
            f"{engine} produced an empty SVG artifact",
            details={"engine": engine},
            engine=engine,
        )
    head = path.read_bytes()[:2048]
    if b"<svg" not in head and b"<?xml" not in head:
        raise EngineOutputInvalidError(
            f"{engine} output is not an SVG document",
            details={"engine": engine},
            engine=engine,
        )


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "vectorize":
        raise UnsupportedParameterError(
            "vectorize processor cannot run this job", details={"jobType": job.type}
        )

    settings = scope.settings
    engine_name = str(job.param("engine", ""))
    if engine_name not in (POTRACE_ENGINE, VTRACER_ENGINE):
        raise UnsupportedParameterError(
            f"unknown vectorize engine {engine_name!r}",
            details={"supported": [POTRACE_ENGINE, VTRACER_ENGINE]},
        )
    mode = str(job.param("mode", "binary"))
    if mode not in ("binary", "color"):
        raise UnsupportedParameterError(
            f"unknown vectorize mode {mode!r}", details={"supported": ["binary", "color"]}
        )

    threshold = job.param_int("threshold", settings.vectorize_threshold)
    color_count = job.param_int("colorCount", settings.vectorize_color_count)
    turdsize = job.param_int("turdsize", settings.vectorize_turdsize)

    source = scope.open_input()
    warnings: list[dict[str, Any]] = list(source.warnings)
    image = source.image
    svg_relative = job.artifact_output("svg")
    if not svg_relative:
        raise UnsupportedParameterError("vectorize requires outputArtifacts.svg")
    output_relative = job.require_output_path()

    hex_value, invert = garment_background(job)
    flattened = composite_over_background(image, hex_value)
    fit_box, canvas_box, fitted = _preview_boxes(job, image)
    if fitted:
        warnings.append(
            make_warning(
                "vector-preview-contained",
                "info",
                "Preview rasterized at the traced aspect and centred on the target "
                "box with transparent padding, exactly like a contain resize.",
                details={
                    "tracedWidthPx": fit_box[0],
                    "tracedHeightPx": fit_box[1],
                    "canvasWidthPx": canvas_box[0],
                    "canvasHeightPx": canvas_box[1],
                },
            )
        )

    svg_scratch = scope.scratch(f"{job.job_id}-vector.svg")

    if engine_name == POTRACE_ENGINE:
        if mode == "color":
            raise EngineModeUnsupportedError(
                "the potrace CLI traces bitmaps only; choose the vtracer engine for "
                "a colour vectorization",
                details={"engine": POTRACE_ENGINE, "mode": mode, "suggest": VTRACER_ENGINE},
                engine=POTRACE_ENGINE,
            )
        greyscale = flattened.convert("L")
        pgm_scratch = scope.scratch(f"{job.job_id}-trace-input.pgm")
        # Pillow's PPM plugin writes binary P5 (PGM) for mode "L".
        greyscale.save(pgm_scratch.absolute, format="PPM")
        scope.engines.potrace.trace_to_svg(
            input_path=pgm_scratch.absolute,
            output_path=svg_scratch.absolute,
            blacklevel=threshold / 255.0,
            turdsize=turdsize,
            dpi=job.context.working_dpi,
            invert=invert,
        )
        _assert_svg(svg_scratch.absolute, POTRACE_ENGINE)
        scale = fit_box[0] / max(image.width, 1)
        preview_scratch = scope.scratch(f"{job.job_id}-preview.pgm")
        scope.engines.potrace.trace_to_pgm(
            input_path=pgm_scratch.absolute,
            output_path=preview_scratch.absolute,
            blacklevel=threshold / 255.0,
            turdsize=turdsize,
            scale=scale,
            invert=invert,
        )
        traced = _pgm_to_preview(
            preview_scratch.absolute, fit_box, WHITE_INK if invert else BLACK_INK
        )
        preview = pad_to_box(traced, canvas_box)
    else:
        png_scratch = scope.scratch(f"{job.job_id}-trace-input.png")
        if mode == "binary":
            # vtracer has no blacklevel: threshold the same way potrace would.
            binary = flattened.convert("L").point(
                lambda value: 0 if value < threshold else 255, mode="L"
            )
            binary.convert("RGB").save(png_scratch.absolute, format="PNG")
        else:
            flattened.save(png_scratch.absolute, format="PNG")
        warnings.extend(
            scope.engines.vtracer.trace_to_svg(
                input_path=png_scratch.absolute,
                output_path=svg_scratch.absolute,
                mode=mode,
                color_count=color_count,
                turdsize=turdsize,
            )
        )
        _assert_svg(svg_scratch.absolute, VTRACER_ENGINE)
        rasterizer = scope.engines.resolve_rasterizer(settings)
        if rasterizer is None:
            raise unavailable(VTRACER_ENGINE)
        raster_scratch = scope.scratch(f"{job.job_id}-preview.png")
        rasterizer.rasterize(
            svg_path=svg_scratch.absolute,
            output_path=raster_scratch.absolute,
            width_px=fit_box[0],
            height_px=fit_box[1],
        )
        with Image.open(raster_scratch.absolute) as opened:
            traced = opened.convert("RGBA")
        preview = pad_to_box(traced, canvas_box)

    scope.storage.promote(svg_scratch.relative, svg_relative, scope.protected)
    warnings.extend(scope.save_image(output_relative, preview))

    effective_dpi = effective_dpi_at_target(
        preview.width, preview.height, job.context.target_width_cm, job.context.target_height_cm
    )
    warnings.extend(dpi_warnings(effective_dpi, settings))

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "outputArtifacts": {"svg": svg_relative},
        "metadata": build_metadata(
            preview,
            duration_ms=0,
            engine=engine_name,
            model=mode,
            effective_dpi=effective_dpi,
            warnings=warnings,
            has_alpha=True,
        ),
    }
