"""Mask shaping: grow/contract, feather and a levels adjustment.

The background-removal mask is the product. Whatever produces it -- the colour
key today -- the operator still needs to push the selection outward or pull it
back and to remap the alpha ramp, exactly like Photoshop's *Select > Modify >
Expand/Contract* and an *Image > Adjustments > Levels* layer.

Everything here works on a single-channel 8-bit ``L`` array and is expressed in
**source pixels**, so a proposal can be re-run against the same version and land
on byte-identical pixels. No operation touches the source image.

Two conventions matter:

* **Grow is a distance, not a kernel radius.** ``growPx = 3`` must move the edge
  three pixels in every direction, including diagonals. A square (Chebyshev)
  kernel would move a diagonal edge by ~1.41x the nominal amount, which reads as
  "the slider lies" the moment you test it on a circle. A Euclidean distance
  transform gives a true circular offset, and it is also much cheaper than a
  large structuring element (0.3 s vs 4.8 s on a 6850 px sheet).
* **Growing extends the matte, it does not stamp 255.** A pixel the offset newly
  covers takes the alpha of the nearest pixel that was already selected, so a
  soft rim stays soft instead of growing a hard shelf. Contracting is the mirror
  image: a pixel the offset drops takes the alpha of the nearest unselected
  pixel.
* **Levels are Photoshop's levels.** ``blackPoint`` / ``whitePoint`` rescale the
  input ramp, ``gamma`` bends the midpoint, and the optional ``outputBlack`` /
  ``outputWhite`` clamp the result into a sub-range. The mapping is applied with
  a 256-entry lookup table so it is exact, fast and reproducible.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np

from app.errors import UnsupportedParameterError

# Distance-transform precision. ``DIST_L2`` with a 5x5 mask is accurate to a few
# hundredths of a pixel, far below one alpha step.
_DISTANCE_MASK = 5

# A selection edge is the alpha contour at this level. 128 keeps "grow" and
# "contract" symmetrical: a pixel counts as selected exactly when it is at least
# half visible.
EDGE_THRESHOLD = 128


def _require_mask(mask: np.ndarray) -> np.ndarray:
    if mask.dtype != np.uint8 or mask.ndim != 2:
        raise UnsupportedParameterError(
            "a mask must be an 8-bit single-channel array",
            details={"shape": list(mask.shape), "dtype": str(mask.dtype)},
        )
    return mask


def _require_ramp(pixels: np.ndarray) -> np.ndarray:
    """Levels work on any 8-bit ramp: an ``L`` mask or an ``RGB`` image body."""

    if pixels.dtype != np.uint8 or pixels.ndim not in (2, 3):
        raise UnsupportedParameterError(
            "levels need an 8-bit grayscale or RGB array",
            details={"shape": list(pixels.shape), "dtype": str(pixels.dtype)},
        )
    return pixels


def _nearest_value_fill(
    mask: np.ndarray, sources: np.ndarray, targets: np.ndarray, max_distance: float
) -> np.ndarray:
    """Give every ``targets`` pixel the value of its nearest ``sources`` pixel.

    ``sources`` is a boolean array of pixels whose value is copied outward;
    ``targets`` selects which pixels may receive one, and ``max_distance`` caps
    how far the copy may travel. One distance transform does the whole job.
    """

    if not sources.any() or not targets.any():
        return mask

    # Zeros at the source pixels, so the transform reports, for every pixel, the
    # distance to the nearest source and the label of that source.
    zero_at_source = np.where(sources, 0, 1).astype(np.uint8)
    distance, labels = cv2.distanceTransformWithLabels(
        zero_at_source,
        cv2.DIST_L2,
        _DISTANCE_MASK,
        labelType=cv2.DIST_LABEL_PIXEL,
    )
    reachable = targets & (distance > 0) & (distance <= max_distance)
    if not reachable.any():
        return mask

    # Label ids are 1-based and unique per zero pixel, so a table indexed by label
    # maps each grown pixel to the value of the source it is nearest to.
    lookup = np.zeros(int(labels.max()) + 1, dtype=np.uint8)
    rows, columns = np.nonzero(sources)
    np.maximum.at(lookup, labels[rows, columns], mask[rows, columns])

    result = mask.copy()
    result[reachable] = lookup[labels][reachable]
    return result


def grow_mask(mask: np.ndarray, grow_px: float, *, threshold: int = EDGE_THRESHOLD) -> np.ndarray:
    """Offset the selection by ``grow_px``: positive grows, negative contracts."""

    _require_mask(mask)
    if not np.isfinite(grow_px):
        raise UnsupportedParameterError(
            "mask grow/contract distance must be a finite number",
            details={"growPx": grow_px},
        )

    distance = float(grow_px)
    if abs(distance) < 0.05:
        return mask.copy()

    selected = mask >= threshold
    if distance > 0:
        # Extend selected alpha outward into unselected, not-yet-opaque pixels.
        return _nearest_value_fill(
            mask,
            sources=selected,
            targets=~selected & (mask < 255),
            max_distance=distance,
        )

    # Pull unselected alpha inward over selected, not-yet-transparent pixels.
    return _nearest_value_fill(
        mask,
        sources=~selected,
        targets=selected & (mask > 0),
        max_distance=-distance,
    )


def feather_mask(mask: np.ndarray, radius_px: float) -> np.ndarray:
    """Soften the alpha ramp with a Gaussian of ``radius_px``; 0 is a no-op."""

    _require_mask(mask)
    if not np.isfinite(radius_px) or radius_px <= 0:
        return mask.copy()

    # sigma = radius / 2 puts the visible transition roughly ``radius`` wide,
    # which is how the edge-softness control has always been described.
    sigma = max(float(radius_px) / 2.0, 1e-3)
    blurred = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), sigmaX=sigma, sigmaY=sigma)
    return np.clip(np.rint(blurred), 0, 255).astype(np.uint8)


def levels_lut(
    black_point: int = 0,
    white_point: int = 255,
    gamma: float = 1.0,
    output_black: int = 0,
    output_white: int = 255,
) -> np.ndarray:
    """The 256-entry lookup table for a Photoshop-style levels adjustment."""

    if not 0 <= black_point <= 254:
        raise UnsupportedParameterError(
            "levels blackPoint must be between 0 and 254",
            details={"blackPoint": black_point},
        )
    if not 1 <= white_point <= 255 or white_point <= black_point:
        raise UnsupportedParameterError(
            "levels whitePoint must be between 1 and 255 and above blackPoint",
            details={"blackPoint": black_point, "whitePoint": white_point},
        )
    if not np.isfinite(gamma) or not 0.01 <= gamma <= 9.99:
        raise UnsupportedParameterError(
            "levels gamma must be between 0.01 and 9.99",
            details={"gamma": gamma},
        )
    if not 0 <= output_black <= 255 or not 0 <= output_white <= 255:
        raise UnsupportedParameterError(
            "levels output points must be between 0 and 255",
            details={"outputBlack": output_black, "outputWhite": output_white},
        )

    ramp = np.arange(256, dtype=np.float32)
    span = float(white_point - black_point)
    normalized = np.clip((ramp - black_point) / span, 0.0, 1.0)
    # gamma > 1 brightens midtones, matching Photoshop's midtone slider.
    shaped = np.power(normalized, 1.0 / float(gamma))
    scaled = output_black + shaped * float(output_white - output_black)
    return np.clip(np.rint(scaled), 0, 255).astype(np.uint8)


def levels_is_identity(levels: dict[str, Any] | None) -> bool:
    """True when a ``levels`` object would leave every pixel unchanged."""

    if not levels:
        return True
    return (
        int(levels.get("blackPoint") or 0) == 0
        and int(levels.get("whitePoint") if levels.get("whitePoint") is not None else 255) == 255
        and abs(float(levels.get("gamma") if levels.get("gamma") is not None else 1.0) - 1.0) < 1e-9
        and int(levels.get("outputBlack") or 0) == 0
        and int(levels.get("outputWhite") if levels.get("outputWhite") is not None else 255) == 255
    )


def apply_levels(mask: np.ndarray, levels: dict[str, Any] | None) -> np.ndarray:
    """Remap an 8-bit ramp (mask alpha or RGB image body) with a levels object."""

    _require_ramp(mask)
    if levels_is_identity(levels):
        return mask.copy()

    payload = levels or {}
    lut = levels_lut(
        int(payload.get("blackPoint") or 0),
        int(payload.get("whitePoint") if payload.get("whitePoint") is not None else 255),
        float(payload.get("gamma") if payload.get("gamma") is not None else 1.0),
        int(payload.get("outputBlack") or 0),
        int(payload.get("outputWhite") if payload.get("outputWhite") is not None else 255),
    )
    return lut[mask]


def refine_mask_regions(
    mask: np.ndarray,
    min_area_px: float,
    *,
    threshold: int = EDGE_THRESHOLD,
) -> tuple[np.ndarray, dict[str, int]]:
    """Drop specks and fill pinholes smaller than ``min_area_px``.

    DTF prints every opaque pixel: a stray island becomes an ink dot on the
    garment and a pinhole inside the artwork prints an unprinted patch, so both
    matter more here than they do on screen. Nothing is guessed -- the caller
    passes the area, and the pass reports exactly what it changed so the proposal
    can say so.

    Islands are opaque regions under the limit; holes are background regions
    under the limit that do not touch the border (a border-touching background is
    the outside, not a hole). The soft ramp outside those regions is untouched.
    """

    _require_mask(mask)
    if min_area_px <= 0:
        return mask, {"removedPx": 0, "filledPx": 0}

    limit = float(min_area_px)
    height, width = mask.shape
    binary = (mask >= threshold).astype(np.uint8)
    cleaned = mask.copy()

    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    small = [
        label
        for label in range(1, count)
        if stats[label, cv2.CC_STAT_AREA] < limit
    ]
    removed = 0
    if small:
        # A lookup table beats np.isin here: the label image is one int32 per
        # pixel and `isin` would sort a copy of that whole array.
        drop = np.zeros(count, dtype=bool)
        drop[small] = True
        affected = drop[labels]
        removed = int(np.count_nonzero(cleaned[affected]))
        cleaned[affected] = 0

    holes, hole_labels, hole_stats, _ = cv2.connectedComponentsWithStats(
        1 - binary, connectivity=8
    )
    filled = 0
    fill: list[int] = []
    for label in range(1, holes):
        x, y, w, h, area = hole_stats[label]
        if area >= limit:
            continue
        if x <= 0 or y <= 0 or x + w >= width or y + h >= height:
            continue
        fill.append(label)
    if fill:
        fill_table = np.zeros(holes, dtype=bool)
        fill_table[fill] = True
        affected = fill_table[hole_labels]
        filled = int(np.count_nonzero(cleaned[affected] != 255))
        cleaned[affected] = 255

    return cleaned, {"removedPx": removed, "filledPx": filled}
