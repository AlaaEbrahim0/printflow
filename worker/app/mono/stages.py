"""The individual refinement steps, each a pure function over a working image.

Design notes
------------
Every stage takes a :class:`WorkingImage` and returns a new one plus a
:class:`StageTrace`, so the chain can report what each step actually changed and
a test can call one step in isolation with a hand-built array. No stage reads the
filesystem, the clock or the job document.

Two representations are in play and confusing them is the easy bug:

``grey``   a ``uint8`` luminance array, ``(H, W)``. Every step before binarizing
           works here, so noise is measured on the real signal.
``ink``    a ``bool`` array, ``(H, W)``, ``True`` where ink will be laid down.
           Produced by :func:`binarize` and everything after it.

The finished plate is assembled from ``ink`` by :func:`to_plate`, which is the
only place that decides what a pixel is allowed to be.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Protocol

import cv2
import numpy as np

from app.mono.types import (
    DenoiseMode,
    MonoConfig,
    MonoStageError,
    StageTrace,
    ThresholdMode,
    TwoStateViolation,
)

# The two states a finished plate may contain. Ink is opaque black; paper is
# fully transparent white. Nothing else is ever written.
INK_RGBA = (0, 0, 0, 255)
PAPER_RGBA = (255, 255, 255, 0)


@dataclass(frozen=True)
class WorkingImage:
    """The image flowing through the chain, in whichever form the last step left.

    ``ink`` is ``None`` until :func:`binarize` runs; from then on ``grey`` is
    stale and only ``ink`` is meaningful. Keeping both fields means a stage can
    declare which form it needs and the chain can refuse a bad order instead of
    silently operating on stale pixels.
    """

    grey: np.ndarray | None = None
    ink: np.ndarray | None = None
    alpha: np.ndarray | None = None

    def __post_init__(self) -> None:
        if self.grey is None and self.ink is None:
            raise MonoStageError("a working image needs either grey or ink pixels")
        if self.grey is not None and self.ink is not None:
            raise MonoStageError(
                "a working image carries grey or ink, never both; "
                "the chain would not know which one is current"
            )

    @property
    def shape(self) -> tuple[int, int]:
        source = self.grey if self.grey is not None else self.ink
        assert source is not None
        return int(source.shape[0]), int(source.shape[1])

    @property
    def is_binary(self) -> bool:
        return self.ink is not None

    def require_grey(self, stage: str) -> np.ndarray:
        if self.grey is None:
            raise MonoStageError(
                f"stage {stage!r} needs continuous-tone pixels, but the image is already "
                "binarized; check the chain order",
                details={"stage": stage},
            )
        return self.grey

    def require_ink(self, stage: str) -> np.ndarray:
        if self.ink is None:
            raise MonoStageError(
                f"stage {stage!r} needs binarized pixels, but the image is still "
                "continuous-tone; check the chain order",
                details={"stage": stage},
            )
        return self.ink


class Stage(Protocol):
    """One refinement step.

    A stage is any callable with this signature, which is what lets the chain be
    a plain list: reordering it, dropping a step, or substituting a different
    implementation is a list edit, not a code change.
    """

    name: str

    def __call__(
        self, image: WorkingImage, config: MonoConfig
    ) -> tuple[WorkingImage, StageTrace]: ...


@dataclass(frozen=True)
class NamedStage:
    """Binds a name to a stage function so the chain can label its traces."""

    name: str
    run: Stage

    def __call__(
        self, image: WorkingImage, config: MonoConfig
    ) -> tuple[WorkingImage, StageTrace]:
        return self.run(image, config)


# --- pre-threshold steps -----------------------------------------------------


def denoise(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Smooth away DCT ringing and mosquito noise before the cut is chosen.

    This runs *before* binarizing on purpose: the cut itself is computed from the
    smoothed pixels, so isolated noise spikes do not drag the threshold or become
    ink. A 3x3 median is the default because it removes single-pixel speckle while
    leaving a 3 px stroke intact — measured on the low-res JPEG fixture upscaled
    to print size, it cut isolated noise pixels from 56 to 8 and blobs of <= 4 px
    from 262 to 208, in about 1 ms on a 1.4 MP plate.
    """

    grey = image.require_grey("denoise")
    if config.denoise_mode is DenoiseMode.NONE:
        return image, StageTrace(stage="denoise", detail={"mode": "none"})

    if config.denoise_mode is DenoiseMode.MEDIAN:
        smoothed = cv2.medianBlur(grey, config.denoise_kernel)
        mode = "median"
        detail = {"mode": mode, "kernel": config.denoise_kernel}
    else:
        smoothed = cv2.bilateralFilter(
            grey,
            config.bilateral_diameter,
            config.bilateral_sigma_colour,
            config.bilateral_sigma_space,
        )
        mode = "bilateral"
        detail = {
            "mode": mode,
            "diameter": config.bilateral_diameter,
            "sigmaColour": config.bilateral_sigma_colour,
            "sigmaSpace": config.bilateral_sigma_space,
        }

    changed = int(np.count_nonzero(smoothed != grey))
    return (
        replace(image, grey=smoothed),
        StageTrace(stage="denoise", changed_px=changed, detail=detail),
    )


