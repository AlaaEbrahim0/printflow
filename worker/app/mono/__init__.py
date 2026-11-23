"""Mono refinement: turn a clean line-art / logo scan into print-ready 1-bit art.

Why this exists
---------------
Customer artwork arrives as JPEG screenshots, WhatsApp photos of printed logos,
and badly compressed scans. Even after crop → enhance → size, those files still
carry DCT block edges, ringing halos around glyphs and mosquito noise in flat
areas. On a DTF press that noise becomes physical speckle on the garment, so a
mono-type design must be reduced to hard ink before it is packed.

Scope
-----
Only *mono-type* artwork takes this path. A photograph is left completely
untouched — the chain refuses to run rather than risk destroying it. The
classifier therefore decides between three outcomes, because the three cases
want different treatment:

``mono-ink``     neutral (near-greyscale) art: text scans, signatures, line art.
                 Safe to binarize automatically.
``flat-colour``  a handful of saturated flat colours: logos, illustrations.
                 Binarizing is irreversible and destroys the colour, so the
                 default is ``clean-only`` (deblock, keep colour) and a human
                 must opt into binarizing.
``photo``        continuous tone. The chain does not run at all.

Output contract
---------------
The finished plate is RGBA with exactly two pixel states: ink is
``(0, 0, 0, 255)`` and paper is ``(255, 255, 255, 0)``. So the luminance channel
holds only ``{0, 255}`` and the alpha channel holds only ``{0, 255}``.

This is deliberately *not* a mode-``1`` PNG. Measured: a mode-``1`` file
converted to RGBA reports alpha ``255`` on every pixel, and the packer decides
occupancy from alpha (``occupancy_from_alpha``), so a mode-``1`` design would be
packed as a solid white rectangle. Two-state RGBA keeps the 1-bit discipline and
keeps the transparency DTF needs.

Structure
---------
Every step is an independent callable behind the :class:`Stage` protocol, so the
chain can be reordered, a step can be swapped, and any step can be tested alone
against a synthetic array. Nothing here reads the filesystem, a clock or a job
document; :mod:`app.processors.refine` adapts a worker job onto it.
"""

from __future__ import annotations

from app.mono.chain import (
    DEFAULT_CHAIN,
    MonoResult,
    build_chain,
    clean_colour,
    run_chain,
    run_refinement,
)
from app.mono.classify import MonoVerdict, classify_mono
from app.mono.presets import PRESETS, MonoPreset, resolve_preset
from app.mono.stages import (
    Stage,
    WorkingImage,
    binarize,
    denoise,
    despeckle,
    fill_holes,
    morphology,
    upscale,
    validate_two_state,
)
from app.mono.types import (
    DenoiseMode,
    MonoConfig,
    MonoKind,
    MonoStageError,
    ThresholdMode,
    TwoStateViolation,
)

__all__ = [
    "DEFAULT_CHAIN",
    "DenoiseMode",
    "MonoConfig",
    "MonoKind",
    "MonoPreset",
    "MonoResult",
    "MonoStageError",
    "MonoVerdict",
    "PRESETS",
    "Stage",
    "ThresholdMode",
    "TwoStateViolation",
    "WorkingImage",
    "binarize",
    "build_chain",
    "classify_mono",
    "clean_colour",
    "denoise",
    "despeckle",
    "fill_holes",
    "morphology",
    "resolve_preset",
    "run_chain",
    "run_refinement",
    "upscale",
    "validate_two_state",
]
