"""Pixel, unit and colour-mode rules shared by all processors.

Everything that touches physical size goes through the single conversion frozen
in the domain model: ``pixels = roundHalfAwayFromZero(cm * dpi / 2.54)`` — the
same rule ``PrintUnits.PixelsForCentimeters`` implements in the API. 58 cm at
300 DPI is 6850 px, no local rounding anywhere else.

Colour handling follows the product rules: alpha is preserved, RGB stays RGB
unless the step creates transparency, and 16-bit or palette sources are widened
to 8-bit RGBA with an explicit warning (that conversion is lossy and the
operator must see it in the preview).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import Settings
from app.errors import (
    ImageDecodeError,
    InputTooLargeError,
    InputUnavailableError,
    OutputFormatError,
)
from app.storage import StorageRoot

CM_PER_INCH = 2.54

# Modes Pillow can carry through without a documented loss warning.
_PASSTHROUGH_MODES = frozenset({"1", "L", "LA", "RGB", "RGBA"})
_HIGH_BIT_MODES = frozenset({"I", "I;16", "I;16B", "I;16N", "F"})

_FORMAT_BY_SUFFIX = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".webp": "WEBP",
    ".bmp": "BMP",
}
_ALPHA_CAPABLE_FORMATS = frozenset({"PNG", "TIFF", "WEBP", "BMP"})


def round_half_away_from_zero(value: float) -> int:
    """Round 0.5 away from zero, matching the API's ``PrintUnits``."""

    if value >= 0:
        return int(math.floor(value + 0.5))
    return -int(math.floor(-value + 0.5))


def pixels_for_centimeters(centimeters: float, dpi: int) -> int:
    """The only allowed cm -> px conversion in this system."""

    if centimeters <= 0:
        raise ValueError("centimeters must be positive")
    return round_half_away_from_zero(centimeters * dpi / CM_PER_INCH)


def centimeters_for_pixels(pixels: int, dpi: int) -> float:
    return pixels * CM_PER_INCH / dpi


def effective_dpi_at_target(
    width_px: int,
    height_px: int,
    target_width_cm: float | None,
    target_height_cm: float | None,
) -> float | None:
    """``min(px / (cm / 2.54))`` over the axes that have a target size."""

    ratios = []
    for pixels, centimeters in ((width_px, target_width_cm), (height_px, target_height_cm)):
        if centimeters and centimeters > 0:
            ratios.append(pixels / (centimeters / CM_PER_INCH))
    if not ratios:
        return None
    return round(min(ratios), 6)


def scale_to_fit(source_w: int, source_h: int, box_w: int, box_h: int) -> tuple[int, int]:
    """Largest integer size inside ``box`` preserving the source aspect ratio."""

    if source_w <= 0 or source_h <= 0 or box_w <= 0 or box_h <= 0:
        return (max(box_w, 1), max(box_h, 1))
    factor = min(box_w / source_w, box_h / source_h)
    width = max(1, round_half_away_from_zero(source_w * factor))
    height = max(1, round_half_away_from_zero(source_h * factor))
    return (min(width, box_w), min(height, box_h))


