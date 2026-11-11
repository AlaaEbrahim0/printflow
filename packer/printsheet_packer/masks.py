"""Alpha decoding, occupancy masks, conservative dilation and grids.

Everything here is exact in the integer-pixel sense: masks are built from the
alpha channel of the approved full-resolution file, dilation uses a Chebyshev
(square) structuring element, and grids round **up** so occupied area is never
underestimated. Nothing in this module resamples pixels.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field, replace

import numpy as np
from PIL import Image
from shapely import affinity
from shapely.geometry import GeometryCollection, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union

from printsheet_packer.contracts import DesignInput
from printsheet_packer.errors import PackerError, SourceDimensionError
from printsheet_packer.units import (
    ceil_pixels_for_millimeters,
    pixels_for_centimeters,
    pixels_for_millimeters,
    round_half_away_from_zero,
)

DEFAULT_ALPHA_THRESHOLD = 5


@dataclass(frozen=True)
class BoundingBox:
    """Half-open pixel box ``[x0, x1) × [y0, y1)`` in image coordinates."""

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    @property
    def area(self) -> int:
        return self.width * self.height


@dataclass(frozen=True)
class DesignMask:
    """Visible geometry of one approved design, at full resolution."""

    design: DesignInput
    occupied: np.ndarray  # cropped to ``bbox``
    bbox: BoundingBox
    image_width_px: int
    image_height_px: int
    # Exact alpha silhouette in full-image pixel coordinates. Built lazily:
    # the raster search never needs it, and unioning hundreds of thousands of
    # alpha runs is expensive on real artwork.
    _geometry: BaseGeometry | None = field(default=None, repr=False, compare=False)

    @property
    def geometry(self) -> BaseGeometry:
        geometry = self._geometry
        if geometry is None:
            geometry = affinity.translate(
                _mask_geometry(self.occupied), xoff=self.bbox.x0, yoff=self.bbox.y0
            )
            object.__setattr__(self, "_geometry", geometry)
        return geometry

    @property
    def visible_pixels(self) -> int:
        return int(self.occupied.sum())


@dataclass(frozen=True)
class Footprint:
    """One design in one rotation, represented by a conservative occupancy grid.

    The grid is the search footprint: every cell is occupied when any visible
    pixel inside it is. ``build_footprint`` also populates exact polygon
    geometry for callers that need it; the production raster search deliberately
    leaves those geometries empty because unioning real artwork is expensive.
    """

    rotation_deg: int
    grid: np.ndarray
    block: np.ndarray
    geometry: BaseGeometry
    collision_geometry: BaseGeometry
    bbox: BoundingBox
    image_width_px: int
    image_height_px: int
    radius_cells: int
    cell_px: int
    visible_pixels: int

    def image_origin_px(self, block_x_cell: int, block_y_cell: int) -> tuple[int, int]:
        shift = self.radius_cells * self.cell_px
        return (block_x_cell * self.cell_px + shift, block_y_cell * self.cell_px + shift)


def load_rgba(path_or_bytes: io.IOBase | str | bytes) -> np.ndarray:
    """Decode an image to an ``(H, W, 4)`` uint8 RGBA array without resampling."""
    source: io.IOBase | str = (
        io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    )
    with Image.open(source) as image:
        image.load()
        rgba = image if image.mode == "RGBA" else image.convert("RGBA")
        return np.array(rgba, dtype=np.uint8, copy=True)


def fit_rgba_to_target(
    design: DesignInput, rgba: np.ndarray, dpi: int
) -> tuple[DesignInput, np.ndarray]:
    """Fit pixels inside the operator's physical target box, preserving aspect ratio."""
    target_width = design.target_width_cm
    target_height = design.target_height_cm
    if target_width is None and target_height is None:
        return design, rgba
    if target_width is None or target_height is None:
        raise PackerError(
            f"Design {design.design_id} must specify both target dimensions or neither",
            designId=design.design_id,
        )

    box_width = pixels_for_centimeters(target_width, dpi)
    box_height = pixels_for_centimeters(target_height, dpi)
    scale = min(box_width / design.width_px, box_height / design.height_px)
    width = max(1, round_half_away_from_zero(design.width_px * scale))
    height = max(1, round_half_away_from_zero(design.height_px * scale))
    if (width, height) == (design.width_px, design.height_px):
        return design, rgba

    resized = resize_rgba(rgba, width, height)
    return (
        replace(
            design,
            width_px=width,
            height_px=height,
            source_width_px=design.source_width_px or design.width_px,
            source_height_px=design.source_height_px or design.height_px,
        ),
        resized,
    )


