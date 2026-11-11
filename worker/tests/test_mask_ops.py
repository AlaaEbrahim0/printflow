"""mask_ops: grow/contract, feather and the levels LUT."""

from __future__ import annotations

import numpy as np
import pytest

from app.errors import UnsupportedParameterError
from app.mask_ops import (
    apply_levels,
    feather_mask,
    grow_mask,
    levels_is_identity,
    levels_lut,
)


def disc(size: int = 201, radius: int = 40, value: int = 255) -> np.ndarray:
    mask = np.zeros((size, size), dtype=np.uint8)
    yy, xx = np.ogrid[:size, :size]
    inside = (xx - size // 2) ** 2 + (yy - size // 2) ** 2 <= radius**2
    mask[inside] = value
    return mask


def edge_distance(mask: np.ndarray) -> float:
    """Signed radius of the selection edge measured along the horizontal axis."""

    row = mask[mask.shape[0] // 2]
    columns = np.nonzero(row >= 128)[0]
    return float(columns[-1] - columns[0] + 1) / 2.0


def test_grow_moves_a_circular_edge_by_the_nominal_distance() -> None:
    mask = disc(radius=40)

    grown = grow_mask(mask, 6)

    # A circular offset must add 6 px of radius everywhere, so the diameter grows
    # by 12 -- not by 12 * sqrt(2) as a square kernel would produce.
    assert edge_distance(grown) - edge_distance(mask) == pytest.approx(6.0, abs=1.0)


def test_contract_pulls_the_edge_inward() -> None:
    mask = disc(radius=40)

    shrunk = grow_mask(mask, -5)

    assert edge_distance(mask) - edge_distance(shrunk) == pytest.approx(5.0, abs=1.0)


def test_grow_extends_the_soft_rim_instead_of_stamping_opaque_pixels() -> None:
    mask = disc(radius=30, value=200)

    grown = grow_mask(mask, 4)

    # Newly covered pixels inherit their nearest selected alpha (200), so the rim
    # stays a rim instead of becoming a hard 255 shelf.
    assert grown.max() == 200
    assert (grown > 0).sum() > (mask > 0).sum()


def test_grow_is_a_no_op_without_a_selection() -> None:
    empty = np.zeros((32, 32), dtype=np.uint8)

    assert np.array_equal(grow_mask(empty, 5), empty)
    assert np.array_equal(grow_mask(empty, -5), empty)


def test_grow_below_a_fraction_of_a_pixel_is_ignored() -> None:
    mask = disc(radius=20)

    assert np.array_equal(grow_mask(mask, 0.01), mask)


def test_grow_rejects_non_finite_distances() -> None:
    with pytest.raises(UnsupportedParameterError):
        grow_mask(disc(), float("inf"))


def test_feather_softens_the_ramp() -> None:
    mask = disc(radius=30)

    feathered = feather_mask(mask, 4)

    assert feathered.shape == mask.shape
    # The hard edge picks up intermediate values, and the core stays opaque.
    assert 0 < feathered[mask.shape[0] // 2, mask.shape[1] // 2 + 31] < 255
    assert feathered[mask.shape[0] // 2, mask.shape[1] // 2] == 255


def test_feather_zero_is_a_no_op() -> None:
    mask = disc(radius=10)

    assert np.array_equal(feather_mask(mask, 0), mask)
    assert np.array_equal(feather_mask(mask, -3), mask)


def test_levels_identity_lut_maps_every_value_to_itself() -> None:
    lut = levels_lut()

    assert np.array_equal(lut, np.arange(256, dtype=np.uint8))


def test_levels_black_and_white_points_stretch_the_ramp() -> None:
    lut = levels_lut(black_point=50, white_point=200)

    assert lut[50] == 0
    assert lut[200] == 255
    assert lut[0] == 0 and lut[255] == 255
    assert lut[125] == 128  # midpoint of the new range


def test_levels_gamma_bends_the_midpoint() -> None:
    bright = levels_lut(gamma=2.0)
    dark = levels_lut(gamma=0.5)

    assert bright[128] > 128
    assert dark[128] < 128
    # The endpoints stay pinned.
    assert bright[0] == 0 and bright[255] == 255


def test_levels_output_range_clamps_the_result() -> None:
    lut = levels_lut(output_black=40, output_white=200)

    assert lut[0] == 40
    assert lut[255] == 200


def test_apply_levels_remaps_a_mask() -> None:
    mask = np.array([[0, 64, 128, 255]], dtype=np.uint8)

    remapped = apply_levels(mask, {"blackPoint": 64, "whitePoint": 192})

    assert remapped.tolist() == [[0, 0, 128, 255]]


def test_apply_levels_without_a_change_returns_the_same_pixels() -> None:
    mask = disc(radius=12)

    assert levels_is_identity(None)
    assert levels_is_identity({"blackPoint": 0, "whitePoint": 255, "gamma": 1.0})
    assert np.array_equal(apply_levels(mask, None), mask)


def test_levels_reject_an_inverted_range() -> None:
    with pytest.raises(UnsupportedParameterError):
        levels_lut(black_point=200, white_point=100)

    with pytest.raises(UnsupportedParameterError):
        levels_lut(gamma=0.0)