def make_warning(
    code: str,
    severity: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    warning: dict[str, Any] = {"code": code, "severity": severity, "message": message}
    if details:
        warning["details"] = details
    return warning


def dpi_warnings(dpi: float | None, settings: Settings) -> list[dict[str, Any]]:
    """Configurable low-DPI guidance. Warnings never block the job."""

    if dpi is None:
        return []
    if dpi < settings.dpi_strong_warn_below:
        return [
            make_warning(
                "very-low-effective-dpi",
                "warning",
                (
                    f"Effective resolution is {dpi:.1f} DPI at the target size, below "
                    f"{settings.dpi_strong_warn_below} DPI; request a better source or "
                    "propose an upscale."
                ),
                details={"effectiveDpiAtTarget": dpi, "threshold": settings.dpi_strong_warn_below},
            )
        ]
    if dpi < settings.dpi_warn_below:
        return [
            make_warning(
                "low-effective-dpi",
                "warning",
                (
                    f"Effective resolution is {dpi:.1f} DPI at the target size, below "
                    f"{settings.dpi_warn_below} DPI."
                ),
                details={"effectiveDpiAtTarget": dpi, "threshold": settings.dpi_warn_below},
            )
        ]
    return []


def load_image(
    storage: StorageRoot,
    relative_path: str,
    settings: Settings,
) -> Image.Image:
    """Open a stored file *after* path validation, refusing absurd sizes."""

    path = storage.resolve(relative_path)
    if not path.is_file():
        raise InputUnavailableError(
            f"input file is missing: {relative_path}",
            details={"relativePath": relative_path},
        )
    try:
        with Image.open(path) as probe:
            width, height = probe.size
            if width * height > settings.max_input_pixels:
                raise InputTooLargeError(
                    f"input is {width}x{height} px, above the "
                    f"{settings.max_input_pixels} px budget",
                    details={
                        "widthPx": width,
                        "heightPx": height,
                        "maxInputPixels": settings.max_input_pixels,
                    },
                )
            probe.load()
            # Copy out of the lazily-read file handle so the input stays closed
            # and can never be written back.
            return probe.copy()
    except InputTooLargeError:
        raise
    except OSError as exc:
        raise ImageDecodeError(
            f"input could not be decoded: {relative_path}",
            details={"relativePath": relative_path, "reason": str(exc)},
        ) from exc


def normalize_source_mode(image: Image.Image) -> tuple[Image.Image, list[dict[str, Any]]]:
    """Widen odd source modes to 8-bit, warning where the step is lossy."""

    mode = image.mode
    if mode in _PASSTHROUGH_MODES:
        if mode == "1":
            return image.convert("L"), [
                make_warning(
                    "bitonal-converted",
                    "info",
                    "1-bit source expanded to 8-bit grayscale.",
                    details={"fromMode": "1", "toMode": "L"},
                )
            ]
        return image, []

    if mode in _HIGH_BIT_MODES:
        return image.convert("RGBA"), [
            make_warning(
                "bit-depth-converted",
                "warning",
                f"{mode} source converted to 8-bit RGBA; highlight and shadow "
                "gradations may clip.",
                details={"fromMode": mode, "toMode": "RGBA"},
            )
        ]

    if mode in ("P", "PA"):
        rgba = image.convert("RGBA")
        return rgba, [
            make_warning(
                "palette-converted",
                "warning",
                "Palette source expanded to 8-bit RGBA; the palette is baked into "
                "the pixels.",
                details={"fromMode": mode, "toMode": "RGBA"},
            )
        ]

    if mode == "CMYK":
        return image.convert("RGBA"), [
            make_warning(
                "color-mode-converted",
                "warning",
                "CMYK source converted to RGBA; colour management is not applied.",
                details={"fromMode": "CMYK", "toMode": "RGBA"},
            )
        ]

    return image.convert("RGBA"), [
        make_warning(
            "color-mode-converted",
            "warning",
            f"Unsupported source mode {mode} converted to RGBA.",
            details={"fromMode": mode, "toMode": "RGBA"},
        )
    ]


def image_has_alpha(image: Image.Image) -> bool:
    """True when the stored pixels carry per-pixel transparency."""

    if image.mode in ("LA", "RGBA"):
        return True
    return image.mode in ("P", "PA") and "transparency" in image.info


def to_rgba(image: Image.Image) -> Image.Image:
    if image.mode == "RGBA":
        return image
    return image.convert("RGBA")





def output_format_for(path: Path, image: Image.Image) -> str:
    """Honour the assigned file suffix, but never silently drop alpha."""

    suffix = path.suffix.lower()
    if suffix not in _FORMAT_BY_SUFFIX:
        raise OutputFormatError(
            f"unsupported output file extension {suffix!r}; the API assigns "
            "raster paths such as .png",
            details={"path": str(path), "supported": sorted(_FORMAT_BY_SUFFIX)},
        )
    fmt = _FORMAT_BY_SUFFIX[suffix]
    if image.mode in ("LA", "RGBA", "PA") and fmt not in _ALPHA_CAPABLE_FORMATS:
        raise OutputFormatError(
            f"{fmt} cannot store the transparency produced by this step; assign an "
            "alpha-capable path (.png) instead of flattening the design",
            details={"path": str(path), "format": fmt, "mode": image.mode},
        )
    return fmt


def save_image(
    storage: StorageRoot,
    relative_path: str,
    image: Image.Image,
    protected: tuple[str, ...] = (),
    dpi: int | None = None,
) -> list[dict[str, Any]]:
    """Atomically write ``image`` to ``relative_path``; returns extra warnings.

    ``dpi`` embeds physical resolution (PNG pHYs / TIFF density) so downstream
    tools can read the print size without re-deriving it.
    """

    target = storage.resolve(relative_path)
    fmt = output_format_for(target, image)
    warnings: list[dict[str, Any]] = []
    save_kwargs: dict[str, Any] = {}

    if dpi:
        save_kwargs["dpi"] = (int(dpi), int(dpi))

    if fmt == "JPEG":
        warnings.append(
            make_warning(
                "lossy-reencode",
                "info",
                "Output re-encoded as JPEG; each approved step adds compression artefacts.",
                details={"path": relative_path},
            )
        )
        save_kwargs["quality"] = 95
        save_kwargs["optimize"] = True
    elif fmt == "PNG":
        save_kwargs["optimize"] = True
    elif fmt == "WEBP":
        save_kwargs["quality"] = 100
        save_kwargs["lossless"] = True

    payload_image = image
    if fmt == "JPEG" and image.mode == "L":
        payload_image = image.convert("RGB")

    with storage.stage(relative_path, protected) as staged:
        payload_image.save(staged, format=fmt, **save_kwargs)
    return warnings


def build_metadata(
    image: Image.Image | None,
    *,
    duration_ms: int,
    engine: str | None = None,
    model: str | None = None,
    effective_dpi: float | None = None,
    warnings: list[dict[str, Any]] | None = None,
    has_alpha: bool | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {"durationMs": max(0, int(duration_ms))}
    if image is not None:
        metadata["widthPx"] = image.width
        metadata["heightPx"] = image.height
    resolved_alpha = image_has_alpha(image) if has_alpha is None else has_alpha
    if image is not None or has_alpha is not None:
        metadata["hasAlpha"] = bool(resolved_alpha)
    if effective_dpi is not None:
        metadata["effectiveDpiAtTarget"] = effective_dpi
    if engine is not None:
        metadata["engine"] = engine
    if model is not None:
        metadata["model"] = model
    if warnings:
        metadata["warnings"] = list(warnings)
    return metadata
