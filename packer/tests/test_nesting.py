"""Nesting: ordering, rotations, sizing, refusals and determinism."""

from __future__ import annotations

import numpy as np
import pytest
from helpers import circle, request_document, ring, solid, specs, write_storage

from printsheet_packer.contracts import PackRequest, parse_pack_request
from printsheet_packer.errors import PackerError
from printsheet_packer.masks import required_margin_px
from printsheet_packer.nesting import Packer
from printsheet_packer.pipeline import load_masks
from printsheet_packer.storage import StorageRoot
from printsheet_packer.units import pixels_for_centimeters


def build_packer(
    tmp_path, items, *, allow_rotation: bool | None = None, **overrides
) -> tuple[PackRequest, Packer]:
    designs = specs(items, allow_rotation=allow_rotation)
    request = parse_pack_request(request_document(designs, **overrides))
    masks, _images = load_masks(request, StorageRoot(write_storage(tmp_path, designs)))
    return request, Packer(request, masks)


def pack(tmp_path, items, **overrides):
    _request, packer = build_packer(tmp_path, items, **overrides)
    layout = packer.place(packer.deterministic_order())
    assert layout is not None
    return layout


def test_sheet_width_is_the_canonical_conversion(tmp_path) -> None:
    layout = pack(tmp_path, [circle(40, 30)], rollWidthCm=58, dpi=300)
    assert layout.sheet_width_px == pixels_for_centimeters(58, 300) == 6850


def test_single_design_lands_inside_the_sheet_and_sizes_the_height(tmp_path) -> None:
    layout = pack(tmp_path, [ring(60, 40)], rollWidthCm=4, edgeMarginMm=1)
    placed = layout.placed[0]
    edge = required_margin_px(1, 300)
    box = placed.visible_bbox_px
    assert box.x0 >= edge
    assert box.x1 <= layout.sheet_width_px - edge
    assert box.y0 >= edge
    assert layout.sheet_height_px == placed.y_px + placed.footprint.image_height_px


def test_transparent_padding_remains_inside_the_sheet(tmp_path) -> None:
    padded = np.pad(circle(20, 40), ((10, 10), (5, 5), (0, 0)))
    layout = pack(tmp_path, [padded], rollWidthCm=2)
    placed = layout.placed[0]

    assert placed.x_px >= 0
    assert placed.x_px + placed.footprint.image_width_px <= layout.sheet_width_px
    assert placed.y_px >= 0
    assert placed.y_px + placed.footprint.image_height_px <= layout.sheet_height_px


def test_full_source_width_must_fit_the_roll_even_with_transparent_padding(tmp_path) -> None:
    padded = np.pad(solid(20, 20), ((0, 0), (50, 50), (0, 0)))

    _request, packer = build_packer(
        tmp_path,
        [padded],
        allow_rotation=False,
        rollWidthCm=0.8,
        marginMm=0,
        edgeMarginMm=0,
    )
    layout = packer.run()
    assert layout.placed == []
    assert layout.unplaced[0].reason == "exceeds-roll"
    assert layout.unplaced[0].details["requiredWidthPx"] == 120


def test_largest_visible_area_is_placed_first(tmp_path) -> None:
    _request, packer = build_packer(
        tmp_path, [solid(20, 20), solid(60, 30), solid(40, 40)], rollWidthCm=2
    )
    areas = [candidate.mask.visible_pixels for candidate in packer.deterministic_order()]
    assert areas == sorted(areas, reverse=True)
    assert areas == [1800, 1600, 400]


def test_rotations_are_only_tried_when_the_design_allows_them(tmp_path) -> None:
    wide = circle(300, 30)
    layout = pack(tmp_path, [wide], rollWidthCm=2)
    assert layout.placed[0].rotation_deg == 90, "only the turned layout fits a 2 cm roll"

    _request, packer = build_packer(tmp_path, [wide], rollWidthCm=20)
    rotations = [option.footprint.rotation_deg for option in packer.candidates[0].options]
    assert rotations == [0, 90, 180, 270]

    _request, packer = build_packer(tmp_path, [wide], allow_rotation=False, rollWidthCm=2)
    layout = packer.run()
    assert layout.unplaced[0].reason == "exceeds-roll"
    assert layout.unplaced[0].details["rotationsTried"] == [0]


def test_a_wide_design_is_turned_not_resampled(tmp_path) -> None:
    layout = pack(tmp_path, [solid(3000, 40)], rollWidthCm=10)
    placed = layout.placed[0]
    assert placed.rotation_deg == 90
    assert (placed.footprint.image_width_px, placed.footprint.image_height_px) == (40, 3000)


