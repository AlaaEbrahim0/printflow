"""Tests for the kit's own machinery.

These guard the two things that make the kit trustworthy:

1. the referee is *correct* — it rejects layouts that break a hard constraint,
   and it accepts layouts that do not;
2. the baseline is *safe* — every layout it produces passes the referee.

A solver that fails these tests cannot be trusted, however good its score.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from printsheet_nest.baseline import RasterSolver, correlate_free, dilate_cells, pool
from printsheet_nest.cases import build_case, synthetic_case
from printsheet_nest.referee import judge, pixels_for_mm, sheet_width_px
from printsheet_nest.types import Case, DesignSpec, Layout, PackParams, Placement, UnplacedDesign


# ----------------------------------------------------------------------
# fixtures
# ----------------------------------------------------------------------


def _rect(width: int, height: int) -> Image.Image:
    """An opaque rectangle: the simplest shape with a predictable bbox."""
    array = np.zeros((height, width, 4), dtype=np.uint8)
    array[..., :3] = 200
    array[..., 3] = 255
    return Image.fromarray(array, "RGBA")


@pytest.fixture(scope="module")
def params() -> PackParams:
    """Small geometry so tests run fast: 10 cm roll, 100 dpi, 5 mm gap."""
    return PackParams(
        roll_width_cm=10.0,
        dpi=100,
        margin_mm=5.0,
        edge_margin_mm=2.0,
        alpha_threshold=5,
        seed=7,
        time_budget_ms=5_000,
    )


@pytest.fixture(scope="module")
def synthetic_params() -> PackParams:
    """A 30 cm roll at 100 dpi, so 6–12 cm synthetic blobs all fit."""
    return PackParams(
        roll_width_cm=30.0,
        dpi=100,
        margin_mm=5.0,
        edge_margin_mm=2.0,
        alpha_threshold=5,
        seed=7,
        time_budget_ms=5_000,
    )


@pytest.fixture(scope="module")
def two_squares(tmp_path_factory: pytest.TempPathFactory, params: PackParams) -> Case:
    directory = tmp_path_factory.mktemp("two-squares")
    return build_case(
        "two-squares",
        [("left", _rect(100, 100)), ("right", _rect(100, 100))],
        params,
        directory,
    )


# ----------------------------------------------------------------------
# primitives
# ----------------------------------------------------------------------


def test_correlate_free_matches_brute_force() -> None:
    rng = np.random.default_rng(11)
    for _ in range(5):
        blocked = rng.random((13, 17)) < 0.35
        mask = rng.random((4, 5)) < 0.5
        counts = correlate_free(blocked, mask)
        rows, columns = blocked.shape[0] - mask.shape[0] + 1, blocked.shape[1] - mask.shape[1] + 1
        assert counts.shape == (rows, columns)
        expected = np.zeros((rows, columns), dtype=int)
        for y in range(rows):
            for x in range(columns):
                expected[y, x] = int((blocked[y : y + mask.shape[0], x : x + mask.shape[1]] & mask).sum())
        assert np.array_equal(counts, expected)


def test_pool_is_conservative() -> None:
    mask = np.zeros((5, 7), dtype=bool)
    mask[4, 6] = True  # the very last pixel
    pooled = pool(mask, 3)
    # A 5x7 mask pooled at 3 must cover ceil(5/3)=2 by ceil(7/3)=3 cells, and
    # the occupied pixel must light up the last cell.
    assert pooled.shape == (2, 3)
    assert pooled[1, 2]


def test_dilate_cells_grows_by_chebyshev_radius() -> None:
    mask = np.zeros((5, 5), dtype=bool)
    mask[2, 2] = True
    grown = dilate_cells(mask, 1)
    # Padding by 1 plus radius 1 gives a 7x7 array; the single pixel becomes a
    # 3x3 block whose corner sits at (1, 1).
    # Padding by 1, then a radius-1 window: a lone pixel becomes a full 3x3
    # block, and the array grows to 7x7 with the block one cell in from each
    # edge. The block sits at the padded position of the original pixel.
    assert grown.shape == (7, 7)
    assert grown[2:5, 2:5].all()
    assert grown.sum() == 9


# ----------------------------------------------------------------------
# referee: it must reject illegal layouts
# ----------------------------------------------------------------------


def test_referee_accepts_a_legal_layout(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    edge = pixels_for_mm(params.edge_margin_mm, params.dpi)
    layout = Layout(
        placements=(
            Placement("left", edge, edge, 100, 100, 0),
            Placement("right", width - edge - 100, edge, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=edge + 100 + edge,
    )
    verdict = judge(two_squares, layout)
    assert verdict.feasible, verdict.reasons


def test_referee_rejects_overlap(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    layout = Layout(
        placements=(
            Placement("left", 20, 20, 100, 100, 0),
            Placement("right", 20, 20, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("apart" in reason for reason in verdict.reasons)


def test_referee_measures_chebyshev_gap_between_visible_pixels(two_squares: Case) -> None:
    """The gap is the Chebyshev distance between the nearest visible pixels.

    For two opaque blocks with pixel columns ending at ``a`` and starting at
    ``b``, that distance is ``b - a``. Production publishes the same number, so
    this test also pins the kit to production's definition.
    """
    params = two_squares.params
    width = sheet_width_px(params)
    edge = pixels_for_mm(params.edge_margin_mm, params.dpi)
    margin = pixels_for_mm(params.margin_mm, params.dpi)

    def gap_for(offset: int) -> int | None:
        layout = Layout(
            placements=(
                Placement("left", edge, edge, 100, 100, 0),
                Placement("right", edge + offset, edge, 100, 100, 0),
            ),
            unplaced=(),
            sheet_width_px=width,
            sheet_height_px=edge + 100 + edge,
        )
        return judge(two_squares, layout).minimum_gap_px

    # Production defines the gap as `first_start - second_end`, i.e. the
    # centre-to-centre Chebyshev distance. Left's last column is `edge + 99`
    # and right's first column is `edge + offset`, so the gap is `offset - 99`.
    assert gap_for(100) == 1  # adjacent pixels
    assert gap_for(110) == 11
    assert gap_for(100 + margin) == margin + 1


def test_referee_rejects_gap_one_pixel_below_the_margin(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    edge = pixels_for_mm(params.edge_margin_mm, params.dpi)
    margin = pixels_for_mm(params.margin_mm, params.dpi)
    layout = Layout(
        placements=(
            Placement("left", edge, edge, 100, 100, 0),
            # Nearest visible columns are `margin - 1` apart, one short.
            Placement("right", edge + 98 + margin, edge, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=edge + 100 + edge,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert verdict.minimum_gap_px == margin - 1


def test_referee_rejects_edge_violation(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    edge = pixels_for_mm(params.edge_margin_mm, params.dpi)
    layout = Layout(
        placements=(
            Placement("left", 0, edge, 100, 100, 0),
            Placement("right", width - 100, edge, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=edge + 100 + edge,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("edge" in reason for reason in verdict.reasons)


def test_referee_rejects_outside_pixels(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    layout = Layout(
        placements=(Placement("left", -40, 20, 100, 100, 0),),
        unplaced=(UnplacedDesign("right", "test"),),
        sheet_width_px=width,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("outside the sheet" in reason for reason in verdict.reasons)


def test_referee_rejects_missing_design(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    layout = Layout(
        placements=(Placement("left", 20, 20, 100, 100, 0),),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("was not placed" in reason for reason in verdict.reasons)


def test_referee_rejects_wrong_declared_size(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    layout = Layout(
        placements=(
            Placement("left", 20, 20, 90, 100, 0),
            Placement("right", 300, 20, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("expected" in reason for reason in verdict.reasons)


def test_referee_rejects_illegal_rotation(two_squares: Case) -> None:
    params = two_squares.params
    width = sheet_width_px(params)
    layout = Layout(
        placements=(
            Placement("left", 20, 20, 100, 100, 45),
            Placement("right", 300, 20, 100, 100, 0),
        ),
        unplaced=(),
        sheet_width_px=width,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("illegal rotation" in reason for reason in verdict.reasons)


def test_referee_rejects_wrong_sheet_width(two_squares: Case) -> None:
    params = two_squares.params
    layout = Layout(
        placements=(Placement("left", 20, 20, 100, 100, 0),),
        unplaced=(UnplacedDesign("right", "test"),),
        sheet_width_px=sheet_width_px(params) + 1,
        sheet_height_px=400,
    )
    verdict = judge(two_squares, layout)
    assert not verdict.feasible
    assert any("roll is" in reason for reason in verdict.reasons)


# ----------------------------------------------------------------------
# baseline: it must always produce a legal layout
# ----------------------------------------------------------------------


@pytest.mark.parametrize("count", [1, 2, 5, 9])
def test_baseline_is_always_feasible(
    tmp_path: Path, synthetic_params: PackParams, count: int
) -> None:
    case = synthetic_case(count, tmp_path / f"synthetic-{count}", synthetic_params, max_side_cm=12.0)
    layout = RasterSolver(case).solve()
    verdict = judge(case, layout)
    assert verdict.feasible, verdict.reasons
    assert len(layout.placements) == count
    assert not layout.unplaced


def test_baseline_reports_unplaceable_designs(tmp_path: Path, params: PackParams) -> None:
    # 40 cm square on a 10 cm roll: no rotation can fit.
    wide = _rect(1575, 1575)  # 40 cm x 40 cm at 100 dpi
    case = build_case("too-wide", [("wide", wide)], params, tmp_path / "too-wide")
    layout = RasterSolver(case).solve()
    assert len(layout.unplaced) == 1
    assert layout.unplaced[0].reason == "exceeds-roll"


def test_baseline_is_deterministic(tmp_path: Path, synthetic_params: PackParams) -> None:
    case = synthetic_case(6, tmp_path / "deterministic", synthetic_params, max_side_cm=12.0)
    first = RasterSolver(case).solve()
    second = RasterSolver(case).solve()
    assert first.to_json() == second.to_json()


def test_baseline_respects_a_seed_change(tmp_path: Path, synthetic_params: PackParams) -> None:
    params = synthetic_params
    case = synthetic_case(6, tmp_path / "seeded", params, max_side_cm=12.0)
    other = Case(
        name=case.name,
        params=PackParams(
            roll_width_cm=params.roll_width_cm,
            dpi=params.dpi,
            margin_mm=params.margin_mm,
            edge_margin_mm=params.edge_margin_mm,
            alpha_threshold=params.alpha_threshold,
            seed=params.seed + 1,
            time_budget_ms=params.time_budget_ms,
        ),
        designs=case.designs,
        files=case.files,
    )
    # Different seeds explore different orderings; they may or may not land on
    # a different height, but both must be legal.
    assert judge(case, RasterSolver(case).solve()).feasible
    assert judge(other, RasterSolver(other).solve()).feasible


def test_baseline_honours_no_rotation(tmp_path: Path, params: PackParams) -> None:
    tall = _rect(40, 200)
    designs = [("tall", tall), ("small", _rect(60, 60))]
    directory = tmp_path / "no-rotation"
    directory.mkdir(parents=True)
    specs: list[DesignSpec] = []
    files: dict[str, str] = {}
    for design_id, image in designs:
        path = directory / f"{design_id}.png"
        image.save(path)
        specs.append(
            DesignSpec(design_id, str(path), image.width, image.height, allow_rotation=False)
        )
        files[design_id] = str(path)
    case = Case("no-rotation", params, tuple(specs), files)
    layout = RasterSolver(case).solve()
    assert all(placement.rotation_deg == 0 for placement in layout.placements)
    assert judge(case, layout).feasible
