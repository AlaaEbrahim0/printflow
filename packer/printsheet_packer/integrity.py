"""The four blocking integrity checks.

Every number in the report is measured against the full-resolution approved
pixels of the placed designs. Where a measurement is impossible — a pair of
designs too far apart to be the minimum, for instance — the pair is counted and
the value is omitted instead of invented.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from printsheet_packer.contracts import new_report_id, sheet_geometry, utc_timestamp
from printsheet_packer.masks import (
    BoundingBox,
    dilate_block,
    occupancy_from_alpha,
    rotate_rgba,
    visible_bbox,
)
from printsheet_packer.render import SheetRenderer
from printsheet_packer.units import millimeters_for_pixels

CHECK_VISIBLE_INSIDE = "visible-pixels-inside-sheet"
CHECK_NO_OVERLAP = "dilated-masks-no-overlap"
CHECK_MINIMUM_GAP = "minimum-gap"
CHECK_PIXEL_EQUALITY = "pixel-equality"

CHECK_ORDER = (CHECK_VISIBLE_INSIDE, CHECK_NO_OVERLAP, CHECK_MINIMUM_GAP, CHECK_PIXEL_EQUALITY)


@dataclass(frozen=True)
class PlacedMask:
    """One design's visible pixels, at full resolution, in sheet coordinates."""

    design_id: str
    version_id: str
    display_name: str | None
    occupied: np.ndarray
    bbox: BoundingBox
    rotation_deg: int
    x_px: int
    y_px: int
    image_width_px: int
    image_height_px: int

    @property
    def visible_pixels(self) -> int:
        return int(self.occupied.sum())


def build_placed_mask(
    design_id: str,
    version_id: str,
    rgba: np.ndarray,
    rotation_deg: int,
    x_px: int,
    y_px: int,
    alpha_threshold: int,
    display_name: str | None = None,
) -> PlacedMask:
    """Decode-time mask of a placement: rotate, threshold, crop, move to the sheet."""
    rotated = rotate_rgba(rgba, rotation_deg)
    height, width = rotated.shape[:2]
    bbox = visible_bbox(occupancy_from_alpha(rotated[..., 3], alpha_threshold))
    if bbox is None:
        empty = np.zeros((1, 1), dtype=bool)
        bbox = BoundingBox(0, 0, 1, 1)
        return PlacedMask(
            design_id,
            version_id,
            display_name,
            empty,
            BoundingBox(x_px, y_px, x_px + 1, y_px + 1),
            rotation_deg,
            x_px,
            y_px,
            width,
            height,
        )
    visible = occupancy_from_alpha(rotated[..., 3], alpha_threshold)
    occupied = visible[bbox.y0 : bbox.y1, bbox.x0 : bbox.x1]
    return PlacedMask(
        design_id,
        version_id,
        display_name,
        occupied,
        BoundingBox(x_px + bbox.x0, y_px + bbox.y0, x_px + bbox.x1, y_px + bbox.y1),
        rotation_deg,
        x_px,
        y_px,
        width,
        height,
    )


def build_placed_masks(
    placements: Sequence[Any],
    loader: Callable[[str], np.ndarray],
    alpha_threshold: int,
) -> list[PlacedMask]:
    """Build :class:`PlacedMask` values from manifest/response placement records."""
    return [
        build_placed_mask(
            placement["designId"],
            placement["versionId"],
            loader(placement["designId"]),
            int(placement["rotationDeg"]),
            int(placement["xPx"]),
            int(placement["yPx"]),
            alpha_threshold,
            placement.get("displayName"),
        )
        for placement in placements
    ]


