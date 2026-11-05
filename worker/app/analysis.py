"""Shared image analysis used by classify, auto-trim and key-colour removal.

The heuristics are intentionally simple, cheap and *explainable*, because a
human reviews every proposal: the classifier measures four things the frozen
contract asks for and nothing else.

Sampling strategy
-----------------
* Colour and edge features are computed on a copy downscaled to at most
  ``Settings.classify_analysis_max_px`` on its longest side, so cost is bounded
  for 6850px sources. Quantised colour counts are therefore counts of
  *quantized* colours (``classify_color_levels`` levels per channel), which is
  what makes a flat logo look flat.
* Background sampling and full-bleed detection use the **full-resolution**
  border strips, because margins are exactly where a screenshot carries its
  chrome and a downscale would smear it.
* A border strip is ``clamp(round(min(w, h) * border_band_ratio), min, max)``
  pixels wide.

Feature definitions
-------------------
``flatColorRatio``   share of analysed pixels within ``classify_flat_color_tolerance``
                     (per channel) of the most common quantised colour.
``edgeDensity``      share of pixels whose Sobel-like gradient magnitude on the
                     luminance channel exceeds ``classify_edge_threshold``.
``uniqueColorCount`` number of distinct quantised RGB colours in the analysis copy.
``sampledBackground``  dominant border colour, classified as transparent / black /
                     white / gray / custom, with the share of border pixels that
                     support it as ``confidence``.
``fullBleed``        true when *no* border strip is at least
                     ``edge_uniform_ratio`` background, i.e. artwork reaches all
                     four edges.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

from app.config import Settings
from app.imaging import make_warning

TRANSPARENT = "transparent"
BLACK = "black"
WHITE = "white"
GRAY = "gray"
CUSTOM = "custom"
BACKGROUND_KINDS = (TRANSPARENT, BLACK, WHITE, GRAY, CUSTOM)

_FALLBACK_HEX = {BLACK: "#000000", WHITE: "#FFFFFF", GRAY: "#808080"}


@dataclass(frozen=True)
class BackgroundSample:
    """The dominant border colour and how much of the border supports it."""

    kind: str
    hex: str | None
    confidence: float

    def key_hex(self) -> str | None:
        if self.kind == TRANSPARENT:
            return None
        if self.hex:
            return self.hex
        return _FALLBACK_HEX.get(self.kind)

    def as_feature(self) -> dict[str, Any]:
        feature: dict[str, Any] = {"kind": self.kind, "confidence": round(self.confidence, 4)}
        if self.hex:
            feature["hex"] = self.hex
        return feature


@dataclass(frozen=True)
class AnalysisArrays:
    """Numpy views over an RGBA image; the alpha channel is kept separate."""

    rgb: np.ndarray
    alpha: np.ndarray
    width: int
    height: int

    @property
    def opaque(self) -> np.ndarray:
        return self.alpha > 0

    @property
    def luminance(self) -> np.ndarray:
        # ITU-R BT.601 weights, integer-ish precision is enough for thresholds.
        return (
            0.299 * self.rgb[..., 0] + 0.587 * self.rgb[..., 1] + 0.114 * self.rgb[..., 2]
        ).astype(np.float32)


def to_arrays(image: Image.Image) -> AnalysisArrays:
    rgba = image.convert("RGBA")
    array = np.asarray(rgba, dtype=np.uint8)
    return AnalysisArrays(
        rgb=array[..., :3].copy(),
        alpha=array[..., 3].copy(),
        width=rgba.width,
        height=rgba.height,
    )


def border_band_size(width: int, height: int, settings: Settings) -> int:
    band = int(round(min(width, height) * settings.border_band_ratio))
    ratio = max(band, settings.border_band_min_px)
    limit = max(1, min(width, height) // 2)
    return min(ratio, settings.border_band_max_px, limit)


def _border_strips(array: np.ndarray, band: int) -> list[np.ndarray]:
    return [
        array[:band, :, :],
        array[-band:, :, :],
        array[:, :band, :],
        array[:, -band:, :],
    ]


def border_pixels(arrays: AnalysisArrays, settings: Settings) -> np.ndarray:
    """All four border strips concatenated, at full resolution."""

    band = border_band_size(arrays.width, arrays.height, settings)
    stacked = np.concatenate([arrays.rgb, arrays.alpha[..., None]], axis=-1)
    strips = _border_strips(stacked, band)
    return np.concatenate([strip.reshape(-1, 4) for strip in strips], axis=0)


def _median_hex(values: np.ndarray) -> str:
    median = np.median(values, axis=0).astype(int)
    return f"#{int(median[0]):02X}{int(median[1]):02X}{int(median[2]):02X}"


def classify_color_name(median_rgb: np.ndarray, settings: Settings) -> str:
    spread = int(median_rgb.max()) - int(median_rgb.min())
    luminance = float(
        0.299 * median_rgb[0] + 0.587 * median_rgb[1] + 0.114 * median_rgb[2]
    )
    neutral_limit = max(2 * settings.background_match_tolerance, 1)
    if spread > neutral_limit:
        return CUSTOM
    if luminance <= 40:
        return BLACK
    if luminance >= 210:
        return WHITE
    return GRAY


def sample_background(arrays: AnalysisArrays, settings: Settings) -> BackgroundSample:
    """Dominant border colour of the four strips, with a supporting-pixel share."""

    border = border_pixels(arrays, settings)
    alpha = border[:, 3]
    transparent_share = float(np.mean(alpha <= settings.alpha_threshold))
    if transparent_share >= 0.5:
        return BackgroundSample(kind=TRANSPARENT, hex=None, confidence=transparent_share)

    opaque = border[alpha > settings.alpha_threshold][:, :3]
    if opaque.size == 0:
        return BackgroundSample(kind=TRANSPARENT, hex=None, confidence=1.0)

    median = np.median(opaque, axis=0)
    within = np.max(np.abs(opaque.astype(np.int16) - median.astype(np.int16)), axis=1)
    tolerance = max(settings.background_match_tolerance, 0)
    share = float(np.mean(within <= tolerance))
    kind = classify_color_name(median.astype(int), settings)
    return BackgroundSample(kind=kind, hex=_median_hex(opaque), confidence=share)


def background_matches(
    arrays: AnalysisArrays,
    sample: BackgroundSample,
    *,
    tolerance: int,
    alpha_threshold: int,
) -> np.ndarray:
    """Boolean map, ``True`` where a pixel looks like the sampled background."""

    opaque = arrays.alpha > alpha_threshold
    if sample.kind == TRANSPARENT:
        return ~opaque
    key_hex = sample.key_hex() or "#FFFFFF"
    key = np.array(
        [int(key_hex[1:3], 16), int(key_hex[3:5], 16), int(key_hex[5:7], 16)], dtype=np.int16
    )
    distance = np.max(np.abs(arrays.rgb.astype(np.int16) - key), axis=2)
    return opaque & (distance <= max(tolerance, 0))


def content_bbox(
    content: np.ndarray,
    *,
    padding_px: int = 0,
) -> tuple[int, int, int, int] | None:
    """Tight ``(x, y, width, height)`` of non-background pixels, plus padding."""

    if content.size == 0 or not bool(content.any()):
        return None
    rows = np.any(content, axis=1)
    columns = np.any(content, axis=0)
    y0 = int(np.argmax(rows))
    y1 = int(content.shape[0] - np.argmax(rows[::-1]))
    x0 = int(np.argmax(columns))
    x1 = int(content.shape[1] - np.argmax(columns[::-1]))
    pad = max(int(padding_px), 0)
    x0 = max(x0 - pad, 0)
    y0 = max(y0 - pad, 0)
    x1 = min(x1 + pad, content.shape[1])
    y1 = min(y1 + pad, content.shape[0])
    return (x0, y0, x1 - x0, y1 - y0)


def touches_all_edges(content: np.ndarray) -> bool:
    """True when content pixels sit on all four outer rows/columns."""

    height, width = content.shape
    return bool(
        content[0].any()
        and content[-1].any()
        and content[:, 0].any()
        and content[:, -1].any()
    )


def edge_margin_ratios(
    arrays: AnalysisArrays,
    background: np.ndarray,
    settings: Settings,
) -> dict[str, float]:
    """Share of background pixels in each border strip."""

    band = border_band_size(arrays.width, arrays.height, settings)
    strips = {
        "top": background[:band, :],
        "bottom": background[-band:, :],
        "left": background[:, :band],
        "right": background[:, -band:],
    }
    return {name: float(np.mean(strip)) for name, strip in strips.items()}


def is_full_bleed(ratios: dict[str, float], settings: Settings) -> bool:
    """No edge is a clean margin: the artwork runs off all four sides."""

    return all(ratio < settings.edge_uniform_ratio for ratio in ratios.values())


def quantize(rgb: np.ndarray, levels: int) -> np.ndarray:
    """Collapse each channel to ``levels`` buckets before counting colours."""

    levels = max(int(levels), 2)
    scaled = np.floor(rgb.astype(np.float32) * (levels / 256.0)).astype(np.int32)
    return np.clip(scaled, 0, levels - 1)


def _quantized_keys(rgb: np.ndarray, levels: int) -> np.ndarray:
    quantized = quantize(rgb, levels) * (256 // levels)
    packed = (
        (quantized[..., 0].astype(np.int64) << 16)
        | (quantized[..., 1].astype(np.int64) << 8)
        | quantized[..., 2].astype(np.int64)
    )
    return packed


def analysis_copy(image: Image.Image, settings: Settings) -> tuple[Image.Image, bool]:
    """Downscaled copy for colour/edge features. Returns (image, was_resized)."""

    limit = settings.classify_analysis_max_px
    if max(image.size) <= limit:
        return image, False
    factor = limit / max(image.size)
    size = (max(1, int(round(image.width * factor))), max(1, int(round(image.height * factor))))
    return image.resize(size, Image.Resampling.BILINEAR), True


def unique_color_count(rgb: np.ndarray, levels: int) -> int:
    keys = _quantized_keys(rgb, levels).reshape(-1)
    return int(np.unique(keys).size)


def flat_color_ratio(rgb: np.ndarray, levels: int, tolerance: int) -> float:
    """Share of pixels near the most common quantised colour."""

    keys = _quantized_keys(rgb, levels).reshape(-1)
    if keys.size == 0:
        return 0.0
    values, counts = np.unique(keys, return_counts=True)
    dominant = int(values[int(np.argmax(counts))])
    representative = np.array(
        [(dominant >> 16) & 0xFF, (dominant >> 8) & 0xFF, dominant & 0xFF], dtype=np.int16
    )
    distance = np.max(np.abs(rgb.astype(np.int16) - representative), axis=-1).reshape(-1)
    return float(np.mean(distance <= max(tolerance, 0)))


def edge_density(luminance: np.ndarray, threshold: int) -> float:
    """Gradient magnitude via central differences; share of pixels above the threshold."""

    if luminance.shape[0] < 3 or luminance.shape[1] < 3:
        return 0.0
    horizontal = np.abs(np.diff(luminance, axis=1, prepend=luminance[:, :1]))
    vertical = np.abs(np.diff(luminance, axis=0, prepend=luminance[:1, :]))
    magnitude = horizontal + vertical
    return float(np.mean(magnitude > threshold))


def feature_report(
    image: Image.Image,
    arrays: AnalysisArrays,
    sample: BackgroundSample,
    settings: Settings,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The frozen ``features`` object plus any honesty warnings, on the analysis copy."""

    analysis, resized = analysis_copy(image, settings)
    analysis_arrays = to_arrays(analysis)
    levels = settings.classify_color_levels
    features = {
        "flatColorRatio": round(
            flat_color_ratio(
                analysis_arrays.rgb,
                levels,
                settings.classify_flat_color_tolerance,
            ),
            4,
        ),
        "edgeDensity": round(
            edge_density(analysis_arrays.luminance, settings.classify_edge_threshold), 4
        ),
        "uniqueColorCount": max(1, unique_color_count(analysis_arrays.rgb, levels)),
        "sampledBackground": sample.as_feature(),
        "fullBleed": False,
    }
    warnings: list[dict[str, Any]] = []
    if resized:
        warnings.append(
            make_warning(
                "classifier-analysis-downscaled",
                "info",
                "Colour and edge features were measured on a copy downscaled to "
                f"{max(analysis.size)}px; margins and full-bleed use full resolution.",
                details={
                    "analysisMaxPx": settings.classify_analysis_max_px,
                    "sourceWidthPx": arrays.width,
                    "sourceHeightPx": arrays.height,
                },
            )
        )
    return features, warnings
