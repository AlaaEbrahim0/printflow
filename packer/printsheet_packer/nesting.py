"""Raster-mask nesting: rotation trials, grid search and sheet sizing.

The search works on the shared occupancy grid (``cellPx`` squares aligned to
the sheet origin) and quantizes every placement to a whole cell, so a candidate
position maps back to an exact integer pixel offset. Full-resolution
verification of the chosen layout lives in :mod:`printsheet_packer.integrity`.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from printsheet_packer.contracts import DesignInput, PackRequest, Placement
from printsheet_packer.errors import DesignExceedsRollError, PackerError
from printsheet_packer.masks import (
    BoundingBox,
    DesignMask,
    Footprint,
    block_radius_cells,
    build_footprint,
    cell_size_px,
    grid_extent,
    required_margin_px,
)

ROTATIONS = (0, 90, 180, 270)


@dataclass
class Option:
    """One design in one allowed rotation, prepared for the grid search."""

    footprint: Footprint
    gx_min: int
    gx_max: int
    gy_min: int
    origin_row_shift: int
    origin_col_shift: int
    block_uint8: np.ndarray
    block_columns: tuple[np.ndarray, np.ndarray]

    @property
    def block(self) -> np.ndarray:
        return self.footprint.block


@dataclass
class Candidate:
    """A design with every feasible rotation prepared."""

    design: DesignInput
    mask: DesignMask
    options: tuple[Option, ...]

    @property
    def design_id(self) -> str:
        return self.design.design_id


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
            self.sheet_height_px,
            sum(placed.occupied_cells for placed in self.placed),
            positions,
        )


class _Canvas:
    """Padded occupancy grid reused across ordering attempts."""

    def __init__(self, columns: int, rows: int, pad: int) -> None:
        self.pad = pad
        self.occupied = np.zeros((rows, columns + 2 * pad), dtype=bool)

    @property
    def columns(self) -> int:
        return self.occupied.shape[1]

    def reset(self) -> None:
        self.occupied[:] = False

    def grow_rows(self, rows: int) -> None:
        missing = rows - self.occupied.shape[0]
        if missing > 0:
            extra = max(missing, self.occupied.shape[0])
            self.occupied = np.vstack(
                [self.occupied, np.zeros((extra, self.columns), dtype=bool)]
            )

    def used_rows(self) -> int:
        rows = np.nonzero(self.occupied.any(axis=1))[0]
        return int(rows[-1]) + 1 if rows.size else 0


class Packer:
    """Prepares designs once, then searches layouts as many times as asked."""

    def __init__(self, request: PackRequest, masks: Mapping[str, DesignMask]) -> None:
        if not request.designs:
            raise PackerError("A pack request must contain at least one design")
        self.request = request
        self.cell_px = cell_size_px(request.cell_mm, request.dpi)
        self.margin_px = required_margin_px(request.margin_mm, request.dpi)
        self.edge_margin_px = required_margin_px(request.edge_margin_mm, request.dpi)
        self.sheet_width_px = request.sheet_width_px
        self.sheet_columns = grid_extent(self.sheet_width_px, self.cell_px)
        self.radius_cells = block_radius_cells(self.margin_px, self.cell_px)
        self.pad = self.radius_cells + 1
        self.candidates = [self._prepare(_lookup(masks, design)) for design in request.designs]
        right_extent = max(
            option.gx_max + option.origin_col_shift + option.block.shape[1]
            for candidate in self.candidates
            for option in candidate.options
        )
        row_extent = sum(
            max(option.block.shape[0] for option in candidate.options)
            for candidate in self.candidates
        )
        self.canvas = _Canvas(
            columns=max(self.sheet_columns, right_extent - self.pad),
            rows=max(8, row_extent + 2 * self.pad + 2),
            pad=self.pad,
        )

    # ------------------------------------------------------------------
    # preparation
    # ------------------------------------------------------------------
    def _prepare(self, mask: DesignMask) -> Candidate:
        design = mask.design
        rotations = ROTATIONS if design.allow_rotation else (0,)
        options: list[Option] = []
        for rotation in rotations:
            footprint = build_footprint(
                mask,
                rotation,
                self.cell_px,
                self.margin_px,
                interlocking=not self.request.no_interlocking,
            )
            bbox = footprint.bbox
            gx_min = _ceil_div(self.edge_margin_px - bbox.x0, self.cell_px)
            gx_max = (
                self.sheet_width_px - self.edge_margin_px - bbox.x0 - bbox.width
            ) // self.cell_px
            gy_min = _ceil_div(self.edge_margin_px - bbox.y0, self.cell_px)
            if gx_max < max(gx_min, 0):
                continue
            options.append(
                Option(
                    footprint=footprint,
                    gx_min=max(gx_min, 0),
                    gx_max=gx_max,
                    gy_min=max(gy_min, 0),
                    origin_row_shift=self.pad - footprint.radius_cells,
                    origin_col_shift=self.pad - footprint.radius_cells,
                    block_uint8=footprint.block.astype(np.uint8),
                    block_columns=(
                        np.flatnonzero(footprint.block.any(axis=0)),
                        np.flatnonzero(footprint.block.any(axis=1)),
                    ),
                )
            )
        if not options:
            usable_px = self.sheet_width_px - 2 * self.edge_margin_px
            raise DesignExceedsRollError(
                f"Design {design.label} is {mask.bbox.width} px wide at "
                f"{self.request.roll_width_cm} cm / {self.request.dpi} DPI; only {usable_px} px "
                f"are usable after {self.request.edge_margin_mm} mm edge margins"
                + ("" if design.allow_rotation else " (rotation is not allowed)"),
                designId=design.design_id,
                versionId=design.version_id,
                displayName=design.display_name,
                requiredWidthPx=mask.bbox.width,
                usableWidthPx=usable_px,
                rotationsTried=list(rotations),
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

    def place(self, ordering: Sequence[Candidate]) -> Layout | None:
        self.canvas.reset()
        placed: list[PlacedDesign] = []
        bottom = 0
        for candidate in ordering:
            placement = self._place_one(candidate)
            if placement is None:
                return None
            placed.append(placement)
            self._commit(placement)
            bottom = max(bottom, placement.visible_bbox_px.y1)
        return Layout(
            request=self.request,
            placed=placed,
            sheet_width_px=self.sheet_width_px,
            sheet_height_px=max(1, bottom + self.edge_margin_px),
            cell_px=self.cell_px,
            margin_px=self.margin_px,
            edge_margin_px=self.edge_margin_px,
        )

    def _place_one(self, candidate: Candidate) -> PlacedDesign | None:
        """Lowest feasible y then lowest x, over every allowed rotation."""
        limit = self.canvas.used_rows() + 2 * self.pad + 1
        best: PlacedDesign | None = None
        for option in candidate.options:
            # A later rotation only matters if it can beat what we already have.
            ceiling = None
            if best is not None:
                ceiling = (best.y_px // self.cell_px, best.x_px // self.cell_px)
            found = self._scan(candidate, option, limit, ceiling)
            if found is not None and (best is None or found.rank < best.rank):
                best = found
        return best

    def _scan(
        self,
        candidate: Candidate,
        option: Option,
        gy_limit: int,
        ceiling: tuple[int, int] | None = None,
    ) -> PlacedDesign | None:
        """First feasible (gy, gx) in ascending order, or ``None``.

        ``ceiling`` is the best rank found so far by another rotation; scanning
        past it cannot improve the layout, so the search stops there.
        """
        block = option.block
        block_rows, block_width = block.shape
        block_uint8 = option.block_uint8
        occupied_columns = option.block_columns[0]
        if ceiling is not None:
            gy_limit = min(gy_limit, ceiling[0])

        # Rolling per-column occupancy of the band under the block: advancing gy
        # by one row only adds and removes a single row, so each step is O(cols).
        last_gy = max(gy_limit, option.gy_min)
        first_row = option.gy_min + option.origin_row_shift
        self.canvas.grow_rows(first_row + block_rows + (last_gy - option.gy_min) + 1)
        rows = self.canvas.occupied
        counts = rows[first_row : first_row + block_rows].sum(axis=0, dtype=np.int32)

        for gy in range(option.gy_min, max(gy_limit, option.gy_min) + 1):
            if gy > option.gy_min:
                leaving = gy - 1 + option.origin_row_shift
                entering = leaving + block_rows
                counts -= rows[leaving]
                counts += rows[entering]
            hit = np.flatnonzero(counts)
            allowed = np.ones(option.gx_max + 1, dtype=bool)
            allowed[: option.gx_min] = False
            if hit.size:
                blocked = np.subtract.outer(hit, occupied_columns) - option.origin_col_shift
                blocked = blocked[(blocked >= 0) & (blocked <= option.gx_max)]
                if blocked.size:
                    allowed[blocked] = False
            if ceiling is not None and gy == ceiling[0]:
                allowed[min(ceiling[1], option.gx_max + 1) :] = False
            for gx in np.flatnonzero(allowed):
                column0 = int(gx) + option.origin_col_shift
                row0 = gy + option.origin_row_shift
                window = rows[row0 : row0 + block_rows, column0 : column0 + block_width]
                if not np.any(window & block_uint8):
                    return PlacedDesign(
                        candidate=candidate,
                        option=option,
                        x_px=int(gx) * self.cell_px,
                        y_px=gy * self.cell_px,
                    )
        return None

    def _commit(self, placement: PlacedDesign) -> None:
        option = placement.option
        block = option.block
        gy = placement.y_px // self.cell_px
        gx = placement.x_px // self.cell_px
        row0 = gy + option.origin_row_shift
        column0 = gx + option.origin_col_shift
        self.canvas.grow_rows(row0 + block.shape[0])
        rows = slice(row0, row0 + block.shape[0])
        columns = slice(column0, column0 + block.shape[1])
        self.canvas.occupied[rows, columns] |= block

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
            if layout is None:  # pragma: no cover - preparation rules this out
                continue
            if best is None or layout.key() < best.key():
                best = layout
            if on_ordering is not None:
                on_ordering(tried, layout)

        if best is None:  # pragma: no cover - place() succeeds for prepared designs
            raise PackerError("No feasible layout was found for these designs")
        best.orderings_tried = tried
        best.duration_ms = max(1, round((time.perf_counter() - started) * 1000))
        return best


def _lookup(masks: Mapping[str, DesignMask], design: DesignInput) -> DesignMask:
    try:
        return masks[design.design_id]
    except KeyError as exc:
        raise PackerError(f"No mask was built for design {design.design_id}") from exc


def _ceil_div(value: int, divisor: int) -> int:
    return -(-value // divisor)


__all__ = ["Candidate", "Layout", "Option", "Packer", "PlacedDesign", "ROTATIONS"]
