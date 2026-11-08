"""Core data types for the nesting kit.

This module is deliberately dependency-free (stdlib only) so that a solver
implementation can be swapped out without touching the types the harness and
the referee depend on.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Rotations a placement may use. The physical sheet is fixed; only these
# quarter turns are legal because they preserve pixel data exactly.
ROTATIONS: tuple[int, ...] = (0, 90, 180, 270)


@dataclass(frozen=True)
class DesignSpec:
    """One approved design that must be placed.

    ``width_px``/``height_px`` are the pixel dimensions of the file the solver
    is given. The solver never resamples: whatever it places must be these
    exact pixels, rotated by a multiple of 90 degrees.
    """

    design_id: str
    file_path: str
    width_px: int
    height_px: int
    allow_rotation: bool = True
    display_name: str | None = None

    @property
    def label(self) -> str:
        return self.display_name or self.design_id


@dataclass(frozen=True)
class PackParams:
    """Sheet geometry and the knobs the production packer exposes.

    ``dpi`` converts millimetres to pixels; ``margin_mm`` is the required
    visible-pixel gap between any two designs; ``edge_margin_mm`` is the
    required clearance between visible pixels and the sheet edge.
    """

    roll_width_cm: float
    dpi: int
    margin_mm: float
    edge_margin_mm: float
    alpha_threshold: int = 5
    seed: int = 0
    time_budget_ms: int = 5000


@dataclass(frozen=True)
class Placement:
    """A design placed on the sheet.

    ``x_px``/``y_px`` are the top-left corner of the *rotated* design image in
    sheet coordinates, with the origin at the top-left of the sheet. ``y`` grows
    downward, matching image conventions.
    """

    design_id: str
    x_px: int
    y_px: int
    width_px: int
    height_px: int
    rotation_deg: int

    def to_json(self) -> dict[str, Any]:
        return {
            "designId": self.design_id,
            "xPx": self.x_px,
            "yPx": self.y_px,
            "widthPx": self.width_px,
            "heightPx": self.height_px,
            "rotationDeg": self.rotation_deg,
        }


@dataclass(frozen=True)
class UnplacedDesign:
    design_id: str
    reason: str
    details: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {"designId": self.design_id, "reason": self.reason, "details": self.details}


@dataclass(frozen=True)
class Layout:
    """A complete solver answer: where everything went, and what did not fit."""

    placements: tuple[Placement, ...]
    unplaced: tuple[UnplacedDesign, ...]
    sheet_width_px: int
    sheet_height_px: int

    def to_json(self) -> dict[str, Any]:
        return {
            "sheet": {"widthPx": self.sheet_width_px, "heightPx": self.sheet_height_px},
            "placements": [placement.to_json() for placement in self.placements],
            "unplacedDesigns": [item.to_json() for item in self.unplaced],
        }


@dataclass(frozen=True)
class Case:
    """A benchmark case: the designs plus the geometry they must satisfy."""

    name: str
    params: PackParams
    designs: tuple[DesignSpec, ...]
    # Absolute paths to the PNG files, keyed by design id.
    files: dict[str, str] = field(default_factory=dict, repr=False, compare=False)
