"""Strip-based sheet rendering with lossless 90° transforms only.

The sheet is never allocated in memory: :meth:`SheetRenderer.render_strip`
returns one horizontal band at a time. Pixels come from the approved
full-resolution files, are rotated with transposes (never interpolation) and
are moved by whole pixels only.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass

import numpy as np
from PIL import Image

from printsheet_packer.errors import PackerError
from printsheet_packer.masks import rotate_rgba

DEFAULT_STRIP_ROWS = 512
DEFAULT_CACHE_BYTES = 256 * 1024 * 1024

SourceLoader = Callable[[str], np.ndarray]


@dataclass(frozen=True)
class RenderPlacement:
    """Geometry a renderer needs for one placement, in sheet pixels."""

    design_id: str
    x_px: int
    y_px: int
    width_px: int
    height_px: int
    rotation_deg: int


class _SourceCache:
    """Decodes each approved file at most once, within a byte budget."""

    def __init__(self, loader: SourceLoader, max_bytes: int = DEFAULT_CACHE_BYTES) -> None:
        self._loader = loader
        self._max_bytes = max_bytes
        self._items: dict[str, np.ndarray] = {}
        self._order: list[str] = []

    def get(self, key: str) -> np.ndarray:
        cached = self._items.get(key)
        if cached is not None:
            self._touch(key)
            return cached
        array = self._loader(key)
        self._items[key] = array
        self._touch(key)
        self._evict()
        return array

    def rotated(self, key: str, rotation_deg: int) -> np.ndarray:
        source = self.get(key)
        if rotation_deg == 0:
            return source
        cache_key = f"{key}@{rotation_deg}"
        cached = self._items.get(cache_key)
        if cached is not None:
            self._touch(cache_key)
            return cached
        rotated = rotate_rgba(source, rotation_deg)
        self._items[cache_key] = rotated
        self._touch(cache_key)
        self._evict()
        return rotated

    def _touch(self, key: str) -> None:
        if key in self._order:
            self._order.remove(key)
        self._order.append(key)

    def _evict(self) -> None:
        used = sum(array.nbytes for array in self._items.values())
        while used > self._max_bytes and len(self._order) > 1:
            victim = self._order.pop(0)
            used -= self._items.pop(victim).nbytes


class SheetRenderer:
    """Renders placements onto a sheet of fixed width, band by band."""

    def __init__(
        self,
        sheet_width_px: int,
        sheet_height_px: int,
        placements: Sequence[RenderPlacement],
        loader: SourceLoader,
        *,
        cache_bytes: int = DEFAULT_CACHE_BYTES,
    ) -> None:
        if sheet_width_px < 1 or sheet_height_px < 1:
            raise PackerError("Sheet geometry must be at least one pixel per side")
        self.sheet_width_px = int(sheet_width_px)
        self.sheet_height_px = int(sheet_height_px)
        self.placements = tuple(placements)
        self._cache = _SourceCache(loader, cache_bytes)

    # ------------------------------------------------------------------
    def render_strip(self, y0: int, y1: int, *, only: str | None = None) -> np.ndarray:
        """RGBA band ``[y0, y1)`` of the sheet as an ``(y1-y0, width, 4)`` array."""
        if not (0 <= y0 < y1 <= self.sheet_height_px):
            raise PackerError(
                f"Strip [{y0}, {y1}) is outside the sheet height {self.sheet_height_px}"
            )
        band = np.zeros((y1 - y0, self.sheet_width_px, 4), dtype=np.uint8)
        for placement in self.placements:
            if only is not None and placement.design_id != only:
                continue
            self._paste(band, y0, y1, placement)
        return band

    def _paste(self, band: np.ndarray, y0: int, y1: int, placement: RenderPlacement) -> None:
        height = placement.height_px
        width = placement.width_px
        top = placement.y_px
        row_from = max(y0 - top, 0)
        row_to = min(y1 - top, height)
        if row_to <= row_from:
            return
        left = placement.x_px
        source = self._cache.rotated(placement.design_id, placement.rotation_deg)
        if source.shape[0] != height or source.shape[1] != width:
            raise PackerError(
                f"Placement {placement.design_id} declares {width}x{height} px but the "
                f"approved file rotates to {source.shape[1]}x{source.shape[0]} px",
                designId=placement.design_id,
            )
        source_column_start = max(0, -left)
        source_column_end = min(width, self.sheet_width_px - left)
        if source_column_end <= source_column_start:
            return
        incoming = source[row_from:row_to, source_column_start:source_column_end]
        target = band[
            row_from + top - y0 : row_to + top - y0,
            left + source_column_start : left + source_column_end,
        ]
        painted = incoming[..., 3] > 0
        np.copyto(target, incoming, where=painted[..., None])

    def iter_strips(
        self, rows: int = DEFAULT_STRIP_ROWS, *, only: str | None = None
    ) -> Iterator[tuple[int, int, np.ndarray]]:
        """Yield ``(y0, y1, band)`` with at most ``rows`` sheet rows each."""
        if rows < 1:
            raise PackerError("rows must be at least 1")
        for y0 in range(0, self.sheet_height_px, rows):
            y1 = min(y0 + rows, self.sheet_height_px)
            yield y0, y1, self.render_strip(y0, y1, only=only)

    def placement(self, design_id: str) -> RenderPlacement:
        for candidate in self.placements:
            if candidate.design_id == design_id:
                return candidate
        raise PackerError(f"Placement {design_id} is not on this sheet")

    def render_layer(self, design_id: str) -> np.ndarray:
        """The band a single placement occupies, with everything else transparent."""
        placement = self.placement(design_id)
        y0 = max(0, placement.y_px)
        y1 = min(self.sheet_height_px, placement.y_px + placement.height_px)
        return self.render_strip(y0, y1, only=design_id)

    def source(self, design_id: str) -> np.ndarray:
        """The approved pixels exactly as the file stores them."""
        return self._cache.get(design_id)

    def rotated_source(self, design_id: str, rotation_deg: int | None = None) -> np.ndarray:
        """Approved pixels rotated by ``rotation_deg``, defaulting to the record's."""
        rotation = self.placement(design_id).rotation_deg
        return self._cache.rotated(design_id, rotation if rotation_deg is None else rotation_deg)


