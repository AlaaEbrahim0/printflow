"""Types shared by every mono-refinement step.

The point of putting these in their own module is that the steps, the chain and
the presets all agree on one vocabulary without importing each other in a cycle.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from app.errors import WorkerError


class MonoKind(StrEnum):
    """What the artwork is, which decides whether binarizing is even allowed."""

    MONO_INK = "mono-ink"
    FLAT_COLOUR = "flat-colour"
    PHOTO = "photo"


class MonoStageError(WorkerError):
    """A mono step could not honour its parameters or its own postconditions."""

    code = "mono-stage-failed"
    retryable = False


class TwoStateViolation(MonoStageError):
    """The finished plate was not exactly two pixel states.

    This is an internal invariant, not an operator error: if it ever fires, a
    stage has broken its contract and the plate must not reach the packer.
    """

    code = "mono-output-not-two-state"
    retryable = False


class ThresholdMode(StrEnum):
    """How the ink/paper cut is chosen.

    ``otsu``     global Otsu. Best on the dominant case: uniform background and
                 flat ink. Measured 4.5x faster than adaptive and equal or
                 better on clean art.
    ``adaptive`` mean-of-local-window minus a constant. Required when lighting is
                 uneven across the scan, where global Otsu fails badly.
    ``fixed``    an operator-chosen level, for a scan the operator knows.
    """

    OTSU = "otsu"
    ADAPTIVE = "adaptive"
    FIXED = "fixed"


class DenoiseMode(StrEnum):
    """The pre-threshold smoother.

    ``median`` is the default. Measured against a hard-JPEG text plate, a 3x3
    median removed the isolated mosquito speckle and cut tiny blobs from 262 to
    208 for ~1 ms on a 1.4 MP plate. Bilateral was 10x slower for no accuracy
    gain, and a 5x5 median ate thin strokes.
    """

    NONE = "none"
    MEDIAN = "median"
    BILATERAL = "bilateral"


@dataclass(frozen=True)
class MonoConfig:
    """Every knob the mono chain accepts, with the defaults the shop uses.

    Values are validated in :meth:`__post_init__` so a bad job parameter fails
    immediately with a clear message instead of producing a strange plate.
    """

    # --- gating ---------------------------------------------------------------
    # Classification thresholds. Measured on the ten repo fixtures: the six
    # mono-type images score eta >= 0.92 and the four photographs <= 0.79, so
    # 0.85 sits in a wide empty band rather than on a cliff edge.
    mono_eta_min: float = 0.85
    # A "flat colour" image is still gate-eligible, but only for clean-only.
    flat_colour_eta_min: float = 0.85
    # Share of the ink side that must be neutral for the art to count as ink
    # rather than an illustration. The fixtures split absolutely: mono-ink art
    # measures >= 0.946, flat-colour art 0.000.
    neutral_ink_min: float = 0.9
    # Above this many distinct quantised colours the art is not flat enough to
    # binarize safely; it is treated as a photo unless it is neutral ink.
    flat_colour_max_colours: int = 64

    # --- denoise --------------------------------------------------------------
    denoise_mode: DenoiseMode = DenoiseMode.MEDIAN
    denoise_kernel: int = 3
    bilateral_diameter: int = 5
    bilateral_sigma_colour: float = 40.0
    bilateral_sigma_space: float = 40.0

    # --- binarize -------------------------------------------------------------
    threshold_mode: ThresholdMode = ThresholdMode.OTSU
    fixed_threshold: int = 128
    adaptive_block: int = 41
    adaptive_constant: float = 8.0

    # --- post-threshold cleanup ----------------------------------------------
    despeckle_max_px: int = 4
    fill_hole_max_px: int = 4
    morphology_open: int = 0
    morphology_close: int = 0

    # --- optional upscale-then-threshold -------------------------------------
    # Off by default: it multiplies the pixel count, and only helps when the
    # source is smaller than the print size.
    upscale_factor: int = 1

    # --- binarizing a flat-colour illustration is irreversible ---------------
    # The chain refuses unless the operator explicitly asked for it.
    allow_binarize_flat_colour: bool = False

    def __post_init__(self) -> None:
        if not 0.0 < self.mono_eta_min <= 1.0:
            raise MonoStageError(
                f"monoEtaMin must be in (0, 1], got {self.mono_eta_min!r}",
                details={"parameter": "monoEtaMin"},
            )
        if not 0.0 < self.flat_colour_eta_min <= 1.0:
            raise MonoStageError(
                f"flatColourEtaMin must be in (0, 1], got {self.flat_colour_eta_min!r}",
                details={"parameter": "flatColourEtaMin"},
            )
        if not 0.0 < self.neutral_ink_min <= 1.0:
            raise MonoStageError(
                f"neutralInkMin must be in (0, 1], got {self.neutral_ink_min!r}",
                details={"parameter": "neutralInkMin"},
            )
        if self.denoise_kernel not in (3, 5, 7):
            raise MonoStageError(
                f"denoiseKernel must be 3, 5 or 7, got {self.denoise_kernel!r}",
                details={"parameter": "denoiseKernel", "supported": [3, 5, 7]},
            )
        if not 0 <= self.fixed_threshold <= 255:
            raise MonoStageError(
                f"fixedThreshold must be 0..255, got {self.fixed_threshold!r}",
                details={"parameter": "fixedThreshold"},
            )
        if self.adaptive_block < 3 or self.adaptive_block % 2 == 0:
            raise MonoStageError(
                "adaptiveBlock must be an odd number >= 3 "
                f"(it is a window size), got {self.adaptive_block!r}",
                details={"parameter": "adaptiveBlock"},
            )
        if self.upscale_factor not in (1, 2, 3, 4):
            raise MonoStageError(
                f"upscaleFactor must be 1, 2, 3 or 4, got {self.upscale_factor!r}",
                details={"parameter": "upscaleFactor", "supported": [1, 2, 3, 4]},
            )
        for name in ("despeckle_max_px", "fill_hole_max_px"):
            if getattr(self, name) < 0:
                raise MonoStageError(
                    f"{name} must be >= 0, got {getattr(self, name)!r}",
                    details={"parameter": name},
                )
        for name in ("morphology_open", "morphology_close"):
            value = getattr(self, name)
            if value < 0 or value > 9:
                raise MonoStageError(
                    f"{name} must be 0..9 (0 disables it), got {value!r}",
                    details={"parameter": name},
                )


@dataclass
class StageTrace:
    """One line of provenance: what a step did, and what it changed.

    The operator needs to see *why* a plate looks the way it does, and a
    reviewer needs it to tell a genuine cleanup from a destructive one, so each
    step reports the pixel counts it altered rather than a bare "ok".
    """

    stage: str
    changed_px: int = 0
    detail: dict[str, object] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {"stage": self.stage, "changedPx": self.changed_px}
        if self.detail:
            payload["detail"] = dict(self.detail)
        return payload
