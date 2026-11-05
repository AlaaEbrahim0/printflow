"""Masks: thresholding, holes, dilation, grids and 90-degree rotation."""

from __future__ import annotations

import numpy as np
import pytest
from helpers import faint, gradient, png_bytes, ring, solid

from printsheet_packer.contracts import DesignInput
from printsheet_packer.errors import PackerError, SourceDimensionError
from printsheet_packer.masks import (
    BoundingBox,
    block_radius_cells,
    build_design_mask,
    build_footprint,
    cell_size_px,
    dilate_block,
    dilate_square,
    grid_extent,
    load_rgba,
    occupancy_from_alpha,
    required_margin_px,
    rotate_bbox,
    rotate_degrees,
    rotate_rgba,
    simple_footprint,
    to_grid,
    visible_bbox,
)


def design(width: int, height: int) -> DesignInput:
    return DesignInput(
        design_id="d1",
        version_id="v1",
        file_path="x.png",
        width_px=width,
        height_px=height,
        allow_rotation=True,
    )


def brute_dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    out = np.zeros_like(mask)
    height, width = mask.shape
    for y in range(height):
        for x in range(width):
            window = mask[max(0, y - radius) : y + radius + 1, max(0, x - radius) : x + radius + 1]
            out[y, x] = window.any()
    return out


def test_threshold_includes_faint_smoke_and_excludes_zero() -> None:
    alpha = np.array([[0, 5, 6, 255]], dtype=np.uint8)
    assert list(occupancy_from_alpha(alpha, 5)[0]) == [False, False, True, True]