@dataclass
class Verification:
    """Raw measurements; :func:`build_report` turns these into a report."""

    dpi: int
    margin_px: int
    margin_mm: float
    edge_margin_px: int
    edge_margin_mm: float
    dilation_radius_px: int
    outside_pixels: dict[str, int] = field(default_factory=dict)
    outside_sides: dict[str, list[str]] = field(default_factory=dict)
    overlaps: list[tuple[str, str, int]] = field(default_factory=list)
    pair_gaps: list[tuple[str, str, int]] = field(default_factory=list)
    pairs_beyond_probe: int = 0
    edge_clearances: dict[str, int] = field(default_factory=dict)
    pixel_mismatches: dict[str, int] = field(default_factory=dict)
    gap_probe_px: int = 0
    clipped_placements: int = 0
    pixels_compared: int = 0
    placements_checked: int = 0
    visible_pixel_count: int = 0
    checked_designs: int = 0

    @property
    def min_pair_gap_px(self) -> int | None:
        return min((gap for _, _, gap in self.pair_gaps), default=None)

    @property
    def min_edge_clearance_px(self) -> int | None:
        return min(self.edge_clearances.values(), default=None)

    @property
    def total_outside(self) -> int:
        return sum(self.outside_pixels.values())

    @property
    def overlap_pairs(self) -> int:
        return len(self.overlaps)

    @property
    def mismatched_pixels(self) -> int:
        return sum(self.pixel_mismatches.values())


def expand_bbox(box: BoundingBox, radius: int) -> BoundingBox:
    return BoundingBox(box.x0 - radius, box.y0 - radius, box.x1 + radius, box.y1 + radius)


def intersect_bbox(a: BoundingBox, b: BoundingBox) -> BoundingBox | None:
    box = BoundingBox(max(a.x0, b.x0), max(a.y0, b.y0), min(a.x1, b.x1), min(a.y1, b.y1))
    return box if box.width > 0 and box.height > 0 else None


def _raster_in(source: PlacedMask, region: BoundingBox) -> np.ndarray:
    """``source``'s occupied pixels clipped to ``region`` (both in sheet coords)."""
    out = np.zeros((region.height, region.width), dtype=bool)
    crop = intersect_bbox(source.bbox, region)
    if crop is None:
        return out
    rows = slice(crop.y0 - source.bbox.y0, crop.y1 - source.bbox.y0)
    columns = slice(crop.x0 - source.bbox.x0, crop.x1 - source.bbox.x0)
    out[crop.y0 - region.y0 : crop.y1 - region.y0, crop.x0 - region.x0 : crop.x1 - region.x0] = (
        source.occupied[rows, columns]
    )
    return out


def _dilated_in_window(source: PlacedMask, window: BoundingBox, radius: int) -> np.ndarray:
    """``source`` dilated by ``radius`` and clipped to ``window``, without a sheet copy."""
    if radius <= 0:
        return _raster_in(source, window)
    needed = intersect_bbox(source.bbox, expand_bbox(window, radius))
    if needed is None:
        return np.zeros((window.height, window.width), dtype=bool)
    dilated = dilate_block(_raster_in(source, needed), radius)
    base_x, base_y = needed.x0 - radius, needed.y0 - radius
    rows = slice(window.y0 - base_y, window.y1 - base_y)
    columns = slice(window.x0 - base_x, window.x1 - base_x)
    return dilated[rows, columns]


def dilated_overlap_px(first: PlacedMask, second: PlacedMask, radius: int) -> int:
    """Shared pixels of the two dilated masks; only pairs with touching bboxes are probed."""
    window = intersect_bbox(
        expand_bbox(first.bbox, radius), expand_bbox(second.bbox, radius)
    )
    if window is None:
        return 0
    left = _dilated_in_window(first, window, radius)
    right = _dilated_in_window(second, window, radius)
    return int((left & right).sum())


def _touches(source: PlacedMask, other: PlacedMask, radius: int) -> bool:
    window = intersect_bbox(expand_bbox(source.bbox, radius), other.bbox)
    if window is None:
        return False
    return bool((_dilated_in_window(source, window, radius) & _raster_in(other, window)).any())


