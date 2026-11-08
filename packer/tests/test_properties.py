"""Property-based invariants (hypothesis).

These are the rules the packer must never break, whatever shapes it is handed:
conservative grids, lossless rotations, exact sheet width, placements that stay
inside the sheet and apart from each other, and reproducible results.
"""

from __future__ import annotations

import tempfile
from decimal import Decimal
from pathlib import Path

import numpy as np
from helpers import circle, faint, gradient, request_document, ring, solid, specs, write_storage
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from printsheet_packer.contracts import ContractStore, parse_pack_request
from printsheet_packer.integrity import dilation_radius_px
from printsheet_packer.masks import (
    block_radius_cells,
    cell_size_px,
    grid_extent,
    required_margin_px,
    rotate_degrees,
    rotate_rgba,
    to_grid,
)
from printsheet_packer.pipeline import load_masks, measure_layout, run_pack
from printsheet_packer.storage import StorageRoot
from printsheet_packer.units import pixels_for_centimeters, round_half_away_from_zero

MASKS = st.integers(1, 48).flatmap(
    lambda height: st.integers(1, 48).flatmap(
        lambda width: st.integers(0, 2**31 - 1).map(
            lambda seed, width=width, height=height: np.random.default_rng(seed).random(
                (height, width)
            )
            > 0.75
        )
    )
)
ROTATIONS = st.sampled_from([0, 90, 180, 270])
CELLS = st.integers(1, 17)
DESIGN_KINDS = [
    circle(37, 21),
    ring(41, 41),
    solid(19, 33),
    gradient(44, 12),
    faint(23, 17, alpha=6),
]
DESIGNS = st.lists(st.sampled_from(DESIGN_KINDS), min_size=1, max_size=4)


@settings(deadline=None, max_examples=25)
@given(mask=MASKS, cell=CELLS)
def test_grid_never_underestimates_occupied_area(mask: np.ndarray, cell: int) -> None:
    grid = to_grid(mask, cell)
    assert grid.shape == (grid_extent(mask.shape[0], cell), grid_extent(mask.shape[1], cell))
    expanded = np.kron(grid, np.ones((cell, cell), dtype=bool))
    assert (mask & ~expanded[: mask.shape[0], : mask.shape[1]]).sum() == 0


@settings(deadline=None, max_examples=25)
@given(mask=MASKS, cell=CELLS, rotation=ROTATIONS)
def test_a_rotated_mask_grids_to_the_swapped_extent(
    mask: np.ndarray, cell: int, rotation: int
) -> None:
    straight = to_grid(mask, cell)
    turned = to_grid(rotate_degrees(mask, rotation), cell)
    assert turned.shape == (straight.shape[::-1] if rotation in (90, 270) else straight.shape)


@settings(deadline=None, max_examples=25)
@given(data=st.data(), rotation=ROTATIONS)
def test_rotation_is_a_permutation_of_the_same_pixels(data, rotation: int) -> None:
    height = data.draw(st.integers(1, 40))
    width = data.draw(st.integers(1, 40))
    array = data.draw(
        st.integers(0, 2**31 - 1).map(
            lambda seed, width=width, height=height: np.random.default_rng(seed).integers(
                0, 256, (height, width, 4), dtype=np.uint8
            )
        )
    )
    rotated = rotate_rgba(array, rotation)
    assert np.array_equal(np.sort(rotated.ravel()), np.sort(array.ravel()))
    expected = (width, height) if rotation in (90, 270) else (height, width)
    assert rotated.shape[:2] == expected


@settings(deadline=None, max_examples=50)
@given(roll_mm=st.integers(100, 50_000), dpi=st.integers(72, 1200))
def test_sheet_width_is_the_canonical_rounding(roll_mm: int, dpi: int) -> None:
    assert pixels_for_centimeters(roll_mm / 10, dpi) == round_half_away_from_zero(
        Decimal(roll_mm) * Decimal(dpi) / Decimal("25.4")
    )
    assert pixels_for_centimeters(58, 300) == 6850