def preview_from_renderer(
    renderer: SheetRenderer, *, target_width_px: int = 900, strip_rows: int = DEFAULT_STRIP_ROWS
) -> Image.Image:
    """Downscaled RGBA preview of the whole sheet.

    This is the only place the packer resamples, and only for the preview file:
    the print-ready flat exports are written strip-by-strip at full resolution.
    """
    if renderer.sheet_width_px == 0:  # pragma: no cover - guarded by the constructor
        raise PackerError("Cannot preview an empty sheet")
    scale = min(1.0, target_width_px / renderer.sheet_width_px)
    preview_width = max(1, round(renderer.sheet_width_px * scale))
    boundaries = list(range(0, renderer.sheet_height_px, strip_rows))
    heights = [
        max(1, round(min(strip_rows, renderer.sheet_height_px - y0) * scale)) for y0 in boundaries
    ]
    preview_height = sum(heights)
    target = Image.new("RGBA", (preview_width, max(1, preview_height)), (0, 0, 0, 0))
    offset = 0
    for y0, strip_height in zip(boundaries, heights, strict=True):
        band = renderer.render_strip(y0, min(y0 + strip_rows, renderer.sheet_height_px))
        strip = Image.fromarray(band)
        strip = strip.resize((preview_width, strip_height), Image.Resampling.BILINEAR)
        target.paste(strip, (0, offset))
        offset += strip_height
    return target


def rgba_loader_from(mapping: Mapping[str, np.ndarray]) -> SourceLoader:
    """Test helper: serve decoded arrays straight from a mapping."""

    def load(design_id: str) -> np.ndarray:
        try:
            return mapping[design_id]
        except KeyError as exc:
            raise PackerError(f"No image data for design {design_id}") from exc

    return load


__all__ = [
    "DEFAULT_CACHE_BYTES",
    "DEFAULT_STRIP_ROWS",
    "RenderPlacement",
    "SheetRenderer",
    "preview_from_renderer",
    "rgba_loader_from",
]
