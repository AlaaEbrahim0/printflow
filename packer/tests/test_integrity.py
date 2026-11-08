"""Adversarial integrity tests: the four checks must refuse, not reassure.

Designs are pushed together, turned the wrong way, thinned to one faint pixel
and pressed against the sheet edge; each case asserts that the report says
``failed`` and names the design responsible.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pytest
from helpers import circle, faint, gradient, request_document, ring, solid

from printsheet_packer.contracts import ContractStore, parse_pack_request
from printsheet_packer.errors import PackerError
from printsheet_packer.integrity import (
    CHECK_MINIMUM_GAP,
    CHECK_NO_OVERLAP,
    CHECK_ORDER,
    CHECK_PIXEL_EQUALITY,
    CHECK_VISIBLE_INSIDE,
    PlacedMask,
    ReportContext,
    build_placed_mask,
    build_report,
    dilation_radius_px,
    min_gap_px,
    verify_layout,
)
from printsheet_packer.masks import occupancy_from_alpha, required_margin_px
from printsheet_packer.render import RenderPlacement, SheetRenderer, rgba_loader_from
from printsheet_packer.units import pixels_for_centimeters

DPI = 300
THRESHOLD = 5


@dataclass
class Sheet:
    """A hand-built sheet: designs placed by hand, then measured honestly."""

    width_px: int
    height_px: int
    arrays: dict[str, np.ndarray] = field(default_factory=dict)
    designs: list[PlacedMask] = field(default_factory=list)

    def add(self, name: str, array: np.ndarray, x: int, y: int, rotation: int = 0) -> PlacedMask:
        self.arrays[name] = array
        design = build_placed_mask(name, f"v-{name}", array, rotation, x, y, THRESHOLD, name)
        self.designs.append(design)
        return design

    def renderer(self, rotations: dict[str, int] | None = None) -> SheetRenderer:
        rotations = rotations or {}
        placements = [
            RenderPlacement(
                design.design_id,
                design.x_px,
                design.y_px,
                design.image_width_px,
                design.image_height_px,
                rotations.get(design.design_id, design.rotation_deg),
            )
            for design in self.designs
        ]
        return SheetRenderer(
            self.width_px, self.height_px, placements, rgba_loader_from(self.arrays)
        )

    def measure(
        self, margin_mm: float, edge_mm: float = 0, *, renderer: SheetRenderer | None = "auto"
    ):
        margin_px = required_margin_px(margin_mm, DPI)
        chosen = self.renderer() if renderer == "auto" else renderer
        return verify_layout(
            self.designs,
            dpi=DPI,
            margin_px=margin_px,
            margin_mm=margin_mm,
            edge_margin_px=required_margin_px(edge_mm, DPI),
            edge_margin_mm=edge_mm,
            dilation_radius_px=dilation_radius_px(margin_px),
            sheet_width_px=self.width_px,
            sheet_height_px=self.height_px,
            renderer=chosen,
        )

    def document(self, measured) -> dict:
        return build_report(
            measured,
            ReportContext(
                dpi=DPI,
                sheet_width_px=self.width_px,
                sheet_height_px=self.height_px,
                design_count=len(self.designs),
                duration_ms=7,
                occupancy_ratio=0.25,
                orderings_tried=2,
            ),
        )

    def report(self, margin_mm: float, edge_mm: float = 0, **kwargs):
        measured = self.measure(margin_mm, edge_mm, **kwargs)
        return measured, self.document(measured)


def sheet_pixels(design: PlacedMask) -> np.ndarray:
    rows, columns = np.nonzero(design.occupied)
    return np.stack([columns + design.bbox.x0, rows + design.bbox.y0], axis=1)


def brute_force_gap(first: PlacedMask, second: PlacedMask) -> int:
    a, b = sheet_pixels(first), sheet_pixels(second)
    return int(np.abs(a[:, None, :] - b[None, :, :]).max(axis=2).min())


def status(document: dict, index: int) -> str:
    return document["checks"][index]["status"]


def first_occupied_column(array: np.ndarray) -> int:
    return int(np.argmax(occupancy_from_alpha(array[..., 3], THRESHOLD).any(axis=0)))


def test_report_shape_is_the_four_frozen_checks_in_order() -> None:
    sheet = Sheet(400, 120)
    sheet.add("a", circle(60, 40), 10, 10)
    _measured, document = sheet.report(2)
    assert [check["id"] for check in document["checks"]] == list(CHECK_ORDER)
    assert all(check["blocking"] is True for check in document["checks"])
    assert document["passed"] is True
    assert document["failures"] == []
    assert ContractStore().validate("integrity-report", document) == []


def test_a_missing_renderer_skips_the_report_to_not_passed() -> None:
    sheet = Sheet(400, 120)
    sheet.add("a", circle(60, 40), 10, 10)
    document = sheet.document(sheet.measure(2, renderer=None))
    assert status(document, 3) == "skipped"
    assert document["passed"] is False
    assert CHECK_PIXEL_EQUALITY in {failure["checkId"] for failure in document["failures"]}


def test_an_explicitly_skipped_check_is_never_a_pass() -> None:
    sheet = Sheet(400, 120)
    sheet.add("a", circle(60, 40), 10, 10)
    measured = sheet.measure(2)
    document = build_report(
        measured,
        ReportContext(
            dpi=DPI,
            sheet_width_px=400,
            sheet_height_px=120,
            design_count=1,
            duration_ms=1,
            occupancy_ratio=0.1,
            orderings_tried=1,
        ),
        skipped=[CHECK_NO_OVERLAP],
    )
    assert status(document, 1) == "skipped"
    assert document["passed"] is False


def test_ring_hole_stays_a_hole_and_permits_interlocking() -> None:
    sheet = Sheet(120, 120)
    donut = sheet.add("ring", ring(120, 120), 0, 0)
    core = sheet.add("core", circle(30, 30), 45, 45)
    assert not donut.occupied[60, 60], "the hole is not occupied"
    assert min_gap_px(donut, core, 400) == brute_force_gap(donut, core)
    assert donut.bbox.x0 < core.bbox.x0 and core.bbox.x1 < donut.bbox.x1, "nested in the ring"
    _measured, document = sheet.report(0)
    assert document["passed"] is True


def test_single_faint_pixel_counts_as_visible_ink() -> None:
    array = faint(80, 60, alpha=6)
    sheet = Sheet(200, 100)
    design = sheet.add("faint", array, 20, 20)
    assert design.visible_pixels == 1
    assert design.bbox.x0 == 20 + first_occupied_column(array)
    measured, document = sheet.report(0)
    assert measured.visible_pixel_count == 1
    assert document["passed"] is True


def test_two_faint_pixels_closer_than_the_margin_fail_gap_and_overlap() -> None:
    sheet = Sheet(200, 200)
    sheet.add("a", faint(40, 40, alpha=6), 0, 0)
    sheet.add("b", faint(40, 40, alpha=7), 20, 20)
    measured, document = sheet.report(2)
    assert measured.min_pair_gap_px == 20
    assert document["passed"] is False
    failing = {check["id"] for check in document["checks"] if check["status"] == "failed"}
    assert {CHECK_MINIMUM_GAP, CHECK_NO_OVERLAP} <= failing
    assert {failure["designId"] for failure in document["failures"]} == {"a"}
    assert document["metrics"]["minimumGapMm"] < 2


def test_smoke_gradient_is_measured_at_its_faint_edge() -> None:
    array = gradient(120, 40)
    sheet = Sheet(400, 100)
    smoke = sheet.add("smoke", array, 10, 10)
    assert smoke.bbox.x0 == 10 + first_occupied_column(array)
    spark = sheet.add("spark", faint(20, 20, alpha=250), 10, 25)
    measured, document = sheet.report(0.1)
    assert measured.min_pair_gap_px == brute_force_gap(smoke, spark)
    assert document["passed"] is False, "the spark sits inside the smoke's faint pixels"


def test_a_tall_design_is_measured_against_the_bottom_edge() -> None:
    banner = solid(40, 900)
    sheet = Sheet(200, 921)
    sheet.add("banner", banner, 30, 20)
    measured, document = sheet.report(1)
    assert measured.min_edge_clearance_px == 1
    assert document["passed"] is True
    cramped = Sheet(200, 910)
    cramped.add("banner", banner, 30, 20)
    _cramped_measured, cramped_document = cramped.report(1)
    assert status(cramped_document, 0) == "failed"
    assert cramped_document["failures"][0]["details"]["sides"] == ["bottom"]


def test_clipping_transparent_source_padding_fails_pixel_equality() -> None:
    source = np.zeros((100, 50, 4), dtype=np.uint8)
    source[10:80, 5:45] = (120, 80, 40, 255)
    sheet = Sheet(60, 80)
    sheet.add("padded", source, 0, 0)

    measured, document = sheet.report(0)

    assert measured.total_outside == 0
    assert measured.clipped_placements == 1
    assert status(document, 0) == "passed"
    assert status(document, 3) == "failed"
    assert document["passed"] is False
    assert document["failures"][-1]["designId"] == "padded"


def test_clipping_transparent_source_padding_at_sheet_origin_fails() -> None:
    source = np.zeros((40, 50, 4), dtype=np.uint8)
    source[:, 10:40] = (120, 80, 40, 255)
    sheet = Sheet(50, 40)
    sheet.add("left-padded", source, -10, 0)

    measured, document = sheet.report(0)

    assert measured.total_outside == 0
    assert measured.clipped_placements == 1
    assert measured.mismatched_pixels == 0
    assert status(document, 3) == "failed"


def test_a_deliberate_overlap_is_reported_with_both_designs() -> None:
    sheet = Sheet(200, 100)
    sheet.add("left", circle(60, 60), 5, 5)
    sheet.add("right", circle(60, 60), 40, 5)
    measured, document = sheet.report(2)
    assert document["passed"] is False
    assert status(document, 1) == "failed"
    assert measured.overlap_pairs == 1
    pair = document["checks"][1]["details"]["pairs"][0]
    assert {pair["designId"], pair["otherDesignId"]} == {"left", "right"}
    assert document["failures"][0]["details"]["otherDesignId"] == "right"


def test_a_placement_past_the_sheet_edge_is_a_hard_failure() -> None:
    sheet = Sheet(200, 60)
    sheet.add("hanging", circle(60, 40), 170, 10)
    _measured, document = sheet.report(1)
    assert status(document, 0) == "failed"
    failure = document["failures"][0]
    assert failure["checkId"] == CHECK_VISIBLE_INSIDE
    assert failure["designId"] == "hanging"
    assert "right" in failure["details"]["sides"]


def test_touching_the_edge_margin_fails_the_minimum_gap_check() -> None:
    sheet = Sheet(200, 60)
    sheet.add("flush", circle(40, 30), 0, 0)
    _measured, document = sheet.report(1, edge_mm=2)
    assert status(document, 2) == "failed"
    assert document["failures"][0]["checkId"] == CHECK_MINIMUM_GAP
    assert document["failures"][0]["designId"] == "flush"


def test_a_rotation_the_renderer_did_not_apply_fails_pixel_equality() -> None:
    array = circle(50, 24)
    array[0, 0] = (9, 9, 9, 255)  # break the symmetry so a turn is detectable
    honest = Sheet(80, 40)
    honest.add("turned", array, 5, 5, rotation=0)
    measured, document = honest.report(0)
    assert measured.mismatched_pixels == 0
    assert document["passed"] is True

    lying = Sheet(80, 40)
    lying.add("turned", array, 5, 5, rotation=0)
    tampered = lying.measure(0, renderer=lying.renderer(rotations={"turned": 180}))
    assert tampered.mismatched_pixels > 0
    assert status(lying.document(tampered), 3) == "failed"


def test_a_crop_mismatch_is_caught_by_pixel_equality() -> None:
    array = circle(60, 40)
    sheet = Sheet(80, 60)
    honest = sheet.add("cropped", array, 0, 0)
    sheet.designs[-1] = PlacedMask(
        design_id="cropped",
        version_id="v",
        display_name="cropped",
        occupied=honest.occupied,
        bbox=honest.bbox,
        rotation_deg=0,
        x_px=0,
        y_px=0,
        image_width_px=59,
        image_height_px=40,
    )
    measured, document = sheet.report(0)
    every_pixel_in_the_file = 60 * 40
    assert measured.mismatched_pixels == every_pixel_in_the_file
    assert status(document, 3) == "failed"
    assert document["failures"][0]["details"]["mismatchedPixels"] == every_pixel_in_the_file


def test_a_footprint_that_is_not_a_rotation_is_refused() -> None:
    sheet = Sheet(60, 40)
    sheet.add("wrong", circle(40, 24), 0, 0)
    renderer = sheet.renderer()
    renderer.placements = (RenderPlacement("wrong", 0, 0, 41, 24, 0),)
    with pytest.raises(PackerError, match="declares 41x24"):
        renderer.render_strip(0, 40)


def test_metrics_are_omitted_rather_than_invented() -> None:
    sheet = Sheet(6850, 40)
    sheet.add("a", circle(20, 20), 0, 0)
    sheet.add("b", circle(20, 20), 6830, 0)
    measured, document = sheet.report(100)
    assert measured.pair_gaps == []
    assert measured.pairs_beyond_probe == 1
    assert "minimumGapMm" not in document["metrics"]
    assert document["metrics"]["pairsBeyondGapProbe"] == 1
    assert document["passed"] is True


def test_sheet_width_uses_the_canonical_conversion() -> None:
    assert pixels_for_centimeters(58, 300) == 6850
    request = parse_pack_request(request_document([circle(40, 30)], rollWidthCm=58, dpi=300))
    assert request.sheet_width_px == 6850


def test_rotated_masks_have_a_tight_visible_box() -> None:
    """The cropped mask is the bbox, so all four of its borders carry ink."""
    array = circle(70, 30)
    for rotation in (0, 90, 180, 270):
        sheet = Sheet(200, 200)
        design = sheet.add("r", array, 4, 6, rotation=rotation)
        box = design.bbox
        mask = design.occupied
        assert mask.shape == (box.height, box.width)
        assert mask[0].any() and mask[-1].any() and mask[:, 0].any() and mask[:, -1].any()
        assert design.x_px == 4 and design.y_px == 6