def min_gap_px(source: PlacedMask, other: PlacedMask, probe_radius: int) -> int | None:
    """Exact minimum Chebyshev pixel distance, or ``None`` if beyond the probe."""
    if not _touches(source, other, probe_radius):
        return None
    low, high = 0, probe_radius
    while low < high:
        middle = (low + high) // 2
        if _touches(source, other, middle):
            high = middle
        else:
            low = middle + 1
    return low


def box_gap(first: PlacedMask, second: PlacedMask) -> int:
    """Chebyshev distance between the two visible boxes: a lower bound."""
    dx = max(first.bbox.x0 - second.bbox.x1, second.bbox.x0 - first.bbox.x1, 0)
    dy = max(first.bbox.y0 - second.bbox.y1, second.bbox.y0 - first.bbox.y1, 0)
    return max(dx, dy)


def _pairs(designs: Sequence[PlacedMask]) -> Iterable[tuple[PlacedMask, PlacedMask]]:
    for index, first in enumerate(designs):
        for second in designs[index + 1 :]:
            yield first, second


def verify_layout(
    designs: Sequence[PlacedMask],
    *,
    dpi: int,
    margin_px: int,
    margin_mm: float,
    edge_margin_px: int,
    edge_margin_mm: float,
    dilation_radius_px: int,
    sheet_width_px: int,
    sheet_height_px: int,
    renderer: SheetRenderer | None = None,
) -> Verification:
    """Measure everything the four blocking checks need, at full resolution."""
    result = Verification(
        dpi=dpi,
        margin_px=margin_px,
        margin_mm=margin_mm,
        edge_margin_px=edge_margin_px,
        edge_margin_mm=edge_margin_mm,
        dilation_radius_px=dilation_radius_px,
        checked_designs=len(designs),
    )
    # Only pairs that can *violate* the margin are worth measuring at full
    # resolution. A dilated pair overlap needs gap <= 2 * dilation_radius, and
    # 2 * dilation_radius + 1 >= margin_px, so a probe just past the margin
    # decides every check; pairs beyond it cannot fail and are counted instead.
    probe = margin_px + 4
    result.gap_probe_px = probe

    for design in designs:
        result.visible_pixel_count += design.visible_pixels
        outside, sides = _count_outside(design, sheet_width_px, sheet_height_px)
        if outside:
            result.outside_pixels[design.design_id] = outside
            result.outside_sides[design.design_id] = sides
        result.edge_clearances[design.design_id] = min(
            design.bbox.x0,
            sheet_width_px - design.bbox.x1,
            design.bbox.y0,
            sheet_height_px - design.bbox.y1,
        )

    for first, second in _pairs(designs):
        if box_gap(first, second) > probe:
            result.pairs_beyond_probe += 1
            continue
        gap = min_gap_px(first, second, probe)
        if gap is None:
            result.pairs_beyond_probe += 1
            continue
        result.pair_gaps.append((first.design_id, second.design_id, gap))
        if gap <= 2 * dilation_radius_px:
            overlap = dilated_overlap_px(first, second, dilation_radius_px)
            if overlap:
                result.overlaps.append((first.design_id, second.design_id, overlap))

    if renderer is not None:
        for design in designs:
            result.placements_checked += 1
            mismatches, clipped, compared = _pixel_mismatch(design, renderer)
            result.pixel_mismatches[design.design_id] = mismatches
            result.clipped_placements += clipped
            result.pixels_compared += compared

    return result


