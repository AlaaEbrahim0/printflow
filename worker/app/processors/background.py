"""background-removal: non-destructive mask, three modes, brush edits.

The mask is the product. Modes never touch the source file: they produce an
8-bit grayscale mask at ``outputArtifacts.mask`` (255 = visible), and the stored
image is ``source alpha x mask / 255``. Brush operations live in the job
parameters and are applied to the mask in source pixel coordinates, so an
"undo by restore" is just another mask write.

``color-to-alpha`` implements the **unmultiplied** formulation (the one GIMP
uses), so gradients keep their hue instead of picking up a dark or white
fringe. Per channel the maximum transparency the key can explain is

    x > key : contribution = (x - key) / (255 - key)
    x < key : contribution = (key - x) / key
    x == key: contribution = 0            # the channel is pure key

and the pixel's opacity is the *largest* of those contributions — a pixel equal
to the key in every channel is fully transparent, one channel far from the key
is enough to keep it opaque. The colour is then un-multiplied back over the
key:

    colour = key + (pixel - key) / opacity        (clipped to 0..255)

``tolerance`` expands the key: anything whose contribution is at or below
``tolerance / 255`` becomes fully transparent and the remaining ramp is rescaled
so genuinely opaque artwork still lands on 255. ``edgeSoftness`` is a feather
radius in pixels applied to the *mode's* mask before it is combined with a
loaded prior mask and the brush strokes, so the operator's brush edges stay
crisp while a keyed edge is softened.
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from app.analysis import to_arrays
from app.context import JobScope
from app.errors import (
    EngineOutputInvalidError,
    MaskMismatchError,
    UnsupportedParameterError,
)
from app.imaging import build_metadata, image_has_alpha, make_warning, to_rgba
from app.job_models import WorkerJob

ENGINE_BY_MODE = {
    "color-to-alpha": ("color-to-alpha", "unmultiplied-key-color"),
    "ai": ("rembg", None),
    "none": ("passthrough", None),
}
_HEX_PATTERN = re.compile(r"^#[0-9A-Fa-f]{6}$")
_EPSILON = 1.0 / 1024.0


def parse_hex(value: str) -> np.ndarray:
    if not _HEX_PATTERN.match(value or ""):
        raise UnsupportedParameterError(
            f"keyColor {value!r} is not a #rrggbb colour", details={"keyColor": value}
        )
    return np.array(
        [int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)], dtype=np.float64
    )


def unmultiplied_color_to_alpha(
    rgb: np.ndarray, key: np.ndarray, tolerance: int
) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(alpha uint8, rgb uint8)`` for the GIMP-style key removal.

    ``rgb`` is a uint8 array shaped (H, W, 3); ``key`` is the 3-vector key colour.
    Pixels that land on alpha 0 keep their **original** colour in the output:
    the operator may brush them back to visible later, and restoring must reveal
    the artwork, not a key-colour placeholder.
    """

    work = rgb.astype(np.float64)
    broadcast_key = key.reshape((1, 1, 3))

    contribution = np.zeros_like(work)
    above = work > broadcast_key
    below = work < broadcast_key

    # x > key: how far above the key, relative to the headroom up to white.
    above_denominator = np.maximum(255.0 - broadcast_key, _EPSILON)
    np.divide(work - broadcast_key, above_denominator, out=contribution, where=above)
    # x < key: how far below the key, relative to the headroom down to black.
    below_denominator = np.maximum(broadcast_key, _EPSILON)
    np.divide(
        broadcast_key - work,
        below_denominator,
        out=contribution,
        where=below,
    )

    opacity = contribution.max(axis=2)

    # Tolerance widens the key match and rescales the rest of the ramp.
    share = max(min(float(tolerance) / 255.0, 1.0 - _EPSILON), 0.0)
    if share > 0.0:
        opacity = np.clip((opacity - share) / (1.0 - share), 0.0, 1.0)

    visible = opacity > _EPSILON
    safe_opacity = np.where(visible, opacity, 1.0)
    colours = broadcast_key + (work - broadcast_key) / safe_opacity[..., None]
    colours = np.where(visible[..., None], colours, work)
    colours = np.clip(np.rint(colours), 0, 255).astype(np.uint8)
    alpha = np.clip(np.rint(opacity * 255.0), 0, 255).astype(np.uint8)
    return alpha, colours


