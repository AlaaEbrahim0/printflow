"""classify: measure the frozen features and propose the next steps.

Nothing here decides for the operator — the contract calls them *suggestions*
and the UI can override every one. The rules that matter are documented inline:

* ``fullBleed == True`` **always** means ``trim.recommended == False`` (product
  rule 12: never silently cut a design that runs off all four edges);
* background removal prefers key-colour to alpha when the border really is one
  flat colour, and only then proposes the AI cutout;
* the upscale model follows the content (flat illustration vs. photo) and the
  scale follows the effective DPI at the declared target;
* vectorization is proposed for flat, low-colour-count artwork only.
"""

from __future__ import annotations

from typing import Any

from app.analysis import (
    TRANSPARENT,
    background_matches,
    content_bbox,
    edge_margin_ratios,
    feature_report,
    is_full_bleed,
    sample_background,
    to_arrays,
)
from app.config import Settings
from app.context import JobScope
from app.errors import UnsupportedParameterError
from app.imaging import build_metadata, dpi_warnings, effective_dpi_at_target
from app.job_models import WorkerJob

ENGINE_NAME = "heuristic-v1"


def _target_centimeters(job: WorkerJob) -> tuple[float | None, float | None]:
    """Job parameters win over the context snapshot; both are optional."""

    parameters = job.parameters
    width = parameters.get("targetWidthCm")
    if width is None:
        width = job.context.target_width_cm
    height = parameters.get("targetHeightCm")
    if height is None:
        height = job.context.target_height_cm
    return (width, height)


def _trim_suggestion(
    *,
    full_bleed: bool,
    ratios: dict[str, float],
    box: tuple[int, int, int, int] | None,
    covers_canvas: bool,
    background_kind: str,
    confidence: float,
    settings: Settings,
) -> dict[str, Any]:
    suggestion: dict[str, Any] = {
        "recommended": False,
        "reason": "",
        "paddingPx": settings.trim_padding_px,
        "tolerance": settings.trim_tolerance,
    }
    if box is None:
        suggestion["reason"] = (
            "No pixels distinguishable from the sampled background; there is nothing "
            "to trim."
        )
        return suggestion
    suggestion["box"] = {
        "x": box[0],
        "y": box[1],
        "width": box[2],
        "height": box[3],
    }
    if full_bleed:
        suggestion["reason"] = (
            "Artwork reaches all four edges (full bleed). Auto-trim would cut "
            "content, so only the manual crop tool is offered."
        )
        return suggestion
    if covers_canvas:
        suggestion["reason"] = (
            f"Content already fills the canvas once {settings.trim_padding_px}px of "
            "padding is kept; trimming would remove artwork."
        )
        return suggestion
    widest = max(ratios, key=lambda name: ratios[name])
    suggestion["recommended"] = True
    suggestion["reason"] = (
        f"{background_kind} background covers {ratios[widest]:.0%} of the {widest} "
        f"border strip (confidence {confidence:.2f}); cropping to the content box "
        f"plus {settings.trim_padding_px}px padding removes dead margin only."
    )
    return suggestion


def _background_removal_suggestion(
    *, sample, settings: Settings
) -> dict[str, Any]:
    key_hex = sample.key_hex()
    if sample.kind == TRANSPARENT:
        return {
            "mode": "none",
            "reason": (
                "The source already carries an alpha channel; there is no flat "
                "background colour to key out."
            ),
            "confidence": round(min(1.0, sample.confidence), 4),
        }
    if sample.confidence >= 0.8 and key_hex:
        return {
            "mode": "color-to-alpha",
            "keyColor": key_hex,
            "reason": (
                f"The border is a near-uniform {sample.kind} ({key_hex}) covering "
                f"{sample.confidence:.0%} of the sampled strips; unmultiplied "
                "key-colour removal keeps gradient hues without a fringe."
            ),
            "confidence": round(min(1.0, sample.confidence), 4),
        }
    if sample.confidence >= 0.5 and key_hex:
        return {
            "mode": "color-to-alpha",
            "keyColor": key_hex,
            "reason": (
                f"The border is mostly {sample.kind} ({key_hex}) but not uniform "
                f"({sample.confidence:.0%}); check the preview for gradients the key "
                "may eat."
            ),
            "confidence": round(sample.confidence, 4),
        }
    return {
        "mode": "ai",
        "reason": (
            "The border is not a single flat colour, so key-colour removal would "
            "leave background behind; an AI cutout is the better starting point."
        ),
        "confidence": round(max(0.05, 1.0 - sample.confidence), 4),
    }


def _upscale_suggestion(
    *,
    effective_dpi: float | None,
    flat_color_ratio: float,
    unique_color_count: int,
    settings: Settings,
) -> dict[str, Any]:
    illustration = (
        unique_color_count <= settings.classify_unique_color_logo_max
        and flat_color_ratio >= 0.5
    )
    model = "realesrgan-x4plus-anime" if illustration else "realesrgan-x4plus"
    content_reason = (
        "flat colour with few distinct tones reads as illustration/line art"
        if illustration
        else "continuous-tone content reads as a photo"
    )
    if effective_dpi is None:
        return {
            "model": model,
            "scale": 2,
            "reason": (
                f"No target size is set yet, so the resolution need is unknown; "
                f"{content_reason}. Confirm the target before upscaling."
            ),
            "confidence": 0.35,
        }
    if effective_dpi < settings.dpi_strong_warn_below:
        return {
            "model": model,
            "scale": 4,
            "reason": (
                f"Source resolves to {effective_dpi:.0f} DPI at the target, below "
                f"{settings.dpi_strong_warn_below} DPI; 4x restores workable density "
                f"because {content_reason}."
            ),
            "confidence": 0.9,
        }
    if effective_dpi < settings.dpi_warn_below:
        return {
            "model": model,
            "scale": 2,
            "reason": (
                f"Source resolves to {effective_dpi:.0f} DPI at the target, below "
                f"{settings.dpi_warn_below} DPI; 2x is enough because {content_reason}."
            ),
            "confidence": 0.65,
        }
    return {
        "model": model,
        "scale": 2,
        "reason": (
            f"Source already resolves to {effective_dpi:.0f} DPI at the target; "
            f"upscaling is optional and only helps if you intend {content_reason} "
            "edge cleanup."
        ),
        "confidence": 0.15,
    }


