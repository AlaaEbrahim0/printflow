"""The chain: classify, then run an ordered list of stages.

Why a chain and not one function
--------------------------------
Each step is independently testable and independently swappable, so the operator's
"this preset cleans too hard" report is answered by changing one number or one
list entry, not by editing a monolith. :data:`DEFAULT_CHAIN` is the order the
measurements support; a caller may pass its own list.

The order is not arbitrary:

1. ``denoise`` runs *before* the cut so the threshold is chosen from smoothed
   pixels rather than from noise spikes;
2. ``upscale`` (optional) also runs before the cut, so the cut happens at print
   resolution;
3. ``binarize`` is the point of no return — it is the only step that turns
   continuous tone into two values;
4. the cleanup steps run *after* it, because "a blob of four pixels" and "a hole
   enclosed by ink" are only meaningful once pixels are ink or paper;
5. ``validate`` asserts the result before it can be written.

``classify`` is not in the list on purpose. It is a gate, not a transformation:
if it says the art is a photograph the chain never starts, which is what keeps a
photo's pixels bit-identical.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from app.mono.classify import MonoVerdict, classify_mono
from app.mono.stages import (
    NamedStage,
    Stage,
    WorkingImage,
    binarize,
    denoise,
    despeckle,
    fill_holes,
    morphology,
    to_plate,
    upscale,
    validate_two_state,
)
from app.mono.types import MonoConfig, MonoKind, MonoStageError, StageTrace


@dataclass(frozen=True)
class MonoResult:
    """What the chain produced, or why it declined to produce anything."""

    verdict: MonoVerdict
    # None when the chain declined to run (a photograph, or a flat-colour image
    # whose operator did not opt into binarizing).
    plate: Any | None
    traces: list[StageTrace] = field(default_factory=list)
    binarized: bool = False

    @property
    def ran(self) -> bool:
        return self.plate is not None

    def trace_dicts(self) -> list[dict[str, object]]:
        return [trace.as_dict() for trace in self.traces]


def _stage(name: str, function: Stage) -> Stage:
    return NamedStage(name=name, run=function)


DEFAULT_CHAIN: tuple[Stage, ...] = (
    _stage("denoise", denoise),
    _stage("upscale", upscale),
    _stage("binarize", binarize),
    _stage("despeckle", despeckle),
    _stage("fillHoles", fill_holes),
    _stage("morphology", morphology),
)


def build_chain(names: Sequence[str] | None = None) -> tuple[Stage, ...]:
    """The default chain, or a named subset/reordering of it.

    Exposed so a preset can skip a step and a test can run one stage in
    isolation, without either having to know how the stages are implemented.
    """

    if names is None:
        return DEFAULT_CHAIN
    available = {stage.name: stage for stage in DEFAULT_CHAIN}
    unknown = [name for name in names if name not in available]
    if unknown:
        raise MonoStageError(
            f"unknown mono stage(s) {unknown!r}",
            details={"requested": list(names), "available": sorted(available)},
        )
    return tuple(available[name] for name in names)


def run_chain(
    image,
    config: MonoConfig | None = None,
    *,
    chain: Sequence[Stage] | None = None,
    verdict: MonoVerdict | None = None,
    binarize_flat_colour: bool | None = None,
) -> MonoResult:
    """Classify, then refine — or decline.

    ``verdict`` lets a caller that already classified (the job processor, which
    wants the features in the result envelope) avoid measuring twice. It is not
    trusted blindly for the gate: the kind still has to be eligible.

    ``binarize_flat_colour`` is the operator's explicit opt-in for reducing a
    multi-colour illustration to one ink. It overrides the config so the decision
    is recorded at the call site rather than buried in a preset.
    """

    settings = config or MonoConfig()
    decided = verdict or classify_mono(image, settings)

    # The gate. A photo is returned untouched, with the reason attached, so the
    # processor can report "skipped" rather than silently doing nothing.
    if not decided.eligible:
        return MonoResult(verdict=decided, plate=None)

    # Flat colour is only binarized on an explicit opt-in, because the colour is
    # lost for good. Without it the chain would end in a cut the operator did not
    # ask for.
    opt_in = (
        settings.allow_binarize_flat_colour
        if binarize_flat_colour is None
        else binarize_flat_colour
    )
    if decided.kind is MonoKind.FLAT_COLOUR and not opt_in:
        return MonoResult(verdict=decided, plate=None)

    working = _to_working(image)
    traces: list[StageTrace] = []
    for stage in chain if chain is not None else DEFAULT_CHAIN:
        working, trace = stage(working, settings)
        traces.append(trace)

    # Validate is not in DEFAULT_CHAIN because it produces no pixels; it is the
    # last gate and always runs, whatever the chain looked like.
    traces.append(validate_two_state(working))

    plate = to_plate(working)
    return MonoResult(verdict=decided, plate=plate, traces=traces, binarized=True)


def run_refinement(
    image,
    config: MonoConfig | None = None,
    *,
    preset=None,
    binarize_flat_colour: bool | None = None,
    chain: Sequence[Stage] | None = None,
) -> MonoResult:
    """Entry point the worker uses: classify, then binarize or clean.

    ``preset`` decides the mode. ``clean-only`` keeps the artwork's colours and
    stops; the binarizing presets produce the two-state ink plate. A photograph
    is refused either way — the whole point of the stage is that a photo's pixels
    are never altered by it.
    """

    settings = config or MonoConfig()
    decided = classify_mono(image, settings)

    if not decided.eligible:
        return MonoResult(verdict=decided, plate=None)

    wants_clean = preset is not None and not preset.binarizes
    if wants_clean:
        plate, traces = clean_colour(image, settings)
        return MonoResult(
            verdict=decided, plate=plate, traces=traces, binarized=False
        )

    opt_in = (
        settings.allow_binarize_flat_colour
        if binarize_flat_colour is None
        else binarize_flat_colour
    )
    if decided.kind is MonoKind.FLAT_COLOUR and not opt_in:
        # A flat-colour image with no opt-in and no clean preset: nothing to do
        # that would not destroy the colour, so decline rather than guess.
        return MonoResult(verdict=decided, plate=None)

    return run_chain(
        image, settings, verdict=decided, binarize_flat_colour=opt_in, chain=chain
    )


def _to_working(image) -> WorkingImage:
    """Convert a PIL image into the chain's continuous-tone form."""

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[..., 3]
    alpha_fraction = (alpha.astype(np.float32) / 255.0)[..., None]
    composited = rgba[..., :3].astype(np.float32) * alpha_fraction + 255.0 * (
        1.0 - alpha_fraction
    )
    luminance = (
        0.299 * composited[..., 0] + 0.587 * composited[..., 1] + 0.114 * composited[..., 2]
    )
    grey = np.clip(luminance, 0.0, 255.0).astype(np.uint8)
    return WorkingImage(grey=grey, alpha=alpha)