def test_ring_keeps_its_hole() -> None:
    mask = occupancy_from_alpha(ring(40, 30)[..., 3], 5)
    box = visible_bbox(mask)
    assert box is not None
    assert not mask[mask.shape[0] // 2, mask.shape[1] // 2], "the hole must not be filled"
    assert mask[box.y0, box.x0 : box.x1].any(), "top border of a tight box is occupied"
    assert mask[box.y1 - 1, box.x0 : box.x1].any()
    assert mask[box.y0 : box.y1, box.x0].any()
    assert mask[box.y0 : box.y1, box.x1 - 1].any()
    assert not mask[:, : box.x0].any() and not mask[:, box.x1 :].any()


def test_gradient_is_occupied_where_alpha_beats_the_threshold() -> None:
    array = gradient(60, 10)
    mask = occupancy_from_alpha(array[..., 3], 5)
    assert mask[:, 0].sum() == 0
    assert mask[:, -1].all()


def test_single_faint_pixel_defines_the_bounding_box() -> None:
    array = faint(50, 40, alpha=6)
    built = build_design_mask(design(50, 40), array, 5)
    assert built.bbox == BoundingBox(25, 20, 26, 21)
    assert built.visible_pixels == 1
    with pytest.raises(PackerError, match="no pixel above the alpha threshold"):
        build_design_mask(design(50, 40), array, 6)


def test_declared_and_actual_dimensions_must_match() -> None:
    with pytest.raises(SourceDimensionError):
        build_design_mask(design(41, 30), solid(40, 30))


def test_decoding_round_trips_through_png_without_resampling() -> None:
    array = ring(23, 17)
    assert np.array_equal(load_rgba(png_bytes(array)), array)


@pytest.mark.parametrize("radius", [0, 1, 3, 7])
@pytest.mark.parametrize("shape", [(9, 13), (23, 7), (40, 40)])
def test_dilation_matches_a_brute_force_square_kernel(shape: tuple[int, int], radius: int) -> None:
    rng = np.random.default_rng(sum(shape) + radius)
    mask = rng.random(shape) > 0.8
    assert np.array_equal(dilate_square(mask, radius), brute_dilate(mask, radius))
    grown = dilate_block(mask, radius)
    assert grown.shape == (shape[0] + 2 * radius, shape[1] + 2 * radius)
    assert np.array_equal(grown, brute_dilate(np.pad(mask, radius, constant_values=False), radius))


def test_dilation_never_loses_an_occupied_pixel() -> None:
    mask = occupancy_from_alpha(ring(30, 30)[..., 3], 5)
    grown = dilate_block(mask, 4)
    assert grown[4:-4, 4:-4][mask].all()
    assert grown.sum() >= mask.sum()


def test_grid_rounds_up_and_never_underestimates() -> None:
    mask = occupancy_from_alpha(ring(37, 29)[..., 3], 5)
    cell = 5
    grid = to_grid(mask, cell)
    assert grid.shape == (grid_extent(mask.shape[0], cell), grid_extent(mask.shape[1], cell))
    assert mask.shape == (29, 37)
    expanded = np.kron(grid, np.ones((cell, cell), dtype=bool))[: mask.shape[0], : mask.shape[1]]
    assert (mask & ~expanded).sum() == 0


def test_cell_size_and_margin_conversion() -> None:
    assert cell_size_px(5, 300) == 59
    assert cell_size_px(0.05, 72) == 1
    assert required_margin_px(30, 300) == 355
    for margin in (0, 1, 59, 118, 355, 1000):
        radius = block_radius_cells(margin, 59)
        assert 2 * radius * 59 + 1 >= margin


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotation_only_transposes_and_swaps_dimensions(rotation: int) -> None:
    array = gradient(37, 21)
    rotated = rotate_rgba(array, rotation)
    height, width = array.shape[:2]
    expected = (width, height) if rotation in (90, 270) else (height, width)
    assert rotated.shape[:2] == expected
    assert np.array_equal(np.sort(rotated.ravel()), np.sort(array.ravel()))


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_numpy_rotation_matches_pillow_transpose(rotation: int) -> None:
    from PIL import Image

    array = solid(23, 41)
    transposed = {
        0: None,
        90: Image.Transpose.ROTATE_270,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_90,
    }[rotation]
    image = Image.fromarray(array, "RGBA")
    if transposed is not None:
        image = image.transpose(transposed)
    assert np.array_equal(np.array(image), rotate_degrees(array, rotation))


def test_rotate_bbox_tracks_the_pixels() -> None:
    array = ring(60, 40)
    mask = build_design_mask(design(60, 40), array)
    for rotation in (0, 90, 180, 270):
        box, width, height = rotate_bbox(mask.bbox, 60, 40, rotation)
        rotated = rotate_degrees(mask.occupied, rotation)
        rebuilt = build_design_mask(design(width, height), rotate_rgba(array, rotation))
        assert rebuilt.bbox == box
        assert np.array_equal(rebuilt.occupied, rotated)


def test_rotate_bbox_rejects_other_angles() -> None:
    with pytest.raises(PackerError, match="0/90/180/270"):
        rotate_bbox(BoundingBox(0, 0, 4, 4), 10, 10, 45)


def test_footprint_block_covers_the_grid_and_the_padding() -> None:
    mask = build_design_mask(design(50, 40), ring(50, 40))
    cell = 7
    margin = required_margin_px(2, 300)
    footprint = build_footprint(mask, 0, cell, margin)
    radius = footprint.radius_cells
    expected = (footprint.grid.shape[0] + 2 * radius, footprint.grid.shape[1] + 2 * radius)
    assert footprint.block.shape == expected
    rows, columns = footprint.grid.shape
    anchor = footprint.block[radius : radius + rows, radius : radius + columns]
    assert anchor[footprint.grid].all()
    assert footprint.visible_pixels == mask.visible_pixels


def test_footprint_rotation_uses_rotated_geometry() -> None:
    mask = build_design_mask(design(60, 24), solid(60, 24))
    straight = build_footprint(mask, 0, 6, 12)
    turned = build_footprint(mask, 90, 6, 12)
    assert (turned.image_width_px, turned.image_height_px) == (24, 60)
    assert turned.grid.shape == straight.grid.shape[::-1]
    assert turned.visible_pixels == straight.visible_pixels


def test_no_interlocking_uses_the_bounding_box_or_the_hull() -> None:
    grid = np.zeros((9, 9), dtype=bool)
    grid[2, 4] = grid[6, 4] = grid[4, 2] = grid[4, 6] = True
    filled = simple_footprint(grid, "bbox")
    assert filled[2:7, 2:7].all()
    assert not filled[0, 0]
    hull = simple_footprint(grid, "hull")
    assert (hull & ~filled).sum() == 0
    assert hull.sum() >= grid.sum()
    assert np.array_equal(simple_footprint(grid, "none"), grid)
    with pytest.raises(PackerError):
        simple_footprint(grid, "wat")
