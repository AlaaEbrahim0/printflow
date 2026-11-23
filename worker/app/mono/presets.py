"""Named bundles of settings, so an operator picks an intent, not twelve numbers.

A preset is only a :class:`MonoConfig` with a few fields overridden; nothing
about the chain changes. That keeps the presets honest — they cannot do anything
the individual parameters could not — and it means a new preset is one entry
here, not a code path.

``text`` and ``line-art`` differ in how hard they clean, not in what they produce:
both end at hard ink. ``clean-only`` is the escape hatch for a multi-colour
illustration, where binarizing would throw the colour away, so it debocks and
denoises but never crosses into two tones.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from app.mono.types import (
    DenoiseMode,
    MonoConfig,
    MonoKind,
    MonoStageError,
    ThresholdMode,
)


@dataclass(frozen=True)
class MonoPreset:
    """A named starting point, plus the kinds of artwork it is meant for."""

    name: str
    label: str
    description: str
    # Which classified kinds this preset may run on. A preset never widens the
    # gate; it can only narrow it.
    allowed_kinds: tuple[MonoKind, ...]
    overrides: dict[str, object]
    # ``binarize`` produces the two-state ink plate. ``clean`` debocks and
    # denoises but keeps the original colours and alpha, because forcing a
    # multi-colour logo to one ink is irreversible. The two modes have different
    # outputs, so this is an explicit choice rather than a parameter.
    mode: str = "binarize"

    def config(self, base: MonoConfig | None = None) -> MonoConfig:
        return replace(base or MonoConfig(), **self.overrides)

    @property
    def binarizes(self) -> bool:
        return self.mode == "binarize"


# Order matters only for display; lookup is by name.
PRESETS: dict[str, MonoPreset] = {
    "text": MonoPreset(
        name="text",
        label="Text / scan",
        description=(
            "Hard ink for text and scans: median 3x3 to kill ringing, Otsu cut, "
            "then remove specks and fill pinpricks."
        ),
        allowed_kinds=(MonoKind.MONO_INK,),
        overrides={
            "denoise_mode": DenoiseMode.MEDIAN,
            "denoise_kernel": 3,
            "threshold_mode": ThresholdMode.OTSU,
            "despeckle_max_px": 4,
            "fill_hole_max_px": 4,
        },
    ),
    "logo": MonoPreset(
        name="logo",
        label="Logo / line art",
        description=(
            "Like text, but tolerant of thin strokes and large flat areas: a "
            "slightly larger speckle limit and an opening pass to round a "
            "staircased edge."
        ),
        allowed_kinds=(MonoKind.MONO_INK, MonoKind.FLAT_COLOUR),
        overrides={
            "denoise_mode": DenoiseMode.MEDIAN,
            "denoise_kernel": 3,
            "threshold_mode": ThresholdMode.OTSU,
            "despeckle_max_px": 6,
            "fill_hole_max_px": 6,
            "morphology_open": 3,
        },
    ),
    "illustration": MonoPreset(
        name="illustration",
        label="Illustration (binarize)",
        description=(
            "For flat-colour art the operator has decided to reduce to one ink. "
            "Same cleanup, but it is the only preset that opts flat colour into "
            "binarizing."
        ),
        allowed_kinds=(MonoKind.FLAT_COLOUR, MonoKind.MONO_INK),
        overrides={
            "denoise_mode": DenoiseMode.MEDIAN,
            "denoise_kernel": 3,
            "threshold_mode": ThresholdMode.OTSU,
            "despeckle_max_px": 6,
            "fill_hole_max_px": 6,
            "allow_binarize_flat_colour": True,
        },
    ),
    "clean-only": MonoPreset(
        name="clean-only",
        label="Clean only (keep colour)",
        description=(
            "Deblock and denoise but never binarize. Use when a logo's colour "
            "matters and only its JPEG damage should go."
        ),
        allowed_kinds=(MonoKind.FLAT_COLOUR, MonoKind.MONO_INK),
        mode="clean",
        overrides={
            "denoise_mode": DenoiseMode.MEDIAN,
            "denoise_kernel": 3,
            "despeckle_max_px": 0,
            "fill_hole_max_px": 0,
        },
    ),
}

DEFAULT_PRESET = "text"


def resolve_preset(name: str | None, base: MonoConfig | None = None) -> MonoPreset:
    """Look a preset up by name, refusing unknown names instead of guessing."""

    if name is None or name == "":
        return PRESETS[DEFAULT_PRESET]
    try:
        return PRESETS[name]
    except KeyError:
        raise MonoStageError(
            f"unknown mono preset {name!r}",
            details={"preset": name, "supported": sorted(PRESETS)},
        ) from None
