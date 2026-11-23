"""Decide whether artwork is mono-type, and which flavour of mono-type it is.

The gate exists so the refinement chain can never touch a photograph. Getting
this wrong in the permissive direction destroys artwork irreversibly (binarized
pixels cannot be recovered), so the classifier is deliberately biased: anything
it is unsure about is reported as ``photo`` and the chain does not run.

The measurement
---------------
The deciding feature is **Otsu separability** ``eta``: the between-class variance
of the best single luminance threshold, divided by total variance. It answers
exactly the question the binarizer will ask — *is there one cut that splits this
image into two well-separated populations?* — and it is invariant to how much
ink is present, which a "share of extreme pixels" heuristic is not.

Measured on the ten repo fixtures (luminance composited over white, which is how
the operator sees the art):

===============  ======  ===========  ===============
fixture          eta     neutral ink  kind
===============  ======  ===========  ===============
flat-logo        0.922   1.000        mono-ink
thin-signature   0.987   1.000        mono-ink
overwide-banner  0.995   0.946        mono-ink
flat-vector      0.989   0.000        flat-colour
sticker-fringe   0.932   0.000        flat-colour
tall-banner      0.971   0.000        flat-colour
lowres-jpeg      0.784   0.286        photo
pale-mist        0.788   1.000        photo
white-smoke      0.728   1.000        photo
full-bleed       0.624   0.039        photo
===============  ======  ===========  ===============

The gate at ``eta >= 0.85`` therefore sits in an empty band: the lowest
mono-type fixture is 0.922 and the highest photograph is 0.788. Nothing lands
between. Two photographs (pale-mist, white-smoke) are perfectly neutral and would
be classified as ink by a colour test alone, which is why eta decides first.

The second feature separates the two gate-eligible kinds: **share of ink pixels
that are near-neutral**. Neutral ink means a text/line-art scan; saturated ink
means a coloured illustration. The split is absolute in the fixtures (>= 0.946
versus 0.000), so the threshold is not delicate.

Note that ``flat-colour`` is *not* an instruction to binarize. Forcing a
multi-colour logo to two tones throws the colour away, so the caller must opt in.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.mono.types import MonoConfig, MonoKind


@dataclass(frozen=True)
class MonoVerdict:
    """The classifier's answer, with the numbers it used.

    The features are returned rather than logged and forgotten: the review UI
    shows them so an operator can see *why* a design was or was not binarized,
    and a disputed decision can be diagnosed without re-running the job.
    """

    kind: MonoKind
    eta: float
    neutral_ink_share: float
    distinct_colours: int
    # True when the chain may run at all; False means "leave the pixels alone".
    eligible: bool
    # True when binarizing is allowed. For flat colour this mirrors the opt-in.
    may_binarize: bool
    reason: str

    def as_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind.value,
            "eta": round(self.eta, 4),
            "neutralInkShare": round(self.neutral_ink_share, 4),
            "distinctColours": self.distinct_colours,
            "eligible": self.eligible,
            "mayBinarize": self.may_binarize,
            "reason": self.reason,
        }


# Luminance weights: ITU-R BT.601, the same the rest of the worker uses.
_RED, _GREEN, _BLUE = 0.299, 0.587, 0.114

# Quantisation for the "distinct colours" feature. 32 levels per channel is the
# same granularity the existing classifier uses, so the two agree on flatness.
_COLOUR_LEVELS = 8

# A pixel whose max-minus-min channel spread is at most this counts as neutral.
# JPEG chroma subsampling shifts flat grey by a few levels, so this cannot be 0.
_NEUTRAL_CHROMA = 24


def to_working_arrays(image) -> tuple[np.ndarray, np.ndarray]:
    """Luminance and alpha, with transparent pixels flattened onto white.

    A transparent pixel has no meaningful colour, so letting its stored RGB into
    the histogram would add a phantom population and corrupt ``eta``. Compositing
    over white is also what the operator sees in a preview, so the measurement
    matches the review.
    """

    rgba = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[..., 3]
    alpha_fraction = (alpha.astype(np.float32) / 255.0)[..., None]
    composited = (
        rgba[..., :3].astype(np.float32) * alpha_fraction + 255.0 * (1.0 - alpha_fraction)
    )
    luminance = (
        _RED * composited[..., 0] + _GREEN * composited[..., 1] + _BLUE * composited[..., 2]
    )
    return np.clip(luminance, 0.0, 255.0).astype(np.uint8), alpha


def otsu_threshold(luminance: np.ndarray) -> int:
    """The luminance level that maximises between-class variance."""

    histogram = np.bincount(luminance.ravel(), minlength=256).astype(np.float64)
    total = histogram.sum()
    if total <= 0:
        return 128
    probability = histogram / total
    omega = np.cumsum(probability)
    mu = np.cumsum(probability * np.arange(256))
    mu_total = mu[-1]
    # omega * (1 - omega) is zero at the ends; guard the division rather than
    # clamping, so the search is not biased toward the middle.
    spread = omega * (1.0 - omega)
    with np.errstate(divide="ignore", invalid="ignore"):
        between = np.where(spread > 0, (mu_total * omega - mu) ** 2 / spread, 0.0)
    return int(np.argmax(between))


def otsu_separability(luminance: np.ndarray) -> float:
    """``eta``: between-class variance at the best cut, over total variance.

    1.0 means one threshold splits the image perfectly into two populations;
    near 0 means the tones are smeared across the range with no natural cut.
    """

    histogram = np.bincount(luminance.ravel(), minlength=256).astype(np.float64)
    total = histogram.sum()
    if total <= 0:
        return 0.0
    probability = histogram / total
    omega = np.cumsum(probability)
    mu = np.cumsum(probability * np.arange(256))
    mu_total = mu[-1]
    spread = omega * (1.0 - omega)
    with np.errstate(divide="ignore", invalid="ignore"):
        between = np.where(spread > 0, (mu_total * omega - mu) ** 2 / spread, 0.0)
    variance_total = float(np.sum(probability * (np.arange(256) - mu_total) ** 2))
    if variance_total <= 0:
        # A perfectly uniform image: nothing to separate, and nothing to binarize.
        return 0.0
    return float(np.max(between) / variance_total)


def distinct_colour_count(composited_rgb: np.ndarray) -> int:
    """Distinct colours after quantisation, which is what makes flat art look flat."""

    quantised = (composited_rgb // (256 // _COLOUR_LEVELS)).astype(np.int64)
    packed = (
        (quantised[..., 0] << 12) | (quantised[..., 1] << 6) | quantised[..., 2]
    ).reshape(-1)
    return int(np.unique(packed).size)


def neutral_ink_share(luminance: np.ndarray, composited_rgb: np.ndarray, threshold: int) -> float:
    """Share of the ink side of the cut that carries no meaningful colour.

    Text and line art are printed in one ink, so their ink side is neutral.
    An illustration's ink side is where its colours live.
    """

    ink = luminance <= threshold
    if not ink.any():
        return 0.0
    ink_pixels = composited_rgb[ink]
    chroma = ink_pixels.max(axis=1) - ink_pixels.min(axis=1)
    return float(np.mean(chroma <= _NEUTRAL_CHROMA))


def classify_mono(image, config: MonoConfig | None = None) -> MonoVerdict:
    """Decide what this artwork is, and whether the chain may touch it.

    Returns a verdict for every image; :attr:`MonoVerdict.eligible` is the gate.
    """

    settings = config or MonoConfig()
    luminance, _alpha = to_working_arrays(image)
    rgba = np.asarray(image.convert("RGBA"), dtype=np.float32)
    alpha_fraction = (rgba[..., 3:4] / 255.0)
    composited_rgb = rgba[..., :3] * alpha_fraction + 255.0 * (1.0 - alpha_fraction)

    eta = otsu_separability(luminance)
    threshold = otsu_threshold(luminance)
    colours = distinct_colour_count(composited_rgb)
    neutral = neutral_ink_share(luminance, composited_rgb, threshold)

    if eta < settings.mono_eta_min:
        return MonoVerdict(
            kind=MonoKind.PHOTO,
            eta=eta,
            neutral_ink_share=neutral,
            distinct_colours=colours,
            eligible=False,
            may_binarize=False,
            reason=(
                f"Tones are smeared across the range (Otsu separability {eta:.3f} is "
                f"below {settings.mono_eta_min:.2f}), so there is no clean ink/paper cut. "
                "Treating this as a photo and leaving the pixels untouched."
            ),
        )

    if neutral >= settings.neutral_ink_min:
        return MonoVerdict(
            kind=MonoKind.MONO_INK,
            eta=eta,
            neutral_ink_share=neutral,
            distinct_colours=colours,
            eligible=True,
            may_binarize=True,
            reason=(
                f"Two well-separated tone populations (separability {eta:.3f}) and "
                f"{neutral:.0%} of the ink is neutral, which is a text or line-art scan. "
                "Safe to binarize."
            ),
        )

    # Gate-eligible but colourful: a flat illustration. Binarizing is allowed
    # only when the operator asked for it, because it discards the colour.
    return MonoVerdict(
        kind=MonoKind.FLAT_COLOUR,
        eta=eta,
        neutral_ink_share=neutral,
        distinct_colours=colours,
        eligible=True,
        may_binarize=settings.allow_binarize_flat_colour,
        reason=(
            f"Flat artwork with {colours} distinct colours, but only {neutral:.0%} of the "
            "ink is neutral, so the colour is load-bearing. "
            + (
                "Binarizing was explicitly requested."
                if settings.allow_binarize_flat_colour
                else "Cleaning without binarizing; request binarizing to force two tones."
            )
        ),
    )