def clean_colour(image, config: MonoConfig) -> tuple[Any, list[StageTrace]]:
    """Deblock and denoise while keeping the artwork's colours and alpha.

    This is the ``clean-only`` path. It exists because binarizing a flat-colour
    illustration is irreversible — a six-colour logo reduced to one ink cannot be
    recovered — so the operator needs a way to remove JPEG damage and stop.

    The filter has to be **vector-valued**, which is the subtle part. A median
    run on each channel independently picks each channel's winner from a
    different neighbour, so the result is a colour that was never in the
    artwork: measured on the ``tall-banner`` fixture it invented 108 new shades.
    Instead each pixel takes the *whole colour* of the neighbour that is median
    by luminance, so every output colour is one that was already present. Flat
    regions stay perfectly flat, which is what makes compressed flat art look
    clean again, and no new shade can appear.

    Alpha is filtered separately: running a median across RGBA would let the
    alpha channel drag colour values around and bleed ink into the margin.
    """

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[..., 3]
    kernel = config.denoise_kernel

    # Pick, per pixel, the offset of the neighbour whose luminance is the median.
    luminance = (
        0.299 * rgba[..., 0].astype(np.float32)
        + 0.587 * rgba[..., 1].astype(np.float32)
        + 0.114 * rgba[..., 2].astype(np.float32)
    )
    chosen = _median_by_luminance(luminance, kernel)
    rgb = _gather_colours(rgba[..., :3], chosen)

    cleaned_alpha = cv2.medianBlur(np.ascontiguousarray(alpha), kernel)

    # A median can open pinholes where the matte was semi-transparent; only keep
    # the change where the original alpha was opaque, so the silhouette is not
    # re-cut by a denoiser.
    alpha_kept = np.where(alpha >= 250, np.maximum(cleaned_alpha, alpha), alpha)

    plate = np.dstack([rgb, alpha_kept]).astype(np.uint8)
    trace = StageTrace(
        stage="cleanColour",
        changed_px=int(np.count_nonzero(rgb != rgba[..., :3])),
        detail={"kernel": kernel, "filter": "vector-median"},
    )
    return plate, [trace]


def _median_by_luminance(luminance: np.ndarray, kernel: int) -> np.ndarray:
    """Offset index of the median-luminance neighbour within each pixel's window.

    Returns an ``(H, W)`` array of window indices in ``[0, kernel*kernel)``. A
    median filter is exactly this choice — no averaging — which is why it cannot
    invent a value.
    """

    radius = kernel // 2
    padded = np.pad(luminance, radius, mode="edge")
    height, width = luminance.shape

    windows = np.empty((kernel * kernel, height, width), dtype=np.float32)
    index = 0
    for dy in range(kernel):
        for dx in range(kernel):
            windows[index] = padded[dy : dy + height, dx : dx + width]
            index += 1

    # argmedian: sort each window and take the middle element's original offset.
    order = np.argsort(windows, axis=0, kind="stable")
    middle = order[kernel * kernel // 2]
    return middle.astype(np.int32)


def _gather_colours(rgb: np.ndarray, chosen: np.ndarray) -> np.ndarray:
    """Select each pixel's full colour from the neighbour index it chose."""

    kernel_side = int(round(np.sqrt(float(chosen.max()) + 1)))
    # ``chosen`` indexes a kernel_side x kernel_side window; rebuild the padded
    # colour planes so the same offsets can be applied to all three channels.
    radius = kernel_side // 2
    height, width = rgb.shape[:2]
    padded = np.pad(rgb, ((radius, radius), (radius, radius), (0, 0)), mode="edge")

    rows = np.arange(height)[:, None]
    columns = np.arange(width)[None, :]
    dy = (chosen // kernel_side)
    dx = (chosen % kernel_side)
    out = np.empty_like(rgb)
    for channel in range(rgb.shape[2]):
        out[..., channel] = padded[rows + dy, columns + dx, channel]
    return out
