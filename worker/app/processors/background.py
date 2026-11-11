"""background-removal: non-destructive mask, two modes, brush edits, mask shaping.

The mask is the product. Modes never touch the source file: they produce an 8-bit
grayscale mask at ``outputArtifacts.mask`` (255 = visible), and the stored image is
``source alpha x mask / 255``. Brush operations live in the job parameters and are
applied to the mask in source pixel coordinates, so an "undo by restore" is just
another mask write -- no history, no drift.

Modes
-----
``color-to-alpha``
    The **unmultiplied** formulation (the one GIMP uses), so gradients keep their
    hue instead of picking up a dark or white fringe. Per channel the maximum
    transparency the key can explain is

        x > key : contribution = (x - key) / (255 - key)
        x < key : contribution = (key - x) / key
        x == key: contribution = 0            # the channel is pure key

    and the pixel's opacity is the *largest* of those contributions -- a pixel
    equal to the key in every channel is fully transparent, one channel far from
    the key is enough to keep it opaque. The colour is then un-multiplied back over
    the key:

        colour = key + (pixel - key) / opacity        (clipped to 0..255)

    ``tolerance`` expands the key: anything whose contribution is at or below
    ``tolerance / 255`` becomes fully transparent and the rest is rescaled.
``none``
    No automatic mask. Used to re-apply brush strokes and mask shaping to an
    earlier mask (``maskFromVersionId``) without re-running a key.

``ai`` (BiRefNet) is **archived**. It is still a legal schema value so historical
job records stay readable, but this worker refuses it with a stable
``unsupported-parameters`` failure instead of loading a model. See
``archive/birefnet/README.md``.

Order of operations
-------------------
The mask is built in one documented pass so a proposal is reproducible:

1. the mode mask (colour key, reused mask, or full);
2. combined with a reused mask using ``min`` -- conservative, a pixel is visible
   only when both layers say so;
3. brush strokes, in source pixels;
4. grow/contract (``maskGrowPx``), a true circular offset of the selection edge;
5. feather (``edgeSoftness``), a Gaussian on the alpha ramp;
6. mask levels (``maskLevels``), a Photoshop-style ramp remap.

The image gets its own, independent levels adjustment (``imageLevels``) before the
mask is multiplied into its alpha, so tone and selection can be judged separately.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from PIL import Image, ImageDraw

from app.analysis import to_arrays
from app.context import JobScope
from app.errors import (
    MaskMismatchError,
    UnsupportedParameterError,
)
from app.imaging import build_metadata, image_has_alpha, make_warning, to_rgba
from app.job_models import WorkerJob
from app.mask_ops import apply_levels, feather_mask, grow_mask, levels_is_identity

MODES = ("color-to-alpha", "none")

# Retained so a historical ``ai`` job fails with a precise, actionable message
# rather than a generic enum error.
_ARCHIVED_MODES = ("ai",)

# Which engine/model a mode reports in result metadata.
ENGINE_BY_MODE = {
    "color-to-alpha": ("color-to-alpha", "unmultiplied"),
    "none": ("none", None),
}

_EPSILON = 1e-6

def parse_hex(value: str) -> np.ndarray:
    """``#rgb`` or ``#rrggbb`` to an ``(3,)`` uint8 array."""

    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise UnsupportedParameterError(
            f"keyColor {value!r} is not a 3 or 6 digit hex colour",
            details={"keyColor": value},
        )
    try:
        return np.array([int(text[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.uint8)
    except ValueError as exc:
        raise UnsupportedParameterError(
            f"keyColor {value!r} is not a valid hex colour",
            details={"keyColor": value},
        ) from exc

def unmultiplied_color_to_alpha(
    rgb: np.ndarray, key: np.ndarray, tolerance: int
) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(alpha, decontaminated_rgb)`` for the unmultiplied key formulation."""

    work = rgb.astype(np.float32)
    broadcast_key = key.astype(np.float32).reshape(1, 1, 3)
    contribution = np.zeros_like(work)

    above = work >= broadcast_key
    below = ~above

    # x > key: headroom up to 255. x < key: headroom down to 0.
    np.divide(
        work - broadcast_key,
        np.maximum(255.0 - broadcast_key, _EPSILON),
        out=contribution,
        where=above,
    )
    np.divide(
        broadcast_key - work,
        np.maximum(broadcast_key, _EPSILON),
        out=contribution,
        where=below,
    )

    opacity = contribution.max(axis=2)

    # Tolerance widens the key match and rescales the rest of the ramp.
    share = max(min(float(tolerance) / 255.0, 1.0 - _EPSILON), 0.0)
    if share > 0.0:
        opacity = np.clip((opacity - share) / (1.0 - share), 0.0, 1.0)

    visible = opacity > _EPSILON
    safe = np.where(visible, opacity, 1.0)
    colours = broadcast_key + (work - broadcast_key) / safe[..., None]
    colours = np.where(visible[..., None], colours, work)
    colours = np.clip(np.rint(colours), 0, 255).astype(np.uint8)
    alpha = np.clip(np.rint(opacity * 255.0), 0, 255).astype(np.uint8)
    return alpha, colours

def apply_brush_ops(mask: Image.Image, brush_ops: list[dict[str, Any]]) -> list[dict]:
    """Paint circular erase/restore strokes onto the ``L`` mask, in source pixels."""

    warnings: list[dict] = []
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

def _levels_parameter(job: WorkerJob, name: str) -> dict[str, Any] | None:
    value = job.param(name)
    if value is None:
        return None
    if not isinstance(value, dict):
        raise UnsupportedParameterError(
            f"{name} must be an object with blackPoint, whitePoint, gamma, "
            "outputBlack and outputWhite",
            details={name: type(value).__name__},
        )
    return value

def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    if job.type != "background-removal":
        raise UnsupportedParameterError(
            "background-removal processor cannot run this job",
            details={"jobType": job.type},
        )

    settings = scope.settings
    mode = job.param("mode")
    if mode in _ARCHIVED_MODES:
        raise UnsupportedParameterError(
            "the BiRefNet AI cutout is archived and cannot run; use color-to-alpha, "
            "or cut the artwork out in Photoshop and import the PNG as ready-to-pack",
            details={
                "mode": mode,
                "supported": list(MODES),
                "archived": list(_ARCHIVED_MODES),
            },
        )
    if mode not in MODES:
        raise UnsupportedParameterError(
            f"unknown background-removal mode {mode!r}",
            details={"supported": sorted(MODES), "archived": list(_ARCHIVED_MODES)},
        )

    source = scope.open_input()
    warnings: list[dict] = list(source.warnings)
    image = to_rgba(source.image)
    arrays = to_arrays(image)

    tolerance = job.param_int("tolerance", settings.background_match_tolerance)
    edge_softness = job.param_float("edgeSoftness", 0.0)
    grow_px = job.param_float("maskGrowPx", 0.0)
    mask_levels = _levels_parameter(job, "maskLevels")
    image_levels = _levels_parameter(job, "imageLevels")

    body = arrays.rgb.copy()
    if mode == "color-to-alpha":
        key = parse_hex(str(job.param("keyColor") or ""))
        mode_mask, body = unmultiplied_color_to_alpha(arrays.rgb, key, tolerance)
    else:  # none
        mode_mask = np.full(arrays.alpha.shape, 255, dtype=np.uint8)

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

    # --- selection shaping ---------------------------------------------------
    # Grow/contract runs on the painted mask so a brush correction is included in
    # the offset, then the edge is feathered and finally the ramp is remapped.
    if abs(grow_px) >= 0.05:
        mask_array = grow_mask(np.asarray(mask_image, dtype=np.uint8), grow_px)
        mask_image = Image.fromarray(mask_array, "L")
        warnings.append(
            make_warning(
                "mask-selection-offset",
                "info",
                f"The selection edge was moved {abs(grow_px):g}px "
                f"{'outward' if grow_px > 0 else 'inward'}.",
                details={"maskGrowPx": grow_px},
            )
        )

    if edge_softness > 0.0:
        mask_array = feather_mask(np.asarray(mask_image, dtype=np.uint8), edge_softness)
        mask_image = Image.fromarray(mask_array, "L")
        warnings.append(
            make_warning(
                "mask-edge-softened",
                "info",
                f"Key edge feathered with a {edge_softness:g}px blur after the "
                "selection and brush strokes were combined.",
                details={"edgeSoftness": edge_softness},
            )
        )

    if not levels_is_identity(mask_levels):
        mask_array = apply_levels(np.asarray(mask_image, dtype=np.uint8), mask_levels)
        mask_image = Image.fromarray(mask_array, "L")
        warnings.append(
            make_warning(
                "mask-levels-applied",
                "info",
                "The mask alpha ramp was remapped by a levels adjustment.",
                details=dict(mask_levels or {}),
            )
        )

    # --- image tone ----------------------------------------------------------
    if not levels_is_identity(image_levels):
        body = apply_levels(body, image_levels)
        warnings.append(
            make_warning(
                "image-levels-applied",
                "info",
                "The cut-out colours were remapped by a levels adjustment.",
                details=dict(image_levels or {}),
            )
        )

    multiplied = (
        arrays.alpha.astype(np.uint16) * np.asarray(mask_image, dtype=np.uint16) + 127
    ) // 255
    final_alpha = np.clip(multiplied, 0, 255).astype(np.uint8)

    if (
        mode == "none"
        and bool(np.all(np.asarray(mask_image) == 255))
        and levels_is_identity(image_levels)
    ):
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
            model=model,
            warnings=warnings,
            has_alpha=image_has_alpha(output_image),
        ),
    }