def apply_brush_ops(mask: Image.Image, brush_ops: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Paint circular erase/restore strokes onto the ``L`` mask, in source pixels."""

    warnings: list[dict[str, Any]] = []
    if not brush_ops:
        return warnings
    draw = ImageDraw.Draw(mask)
    width, height = mask.size
    for index, operation in enumerate(brush_ops):
        tool = operation.get("tool")
        if tool not in ("erase", "restore"):
            raise UnsupportedParameterError(
                f"brushOps[{index}].tool must be erase or restore",
                details={"tool": tool},
            )
        radius = int(operation["radiusPx"])
        value = 0 if tool == "erase" else 255
        off_canvas = 0
        for point in operation.get("points", []):
            x, y = int(point[0]), int(point[1])
            if x + radius < 0 or y + radius < 0 or x - radius > width or y - radius > height:
                off_canvas += 1
                continue
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=value)
        if off_canvas:
            warnings.append(
                make_warning(
                    "brush-op-off-canvas",
                    "info",
                    f"{off_canvas} point(s) of brush operation {index} ({tool}) fall "
                    "outside the canvas and were skipped.",
                    details={"index": index, "tool": tool, "skippedPoints": off_canvas},
                )
            )
    return warnings


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "background-removal":
        raise UnsupportedParameterError(
            "background-removal processor cannot run this job",
            details={"jobType": job.type},
        )

    settings = scope.settings
    mode = job.param("mode")
    if mode not in ENGINE_BY_MODE:
        raise UnsupportedParameterError(
            f"unknown background-removal mode {mode!r}",
            details={"supported": sorted(ENGINE_BY_MODE)},
        )

    source = scope.open_input()
    warnings: list[dict[str, Any]] = list(source.warnings)
    image = to_rgba(source.image)
    arrays = to_arrays(image)

    tolerance = job.param_int("tolerance", settings.background_tolerance)
    edge_softness = job.param_float("edgeSoftness", settings.background_edge_softness)

    body = arrays.rgb.copy()
    if mode == "color-to-alpha":
        key = parse_hex(str(job.param("keyColor") or ""))
        mode_mask, body = unmultiplied_color_to_alpha(arrays.rgb, key, tolerance)
    elif mode == "ai":
        cutout = scope.engines.ai_cutout.cutout(image, model=job.param("aiModel"))
        cutout_arrays = to_arrays(cutout)
        if cutout_arrays.alpha.shape != arrays.alpha.shape:
            raise EngineOutputInvalidError(
                f"the AI cutout returned {cutout_arrays.width}x{cutout_arrays.height} "
                f"for a {arrays.width}x{arrays.height} source",
                details={
                    "cutoutWidthPx": cutout_arrays.width,
                    "cutoutHeightPx": cutout_arrays.height,
                    "sourceWidthPx": arrays.width,
                    "sourceHeightPx": arrays.height,
                },
                engine=ENGINE_BY_MODE["ai"][0],
            )
        mode_mask = cutout_arrays.alpha
        body = cutout_arrays.rgb.copy()
    else:  # none
        mode_mask = np.full(arrays.alpha.shape, 255, dtype=np.uint8)

    if edge_softness > 0.0:
        softened = Image.fromarray(mode_mask, "L").filter(
            ImageFilter.GaussianBlur(radius=edge_softness)
        )
        mode_mask = np.asarray(softened, dtype=np.uint8)
        warnings.append(
            make_warning(
                "mask-edge-softened",
                "info",
                f"Key edge feathered with a {edge_softness:g}px blur before masks and "
                "brush strokes were combined.",
                details={"edgeSoftness": edge_softness},
            )
        )

    mask_array = mode_mask
    if job.param("maskFromVersionId") is not None:
        prior_relative = scope.require_input_artifact(
            "mask", why="reuse the mask of the earlier proposed version"
        )
        prior = np.asarray(scope.open(prior_relative).convert("L"), dtype=np.uint8)
        if prior.shape != mask_array.shape:
            raise MaskMismatchError(
                f"prior mask is {prior.shape[1]}x{prior.shape[0]} but the source is "
                f"{arrays.width}x{arrays.height}",
                details={
                    "maskWidthPx": prior.shape[1],
                    "maskHeightPx": prior.shape[0],
                    "sourceWidthPx": arrays.width,
                    "sourceHeightPx": arrays.height,
                },
            )
        # Combine conservatively: a pixel is visible only if both layers say so.
        mask_array = np.minimum(mask_array, prior)

    mask_image = Image.fromarray(mask_array, "L")
    warnings.extend(apply_brush_ops(mask_image, list(job.parameters.get("brushOps") or [])))

    multiplied = (
        arrays.alpha.astype(np.uint16) * np.asarray(mask_image, dtype=np.uint16) + 127
    ) // 255
    final_alpha = np.clip(multiplied, 0, 255).astype(np.uint8)

    if mode == "none" and bool(np.all(mask_array == 255)):
        # An untouched mask means nothing was removed: keep the source pixels and
        # colour mode exactly as they are.
        output_image = source.image
    else:
        output_image = Image.fromarray(body, "RGB").convert("RGBA")
        output_image.putalpha(Image.fromarray(final_alpha, "L"))

    output_relative = job.require_output_path()
    mask_relative = job.artifact_output("mask")
    if not mask_relative:
        raise UnsupportedParameterError(
            "background-removal requires outputArtifacts.mask; the non-destructive "
            "mask is the reviewable artifact"
        )

    warnings.extend(scope.save_image(mask_relative, mask_image))
    warnings.extend(scope.save_image(output_relative, output_image))

    engine, model = ENGINE_BY_MODE[mode]
    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "outputPath": output_relative,
        "outputArtifacts": {"mask": mask_relative},
        "metadata": build_metadata(
            output_image,
            duration_ms=0,
            engine=engine,
            model=model or job.param("aiModel"),
            warnings=warnings,
            has_alpha=image_has_alpha(output_image),
        ),
    }
