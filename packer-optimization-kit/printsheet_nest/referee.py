"""The referee: exact, full-resolution validation of any layout.

The referee is intentionally separate from the solver. A solver's output is
only accepted if this module agrees, pixel for pixel, that the layout is
legal. It never trusts the solver's own numbers.

Rules enforced (these are the product's hard constraints):

1. Every requested design is placed exactly once.
2. Rotations are one of 0/90/180/270.
3. Declared ``width_px``/``height_px`` equal the rotated source's dimensions.
4. No visible pixel (``alpha > alpha_threshold``) falls outside the sheet.
5. Visible pixels of different designs are at least ``margin_px`` apart, using
   Chebyshev (``max(|dx|, |dy|)``) distance, which is conservative relative to
   Euclidean distance.
6. Visible pixels are at least ``edge_margin_px`` from every sheet edge.
7. The sheet height is at least the lowest visible pixel, so the reported
   sheet cannot be shorter than the artwork it contains.

Chebyshev distance is used because the production packer certifies gaps with a
square structuring element: a gap that holds here also holds as a Euclidean
gap. Do not weaken it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from printsheet_nest.types import Case, Layout, PackParams

try:  # Pillow is required for reading artwork; fail loudly rather than silently.
    from PIL import Image
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        "Pillow is required by the referee: pip install -r requirements.txt"
    ) from exc


@dataclass
class DesignRaster:
    """One design's alpha occupancy at full resolution, in sheet coordinates."""

    design_id: str
    occupied: np.ndarray  # cropped to the visible bounding box
    x0: int  # visible bbox origin in sheet coordinates
    y0: int
    image_width_px: int
    image_height_px: int
    rotation_deg: int

    @property
    def x1(self) -> int:
        return self.x0 + self.occupied.shape[1]

    @property
    def y1(self) -> int:
        return self.y0 + self.occupied.shape[0]

    @property
    def visible_pixels(self) -> int:
        return int(self.occupied.sum())


@dataclass
class Verdict:
    """The referee's answer about one layout."""

    feasible: bool
    reasons: list[str] = field(default_factory=list)
    sheet_height_px: int = 0
    sheet_width_px: int = 0
    visible_pixels: int = 0
    minimum_gap_px: int | None = None
    minimum_edge_clearance_px: int | None = None
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def density(self) -> float:
        """Fraction of the sheet's area covered by visible artwork pixels."""
        area = self.sheet_width_px * self.sheet_height_px
        return self.visible_pixels / area if area else 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "feasible": self.feasible,
            "reasons": self.reasons,
            "sheetHeightPx": self.sheet_height_px,
            "sheetWidthPx": self.sheet_width_px,
            "visiblePixels": self.visible_pixels,
            "density": round(self.density, 6),
            "minimumGapPx": self.minimum_gap_px,
            "minimumEdgeClearancePx": self.minimum_edge_clearance_px,
            "details": self.details,
        }


def pixels_for_mm(millimeters: float, dpi: int) -> int:
    """Ceiling conversion: a required clearance is never rounded down."""
    if millimeters <= 0:
        return 0
    return int(np.ceil(millimeters / 25.4 * dpi - 1e-9))


def sheet_width_px(params: PackParams) -> int:
    return int(round(params.roll_width_cm / 2.54 * params.dpi))


def load_alpha(path: str | Path) -> np.ndarray:
    """Decode an image to a 2-D ``uint8`` alpha array, without resampling."""
    with Image.open(path) as image:
        image.load()
        if image.mode == "RGBA" or "A" in image.mode:
            rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
            return np.ascontiguousarray(rgba[..., 3])
        return np.full((image.height, image.width), 255, dtype=np.uint8)


def _rotate(array: np.ndarray, rotation_deg: int) -> np.ndarray:
    turns = rotation_deg // 90
    if turns == 0:
        return array
    return np.ascontiguousarray(np.rot90(array, k=-turns))


def _visible_bbox(occupied: np.ndarray) -> tuple[int, int, int, int] | None:
    rows = np.flatnonzero(occupied.any(axis=1))
    if rows.size == 0:
        return None
    columns = np.flatnonzero(occupied.any(axis=0))
    return int(rows[0]), int(rows[-1]) + 1, int(columns[0]), int(columns[-1]) + 1


def _dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    """Chebyshev dilation via summed-area tables; exact and O(n) per axis."""
    if radius <= 0:
        return mask
    out = mask
    for axis in (0, 1):
        length = out.shape[axis]
        shape = list(out.shape)
        shape[axis] = length + 1
        prefix = np.zeros(shape, dtype=np.int32)
        window = prefix[(slice(None),) * axis + (slice(1, None),)]
        np.cumsum(out, axis=axis, dtype=np.int32, out=window)
        indices = np.arange(length)
        high = np.minimum(indices + radius + 1, length)
        low = np.maximum(indices - radius, 0)
        out = (np.take(prefix, high, axis=axis) - np.take(prefix, low, axis=axis)) > 0
    return out


