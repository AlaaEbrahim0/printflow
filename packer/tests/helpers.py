"""Synthetic approved designs, requests and storage helpers for the tests.

Tests never commit binaries and never touch the network: every image is a small
NumPy array written into a ``tmp_path`` storage root. Plain arrays are accepted
anywhere a design is expected; the helpers mint the UUIDs and paths.
"""

from __future__ import annotations

import io
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from printsheet_packer.storage import StorageRoot

ALPHA = 5


def _paint(w: int, h: int, color: tuple[int, int, int], mask: np.ndarray, alpha: int) -> np.ndarray:
    array = np.zeros((h, w, 4), dtype=np.uint8)
    array[..., 0], array[..., 1], array[..., 2] = color
    array[mask, 3] = alpha
    return array


def circle(w: int, h: int, color=(200, 40, 40)) -> np.ndarray:
    ys, xs = np.mgrid[0:h, 0:w]
    mask = ((xs - w / 2) / (w * 0.45)) ** 2 + ((ys - h / 2) / (h * 0.45)) ** 2 < 1
    return _paint(w, h, color, mask, 255)


def ring(w: int, h: int) -> np.ndarray:
    """A donut: visible pixels with a transparent hole in the middle."""
    ys, xs = np.mgrid[0:h, 0:w]
    radius = ((xs - w / 2) ** 2 + (ys - h / 2) ** 2) ** 0.5
    mask = (radius < min(w, h) * 0.45) & (radius > min(w, h) * 0.25)
    return _paint(w, h, (30, 200, 60), mask, 255)


def solid(w: int, h: int) -> np.ndarray:
    return _paint(w, h, (10, 20, 200), np.ones((h, w), dtype=bool), 255)


def faint(w: int, h: int, alpha: int = 6) -> np.ndarray:
    """One low-alpha pixel: occupied at the default threshold, invisible at 7."""
    array = np.zeros((h, w, 4), dtype=np.uint8)
    array[h // 2, w // 2] = (0, 0, 0, alpha)
    return array


def gradient(w: int, h: int) -> np.ndarray:
    """Smoke-like alpha ramp, nothing fully opaque."""
    array = np.zeros((h, w, 4), dtype=np.uint8)
    array[..., 0] = 255
    array[..., 3] = np.linspace(0, 200, w, dtype=np.uint8)[None, :]
    return array


def blank(w: int, h: int) -> np.ndarray:
    return np.zeros((h, w, 4), dtype=np.uint8)


def png_bytes(array: np.ndarray) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(array, "RGBA").save(buffer, format="PNG")
    return buffer.getvalue()


@dataclass
class Spec:
    """One design: its approved pixels and the request record that points at it."""

    array: np.ndarray
    name: str = "design"
    allow_rotation: bool = True
    design_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    version_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    relative_path: str | None = None

    def __post_init__(self) -> None:
        height, width = self.array.shape[:2]
        self.relative_path = (
            self.relative_path or f"b1/{self.design_id}/versions/{self.version_id}.png"
        )
        self.size = (width, height)

    @property
    def record(self) -> dict[str, Any]:
        width, height = self.size
        return {
            "designId": self.design_id,
            "versionId": self.version_id,
            "displayName": self.name,
            "filePath": self.relative_path,
            "widthPx": width,
            "heightPx": height,
            "allowRotation": self.allow_rotation,
        }

    @property
    def path(self) -> str:
        return self.relative_path


def as_spec(item: np.ndarray | Spec, name: str | None = None) -> Spec:
    if isinstance(item, Spec):
        return item
    return Spec(array=item, name=name or "design")


def specs(items: list[np.ndarray | Spec], allow_rotation: bool | None = None) -> list[Spec]:
    out = [as_spec(item) for item in items]
    if allow_rotation is not None:
        for spec in out:
            spec.allow_rotation = allow_rotation
    return out


def request_document(
    items: list[np.ndarray | Spec], *, allow_rotation: bool | None = None, **overrides: Any
) -> dict[str, Any]:
    designs = specs(items, allow_rotation=allow_rotation)
    base: dict[str, Any] = {
        "schemaVersion": "1.0",
        "requestId": "req-test",
        "rollWidthCm": 10,
        "marginMm": 2,
        "edgeMarginMm": 0,
        "dpi": 300,
        "alphaThreshold": ALPHA,
        "cellMm": 1,
        "randomizedOrderings": 1,
        "timeBudgetMs": 1000,
        "seed": 1,
        "noInterlocking": False,
        "designs": [design.record for design in designs],
        "output": {
            "directory": "b1/sheets",
            "previewPath": "b1/sheets/preview.png",
            "manifestPath": "b1/sheets/placements.json",
        },
    }
    base.update(overrides)
    return base


def write_storage(directory: Path, items: list[np.ndarray | Spec]) -> Path:
    root = directory / "storage"
    root.mkdir(parents=True, exist_ok=True)
    for spec in specs(items):
        target = root / spec.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(png_bytes(spec.array))
    return root


def storage_root(directory: Path) -> StorageRoot:
    return StorageRoot(write_storage(directory, []))