def _count_outside(
    source: PlacedMask, sheet_width_px: int, sheet_height_px: int
) -> tuple[int, list[str]]:
    """Visible pixels that fall outside the sheet, by side."""
    sides: list[str] = []
    count = 0
    if source.bbox.x0 < 0:
        pixels = int(source.occupied[:, : -source.bbox.x0].sum())
        if pixels:
            sides.append("left")
            count += pixels
    if source.bbox.x1 > sheet_width_px:
        start = max(0, sheet_width_px - source.bbox.x0)
        pixels = int(source.occupied[:, start:].sum())
        if pixels:
            sides.append("right")
            count += pixels
    if source.bbox.y0 < 0:
        pixels = int(source.occupied[: -source.bbox.y0, :].sum())
        if pixels:
            sides.append("top")
            count += pixels
    if source.bbox.y1 > sheet_height_px:
        start = max(0, sheet_height_px - source.bbox.y0)
        pixels = int(source.occupied[start:, :].sum())
        if pixels:
            sides.append("bottom")
            count += pixels
    return count, sides


def _pixel_mismatch(design: PlacedMask, renderer: SheetRenderer) -> tuple[int, int, int]:
    """(mismatched pixels, clipped, compared) for one placement.

    The expectation is the approved file rotated the way the *record* says; the
    band is what the *renderer* produced. If the two disagree - a wrong angle,
    a wrong footprint, a strip boundary handled badly - the check fails.

    A source pixel with ``alpha == 0`` carries no ink and its unused RGB bytes
    are not reproduced, so the comparison is byte-exact on every painted pixel
    plus a refusal to accept any pixel painted outside that set.
    """
    source = renderer.rotated_source(design.design_id, design.rotation_deg)
    if source.shape[0] != design.image_height_px or source.shape[1] != design.image_width_px:
        return int(source.shape[0] * source.shape[1]), 0, 0
    left = max(0, design.x_px)
    top = max(0, design.y_px)
    columns = min(design.image_width_px, renderer.sheet_width_px - left)
    rows = min(design.image_height_px, renderer.sheet_height_px - top)
    clipped = int(columns < design.image_width_px or rows < design.image_height_px)
    if columns <= 0 or rows <= 0:
        return 0, clipped, 0
    expected = source[:rows, :columns]
    rendered = renderer.render_strip(top, top + rows, only=design.design_id)[
        :, left : left + columns
    ]
    painted = expected[..., 3] > 0
    differs = np.any(rendered != expected, axis=2)
    invented = (rendered[..., 3] > 0) & ~painted
    compared = int(painted.sum())
    mismatches = int(np.count_nonzero(differs & (painted | invented)))
    return mismatches, clipped, compared


@dataclass(frozen=True)
class ReportContext:
    """The sheet numbers a report is allowed to repeat."""

    dpi: int
    sheet_width_px: int
    sheet_height_px: int
    design_count: int
    duration_ms: int
    occupancy_ratio: float
    orderings_tried: int


