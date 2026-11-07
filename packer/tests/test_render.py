"""Strip renderer: band boundaries, rotations, transparency, memory shape."""

from __future__ import annotations

import numpy as np
import pytest
from helpers import blank, circle, gradient, ring, solid

from printsheet_packer.errors import PackerError
from printsheet_packer.masks import rotate_rgba
from printsheet_packer.render import (
    RenderPlacement,
    SheetRenderer,
    preview_from_renderer,
    rgba_loader_from,
)


def reference_sheet(width: int, height: int, placements, arrays) -> np.ndarray:
    """An honest full-sheet composite, used only for small test sheets."""
    sheet = np.zeros((height, width, 4), dtype=np.uint8)
    for placement in placements:
        source = rotate_rgba(arrays[placement.design_id], placement.rotation_deg)
        rows = slice(max(0, placement.y_px), min(height, placement.y_px + placement.height_px))
        columns = slice(max(0, placement.x_px), min(width, placement.x_px + placement.width_px))
        incoming = source[
            rows.start - placement.y_px : rows.stop - placement.y_px,
            columns.start - placement.x_px : columns.stop - placement.x_px,
        ]
        painted = incoming[..., 3] > 0
        region = sheet[rows, columns]
        np.copyto(region, incoming, where=painted[..., None])
        sheet[rows, columns] = region
    return sheet


def assert_ink_equal(rendered: np.ndarray, expected: np.ndarray) -> None:
    """Alpha matches everywhere; RGB matches wherever the source paints ink."""
    assert np.array_equal(rendered[..., 3], expected[..., 3])
    painted = expected[..., 3] > 0
    assert np.array_equal(rendered[painted], expected[painted])
    assert (rendered[~painted, 3] == 0).all()


def build(width: int, height: int, items) -> tuple[SheetRenderer, list[RenderPlacement], dict]:
    arrays = {}
    placements = []
    for index, (array, x, y, rotation) in enumerate(items):
        design_id = f"d{index}"
        arrays[design_id] = array
        rotated = rotate_rgba(array, rotation)
        placements.append(
            RenderPlacement(
                design_id=design_id,
                x_px=x,
                y_px=y,
                width_px=rotated.shape[1],
                height_px=rotated.shape[0],
                rotation_deg=rotation,
            )
        )
    renderer = SheetRenderer(width, height, placements, rgba_loader_from(arrays))
    return renderer, placements, arrays


def test_strip_edges_cutting_through_a_placement_match_a_full_composite() -> None:
    width, height = 70, 60
    renderer, placements, arrays = build(
        width,
        height,
        [
            (circle(30, 24), 4, 8, 0),
            (ring(20, 20), 40, 26, 90),
            (gradient(24, 12), 2, 45, 180),
        ],
    )
    expected = reference_sheet(width, height, placements, arrays)
    for rows in (1, 7, 60):
        bands = [renderer.render_strip(y0, min(y0 + rows, height)) for y0 in range(0, height, rows)]
        assert np.array_equal(np.vstack(bands), expected), f"strip size {rows}"


def test_every_rotation_is_reproduced_exactly() -> None:
    """Ink is byte-exact; only pixels the source paints are written.

    A pixel with alpha 0 carries no ink, so its unused RGB bytes stay at the
    sheet's transparent black. That is the same rule the pixel-equality check
    applies.
    """
    array = circle(23, 17)
    for rotation in (0, 90, 180, 270):
        rotated = rotate_rgba(array, rotation)
        renderer, _placements, _arrays = build(60, 60, [(array, 5, 7, rotation)])
        band = renderer.render_strip(7, 7 + rotated.shape[0])
        assert_ink_equal(band[:, 5 : 5 + rotated.shape[1]], rotated)


def test_transparent_designs_paint_nothing() -> None:
    renderer, _placements, _arrays = build(40, 30, [(blank(20, 15), 3, 4, 0)])
    band = renderer.render_strip(0, 30)
    assert band[..., 3].max() == 0
    assert band.shape == (30, 40, 4)


def test_low_alpha_smoke_is_kept_not_thresholded_away() -> None:
    array = gradient(40, 10)
    renderer, _placements, _arrays = build(60, 20, [(array, 0, 5, 0)])
    band = renderer.render_strip(0, 20)
    assert_ink_equal(band[5:15, 0:40], rotate_rgba(array, 0))
    assert int((band[..., 3] > 0).sum()) == int((array[..., 3] > 0).sum())


def test_a_tall_sheet_is_never_allocated_at_once() -> None:
    width, height = 200, 9000
    renderer, _placements, _arrays = build(width, height, [(circle(60, 40), 10, 8000, 0)])
    largest = 0
    rows_seen = 0
    for _, _, band in renderer.iter_strips(512):
        largest = max(largest, band.shape[0] * band.shape[1])
        rows_seen += band.shape[0]
    assert rows_seen == height
    assert largest <= width * 512, "no band may be taller than the requested strip"
    assert not any(
        getattr(value, "shape", ())[:2] == (height, width) for value in vars(renderer).values()
    )


def test_placements_are_clipped_to_the_sheet_width() -> None:
    renderer, _placements, _arrays = build(30, 20, [(solid(40, 10), 20, 5, 0)])
    band = renderer.render_strip(0, 20)
    assert band[:, 20:30, 3].max() == 255
    assert int((band[..., 3] > 0).sum()) == 10 * 10


def test_out_of_range_strips_are_refused() -> None:
    renderer, _placements, _arrays = build(20, 20, [(solid(8, 8), 1, 1, 0)])
    with pytest.raises(PackerError, match="outside the sheet"):
        renderer.render_strip(20, 24)
    with pytest.raises(PackerError, match="outside the sheet"):
        renderer.render_strip(-1, 5)
    with pytest.raises(PackerError, match="at least one pixel"):
        SheetRenderer(0, 10, (), lambda design_id: solid(4, 4))


def test_placement_geometry_must_match_the_approved_file() -> None:
    array = circle(20, 12)
    renderer, _placements, _arrays = build(40, 30, [(array, 2, 2, 0)])
    renderer.placements = (
        RenderPlacement("d0", 2, 2, 99, 99, 0),
    )
    with pytest.raises(PackerError, match="declares 99x99"):
        renderer.render_strip(0, 30)


def test_preview_is_downscaled_and_keeps_transparency() -> None:
    renderer, _placements, _arrays = build(400, 200, [(circle(120, 80), 40, 60, 0)])
    preview = preview_from_renderer(renderer, target_width_px=100, strip_rows=64)
    assert preview.size == (100, 50)
    assert preview.mode == "RGBA"
    preview_array = np.array(preview)
    assert preview_array[..., 3].min() == 0, "background stays transparent"
    assert preview_array[..., 3].max() > 0


def test_unknown_design_is_reported() -> None:
    renderer, _placements, _arrays = build(40, 30, [(circle(10, 10), 1, 1, 0)])
    with pytest.raises(PackerError, match="not on this sheet"):
        renderer.placement("nope")