def _window(raster: DesignRaster, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    """The raster's occupied pixels clipped to a sheet-space window."""
    out = np.zeros((y1 - y0, x1 - x0), dtype=bool)
    ix0, iy0 = max(x0, raster.x0), max(y0, raster.y0)
    ix1, iy1 = min(x1, raster.x1), min(y1, raster.y1)
    if ix1 <= ix0 or iy1 <= iy0:
        return out
    out[iy0 - y0 : iy1 - y0, ix0 - x0 : ix1 - x0] = raster.occupied[
        iy0 - raster.y0 : iy1 - raster.y0, ix0 - raster.x0 : ix1 - raster.x0
    ]
    return out


def _dilated_window(
    raster: DesignRaster, x0: int, y0: int, x1: int, y1: int, radius: int
) -> np.ndarray:
    """This raster's pixels, grown by ``radius``, clipped to the window.

    Mirrors the production integrity probe: crop the source to the window grown
    by ``radius``, dilate that crop with padding so nothing is clipped, then
    read back the part that lands inside the window.
    """
    if radius <= 0:
        return _window(raster, x0, y0, x1, y1)
    nx0, ny0 = max(x0 - radius, raster.x0), max(y0 - radius, raster.y0)
    nx1, ny1 = min(x1 + radius, raster.x1), min(y1 + radius, raster.y1)
    out = np.zeros((y1 - y0, x1 - x0), dtype=bool)
    if nx1 <= nx0 or ny1 <= ny0:
        return out
    source = raster.occupied[ny0 - raster.y0 : ny1 - raster.y0, nx0 - raster.x0 : nx1 - raster.x0]
    padded = np.pad(source, ((radius, radius), (radius, radius)), constant_values=False)
    grown = _dilate(padded, radius)
    base_x, base_y = nx0 - radius, ny0 - radius
    rows = slice(y0 - base_y, y1 - base_y)
    columns = slice(x0 - base_x, x1 - base_x)
    return grown[rows, columns]


def _touches(first: DesignRaster, second: DesignRaster, radius: int) -> bool:
    x0, y0 = max(first.x0, second.x0) - radius, max(first.y0, second.y0) - radius
    x1 = min(first.x1, second.x1) + radius
    y1 = min(first.y1, second.y1) + radius
    if x1 <= x0 or y1 <= y0:
        return False
    return bool(
        (_dilated_window(first, x0, y0, x1, y1, radius) & _window(second, x0, y0, x1, y1)).any()
    )


def minimum_gap_px(first: DesignRaster, second: DesignRaster, probe: int) -> int | None:
    """Exact minimum Chebyshev distance between visible pixels, or None if > probe."""
    if not _touches(first, second, probe):
        return None
    low, high = 0, probe
    while low < high:
        middle = (low + high) // 2
        if _touches(first, second, middle):
            high = middle
        else:
            low = middle + 1
    return low


def _bbox_gap(first: DesignRaster, second: DesignRaster) -> int:
    dx = max(first.x0 - second.x1, second.x0 - first.x1, 0)
    dy = max(first.y0 - second.y1, second.y0 - first.y1, 0)
    return max(dx, dy)


def build_rasters(case: Case, layout: Layout) -> tuple[list[DesignRaster], list[str]]:
    """Turn placements into sheet-space rasters, checking declared dimensions."""
    by_id = {design.design_id: design for design in case.designs}
    seen: set[str] = set()
    problems: list[str] = []
    rasters: list[DesignRaster] = []

    for placement in layout.placements:
        design = by_id.get(placement.design_id)
        if design is None:
            problems.append(f"unknown design id {placement.design_id!r}")
            continue
        if placement.design_id in seen:
            problems.append(f"design {placement.design_id!r} is placed more than once")
            continue
        seen.add(placement.design_id)
        if placement.rotation_deg not in (0, 90, 180, 270):
            problems.append(
                f"design {placement.design_id!r} has illegal rotation {placement.rotation_deg}"
            )
            continue

        alpha = load_alpha(case.files[placement.design_id])
        rotated = _rotate(alpha, placement.rotation_deg)
        expected = (
            (design.width_px, design.height_px)
            if placement.rotation_deg in (0, 180)
            else (design.height_px, design.width_px)
        )
        if (rotated.shape[1], rotated.shape[0]) != expected:
            problems.append(
                f"design {placement.design_id!r} declares {expected[0]}x{expected[1]} px but "
                f"rotation {placement.rotation_deg} yields {rotated.shape[1]}x{rotated.shape[0]}"
            )
            continue
        if (placement.width_px, placement.height_px) != expected:
            problems.append(
                f"design {placement.design_id!r} placement reports "
                f"{placement.width_px}x{placement.height_px} px, expected {expected[0]}x{expected[1]}"
            )
            continue

        occupied = rotated > case.params.alpha_threshold
        box = _visible_bbox(occupied)
        if box is None:
            problems.append(f"design {placement.design_id!r} has no visible pixels")
            continue
        y0, y1, x0, x1 = box
        rasters.append(
            DesignRaster(
                design_id=placement.design_id,
                occupied=occupied[y0:y1, x0:x1],
                x0=placement.x_px + x0,
                y0=placement.y_px + y0,
                image_width_px=rotated.shape[1],
                image_height_px=rotated.shape[0],
                rotation_deg=placement.rotation_deg,
            )
        )
    return rasters, problems


def judge(case: Case, layout: Layout, *, probe_extra: int = 4) -> Verdict:
    """Independently verify a layout and measure it."""
    params = case.params
    width = sheet_width_px(params)
    margin_px = pixels_for_mm(params.margin_mm, params.dpi)
    edge_px = pixels_for_mm(params.edge_margin_mm, params.dpi)
    height = int(layout.sheet_height_px)

    rasters, problems = build_rasters(case, layout)
    placed_ids = {raster.design_id for raster in rasters}
    for design in case.designs:
        if design.design_id not in placed_ids:
            problems.append(f"design {design.design_id!r} was not placed")

    if layout.sheet_width_px != width:
        problems.append(
            f"layout reports width {layout.sheet_width_px} px but the roll is {width} px"
        )
    if height < 1:
        problems.append("sheet height must be at least one pixel")

    # Visible pixels outside the sheet.
    outside = 0
    for raster in rasters:
        if raster.x0 < 0 or raster.y0 < 0 or raster.x1 > width or raster.y1 > height:
            outside += raster.visible_pixels - int(
                _window(raster, 0, 0, width, height).sum()
            )
    if outside:
        problems.append(f"{outside} visible pixel(s) fall outside the sheet")

    # Lowest visible pixel must be within the reported height.
    lowest = max((raster.y1 for raster in rasters), default=0)
    if lowest > height:
        problems.append(
            f"reported sheet height {height} px is shorter than the lowest visible pixel at {lowest}"
        )

    # Edge clearance and pairwise gaps.
    edge_clearance: int | None = None
    for raster in rasters:
        clearance = min(raster.x0, width - raster.x1, raster.y0, height - raster.y1)
        edge_clearance = clearance if edge_clearance is None else min(edge_clearance, clearance)
        if clearance < edge_px:
            problems.append(
                f"design {raster.design_id!r} is {clearance} px from the sheet edge, "
                f"below the required {edge_px} px"
            )

    probe = margin_px + probe_extra
    min_gap: int | None = None
    beyond_probe = 0
    for index, first in enumerate(rasters):
        for second in rasters[index + 1 :]:
            if _bbox_gap(first, second) > probe:
                beyond_probe += 1
                continue
            gap = minimum_gap_px(first, second, probe)
            if gap is None:
                beyond_probe += 1
                continue
            min_gap = gap if min_gap is None else min(min_gap, gap)
            if gap < margin_px:
                problems.append(
                    f"designs {first.design_id!r} and {second.design_id!r} are {gap} px apart, "
                    f"below the required {margin_px} px"
                )

    visible = sum(raster.visible_pixels for raster in rasters)
    return Verdict(
        feasible=not problems,
        reasons=problems,
        sheet_height_px=height,
        sheet_width_px=width,
        visible_pixels=visible,
        minimum_gap_px=min_gap,
        minimum_edge_clearance_px=edge_clearance,
        details={
            "marginPx": margin_px,
            "edgeMarginPx": edge_px,
            "pairsBeyondProbe": beyond_probe,
            "probePx": probe,
            "placedCount": len(rasters),
            "requestedCount": len(case.designs),
        },
    )


def write_layout(path: Path, layout: Layout) -> None:
    path.write_text(json.dumps(layout.to_json(), indent=2), encoding="utf-8")


__all__ = [
    "DesignRaster",
    "Verdict",
    "build_rasters",
    "judge",
    "load_alpha",
    "minimum_gap_px",
    "pixels_for_mm",
    "sheet_width_px",
    "write_layout",
]