def _vectorize_suggestion(
    *,
    flat_color_ratio: float,
    unique_color_count: int,
    edge_density: float,
    full_bleed: bool,
    settings: Settings,
) -> dict[str, Any]:
    flat_logo = (
        flat_color_ratio >= settings.classify_flat_logo_ratio
        and unique_color_count <= settings.classify_unique_color_logo_max
    )
    confidence = round(
        min(
            0.95,
            max(
                0.05,
                0.35 + 0.35 * flat_color_ratio + 0.15 * (1.0 - min(edge_density, 1.0)),
            ),
        ),
        4,
    )
    if flat_logo and not full_bleed:
        return {
            "recommended": True,
            "reason": (
                f"{flat_color_ratio:.0%} flat colour and only {unique_color_count} "
                "quantised tones: a trace will reproduce this cleanly and let the "
                "final resize rasterise at print resolution."
            ),
            "confidence": confidence,
        }
    if flat_logo and full_bleed:
        return {
            "recommended": False,
            "reason": (
                "The palette is flat enough to trace, but the artwork is full-bleed "
                "and the trace would fill the entire canvas; trim or crop first."
            ),
            "confidence": confidence,
        }
    if unique_color_count > settings.classify_unique_color_logo_max:
        return {
            "recommended": False,
            "reason": (
                f"{unique_color_count} distinct quantised colours and only "
                f"{flat_color_ratio:.0%} flat coverage: continuous tone. Tracing "
                "would posterise the design — upscale instead."
            ),
            "confidence": round(1.0 - confidence, 4) if confidence > 0.5 else confidence,
        }
    return {
        "recommended": False,
        "reason": (
            f"Edge density is {edge_density:.2f} against {flat_color_ratio:.0%} flat "
            "colour, so the artwork has detail a trace would lose."
        ),
        "confidence": confidence,
    }


def process(job: WorkerJob, scope: JobScope) -> dict[str, Any]:
    settings = scope.settings
    if job.type != "classify":
        raise UnsupportedParameterError(
            f"classify processor cannot run job type {job.type!r}",
            details={"jobType": job.type},
        )

    source = scope.open_input()
    image = source.image
    warnings: list[dict[str, Any]] = list(source.warnings)

    arrays = to_arrays(image)
    sample = sample_background(arrays, settings)
    background = background_matches(
        arrays,
        sample,
        tolerance=settings.trim_tolerance,
        alpha_threshold=settings.alpha_threshold,
    )
    ratios = edge_margin_ratios(arrays, background, settings)
    full_bleed = is_full_bleed(ratios, settings)
    features, feature_warnings = feature_report(image, arrays, sample, settings)
    features["fullBleed"] = full_bleed
    warnings.extend(feature_warnings)

    target_width_cm, target_height_cm = _target_centimeters(job)
    effective_dpi = effective_dpi_at_target(
        image.width, image.height, target_width_cm, target_height_cm
    )
    box = content_bbox(~background, padding_px=settings.trim_padding_px)
    covers_canvas = bool(box) and (
        box[0] == 0 and box[1] == 0 and box[2] >= image.width and box[3] >= image.height
    )
    if full_bleed:
        warnings.append(
            scope.warning(
                "full-bleed-detected",
                "info",
                "Artwork runs off all four edges; no auto-trim proposal is made.",
                edgeRatios={name: round(value, 4) for name, value in ratios.items()},
            )
        )
    warnings.extend(dpi_warnings(effective_dpi, settings))

    source_block: dict[str, Any] = {"widthPx": image.width, "heightPx": image.height}
    if effective_dpi is not None:
        source_block["effectiveDpiAtTarget"] = effective_dpi

    return {
        "schemaVersion": "1.0",
        "jobId": job.job_id,
        "status": "succeeded",
        "metadata": build_metadata(
            image,
            duration_ms=0,
            engine=ENGINE_NAME,
            effective_dpi=effective_dpi,
            warnings=warnings,
            has_alpha=source.has_alpha,
        ),
        "suggestions": {
            "source": source_block,
            "features": features,
            "suggestions": {
                "trim": _trim_suggestion(
                    full_bleed=full_bleed,
                    ratios=ratios,
                    box=box,
                    covers_canvas=covers_canvas,
                    background_kind=sample.kind,
                    confidence=sample.confidence,
                    settings=settings,
                ),
                "backgroundRemoval": _background_removal_suggestion(
                    sample=sample, settings=settings
                ),
                "upscale": _upscale_suggestion(
                    effective_dpi=effective_dpi,
                    flat_color_ratio=features["flatColorRatio"],
                    unique_color_count=features["uniqueColorCount"],
                    settings=settings,
                ),
                "vectorize": _vectorize_suggestion(
                    flat_color_ratio=features["flatColorRatio"],
                    unique_color_count=features["uniqueColorCount"],
                    edge_density=features["edgeDensity"],
                    full_bleed=full_bleed,
                    settings=settings,
                ),
            },
        },
    }