def resize_rgba(rgba: np.ndarray, width: int, height: int) -> np.ndarray:
    if width < 1 or height < 1:
        raise PackerError("Resized dimensions must be at least one pixel")
    resized = np.asarray(
        Image.fromarray(rgba).resize((width, height), resample=Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )
    return resized


def occupancy_from_alpha(alpha: np.ndarray, threshold: int = DEFAULT_ALPHA_THRESHOLD) -> np.ndarray:
    """``True`` where ``alpha > threshold``; faint smoke counts as occupied."""
    return alpha > threshold


def visible_bbox(occupied: np.ndarray) -> BoundingBox | None:
    """Bounding box of the occupied pixels, or ``None`` when nothing is visible."""
    rows = occupied.any(axis=1)
    if not rows.any():
        return None
    columns = occupied.any(axis=0)
    y0 = int(np.nonzero(rows)[0][0])
    y1 = int(np.nonzero(rows)[0][-1]) + 1
    x0 = int(np.nonzero(columns)[0][0])
    x1 = int(np.nonzero(columns)[0][-1]) + 1
    return BoundingBox(x0, y0, x1, y1)


def build_design_mask(
    design: DesignInput,
    rgba: np.ndarray,
    alpha_threshold: int = DEFAULT_ALPHA_THRESHOLD,
) -> DesignMask:
    height, width = rgba.shape[:2]
    if (width, height) != (design.width_px, design.height_px):
        raise SourceDimensionError(
            f"Design {design.design_id} declares {design.width_px}x{design.height_px} px but "
            f"{design.file_path} decodes to {width}x{height} px",
            designId=design.design_id,
            versionId=design.version_id,
            declared={"widthPx": design.width_px, "heightPx": design.height_px},
            actual={"widthPx": width, "heightPx": height},
        )
    occupied = occupancy_from_alpha(rgba[..., 3], alpha_threshold)
    bbox = visible_bbox(occupied)
    if bbox is None:
        raise PackerError(
            f"Design {design.design_id} has no pixel above the alpha threshold "
            f"({alpha_threshold}); nothing can be packed",
            designId=design.design_id,
            versionId=design.version_id,
        )
    return DesignMask(
        design=design,
        occupied=occupied[bbox.y0 : bbox.y1, bbox.x0 : bbox.x1],
        bbox=bbox,
        image_width_px=width,
        image_height_px=height,
    )


def _mask_geometry(occupied: np.ndarray) -> BaseGeometry:
    """Convert occupied pixel cells to polygonal geometry, preserving holes."""
    rectangles: list[Polygon] = []
    active: dict[tuple[int, int], int] = {}

    def row_runs(row: np.ndarray) -> set[tuple[int, int]]:
        padded = np.pad(row, (1, 1), constant_values=False).astype(np.int8)
        changes = np.diff(padded)
        starts = np.flatnonzero(changes == 1)
        ends = np.flatnonzero(changes == -1)
        return {(int(start), int(end)) for start, end in zip(starts, ends, strict=True)}

    for y, row in enumerate(occupied):
        runs = row_runs(row)
        for interval in active.keys() - runs:
            start_y = active.pop(interval)
            rectangles.append(box(interval[0], start_y, interval[1], y))
        for interval in runs - active.keys():
            active[interval] = y
    end_y = occupied.shape[0]
    for (x0, x1), start_y in active.items():
        rectangles.append(box(x0, start_y, x1, end_y))

    if not rectangles:
        return GeometryCollection()
    geometry = unary_union(rectangles)
    if not geometry.is_valid:
        geometry = geometry.buffer(0)
    return geometry


# ----------------------------------------------------------------------
# rotation
# ----------------------------------------------------------------------


def rotate_degrees(mask: np.ndarray, rotation_deg: int) -> np.ndarray:
    """Rotate by 0/90/180/270 clockwise with transposes only (no interpolation)."""
    turns = quarter_turns(rotation_deg)
    if turns == 0:
        return mask
    return np.ascontiguousarray(np.rot90(mask, k=-turns))


def rotate_rgba(rgba: np.ndarray, rotation_deg: int) -> np.ndarray:
    """Same transform as :func:`rotate_degrees`, documented for RGBA arrays."""
    return rotate_degrees(rgba, rotation_deg)


def rotate_bbox(
    bbox: BoundingBox, image_width_px: int, image_height_px: int, rotation_deg: int
) -> tuple[BoundingBox, int, int]:
    """Rotate a bbox clockwise; returns the box and the rotated image size."""
    box = bbox
    width, height = image_width_px, image_height_px
    for _ in range(quarter_turns(rotation_deg)):
        box = BoundingBox(height - box.y1, box.x0, height - box.y0, box.x1)
        width, height = height, width
    return box, width, height


def quarter_turns(rotation_deg: int) -> int:
    if rotation_deg not in (0, 90, 180, 270):
        raise PackerError(f"rotationDeg must be 0/90/180/270, got {rotation_deg}")
    return rotation_deg // 90


# ----------------------------------------------------------------------
# dilation
# ----------------------------------------------------------------------


def _max_run_axis(mask: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """Dilate along ``axis`` with a run of ``2*radius+1``. Exact and O(n)."""
    if radius <= 0:
        return mask
    length = mask.shape[axis]
    prefix_shape = tuple(
        length + 1 if index == axis else size for index, size in enumerate(mask.shape)
    )
    prefix = np.zeros(prefix_shape, dtype=np.int32)
    window_prefix = prefix[(slice(None),) * axis + (slice(1, None),)]
    np.cumsum(mask, axis=axis, dtype=np.int32, out=window_prefix)
    indices = np.arange(length)
    high = np.minimum(indices + radius + 1, length)
    low = np.maximum(indices - radius, 0)
    window = np.take(prefix, high, axis=axis) - np.take(prefix, low, axis=axis)
    return window > 0


def dilate_square(mask: np.ndarray, radius: int) -> np.ndarray:
    """Chebyshev dilation clipped to the input shape.

    Structuring element: the square ``{|dx| <= r, |dy| <= r}``, i.e. radius
    ``r`` in the Chebyshev metric. The square contains the disk of radius
    ``r``, so this is the conservative choice: a gap certified here also holds
    as a Euclidean gap.
    """
    if radius <= 0:
        return mask
    return _max_run_axis(_max_run_axis(mask, radius, axis=0), radius, axis=1)


def dilate_block(mask: np.ndarray, radius: int) -> np.ndarray:
    """Chebyshev dilation grown by ``radius`` on every side (never clipped)."""
    if radius <= 0:
        return mask.copy()
    padded = np.pad(mask, ((radius, radius), (radius, radius)), constant_values=False)
    return dilate_square(padded, radius)


# ----------------------------------------------------------------------
# occupancy grid
# ----------------------------------------------------------------------


def cell_size_px(cell_mm: float, dpi: int) -> int:
    """``cellPx = max(1, round(cellMm / 25.4 * dpi))``."""
    return max(1, pixels_for_millimeters(cell_mm, dpi))


def grid_extent(size_px: int, cell_px: int) -> int:
    """Cells needed to cover ``size_px``, rounded **up**."""
    return -(-size_px // cell_px)


def _pool(mask: np.ndarray, cell_px: int, origin_x: int = 0, origin_y: int = 0) -> np.ndarray:
    """Max-pool ``mask`` onto global cell boundaries.

    ``origin_x``/``origin_y`` are the mask's pixel position in the frame the
    cells belong to, so the resulting cells line up with that frame exactly.
    """
    height, width = mask.shape
    col0 = origin_x // cell_px
    col1 = (origin_x + width - 1) // cell_px
    row0 = origin_y // cell_px
    row1 = (origin_y + height - 1) // cell_px
    rows, columns = row1 - row0 + 1, col1 - col0 + 1
    sub_x, sub_y = origin_x - col0 * cell_px, origin_y - row0 * cell_px
    canvas = np.zeros((rows * cell_px, columns * cell_px), dtype=bool)
    canvas[sub_y : sub_y + height, sub_x : sub_x + width] = mask
    return canvas.reshape(rows, cell_px, columns, cell_px).any(axis=(1, 3))


def to_grid(mask: np.ndarray, cell_px: int) -> np.ndarray:
    """Max-pool a mask whose origin is ``(0, 0)``; occupied if any pixel is."""
    if mask.ndim != 2:
        raise ValueError("to_grid expects a 2-D boolean mask")
    if mask.size == 0:
        return np.zeros((0, 0), dtype=bool)
    return _pool(mask, cell_px)


def _aligned_image_grid(
    occupied: np.ndarray, bbox: BoundingBox, image_width_px: int, image_height_px: int, cell_px: int
) -> np.ndarray:
    """Grid of the whole image frame, pooled on that frame's cell boundaries."""
    rows = grid_extent(image_height_px, cell_px)
    columns = grid_extent(image_width_px, cell_px)
    grid = np.zeros((rows, columns), dtype=bool)
    sub = _pool(occupied, cell_px, bbox.x0, bbox.y0)
    row0, col0 = bbox.y0 // cell_px, bbox.x0 // cell_px
    grid[row0 : row0 + sub.shape[0], col0 : col0 + sub.shape[1]] = sub
    return grid


def image_grid(design_mask: DesignMask, cell_px: int) -> np.ndarray:
    return _aligned_image_grid(
        design_mask.occupied,
        design_mask.bbox,
        design_mask.image_width_px,
        design_mask.image_height_px,
        cell_px,
    )


def required_margin_px(margin_mm: float, dpi: int) -> int:
    """Clearance in pixels, rounded **up** so the physical gap is never smaller."""
    return ceil_pixels_for_millimeters(margin_mm, dpi)


def collision_radius_px(margin_px: int) -> float:
    """Radial buffer radius that certifies a Chebyshev gap of ``margin_px``.

    A radial offset of ``r`` certifies a Chebyshev gap of ``2r / sqrt(2)`` on a
    diagonal, so matching the integrity gate needs ``r >= margin / sqrt(2)``.
    Using ``margin / 2 + 1`` (the old value) is ~29% short at real print margins.
    """
    return margin_px / math.sqrt(2) if margin_px > 0 else 0.0


def block_radius_cells(margin_px: int, cell_px: int) -> int:
    """Padding cells per side guaranteeing ``margin_px`` between visible pixels.

    Two blocks that share no cell keep their nearest visible pixels at least
    ``2 * radius * cell_px + 1`` apart in the axis that separates them, so the
    smallest radius satisfying that bound is used.
    """
    return -(-(margin_px - 1) // (2 * cell_px))


def simple_footprint(grid: np.ndarray, mode: str) -> np.ndarray:
    """Non-interlocking footprint: axis-aligned box, or convex hull if available."""
    if mode == "none":
        return grid.copy()
    if mode == "hull":
        hull = _convex_hull_cells(grid)
        if hull is not None:
            return hull
        mode = "bbox"
    if mode == "bbox":
        return _bounding_box_cells(grid)
    raise PackerError(f"Unknown footprint mode: {mode}")


def _bounding_box_cells(grid: np.ndarray) -> np.ndarray:
    filled = np.zeros_like(grid)
    rows = np.nonzero(grid.any(axis=1))[0]
    columns = np.nonzero(grid.any(axis=0))[0]
    if rows.size and columns.size:
        filled[rows[0] : rows[-1] + 1, columns[0] : columns[-1] + 1] = True
    return filled


def _convex_hull_cells(grid: np.ndarray) -> np.ndarray | None:
    """Cells touched by the convex hull of the occupied cells, if Shapely is installed."""
    try:
        from shapely.geometry import box
        from shapely.ops import unary_union
    except ImportError:
        return None
    rows, columns = np.nonzero(grid)
    if rows.size == 0:
        return _bounding_box_cells(grid)
    cells = [
        box(column, row, column + 1, row + 1) for row, column in zip(rows, columns, strict=True)
    ]
    hull = unary_union(cells).convex_hull
    out = np.zeros_like(grid)
    bounds = hull.bounds
    row_lo = max(0, int(np.floor(bounds[1])))
    row_hi = min(grid.shape[0], int(np.ceil(bounds[3])))
    col_lo = max(0, int(np.floor(bounds[0])))
    col_hi = min(grid.shape[1], int(np.ceil(bounds[2])))
    for row in range(row_lo, row_hi):
        for column in range(col_lo, col_hi):
            if hull.intersects(box(column, row, column + 1, row + 1)):
                out[row, column] = True
    return out


def build_footprint(
    design_mask: DesignMask,
    rotation_deg: int,
    cell_px: int,
    margin_px: int,
    *,
    interlocking: bool = True,
) -> Footprint:
    """Grid + collision block for one design in one allowed rotation."""
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

    geometry = _rotate_geometry(
        design_mask.geometry,
        design_mask.image_width_px,
        design_mask.image_height_px,
        rotation_deg,
    )
    if not interlocking:
        geometry = geometry.convex_hull

    grid = _aligned_image_grid(occupied, bbox, image_width, image_height, cell_px)

    if not interlocking:
        grid = simple_footprint(grid, "hull")

    radius = block_radius_cells(margin_px, cell_px)
    # The integrity gate measures a Chebyshev gap, so the collision certificate
    # must be a square offset. A radial (mitre) buffer of ``r`` only certifies
    # ``2r / sqrt(2)`` on a diagonal; ``margin_px / sqrt(2)`` matches the gate
    # exactly at the worst-case diagonal.
    collision_geometry = (
        geometry.buffer(collision_radius_px(margin_px), join_style="mitre")
        if margin_px
        else geometry
    )
    return Footprint(
        rotation_deg=rotation_deg,
        grid=grid,
        block=dilate_block(grid, radius),
        geometry=geometry,
        collision_geometry=collision_geometry,
        bbox=bbox,
        image_width_px=image_width,
        image_height_px=image_height,
        radius_cells=radius,
        cell_px=cell_px,
        visible_pixels=int(occupied.sum()),
    )


def _rotate_geometry(
    geometry: BaseGeometry,
    image_width_px: int,
    image_height_px: int,
    rotation_deg: int,
) -> BaseGeometry:
    transforms = {
        0: (1, 0, 0, 1, 0, 0),
        90: (0, -1, 1, 0, image_height_px, 0),
        180: (-1, 0, 0, -1, image_width_px, image_height_px),
        270: (0, 1, -1, 0, 0, image_width_px),
    }
    try:
        transform = transforms[rotation_deg]
    except KeyError as exc:
        raise PackerError(f"rotationDeg must be 0/90/180/270, got {rotation_deg}") from exc
    return affinity.affine_transform(geometry, transform)


__all__ = [
    "DEFAULT_ALPHA_THRESHOLD",
    "BoundingBox",
    "DesignMask",
    "Footprint",
    "build_design_mask",
    "build_footprint",
    "cell_size_px",
    "collision_radius_px",
    "dilate_block",
    "dilate_square",
    "fit_rgba_to_target",
    "grid_extent",
    "image_grid",
    "load_rgba",
    "occupancy_from_alpha",
    "required_margin_px",
    "resize_rgba",
    "rotate_bbox",
    "rotate_degrees",
    "rotate_rgba",
    "simple_footprint",
    "to_grid",
    "visible_bbox",
]