def build_report(
    measured: Verification,
    context: ReportContext,
    *,
    report_id: str | None = None,
    generated_at: str | None = None,
    skipped: Iterable[str] = (),
) -> dict[str, Any]:
    """Assemble the report in the frozen check order."""
    skipped_ids = set(skipped)
    if measured.placements_checked == 0:
        skipped_ids.add(CHECK_PIXEL_EQUALITY)
    checks: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    def add(check_id: str, passed: bool, message: str, details: dict[str, Any]) -> None:
        status = "skipped" if check_id in skipped_ids else ("passed" if passed else "failed")
        checks.append(
            {
                "id": check_id,
                "blocking": True,
                "status": status,
                "message": message,
                "details": details,
            }
        )
        if status == "skipped":
            failures.append({"checkId": check_id, "message": f"{check_id} was skipped."})
        elif status == "failed":
            failures.extend(_failures_for(check_id, measured))

    outside_total = measured.total_outside
    inside = outside_total == 0
    add(
        CHECK_VISIBLE_INSIDE,
        inside,
        "All visible pixels are inside the sheet bounds."
        if inside
        else f"{outside_total} visible pixels lie outside the sheet.",
        {
            "designsChecked": measured.checked_designs,
            "outsidePixels": outside_total,
            "byDesign": {
                design_id: {"pixels": pixels, "sides": measured.outside_sides[design_id]}
                for design_id, pixels in sorted(measured.outside_pixels.items())
            },
        },
    )

    overlaps = measured.overlap_pairs
    add(
        CHECK_NO_OVERLAP,
        overlaps == 0,
        "No dilated masks overlap."
        if overlaps == 0
        else f"{overlaps} pair(s) overlap after dilation.",
        {
            "overlaps": overlaps,
            "dilationRadiusPx": measured.dilation_radius_px,
            "pairs": [
                {"designId": first, "otherDesignId": second, "overlapPixels": pixels}
                for first, second, pixels in measured.overlaps
            ],
        },
    )

    gap = measured.min_pair_gap_px
    edge = measured.min_edge_clearance_px
    gap_ok = all(value >= measured.margin_px for _, _, value in measured.pair_gaps)
    edge_ok = edge is None or edge >= measured.edge_margin_px
    gap_passes = gap_ok and edge_ok
    add(
        CHECK_MINIMUM_GAP,
        gap_passes,
        _gap_message(measured, gap, edge, gap_passes),
        _gap_details(measured, gap, edge),
    )

    mismatched = measured.mismatched_pixels
    not_measured = CHECK_PIXEL_EQUALITY in skipped_ids
    equality_ok = mismatched == 0 and not not_measured
    add(
        CHECK_PIXEL_EQUALITY,
        equality_ok,
        "No renderer was supplied, so the rendered pixels could not be compared."
        if not_measured
        else "Rendered regions match the approved source versions exactly."
        if equality_ok
        else f"{mismatched} pixel(s) differ from the approved source.",
        {
            "placementsChecked": measured.placements_checked,
            "mismatchedPixels": mismatched,
            "pixelsCompared": measured.pixels_compared,
            "clippedPlacements": measured.clipped_placements,
            "byDesign": {
                design_id: pixels
                for design_id, pixels in sorted(measured.pixel_mismatches.items())
                if pixels
            },
        },
    )

    metrics: dict[str, Any] = {
        "designCount": context.design_count,
        "durationMs": context.duration_ms,
        "visiblePixelCount": measured.visible_pixel_count,
        "sheetAreaPx": context.sheet_width_px * context.sheet_height_px,
        "occupancyRatio": round(context.occupancy_ratio, 6),
        "orderingsTried": context.orderings_tried,
    }
    if gap is not None:
        metrics["minimumGapMm"] = round(millimeters_for_pixels(gap, measured.dpi), 4)
    if edge is not None:
        metrics["minimumEdgeClearanceMm"] = round(millimeters_for_pixels(edge, measured.dpi), 4)
    if measured.pairs_beyond_probe:
        metrics["pairsBeyondGapProbe"] = measured.pairs_beyond_probe

    passed = all(check["status"] == "passed" for check in checks)
    return {
        "schemaVersion": "1.0",
        "reportId": report_id or new_report_id(),
        "generatedAt": generated_at or utc_timestamp(),
        "passed": passed,
        "sheet": sheet_geometry(
            context.sheet_width_px, context.sheet_height_px, context.dpi
        ),
        "checks": checks,
        "failures": failures,
        "metrics": metrics,
    }


def _gap_message(measured: Verification, gap: int | None, edge: int | None, passes: bool) -> str:
    if passes:
        if gap is None:
            return (
                f"No design pair is closer than the {measured.gap_probe_px} px probe; "
                "the required gap holds."
            )
        return "All visible pixel gaps meet the configured margin."
    if gap is not None and gap < measured.margin_px:
        return (
            f"The smallest visible-pixel gap is {gap} px, below the required "
            f"{measured.margin_px} px."
        )
    return (
        f"A design is {edge} px from the sheet edge, below the required "
        f"{measured.edge_margin_px} px."
    )


