"""Baseline solver: greedy bottom-left fill on a coarse bitmap.

This is the reference implementation to beat. It reproduces the production
heuristic's *decisions* — largest visible area first, then for each design the
lowest legal row and the leftmost free position in it, picking the rotation
that ranks lowest — but evaluates collisions on a max-pooled bitmap instead of
exact polygons, so a full sweep runs in seconds rather than minutes.

Why the bitmap is safe
----------------------

* Pooling uses ``any``, so a coarse cell is occupied whenever *any* pixel
  inside it is visible. Coarse occupancy can therefore only over-estimate.
* Every placement pins its visible bounding-box origin to a multiple of
  ``cell_px``, so all designs share one global cell lattice.
* Clearance is certified by a single-sided dilation. If the new design's
  occupancy dilated by ``dilate_cells`` never touches an already-placed
  design's undilated occupancy, the two are at least ``dilate_cells + 1`` cells
  apart, hence at least ``dilate_cells * cell_px + 1`` pixels apart, which is
  at least ``margin_px`` by construction of ``dilate_cells``. The referee
  measures the true pixel distance independently.

The only cost is quantization: a legal pixel position may be up to
``cell_px - 1`` px lower or further left than the best lattice position, and
the clearance is padded by up to ``cell_px`` px. Both are deliberate and both
are recoverable by a pixel-exact refinement pass, which this baseline does not
have.

Known weaknesses, in rough order of expected payoff:

1. **Greedy, single-pass.** A design that fits badly early is never moved. No
   backtracking, no local search, no repacking of a sub-region.
2. **Order sensitivity.** Only a fixed ordering plus seeded random permutations
   are tried. Height, width, aspect, perimeter or a learned score are not
   explored, and there is no beam or lookahead.
3. **No pixel refinement.** Positions stay on the cell lattice. Sliding each
   design down and left in whole pixels, re-checking exact clearance, recovers
   up to ``cell_px`` px per stacked design — often a few percent of height.
4. **Sheet height is an output, not an objective.** Nothing minimises the
   maximum visible ``y1``; a better solver can treat that as the objective and
   search for the smallest feasible height.
5. **Rotation choice is myopic.** The lowest-ranked rotation wins even when a
   taller, narrower one would let a later design nest above it.
6. **No interlocking search.** Concave regions are exploited only by accident
   of the scan order, never by explicitly targeting holes.
7. **One evaluation per ordering.** No beam, no lookahead, no early cutoff
   based on a lower bound for the remaining designs.

The interface is intentionally narrow: read a case, return a `Layout`. Any
algorithm — simulated annealing, guided local search, beam search, a CP-SAT
model, a learned policy — is acceptable as long as the referee agrees.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import ceil, floor

import numpy as np

from printsheet_nest.referee import load_alpha, pixels_for_mm, sheet_width_px
from printsheet_nest.types import Case, DesignSpec, Layout, PackParams, Placement, UnplacedDesign

# Target width of the working bitmap. The cell size is the smallest power of two
# that keeps the sheet at or below this, so a 58 cm roll at 300 dpi works on a
# bitmap roughly 512 cells wide.
TARGET_CELLS_WIDE = 512

# Orderings evaluated by :meth:`RasterSolver.solve`.
ORDERINGS = 8


@dataclass
class Shape:
    """One design in one rotation, as coarse occupancy plus its query mask.

    ``occupancy`` is the max-pooled visible mask, burned into the sheet when the
    design is placed. ``query`` is ``occupancy`` dilated by ``dilate_cells`` and
    padded by the same amount, so ``query[r, c]`` covers cell
    ``(row + r - dilate_cells, col + c - dilate_cells)`` relative to the visible
    origin cell ``(row, col)``.
    """

    design: DesignSpec
    rotation_deg: int
    occupancy: np.ndarray
    query: np.ndarray
    # Visible bounding box in the *unrotated* image, in pixels.
    vis_x0: int
    vis_y0: int
    vis_width: int
    vis_height: int
    # Image size after rotation.
    image_width_px: int
    image_height_px: int
    visible_pixels: int


def correlate_free(blocked: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """``out[y, x] == 0`` exactly when ``mask`` fits with its corner at ``(y, x)``.

    This is the 2-D cross-correlation ``out[y, x] = sum(blocked[y+dy, x+dx] *
    mask[dy, dx])``, computed with an FFT and rounded to integers, so a float
    epsilon can never let a real overlap pass as free.
    """
    height, width = blocked.shape
    mask_height, mask_width = mask.shape
    out_height = height - mask_height + 1
    out_width = width - mask_width + 1
    if out_height <= 0 or out_width <= 0:
        return np.zeros((0, 0), dtype=np.int32)

    padded = (height + mask_height, width + mask_width)
    fft_blocked = np.fft.rfft2(blocked.astype(np.float64), padded)
    fft_mask = np.fft.rfft2(mask[::-1, ::-1].astype(np.float64), padded)
    convolution = np.fft.irfft2(fft_blocked * fft_mask, padded)
    # Correlating at offset (y, x) is convolving with the flipped mask, which
    # lands at convolution index (y + mask_height - 1, x + mask_width - 1).
    counts = convolution[
        mask_height - 1 : mask_height - 1 + out_height,
        mask_width - 1 : mask_width - 1 + out_width,
    ]
    return np.rint(counts).astype(np.int32)


def dilate_cells(mask: np.ndarray, radius: int) -> np.ndarray:
    """Grow ``mask`` by ``radius`` cells on every side (Chebyshev).

    The result is ``(H + 2 * radius, W + 2 * radius)`` and is centred on the
    input: ``out[radius + a, radius + b]`` is ``True`` whenever any original
    cell within ``radius`` of ``(a, b)`` is occupied.

    Padding *before* dilating matters. A design's clearance extends beyond its
    own bounding box, so the outermost ``radius`` cells of the result are
    reachable by real pixels; padding afterwards would wrongly leave them empty
    and let a neighbour sit one margin too close.
    """
    if radius <= 0:
        return mask
    out = np.pad(mask, ((radius, radius), (radius, radius)), constant_values=False)
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


def pool(mask: np.ndarray, cell: int) -> np.ndarray:
    """Max-pool onto ``cell``-sized blocks, padding the last row/column."""
    height, width = mask.shape
    rows = ceil(height / cell) * cell
    columns = ceil(width / cell) * cell
    padded = np.zeros((rows, columns), dtype=bool)
    padded[:height, :width] = mask
    return padded.reshape(rows // cell, cell, columns // cell, cell).any(axis=(1, 3))


class RasterSolver:
    """Greedy bottom-left fill on a max-pooled bitmap."""

    name = "baseline-raster-bottom-left"

    def __init__(self, case: Case) -> None:
        self.case = case
        self.params: PackParams = case.params
        self.sheet_width_px = sheet_width_px(self.params)
        self.margin_px = pixels_for_mm(self.params.margin_mm, self.params.dpi)
        self.edge_px = pixels_for_mm(self.params.edge_margin_mm, self.params.dpi)
        self.cell_px = max(1, self._choose_cell())
        # Smallest cell dilation that certifies the pixel margin:
        # `dilate_cells * cell_px + 1 >= margin_px`.
        self.dilate_cells = max(0, ceil((self.margin_px - 1) / self.cell_px)) if self.margin_px > 0 else 0
        self.width_cells = ceil(self.sheet_width_px / self.cell_px)
        self.candidates = [self._prepare(design) for design in case.designs]

    # ------------------------------------------------------------------
    # preparation
    # ------------------------------------------------------------------
    def _choose_cell(self) -> int:
        cell = 1
        while self.sheet_width_px / cell > TARGET_CELLS_WIDE:
            cell *= 2
        return cell

    def _prepare(self, design: DesignSpec) -> tuple[DesignSpec, list[Shape], str | None]:
        alpha = load_alpha(self.case.files[design.design_id])
        occupied = alpha > self.params.alpha_threshold
        rows = np.flatnonzero(occupied.any(axis=1))
        columns = np.flatnonzero(occupied.any(axis=0))
        if rows.size == 0:
            return design, [], "no-visible-pixels"
        vis_x0, vis_x1 = int(columns[0]), int(columns[-1]) + 1
        vis_y0, vis_y1 = int(rows[0]), int(rows[-1]) + 1
        cropped = occupied[vis_y0:vis_y1, vis_x0:vis_x1]
        visible = int(cropped.sum())

        rotations = (0, 90, 180, 270) if design.allow_rotation else (0,)
        shapes: list[Shape] = []
        for rotation in rotations:
            rotated = np.ascontiguousarray(np.rot90(cropped, k=-(rotation // 90)))
            # Where the rotated visible box lands inside the rotated image.
            # ``np.rot90`` turns clockwise here: (x, y) -> (h - 1 - y, x), so a
            # quarter turn maps the box to [h - y1, h - y0) x [x0, x1).
            if rotation == 0:
                image_width, image_height = design.width_px, design.height_px
                box_x0, box_y0 = vis_x0, vis_y0
                vis_width, vis_height = vis_x1 - vis_x0, vis_y1 - vis_y0
            elif rotation == 90:
                image_width, image_height = design.height_px, design.width_px
                box_x0, box_y0 = design.height_px - vis_y1, vis_x0
                vis_width, vis_height = vis_y1 - vis_y0, vis_x1 - vis_x0
            elif rotation == 180:
                image_width, image_height = design.width_px, design.height_px
                box_x0, box_y0 = design.width_px - vis_x1, design.height_px - vis_y1
                vis_width, vis_height = vis_x1 - vis_x0, vis_y1 - vis_y0
            else:
                image_width, image_height = design.height_px, design.width_px
                box_x0, box_y0 = vis_y0, design.width_px - vis_x1
                vis_width, vis_height = vis_y1 - vis_y0, vis_x1 - vis_x0
            if image_width > self.sheet_width_px:
                continue
            occupancy = pool(rotated, self.cell_px)
            query = dilate_cells(occupancy, self.dilate_cells)
            if query.shape[1] > self.width_cells + 2 * self.dilate_cells:
                continue
            shapes.append(
                Shape(
                    design=design,
                    rotation_deg=rotation,
                    occupancy=occupancy,
                    query=query,
                    vis_x0=box_x0,
                    vis_y0=box_y0,
                    vis_width=vis_width,
                    vis_height=vis_height,
                    image_width_px=image_width,
                    image_height_px=image_height,
                    visible_pixels=visible,
                )
            )
        if not shapes:
            return design, [], "exceeds-roll"
        return design, shapes, None

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    def deterministic_order(self) -> list[tuple[DesignSpec, list[Shape], str | None]]:
        """Largest visible area first — the production packer's criterion."""
        return sorted(
            self.candidates,
            key=lambda entry: (
                -max((shape.visible_pixels for shape in entry[1]), default=0),
                -entry[0].width_px * entry[0].height_px,
                entry[0].design_id,
            ),
        )

    def solve(self) -> Layout:
        rng = np.random.default_rng(self.params.seed)
        orderings = [self.deterministic_order()]
        for _ in range(ORDERINGS - 1):
            index = rng.permutation(len(self.candidates))
            orderings.append([self.candidates[int(position)] for position in index])

        best: Layout | None = None
        for ordering in orderings:
            layout = self._place_all(ordering)
            if best is None or self._key(layout) < self._key(best):
                best = layout
        assert best is not None
        return best

    @staticmethod
    def _key(layout: Layout) -> tuple:
        return (len(layout.unplaced), layout.sheet_height_px)

    def _bounds(self, shape: Shape) -> tuple[int, int, int] | None:
        """Legal ``(min_x, max_x, min_y)`` in cells for the *visible origin*."""
        min_x = ceil(max(self.edge_px, shape.vis_x0) / self.cell_px)
        max_x = floor(
            min(
                self.sheet_width_px - self.edge_px - shape.vis_width,
                self.sheet_width_px - shape.image_width_px + shape.vis_x0,
            )
            / self.cell_px
        )
        min_y = ceil(max(self.edge_px, shape.vis_y0) / self.cell_px)
        if max_x < min_x:
            return None
        return min_x, max_x, min_y

    def _place_all(self, ordering: list[tuple[DesignSpec, list[Shape], str | None]]) -> Layout:
        placed: list[Placement] = []
        bottoms: list[tuple[int, int]] = []  # (visible bottom px, image bottom px)
        unplaced: list[UnplacedDesign] = []
        shift = self.dilate_cells
        # Array index ``k`` is global cell ``k - shift``. ``query[0, 0]`` covers
        # global cell ``origin - shift``, so a query corner at array index
        # ``origin`` puts the visible origin at global cell ``origin`` — the
        # bounds below are already in global cells and index the correlation
        # output directly.
        blocked = np.zeros((shift + 1, self.width_cells + 2 * shift), dtype=bool)
        # Global cell row below which nothing is burned.
        content_bottom = 0

        for design, shapes, reason in ordering:
            if not shapes:
                unplaced.append(UnplacedDesign(design.design_id, reason or "no-feasible-rotation"))
                continue

            tallest = max(shape.query.shape[0] for shape in shapes)
            needed = content_bottom + shift + tallest + 2
            if blocked.shape[0] < needed:
                grown = np.zeros((needed, blocked.shape[1]), dtype=bool)
                grown[: blocked.shape[0]] = blocked
                blocked = grown

            choice = self._place_one(shapes, blocked, content_bottom)
            if choice is None:
                unplaced.append(UnplacedDesign(design.design_id, "no-legal-placement"))
                continue

            shape, cell_x, cell_y = choice  # global cells of the visible origin
            x_px = cell_x * self.cell_px - shape.vis_x0
            y_px = cell_y * self.cell_px - shape.vis_y0
            placed.append(
                Placement(
                    design_id=design.design_id,
                    x_px=x_px,
                    y_px=y_px,
                    width_px=shape.image_width_px,
                    height_px=shape.image_height_px,
                    rotation_deg=shape.rotation_deg,
                )
            )

            # Burn the *undilated* occupancy at the visible origin. The query
            # mask is what carries the clearance, so burning both would charge
            # the margin twice and waste space.
            height, width = shape.occupancy.shape
            row = cell_y + shift
            column = cell_x + shift
            blocked[row : row + height, column : column + width] |= shape.occupancy
            bottoms.append(
                (cell_y * self.cell_px + shape.vis_height, y_px + shape.image_height_px)
            )
            content_bottom = max(content_bottom, cell_y + height)

        lowest_visible = max((entry[0] for entry in bottoms), default=0)
        lowest_image = max((entry[1] for entry in bottoms), default=0)
        height = max(1, lowest_visible + self.edge_px, lowest_image)
        return Layout(
            placements=tuple(placed),
            unplaced=tuple(unplaced),
            sheet_width_px=self.sheet_width_px,
            sheet_height_px=height,
        )

    def _place_one(
        self,
        shapes: list[Shape],
        blocked: np.ndarray,
        content_bottom: int,
    ) -> tuple[Shape, int, int] | None:
        best_rank: tuple[int, int, int] | None = None
        best_shape: Shape | None = None
        for shape in shapes:
            position = self._lowest_position(shape, blocked, content_bottom)
            if position is None:
                continue
            cell_y, cell_x = position
            rank = (cell_y, cell_x, shape.rotation_deg)
            if best_rank is None or rank < best_rank:
                best_rank, best_shape = rank, shape
        if best_rank is None or best_shape is None:
            return None
        return best_shape, best_rank[1], best_rank[0]

    def _lowest_position(
        self, shape: Shape, blocked: np.ndarray, content_bottom: int
    ) -> tuple[int, int] | None:
        """Lowest row, then leftmost column, where the query mask is free.

        Returns the *global cell* coordinates of the visible origin.
        """
        bounds = self._bounds(shape)
        if bounds is None:
            return None
        shift = self.dilate_cells
        min_x, max_x, min_y = bounds
        query_height, query_width = shape.query.shape

        # A query corner at global cell `y` lands at array row `y + shift`; the
        # visible origin is then at global cell `y`, so the bounds index the
        # correlation output directly.
        row_lo = min_y
        row_hi = min(blocked.shape[0] - query_height + 1, max(content_bottom, row_lo) + 1)
        if row_hi <= row_lo:
            return None
        col_lo = min_x
        col_hi = min(blocked.shape[1] - query_width + 1, max_x + 1)
        if col_hi <= col_lo:
            return None

        counts = correlate_free(blocked[: row_hi + query_height - 1], shape.query)
        if counts.size == 0:
            return None
        window = counts[row_lo:row_hi, col_lo:col_hi] == 0
        if not window.any():
            return None
        row, column = np.unravel_index(int(np.argmax(window)), window.shape)
        return int(row_lo + row), int(col_lo + column)


def solve(case: Case) -> Layout:
    """Entry point used by the harness."""
    return RasterSolver(case).solve()


__all__ = [
    "ORDERINGS",
    "RasterSolver",
    "Shape",
    "correlate_free",
    "dilate_cells",
    "pool",
    "solve",
]