@settings(deadline=None, max_examples=50)
@given(
    margin_mm=st.integers(0, 500),
    cell_mm=st.integers(1, 500).map(lambda value: value / 10),
    dpi=st.integers(72, 1200),
)
def test_cell_padding_guarantees_the_requested_gap(
    margin_mm: int, cell_mm: float, dpi: int
) -> None:
    cell = cell_size_px(cell_mm, dpi)
    margin = required_margin_px(margin_mm, dpi)
    radius = block_radius_cells(margin, cell)
    assert radius >= 0
    assert 2 * radius * cell + 1 >= margin
    assert dilation_radius_px(margin) * 2 + 1 >= margin


@settings(deadline=None, max_examples=10, suppress_health_check=[HealthCheck.too_slow])
@given(
    kinds=DESIGNS,
    seed=st.integers(0, 10_000),
    rotation_allowed=st.booleans(),
    margin_mm=st.sampled_from([0, 1, 2, 4]),
)
def test_every_pack_result_is_inside_apart_and_reproducible(
    kinds: list[np.ndarray], seed: int, rotation_allowed: bool, margin_mm: int
) -> None:
    designs = specs(kinds, allow_rotation=rotation_allowed)
    request = parse_pack_request(
        request_document(
            designs,
            rollWidthCm=6,
            marginMm=margin_mm,
            edgeMarginMm=1,
            cellMm=1,
            randomizedOrderings=1,
            timeBudgetMs=2000,
            seed=seed,
        )
    )
    with tempfile.TemporaryDirectory() as directory:
        root = StorageRoot(write_storage(Path(directory), designs))
        first = run_pack(request, root, write_outputs=False, preview=False)
        second = run_pack(request, root, write_outputs=False, preview=False)

    response = first.response
    assert ContractStore().validate("packer-response", response) == []
    assert response["integrityReport"]["passed"] is True
    assert [check["status"] for check in response["integrityReport"]["checks"]] == ["passed"] * 5
    assert response["sheet"]["widthPx"] == first.layout.sheet_width_px
    assert response["placements"] == second.response["placements"]
    assert response["sheet"] == second.response["sheet"]
    first_metrics = response["integrityReport"]["metrics"].copy()
    second_metrics = second.response["integrityReport"]["metrics"].copy()
    first_metrics.pop("durationMs")
    second_metrics.pop("durationMs")
    assert first_metrics == second_metrics

    height = response["sheet"]["heightPx"]
    edge = required_margin_px(request.edge_margin_mm, request.dpi)
    for placement in response["placements"]:
        assert placement["rotationDeg"] in (0, 90, 180, 270)
        assert placement["xCm"] >= 0 and placement["yCm"] >= 0
    for placed in first.layout.placed:
        box = placed.visible_bbox_px
        assert box.x0 >= edge and box.y0 >= edge
        assert box.x1 <= response["sheet"]["widthPx"] - edge
        assert box.y1 <= height - edge


@settings(deadline=None, max_examples=8)
@given(margin_mm=st.sampled_from([0, 2, 5]))
def test_placements_never_overlap_at_full_resolution(margin_mm: int) -> None:
    designs = specs([circle(41, 29), ring(37, 37), solid(23, 47)])
    request = parse_pack_request(
        request_document(
            designs, rollWidthCm=5, marginMm=margin_mm, edgeMarginMm=1, cellMm=1, timeBudgetMs=2000
        )
    )
    with tempfile.TemporaryDirectory() as directory:
        root = StorageRoot(write_storage(Path(directory), designs))
        outcome = run_pack(request, root, write_outputs=False, preview=False)
        masks, images = load_masks(request, root)
    assert masks
    measured, _renderer = measure_layout(outcome.layout, images)
    assert measured.overlaps == []
    assert measured.total_outside == 0
    assert measured.mismatched_pixels == 0
    required = required_margin_px(margin_mm, request.dpi)
    assert all(gap >= required for _a, _b, gap in measured.pair_gaps)