def _gap_details(measured: Verification, gap: int | None, edge: int | None) -> dict[str, Any]:
    details: dict[str, Any] = {
        "requiredGapMm": measured.margin_mm,
        "requiredEdgeMarginMm": measured.edge_margin_mm,
        "pairsMeasured": len(measured.pair_gaps),
        "pairsBeyondProbe": measured.pairs_beyond_probe,
        "violations": [
            {"designId": first, "otherDesignId": second, "gapPx": value}
            for first, second, value in measured.pair_gaps
            if value < measured.margin_px
        ]
        + [
            {"designId": design_id, "clearancePx": clearance}
            for design_id, clearance in sorted(measured.edge_clearances.items())
            if clearance < measured.edge_margin_px
        ],
    }
    if gap is not None:
        details["minimumGapMm"] = round(millimeters_for_pixels(gap, measured.dpi), 4)
    if edge is not None:
        details["minimumEdgeClearanceMm"] = round(millimeters_for_pixels(edge, measured.dpi), 4)
    return details


def _failures_for(check_id: str, measured: Verification) -> list[dict[str, Any]]:
    if check_id == CHECK_VISIBLE_INSIDE:
        return [
            {
                "checkId": check_id,
                "designId": design_id,
                "message": (
                    f"{pixels} visible pixels exceed the "
                    f"{'/'.join(measured.outside_sides[design_id])} sheet edge."
                ),
                "details": {"outsidePixels": pixels, "sides": measured.outside_sides[design_id]},
            }
            for design_id, pixels in sorted(measured.outside_pixels.items())
        ]
    if check_id == CHECK_NO_OVERLAP:
        return [
            {
                "checkId": check_id,
                "designId": first,
                "message": f"Dilated masks of {first} and {second} overlap by {pixels} px.",
                "details": {"otherDesignId": second, "overlapPixels": pixels},
            }
            for first, second, pixels in measured.overlaps
        ]
    if check_id == CHECK_MINIMUM_GAP:
        gap = measured.min_pair_gap_px
        if gap is not None and gap < measured.margin_px:
            worst = min(measured.pair_gaps, key=lambda entry: entry[2])
            return [
                {
                    "checkId": check_id,
                    "designId": worst[0],
                    "message": (
                        f"Gap of {worst[2]} px between {worst[0]} and {worst[1]} is below the "
                        f"required {measured.margin_px} px."
                    ),
                    "details": {"otherDesignId": worst[1], "gapPx": worst[2]},
                }
            ]
        return [
            {
                "checkId": check_id,
                "designId": design_id,
                "message": (
                    f"Design is {clearance} px from the sheet edge, below the required "
                    f"{measured.edge_margin_px} px."
                ),
                "details": {"clearancePx": clearance},
            }
            for design_id, clearance in sorted(measured.edge_clearances.items())
            if clearance < measured.edge_margin_px
        ]
    if check_id == CHECK_PIXEL_EQUALITY:
        if measured.placements_checked == 0:
            return [
                {
                    "checkId": check_id,
                    "designId": None,
                    "message": "No placement could be rendered for comparison.",
                    "details": {},
                }
            ]
        return [
            {
                "checkId": check_id,
                "designId": design_id,
                "message": f"Rendered layer differs from the approved source in {pixels} px.",
                "details": {"mismatchedPixels": pixels},
            }
            for design_id, pixels in sorted(measured.pixel_mismatches.items())
            if pixels
        ]
    return []


def dilation_radius_px(margin_px: int) -> int:
    """Half the required clearance, rounded up, in whole pixels."""
    return math.ceil(max(margin_px - 1, 0) / 2)


__all__ = [
    "CHECK_MINIMUM_GAP",
    "CHECK_NO_OVERLAP",
    "CHECK_ORDER",
    "CHECK_PIXEL_EQUALITY",
    "CHECK_VISIBLE_INSIDE",
    "PlacedMask",
    "Verification",
    "build_placed_mask",
    "build_placed_masks",
    "ReportContext",
    "build_report",
    "dilation_radius_px",
    "dilated_overlap_px",
    "box_gap",
    "min_gap_px",
    "verify_layout",
]