def test_over_width_design_has_structured_unplaced_details(tmp_path) -> None:
    designs = specs([solid(4000, 20)], allow_rotation=False)
    request = parse_pack_request(request_document(designs, rollWidthCm=10, edgeMarginMm=1))
    masks, _ = load_masks(request, StorageRoot(write_storage(tmp_path, designs)))
    layout = Packer(request, masks).run()
    details = layout.unplaced[0].details
    assert details["usableWidthPx"] == request.sheet_width_px - 2 * required_margin_px(1, 300)
    assert details["requiredWidthPx"] == 4000


def test_same_seed_and_inputs_reproduce_the_same_layout(tmp_path) -> None:
    designs = specs([circle(60, 40), ring(70, 30), solid(50, 50), circle(45, 80)])
    request = parse_pack_request(request_document(designs, rollWidthCm=6, randomizedOrderings=3))
    masks, _ = load_masks(request, StorageRoot(write_storage(tmp_path, designs)))
    packer = Packer(request, masks)
    assert packer.run().key() == packer.run().key()


def test_more_orderings_never_make_the_sheet_taller(tmp_path) -> None:
    designs = specs([circle(70, 50), ring(60, 60), solid(40, 90)])
    heights = []
    for orderings in (1, 6):
        request = parse_pack_request(
            request_document(
                designs, rollWidthCm=5, randomizedOrderings=orderings, seed=99, timeBudgetMs=5000
            )
        )
        masks, _ = load_masks(request, StorageRoot(write_storage(tmp_path, designs)))
        layout = Packer(request, masks).run()
        heights.append(layout.sheet_height_px)
        assert layout.orderings_tried == orderings + 1
    assert heights[1] <= heights[0]


def test_no_interlocking_mode_keeps_boxes_apart(tmp_path) -> None:
    _request, packer = build_packer(
        tmp_path,
        [ring(80, 80), ring(70, 70)],
        rollWidthCm=5,
        noInterlocking=True,
        randomizedOrderings=2,
    )
    layout = packer.run()
    for placed in layout.placed:
        grid = placed.footprint.grid
        rows = np.nonzero(grid.any(axis=1))[0]
        columns = np.nonzero(grid.any(axis=0))[0]
        assert grid[rows[0] : rows[-1] + 1, columns[0] : columns[-1] + 1].all()


def test_polygon_nesting_places_a_design_inside_another_design_hole(tmp_path) -> None:
    frame = solid(100, 100)
    frame[20:80, 20:80, 3] = 0
    layout = pack(
        tmp_path,
        [frame, solid(40, 40)],
        rollWidthCm=3.53,
        dpi=72,
        marginMm=0,
        edgeMarginMm=0,
    )
    by_shape = {item.candidate.mask.image_width_px: item for item in layout.placed}
    outer = by_shape[100]
    inner = by_shape[40]
    assert 20 <= inner.x_px - outer.x_px <= 40
    assert 20 <= inner.y_px - outer.y_px <= 40
    assert layout.sheet_height_px <= 100


def test_placements_record_the_rotated_footprint(tmp_path) -> None:
    layout = pack(tmp_path, [circle(130, 40)], rollWidthCm=3)
    placed = layout.placed[0]
    assert placed.footprint.image_width_px == (40 if placed.rotation_deg in (90, 270) else 130)
    payload = placed.to_placement().to_json(300)
    assert payload["widthPx"] == placed.footprint.image_width_px
    assert payload["rotationDeg"] == placed.rotation_deg
    assert payload["xCm"] == pytest.approx(placed.x_px * 2.54 / 300)


def test_positions_are_whole_pixels_not_grid_quantized(tmp_path) -> None:
    _request, packer = build_packer(tmp_path, [circle(77, 53), ring(61, 41)], rollWidthCm=5)
    layout = packer.run()
    for placed in layout.placed:
        assert isinstance(placed.x_px, int)
        assert isinstance(placed.y_px, int)


def test_randomised_orderings_never_beat_the_deterministic_one_by_accident(tmp_path) -> None:
    designs = specs([circle(90, 30), solid(60, 60)])
    request = parse_pack_request(
        request_document(designs, rollWidthCm=4, randomizedOrderings=8, seed=4, timeBudgetMs=5000)
    )
    masks, _ = load_masks(request, StorageRoot(write_storage(tmp_path, designs)))
    packer = Packer(request, masks)
    baseline = packer.place(packer.deterministic_order())
    assert packer.run().sheet_height_px <= baseline.sheet_height_px


def test_empty_design_list_is_rejected() -> None:
    request = parse_pack_request(request_document([circle(30, 30)]))
    without_designs = PackRequest(**{**request.__dict__, "designs": ()})
    with pytest.raises(PackerError, match="at least one design"):
        Packer(without_designs, {})
