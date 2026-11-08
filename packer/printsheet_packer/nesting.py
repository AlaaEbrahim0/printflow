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
from math import ceil, floor

import numpy as np
from shapely import affinity

from printsheet_packer.contracts import DesignInput, PackRequest, Placement
from printsheet_packer.errors import PackerError
from printsheet_packer.masks import (
    BoundingBox,
    DesignMask,
    Footprint,
    build_footprint,
    cell_size_px,
    required_margin_px,
)

ROTATIONS = (0, 90, 180, 270)


@dataclass
class Option:
    """One design in one allowed rotation."""

    footprint: Footprint


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
        self.cell_px = cell_size_px(request.cell_mm, request.dpi)
        self.margin_px = required_margin_px(request.margin_mm, request.dpi)
        self.edge_margin_px = required_margin_px(request.edge_margin_mm, request.dpi)
        self.sheet_width_px = request.sheet_width_px
        self.candidates = [self._prepare(_lookup(masks, design)) for design in request.designs]

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
            if (
                footprint.image_width_px > self.sheet_width_px
                or bbox.width > self.sheet_width_px - 2 * self.edge_margin_px
            ):
                continue
            options.append(Option(footprint=footprint))
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
        placed: list[PlacedDesign] = []
        unplaced: list[UnplacedDesign] = []
        bottom = 0
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
            placement = self._place_one(candidate, placed)
            if placement is None:
                unplaced.append(
                    UnplacedDesign(
                        candidate.design_id,
                        candidate.design.version_id,
                        "no-legal-placement",
                        candidate.design.display_name,
                        {"reason": "No valid polygon contact was found within the roll bounds."},
                    )
                )
                continue
            placed.append(placement)
            bottom = max(bottom, placement.visible_bbox_px.y1)
        full_raster_bottom = max(
            (
                placement.y_px + placement.footprint.image_height_px
                for placement in placed
            ),
            default=0,
        )
        return Layout(
            request=self.request,
            placed=placed,
            unplaced=unplaced,
            sheet_width_px=self.sheet_width_px,
            sheet_height_px=max(1, bottom + self.edge_margin_px, full_raster_bottom),
            cell_px=self.cell_px,
            margin_px=self.margin_px,
            edge_margin_px=self.edge_margin_px,
        )

    def _place_one(
        self, candidate: Candidate, placed: Sequence[PlacedDesign]
    ) -> PlacedDesign | None:
        """Place by integer-pixel polygon contacts, preferring bottom-left."""
        best: PlacedDesign | None = None
        for option in candidate.options:
            footprint = option.footprint
            box = footprint.bbox
            x_min = max(0, self.edge_margin_px - box.x0)
            x_max = min(
                self.sheet_width_px - footprint.image_width_px,
                self.sheet_width_px - self.edge_margin_px - box.x1,
            )
            y_min = max(0, self.edge_margin_px - box.y0)
            if x_max < x_min:
                continue

            for x_px, y_px in self._position_candidates(
                option, placed, x_min, x_max, y_min
            ):
                if best is not None and (y_px, x_px, footprint.rotation_deg) >= best.rank:
                    break
                moved = affinity.translate(
                    footprint.collision_geometry, xoff=x_px, yoff=y_px
                )
                if any(
                    moved.intersection(
                        affinity.translate(
                            other.footprint.collision_geometry,
                            xoff=other.x_px,
                            yoff=other.y_px,
                        )
                    ).area > 1e-9
                    for other in placed
                ):
                    continue
                best = PlacedDesign(candidate, option, x_px, y_px)
                break
        return best

    def _position_candidates(
        self,
        option: Option,
        placed: Sequence[PlacedDesign],
        x_min: int,
        x_max: int,
        y_min: int,
    ) -> list[tuple[int, int]]:
        """Generate bounded contact positions from polygon bounds, holes and vertices."""
        target = option.footprint.collision_geometry
        target_bounds = target.bounds
        x_values = {x_min}
        y_values = {y_min}
        if placed:
            y_values.add(
                max(item.y_px + item.footprint.image_height_px for item in placed)
                + self.margin_px
            )

        vertex_contacts: set[tuple[int, int]] = set()
        target_vertices = _geometry_vertices(target)
        for item in placed:
            obstacle = affinity.translate(
                item.footprint.collision_geometry,
                xoff=item.x_px,
                yoff=item.y_px,
            )
            bounds = obstacle.bounds
            for value in (bounds[2] - target_bounds[0], bounds[0] - target_bounds[2]):
                x_values.update(_integer_neighbors(value))
            for value in (bounds[3] - target_bounds[1], bounds[1] - target_bounds[3]):
                y_values.update(_integer_neighbors(value))

            for hole in _hole_bounds(obstacle):
                for value in (hole[0] - target_bounds[0], hole[2] - target_bounds[2]):
                    x_values.update(_integer_neighbors(value))
                for value in (hole[1] - target_bounds[1], hole[3] - target_bounds[3]):
                    y_values.update(_integer_neighbors(value))

            obstacle_vertices = _geometry_vertices(obstacle)
            for target_x, target_y in target_vertices:
                for obstacle_x, obstacle_y in obstacle_vertices:
                    vertex_contacts.add(
                        (round(obstacle_x - target_x), round(obstacle_y - target_y))
                    )

        x_values = {x for x in x_values if x_min <= x <= x_max}
        y_values = {y for y in y_values if y >= y_min}
        candidates = {(x, y) for x in x_values for y in y_values}
        candidates.update(
            (x, y)
            for x, y in vertex_contacts
            if x_min <= x <= x_max and y >= y_min
        )
        return sorted(candidates, key=lambda position: (position[1], position[0]))

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


def _lookup(masks: Mapping[str, DesignMask], design: DesignInput) -> DesignMask:
    try:
        return masks[design.design_id]
    except KeyError as exc:
        raise PackerError(f"No mask was built for design {design.design_id}") from exc


def _integer_neighbors(value: float) -> set[int]:
    return {floor(value), ceil(value), round(value)}


def _geometry_vertices(geometry, limit: int = 32) -> list[tuple[float, float]]:
    simplified = geometry.simplify(1.0, preserve_topology=True)
    polygons = (
        list(simplified.geoms)
        if hasattr(simplified, "geoms")
        else [simplified]
    )
    coordinates: list[tuple[float, float]] = []
    for polygon in polygons:
        if not hasattr(polygon, "exterior"):
            continue
        rings = [polygon.exterior, *polygon.interiors]
        for ring in rings:
            coordinates.extend((float(x), float(y)) for x, y in list(ring.coords)[:-1])
    if len(coordinates) <= limit:
        return coordinates
    step = len(coordinates) / limit
    return [coordinates[int(index * step)] for index in range(limit)]


def _hole_bounds(geometry) -> list[tuple[float, float, float, float]]:
    polygons = list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]
    return [
        tuple(float(value) for value in ring.bounds)
        for polygon in polygons
        if hasattr(polygon, "interiors")
        for ring in polygon.interiors
    ]


__all__ = ["Candidate", "Layout", "Option", "Packer", "PlacedDesign", "ROTATIONS"]
