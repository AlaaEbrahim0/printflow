"""Raster-mask nesting: rotation trials, bottom-left search and sheet sizing.

The search works on a conservative occupancy grid: every cell is occupied when
*any* visible pixel inside it is, so the grid can over-estimate occupied area
but can never under-estimate it. Placements are pinned to the grid, and the
required clearance is certified by a single-sided Chebyshev dilation. The exact
full-resolution checks still run in :mod:`printsheet_packer.integrity`; this
module only proposes layouts.

Why a grid: approved files can be several thousand pixels per side. Building an
exact Shapely union and buffering it for every rotation is quadratic enough to
take minutes per design on real artwork. A max-pooled bitmap keeps the search
in seconds while remaining conservative: a coarse cell is occupied whenever any
pixel in it is, and the dilation radius is chosen so an empty gap implies at
least the requested pixel margin.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from math import ceil, floor

import numpy as np
from shapely.geometry import GeometryCollection

from printsheet_packer.contracts import DesignInput, PackRequest, Placement
from printsheet_packer.errors import PackerError
from printsheet_packer.masks import (
    BoundingBox,
    DesignMask,
    Footprint,
    block_radius_cells,
    cell_size_px,
    dilate_block,
    required_margin_px,
    rotate_bbox,
    rotate_degrees,
    simple_footprint,
    to_grid,
)

ROTATIONS = (0, 90, 180, 270)

# Target width of the search bitmap. ``cellPx`` is at least the smallest power
# of two that keeps a full-width roll at or below this many cells. At 58 cm /
# 300 DPI that is a 64 px cell (108 cells wide). A coarse bitmap lets all
# requested orderings finish inside the operator's time budget; the exact
# full-resolution gate still decides legality.
TARGET_CELLS_WIDE = 128

# The search is never made coarser than this, whatever ``cellMm`` says, so an
# occupation-metric setting cannot turn packing into a 5 cm game of Tetris.
COARSEST_SEARCH_CELL_MM = 5.0


@dataclass
class Option:
    """One design in one allowed rotation."""

    footprint: Footprint
    # ``footprint.grid`` dilated by ``dilation_cells``; the padded query mask
    # used by the collision search.
    query: np.ndarray


@dataclass
class Candidate:
    """A design with every feasible rotation prepared."""

    design: DesignInput
    mask: DesignMask
    options: tuple[Option, ...]
    unplaced_reason: str | None = None
    unplaced_details: dict | None = None

    @property
    def design_id(self) -> str:
        return self.design.design_id


@dataclass(frozen=True)
class UnplacedDesign:
    design_id: str
    version_id: str
    reason: str
    display_name: str | None
    details: dict

    def to_json(self) -> dict:
        result = {
            "designId": self.design_id,
            "versionId": self.version_id,
            "reason": self.reason,
            "details": self.details,
        }
        if self.display_name:
            result["displayName"] = self.display_name
        return result


@dataclass
class PlacedDesign:
    candidate: Candidate
    option: Option
    x_px: int
    y_px: int

    @property
    def footprint(self) -> Footprint:
        return self.option.footprint

    @property
    def rotation_deg(self) -> int:
        return self.footprint.rotation_deg

    @property
    def design_id(self) -> str:
        return self.candidate.design.design_id

    @property
    def visible_bbox_px(self) -> BoundingBox:
        box = self.footprint.bbox
        return BoundingBox(
            self.x_px + box.x0, self.y_px + box.y0, self.x_px + box.x1, self.y_px + box.y1
        )

    @property
    def occupied_cells(self) -> int:
        return int(self.footprint.grid.sum())

    @property
    def rank(self) -> tuple[int, int, int]:
        return (self.y_px, self.x_px, self.rotation_deg)

    def to_placement(self) -> Placement:
        return Placement(
            design_id=self.design_id,
            version_id=self.candidate.design.version_id,
            x_px=self.x_px,
            y_px=self.y_px,
            width_px=self.footprint.image_width_px,
            height_px=self.footprint.image_height_px,
            rotation_deg=self.rotation_deg,
            display_name=self.candidate.design.display_name,
        )


@dataclass
class Layout:
    request: PackRequest
    placed: list[PlacedDesign]
    unplaced: list[UnplacedDesign]
    sheet_width_px: int
    sheet_height_px: int
    cell_px: int
    margin_px: int
    edge_margin_px: int
    orderings_tried: int = 1
    duration_ms: int = 0

    @property
    def dpi(self) -> int:
        return self.request.dpi

    @property
    def placements(self) -> list[Placement]:
        return [design.to_placement() for design in self.placed]

    @property
    def visible_pixels(self) -> int:
        return sum(placed.footprint.visible_pixels for placed in self.placed)

    @property
    def occupancy_ratio(self) -> float:
        area = self.sheet_width_px * self.sheet_height_px
        return self.visible_pixels / area if area else 0.0

    def key(self) -> tuple:
        """Objective: shortest sheet, then fewest occupied cells, then earliest."""
        positions = sorted((placed.y_px, placed.x_px, placed.design_id) for placed in self.placed)
        return (
            len(self.unplaced),
            self.sheet_height_px,
            sum(placed.occupied_cells for placed in self.placed),
            positions,
        )


class Packer:
    """Prepares designs once, then searches layouts as many times as asked."""

    def __init__(self, request: PackRequest, masks: Mapping[str, DesignMask]) -> None:
        if not request.designs:
            raise PackerError("A pack request must contain at least one design")
        self.request = request
        self.sheet_width_px = request.sheet_width_px
        self.cell_px = search_cell_px(self.sheet_width_px, request.cell_mm, request.dpi)
        self.width_cells = ceil(self.sheet_width_px / self.cell_px)
        self.margin_px = required_margin_px(request.margin_mm, request.dpi)
        self.edge_margin_px = required_margin_px(request.edge_margin_mm, request.dpi)
        # A single-sided dilation of ``d`` cells leaves ``d + 1`` empty cells
        # between two occupied cells, hence at least ``d * cell + 1`` pixels.
        self.dilation_cells = dilation_cells(self.margin_px, self.cell_px)
        self.candidates = [self._prepare(_lookup(masks, design)) for design in request.designs]

    # ------------------------------------------------------------------
    # preparation
    # ------------------------------------------------------------------
    def _prepare(self, mask: DesignMask) -> Candidate:
        design = mask.design
        rotations = ROTATIONS if design.allow_rotation else (0,)
        options: list[Option] = []
        for rotation in rotations:
            option = build_search_option(
                mask,
                rotation,
                self.cell_px,
                self.margin_px,
                interlocking=not self.request.no_interlocking,
            )
            if option is None:
                continue
            footprint = option.footprint
            if (
                footprint.image_width_px > self.sheet_width_px
                or footprint.bbox.width > self.sheet_width_px - 2 * self.edge_margin_px
            ):
                continue
            options.append(option)
        if not options:
            usable_px = self.sheet_width_px - 2 * self.edge_margin_px
            required_width_px = min(
                mask.image_width_px if rotation in (0, 180) else mask.image_height_px
                for rotation in rotations
            )
            return Candidate(
                design=design,
                mask=mask,
                options=(),
                unplaced_reason="exceeds-roll",
                unplaced_details={
                    "requiredWidthPx": required_width_px,
                    "usableWidthPx": usable_px,
                    "rotationsTried": list(rotations),
                },
            )
        return Candidate(design=design, mask=mask, options=tuple(options))

    # ------------------------------------------------------------------
    # search
    # ------------------------------------------------------------------
    def deterministic_order(self) -> list[Candidate]:
        """Largest visible area first, then descending height and width."""
        return sorted(
            self.candidates,
            key=lambda candidate: (
                -candidate.mask.visible_pixels,
                -candidate.mask.bbox.area,
                -candidate.mask.bbox.height,
                -candidate.mask.bbox.width,
                candidate.design_id,
            ),
        )

    def place(self, ordering: Sequence[Candidate]) -> Layout:
        """Greedy bottom-left fill on the shared occupancy grid.

        ``blocked`` rows and columns are offset by ``dilation_cells``: array
        index ``k`` corresponds to global cell ``k - shift``. Burning the
        *undilated* occupancy keeps the clearance in the query mask only, so a
        design is never charged its margin twice.
        """
        placed: list[PlacedDesign] = []
        unplaced: list[UnplacedDesign] = []
        shift = self.dilation_cells
        blocked = np.zeros((shift + 1, self.width_cells + 2 * shift), dtype=bool)
        content_bottom = 0
        lowest_visible = 0
        lowest_image = 0

        for candidate in ordering:
            if not candidate.options:
                unplaced.append(
                    UnplacedDesign(
                        candidate.design_id,
                        candidate.design.version_id,
                        candidate.unplaced_reason or "no-feasible-rotation",
                        candidate.design.display_name,
                        candidate.unplaced_details or {},
                    )
                )
                continue

            tallest = max(option.query.shape[0] for option in candidate.options)
            bounds = [self._bounds(option) for option in candidate.options]
            first_row = max((bound[2] for bound in bounds if bound is not None), default=0)
            needed = max(content_bottom + shift, first_row) + 2 * tallest + 2
            if blocked.shape[0] < needed:
                grown = np.zeros((needed, blocked.shape[1]), dtype=bool)
                grown[: blocked.shape[0]] = blocked
                blocked = grown

            choice = self._place_one(candidate, blocked, content_bottom)
            if choice is None:
                unplaced.append(
                    UnplacedDesign(
                        candidate.design_id,
                        candidate.design.version_id,
                        "no-legal-placement",
                        candidate.design.display_name,
                        {"reason": "No valid grid position was found within the roll bounds."},
                    )
                )
                continue

            placed_design, cell_x, cell_y = choice
            footprint = placed_design.footprint
            placed.append(placed_design)
            row = cell_y + shift
            column = cell_x + shift
            grid = footprint.grid
            blocked[row : row + grid.shape[0], column : column + grid.shape[1]] |= grid
            content_bottom = max(content_bottom, cell_y + grid.shape[0])
            lowest_visible = max(lowest_visible, cell_y * self.cell_px + footprint.bbox.height)
            lowest_image = max(lowest_image, placed_design.y_px + footprint.image_height_px)

        return Layout(
            request=self.request,
            placed=placed,
            unplaced=unplaced,
            sheet_width_px=self.sheet_width_px,
            sheet_height_px=max(1, lowest_visible + self.edge_margin_px, lowest_image),
            cell_px=self.cell_px,
            margin_px=self.margin_px,
            edge_margin_px=self.edge_margin_px,
        )

    def _place_one(
        self, candidate: Candidate, blocked: np.ndarray, content_bottom: int
    ) -> tuple[PlacedDesign, int, int] | None:
        """Lowest row, then leftmost column, then lowest rotation number."""
        best_rank: tuple[int, int, int] | None = None
        best: tuple[PlacedDesign, int, int] | None = None
        for option in candidate.options:
            position = self._lowest_position(option, blocked, content_bottom)
            if position is None:
                continue
            cell_y, cell_x = position
            bbox = option.footprint.bbox
            placed = PlacedDesign(
                candidate,
                option,
                cell_x * self.cell_px - bbox.x0,
                cell_y * self.cell_px - bbox.y0,
            )
            rank = (placed.y_px, placed.x_px, option.footprint.rotation_deg)
            if best_rank is None or rank < best_rank:
                best_rank = rank
                best = (placed, cell_x, cell_y)
        return best

    def _lowest_position(
        self, option: Option, blocked: np.ndarray, content_bottom: int
    ) -> tuple[int, int] | None:
        """Global ``(cell_y, cell_x)`` of the visible origin, or ``None``."""
        bounds = self._bounds(option)
        if bounds is None:
            return None
        min_x, max_x, min_y = bounds
        query = option.query
        query_height, query_width = query.shape

        col_lo = min_x
        col_hi = min(blocked.shape[1] - query_width + 1, max_x + 1)
        if col_hi <= col_lo:
            return None

        # Usually the first free row is at or above the current content bottom.
        # If not, scan a bounded region below it rather than declaring a design
        # unplaceable: at that depth the whole roll width is guaranteed empty.
        row_lo = min_y
        limits = (
            max(content_bottom, row_lo) + 1,
            max(content_bottom, row_lo) + query_height + 1,
        )
        for row_hi in limits:
            row_hi = min(blocked.shape[0] - query_height + 1, row_hi)
            if row_hi <= row_lo:
                continue
            region = blocked[: row_hi + query_height - 1]
            counts = correlate_free(region, query)
            if counts.size == 0:
                continue
            window = counts[row_lo:row_hi, col_lo:col_hi] == 0
            if not window.any():
                continue
            row, column = np.unravel_index(int(np.argmax(window)), window.shape)
            return int(row_lo + row), int(col_lo + column)
        return None

    def _bounds(self, option: Option) -> tuple[int, int, int] | None:
        """Legal ``(min_x, max_x, min_y)`` in cells for the visible origin."""
        bbox = option.footprint.bbox
        min_x = ceil(max(self.edge_margin_px, bbox.x0) / self.cell_px)
        max_x = floor(
            min(
                self.sheet_width_px - self.edge_margin_px - bbox.width,
                self.sheet_width_px - option.footprint.image_width_px + bbox.x0,
            )
            / self.cell_px
        )
        min_y = ceil(max(self.edge_margin_px, bbox.y0) / self.cell_px)
        if max_x < min_x:
            return None
        return min_x, max_x, min_y

    # ------------------------------------------------------------------
    # orderings
    # ------------------------------------------------------------------
    def run(self, on_ordering: Callable[[int, Layout], None] | None = None) -> Layout:
        """Search the deterministic order plus seeded random permutations.

        The time budget is only consulted *between* orderings, so a run that
        completes all requested orderings is fully reproducible from the seed.
        """
        started = time.perf_counter()
        orderings = [self.deterministic_order()]
        rng = np.random.default_rng(self.request.seed)
        for _ in range(self.request.randomized_orderings):
            index = rng.permutation(len(self.candidates))
            orderings.append([self.candidates[int(position)] for position in index])

        best: Layout | None = None
        tried = 0
        budget = self.request.time_budget_ms / 1000.0
        for ordering in orderings:
            if tried and (time.perf_counter() - started) >= budget:
                break
            layout = self.place(ordering)
            tried += 1
            if best is None or layout.key() < best.key():
                best = layout
            if on_ordering is not None:
                on_ordering(tried, layout)

        if best is None:  # pragma: no cover - at least the deterministic ordering exists
            raise PackerError("No layout was evaluated")
        best.orderings_tried = tried
        best.duration_ms = max(1, round((time.perf_counter() - started) * 1000))
        return best


# ----------------------------------------------------------------------
# raster helpers
# ----------------------------------------------------------------------


def choose_cell_px(sheet_width_px: int, target_cells: int | None = None) -> int:
    """Smallest power of two keeping the sheet at most ``target_cells`` wide."""
    target = TARGET_CELLS_WIDE if target_cells is None else target_cells
    cell = 1
    while sheet_width_px / cell > target:
        cell *= 2
    return cell


def search_cell_px(sheet_width_px: int, cell_mm: float, dpi: int) -> int:
    """Working cell for the search bitmap.

    The configured occupancy cell is honoured when it is fine enough, but the
    bitmap is always kept to roughly ``TARGET_CELLS_WIDE`` cells and never made
    coarser than ``COARSEST_SEARCH_CELL_MM``. That bound is what keeps a
    20-second budget meaningful on full-resolution shop artwork.
    """
    bounded = choose_cell_px(sheet_width_px)
    configured = cell_size_px(cell_mm, dpi)
    capped = min(configured, cell_size_px(COARSEST_SEARCH_CELL_MM, dpi))
    return max(bounded, capped)


def dilation_cells(margin_px: int, cell_px: int) -> int:
    """Cells of single-sided dilation that certify ``margin_px``.

    Two occupied cells separated by ``d + 1`` empty cells keep their nearest
    pixels at least ``d * cell_px + 1`` apart.
    """
    if margin_px <= 0:
        return 0
    return max(0, ceil((margin_px - 1) / cell_px))


def build_search_option(
    design_mask: DesignMask,
    rotation_deg: int,
    cell_px: int,
    margin_px: int,
    *,
    interlocking: bool = True,
) -> Option | None:
    """One rotation as a coarse occupancy bitmap plus its clearance query.

    Exact polygon geometry is deliberately not built here: real artwork can
    contain hundreds of thousands of alpha runs, and buffering that geometry is
    the reason packing used to run for minutes. The conservative bitmap is
    sufficient for a proposal; full-resolution checks remain the gate.
    """
    if rotation_deg == 0:
        occupied = design_mask.occupied
        bbox = design_mask.bbox
        image_width, image_height = design_mask.image_width_px, design_mask.image_height_px
    else:
        occupied = rotate_degrees(design_mask.occupied, rotation_deg)
        bbox, image_width, image_height = rotate_bbox(
            design_mask.bbox,
            design_mask.image_width_px,
            design_mask.image_height_px,
            rotation_deg,
        )

    grid = to_grid(occupied, cell_px)
    if not interlocking:
        grid = simple_footprint(grid, "bbox")
    if grid.size == 0:
        return None

    radius = block_radius_cells(margin_px, cell_px)
    footprint = Footprint(
        rotation_deg=rotation_deg,
        grid=grid,
        block=dilate_block(grid, radius),
        geometry=GeometryCollection(),
        collision_geometry=GeometryCollection(),
        bbox=bbox,
        image_width_px=image_width,
        image_height_px=image_height,
        radius_cells=radius,
        cell_px=cell_px,
        visible_pixels=int(occupied.sum()),
    )
    return Option(footprint=footprint, query=dilate_block(grid, dilation_cells(margin_px, cell_px)))


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
    fft_blocked = np.fft.rfft2(blocked.astype(np.float32), padded)
    fft_mask = np.fft.rfft2(mask[::-1, ::-1].astype(np.float32), padded)
    convolution = np.fft.irfft2(fft_blocked * fft_mask, padded)
    # Correlating at offset (y, x) is convolving with the flipped mask, which
    # lands at convolution index (y + mask_height - 1, x + mask_width - 1).
    counts = convolution[
        mask_height - 1 : mask_height - 1 + out_height,
        mask_width - 1 : mask_width - 1 + out_width,
    ]
    return np.rint(counts).astype(np.int32)


def _lookup(masks: Mapping[str, DesignMask], design: DesignInput) -> DesignMask:
    try:
        return masks[design.design_id]
    except KeyError as exc:
        raise PackerError(f"No mask was built for design {design.design_id}") from exc


__all__ = [
    "Candidate",
    "Layout",
    "Option",
    "Packer",
    "PlacedDesign",
    "ROTATIONS",
    "build_search_option",
    "choose_cell_px",
    "correlate_free",
    "dilation_cells",
    "search_cell_px",
]