def upscale(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Optionally enlarge before the cut, so the cut is made at print resolution.

    Off by default: it multiplies the pixel count. It only helps when the source
    is materially smaller than the print size, where thresholding at the small
    size would bake in blocky edges. Interpolation happens on the grey image, so
    the extra pixels are real signal for the binarizer rather than invented ink.
    """

    grey = image.require_grey("upscale")
    factor = config.upscale_factor
    if factor == 1:
        return image, StageTrace(stage="upscale", detail={"factor": 1})

    height, width = grey.shape
    enlarged = cv2.resize(
        grey,
        (width * factor, height * factor),
        interpolation=cv2.INTER_CUBIC,
    )
    return (
        replace(image, grey=enlarged),
        StageTrace(
            stage="upscale",
            changed_px=int(enlarged.size),
            detail={"factor": factor, "fromShape": [height, width],
                    "toShape": [int(enlarged.shape[0]), int(enlarged.shape[1])]},
        ),
    )


# --- the cut -----------------------------------------------------------------


def choose_threshold(grey: np.ndarray, config: MonoConfig) -> tuple[np.ndarray, dict[str, object]]:
    """Build the per-pixel cut. Returns a boolean ink mask and its provenance."""

    if config.threshold_mode is ThresholdMode.OTSU:
        # Global Otsu: one cut for the whole plate. Correct for the dominant
        # case (uniform background, flat ink) and much cheaper than adaptive.
        threshold, _ = cv2.threshold(grey, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        ink = grey <= int(threshold)
        return ink, {"mode": "otsu", "threshold": int(threshold)}

    if config.threshold_mode is ThresholdMode.ADAPTIVE:
        # Local mean minus a constant: survives a scan lit unevenly across the
        # page, where a single global cut swallows whole regions.
        local = cv2.adaptiveThreshold(
            grey,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            config.adaptive_block,
            config.adaptive_constant,
        )
        ink = local > 0
        return ink, {
            "mode": "adaptive",
            "block": config.adaptive_block,
            "constant": config.adaptive_constant,
        }

    ink = grey <= config.fixed_threshold
    return ink, {"mode": "fixed", "threshold": config.fixed_threshold}


def binarize(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Reduce the plate to ink or paper. After this the image is two-valued."""

    grey = image.require_grey("binarize")
    ink, detail = choose_threshold(grey, config)
    return (
        replace(image, grey=None, ink=ink),
        StageTrace(
            stage="binarize",
            changed_px=int(ink.size),
            detail={**detail, "inkPx": int(ink.sum()), "inkShare": round(float(ink.mean()), 4)},
        ),
    )


# --- post-threshold cleanup --------------------------------------------------


def _component_areas(ink: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Label the ink blobs. Returns ``(labels, areas_by_label, count)``."""

    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(
        ink.astype(np.uint8), connectivity=8
    )
    return labels, stats[:, cv2.CC_STAT_AREA], count


def despeckle(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Delete ink blobs small enough to be noise, not artwork.

    After binarizing, mosquito noise becomes literal ink islands. On the low-res
    JPEG fixture at print size there were 262 ink blobs of four pixels or fewer
    around otherwise clean glyphs; at press size each one is a visible speck.

    This only ever *removes* ink, and only blobs up to ``despeckle_max_px``, so a
    real dot (an i-tittle, a bullet, a fine serif) survives as long as it is
    larger than the threshold. That is why the default is deliberately small.
    """

    ink = image.require_ink("despeckle")
    limit = config.despeckle_max_px
    if limit <= 0:
        return image, StageTrace(stage="despeckle", detail={"maxPx": 0})

    labels, areas, count = _component_areas(ink)
    # Label 0 is the background, so it must never be a removal candidate.
    small = np.zeros(count, dtype=bool)
    small[1:] = areas[1:] <= limit
    if not small.any():
        return image, StageTrace(
            stage="despeckle", detail={"maxPx": limit, "removedBlobs": 0}
        )

    cleaned = ink & ~small[labels]
    removed_blobs = int(small.sum())
    return (
        replace(image, ink=cleaned),
        StageTrace(
            stage="despeckle",
            changed_px=int(np.count_nonzero(ink & ~cleaned)),
            detail={"maxPx": limit, "removedBlobs": removed_blobs},
        ),
    )


def fill_holes(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Fill paper holes enclosed by ink, up to a size limit.

    JPEG ringing inside a thick stroke punches transparent pinpricks into what
    should be solid ink. At press size those are unprinted dots in a solid area.
    Only *enclosed* paper is considered — a hole touching the border is part of
    the design's negative space, not damage — and only up to ``fill_hole_max_px``
    so a deliberate counter in a letter survives.
    """

    ink = image.require_ink("fill_holes")
    limit = config.fill_hole_max_px
    if limit <= 0:
        return image, StageTrace(stage="fill_holes", detail={"maxPx": 0})

    paper = ~ink
    labels, areas, count = _component_areas(paper)
    if count <= 1:
        return image, StageTrace(stage="fill_holes", detail={"maxPx": limit, "filledHoles": 0})

    # A paper region touching the image border is open background, not a hole.
    border_labels = set(
        np.unique(
            np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        ).tolist()
    )
    fillable = np.zeros(count, dtype=bool)
    for label in range(1, count):
        if label in border_labels:
            continue
        if areas[label] <= limit:
            fillable[label] = True

    if not fillable.any():
        return image, StageTrace(
            stage="fill_holes", detail={"maxPx": limit, "filledHoles": 0}
        )

    filled = ink | fillable[labels]
    return (
        replace(image, ink=filled),
        StageTrace(
            stage="fill_holes",
            changed_px=int(np.count_nonzero(filled & ~ink)),
            detail={"maxPx": limit, "filledHoles": int(fillable.sum())},
        ),
    )


def morphology(image: WorkingImage, config: MonoConfig) -> tuple[WorkingImage, StageTrace]:
    """Optional open/close pass for edge shape.

    Positioned as cleanup, not artifact repair: measured against a ringing halo
    around text it changed nothing (961 halo pixels before and after), because
    ringing lives *outside* the glyph where a closing cannot reach and is too
    large for an opening to remove. It is kept because it does what it claims —
    rounding off a jagged staircase edge on a badly upscaled logo — and is off by
    default so it is never a silent cost.
    """

    ink = image.require_ink("morphology")
    opened = config.morphology_open
    closed = config.morphology_close
    if opened <= 0 and closed <= 0:
        return image, StageTrace(stage="morphology", detail={"open": 0, "close": 0})

    shaped = ink.astype(np.uint8)
    if opened > 0:
        shaped = cv2.morphologyEx(
            shaped, cv2.MORPH_OPEN, np.ones((opened, opened), np.uint8)
        )
    if closed > 0:
        shaped = cv2.morphologyEx(
            shaped, cv2.MORPH_CLOSE, np.ones((closed, closed), np.uint8)
        )
    result = shaped > 0
    return (
        replace(image, ink=result),
        StageTrace(
            stage="morphology",
            changed_px=int(np.count_nonzero(result != ink)),
            detail={"open": opened, "close": closed},
        ),
    )


# --- output ------------------------------------------------------------------


def validate_two_state(image: WorkingImage) -> StageTrace:
    """Assert the plate is exactly two pixel states before it can be written.

    Three separate guarantees protect the output — stages only ever write ink or
    paper, this check asserts it, and the encoder writes RGBA rather than a
    greyscale mode that would lose the transparency DTF needs. This is the one
    that fails loudly if a future stage breaks the contract.
    """

    ink = image.require_ink("validate")
    if ink.dtype != np.bool_:
        raise TwoStateViolation(
            f"the ink mask must be boolean, got {ink.dtype}",
            details={"dtype": str(ink.dtype)},
        )
    if ink.size == 0:
        raise TwoStateViolation("the plate is empty")
    if not ink.any():
        raise TwoStateViolation(
            "the plate contains no ink at all; binarizing removed every pixel, so "
            "the threshold or the cleanup is too aggressive"
        )
    if ink.all():
        raise TwoStateViolation(
            "the plate is solid ink; binarizing selected every pixel, so the "
            "threshold is wrong for this artwork"
        )
    return StageTrace(
        stage="validate",
        detail={"inkPx": int(ink.sum()), "paperPx": int(ink.size - ink.sum())},
    )


def to_plate(image: WorkingImage) -> object:
    """Build the finished RGBA plate: opaque black ink on transparent paper.

    Deliberately not a mode-``1`` PNG. A mode-``1`` image converted to RGBA
    reports alpha 255 on every pixel, and the packer decides occupancy from
    alpha, so a mode-``1`` design would be packed as a solid white rectangle.
    """

    ink = image.require_ink("to_plate")
    height, width = ink.shape
    plate = np.zeros((height, width, 4), dtype=np.uint8)
    plate[..., :3] = 255
    plate[..., 3] = 0
    plate[ink] = INK_RGBA
    return plate
