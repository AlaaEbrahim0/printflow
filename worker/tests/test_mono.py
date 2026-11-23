"""Tests for the mono refinement stage.

The four cases the brief asks for are here by name: a logo, a text scan, a
heavily compressed JPEG, and a regular photo that must be left alone. Each test
states the property it protects rather than a golden file, because the point of
this stage is a guarantee (two pixel states, a photo untouched), not a
particular arrangement of pixels.
"""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
from PIL import Image

from app.mono import (
    DEFAULT_CHAIN,
    PRESETS,
    MonoConfig,
    MonoKind,
    ThresholdMode,
    TwoStateViolation,
    WorkingImage,
    binarize,
    build_chain,
    classify_mono,
    denoise,
    despeckle,
    fill_holes,
    resolve_preset,
    run_chain,
    run_refinement,
    validate_two_state,
)
from app.mono.types import MonoStageError

# --- synthetic artwork -------------------------------------------------------
# Built here rather than loaded from fixtures/generated, which is git-ignored and
# regenerated; a test must not depend on a file that may be absent in CI.


def text_scan(size: tuple[int, int] = (420, 260)) -> Image.Image:
    """Dark text-like strokes on a light field: the mono-ink case."""

    width, height = size
    array = np.full((height, width), 246, dtype=np.uint8)
    # Glyph-ish blocks with deliberate thin strokes.
    for row in range(40, height - 40, 46):
        for column in range(30, width - 30, 34):
            array[row : row + 26, column : column + 20] = 18
            array[row + 10 : row + 13, column : column + 20] = 246
    # A one-pixel-wide rule: thin ink that cleanup must not erase.
    array[height - 30 : height - 29, 30 : width - 30] = 18
    return Image.fromarray(array, "L").convert("RGB")


def flat_logo(size: tuple[int, int] = (300, 300)) -> Image.Image:
    """A two-colour mark on transparency: the flat-colour case."""

    array = np.zeros((size[1], size[0], 4), dtype=np.uint8)
    array[..., 3] = 0
    array[40:260, 60:240] = (30, 90, 170, 255)
    array[110:190, 100:200] = (250, 250, 250, 255)
    return Image.fromarray(array, "RGBA")


def regular_photo(size: tuple[int, int] = (320, 240)) -> Image.Image:
    """Continuous tone with no natural two-way cut: the photo case."""

    rng = np.random.default_rng(11)
    ramp = np.linspace(0, 255, size[0])[None, :]
    base = np.repeat(ramp, size[1], axis=0)
    noise = rng.normal(0, 18, size=(size[1], size[0]))
    grey = np.clip(base + noise, 0, 255).astype(np.uint8)
    array = np.stack([grey, grey, grey], axis=-1)
    return Image.fromarray(array, "RGB")


def compressed(image: Image.Image, quality: int = 8) -> Image.Image:
    """Round-trip through JPEG at a punishing quality, to create real artifacts."""

    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


def plate_values(plate) -> tuple[np.ndarray, np.ndarray]:
    array = np.asarray(plate)
    return np.unique(array[..., :3]), np.unique(array[..., 3])


# --- the four required cases -------------------------------------------------


def test_text_scan_becomes_exactly_two_pixel_states() -> None:
    result = run_refinement(text_scan(), MonoConfig())

    assert result.ran
    assert result.verdict.kind is MonoKind.MONO_INK
    assert result.binarized

    rgb, alpha = plate_values(result.plate)
    assert rgb.tolist() == [0, 255], "the plate holds only black and white"
    assert alpha.tolist() == [0, 255], "and only opaque ink or transparent paper"


def test_logo_is_cleaned_but_not_binarized_without_consent() -> None:
    """A flat-colour logo keeps its colour unless the operator opts in."""

    image = flat_logo()
    verdict = classify_mono(image)
    assert verdict.kind is MonoKind.FLAT_COLOUR
    assert verdict.eligible, "the chain may run, it just must not binarize"
    assert not verdict.may_binarize, "no opt-in was given"

    # Default preset is a binarizing one, and flat colour has not been opted in,
    # so the chain declines rather than destroying the palette.
    declined = run_refinement(image, MonoConfig(), preset=PRESETS["text"])
    assert not declined.ran

    # clean-only keeps the colours.
    cleaned = run_refinement(image, PRESETS["clean-only"].config(), preset=PRESETS["clean-only"])
    assert cleaned.ran
    assert not cleaned.binarized
    colours = np.unique(np.asarray(cleaned.plate)[..., :3].reshape(-1, 3), axis=0)
    assert len(colours) <= 3, "cleaning must not invent shades"

    # With an explicit opt-in it does binarize.
    forced = run_refinement(
        image,
        PRESETS["illustration"].config(),
        preset=PRESETS["illustration"],
        binarize_flat_colour=True,
    )
    assert forced.binarized
    rgb, alpha = plate_values(forced.plate)
    assert rgb.tolist() == [0, 255]
    assert alpha.tolist() == [0, 255]


def test_heavily_compressed_jpeg_is_cleaned_before_binarizing() -> None:
    """The stage's reason for existing: JPEG damage must not reach the press."""

    source = text_scan()
    damaged = compressed(source, quality=8)

    # The damage is real: a hard JPEG round-trip smears the flat field.
    assert len(np.unique(np.asarray(damaged))) > len(np.unique(np.asarray(source)))

    result = run_refinement(damaged, MonoConfig())
    assert result.ran, "a compressed text scan is still mono-type"
    rgb, alpha = plate_values(result.plate)
    assert rgb.tolist() == [0, 255]
    assert alpha.tolist() == [0, 255]

    # The denoise step must have reported work, or the artifacts went untouched.
    denoise_trace = next(trace for trace in result.traces if trace.stage == "denoise")
    assert denoise_trace.changed_px > 0

    # Ink must survive: binarizing must not erase the artwork.
    ink = np.asarray(result.plate)[..., 3] > 0
    assert ink.mean() > 0.01, "the glyphs are still there"
    assert ink.mean() < 0.9, "and the plate is not a solid block"


def test_regular_photo_is_never_touched() -> None:
    photo = regular_photo()

    verdict = classify_mono(photo)
    assert verdict.kind is MonoKind.PHOTO
    assert not verdict.eligible

    result = run_refinement(photo, MonoConfig())
    assert not result.ran, "the chain must decline"
    assert result.plate is None, "and produce no pixels at all"


# --- the gate ----------------------------------------------------------------


def test_the_gate_threshold_sits_in_an_empty_band() -> None:
    """The fixtures' mono art scores >= 0.92 and photos <= 0.79; 0.85 is clear."""

    mono = classify_mono(text_scan())
    photo = classify_mono(regular_photo())

    assert mono.eta >= MonoConfig().mono_eta_min
    assert photo.eta < MonoConfig().mono_eta_min
    # A wide margin, not a lucky call.
    assert mono.eta - photo.eta > 0.15


def test_a_neutral_but_smeared_image_is_a_photo_not_ink() -> None:
    """Neutrality alone must not be enough; pale mist is neutral and is a photo.

    This is why separability decides first: a colour test would binarize this
    and turn a soft image into a hard-edged mess.
    """

    rng = np.random.default_rng(3)
    ramp = np.linspace(120, 140, 200)[None, :].repeat(200, axis=0)
    array = np.clip(ramp + rng.normal(0, 4, ramp.shape), 0, 255).astype(np.uint8)
    image = Image.fromarray(np.stack([array] * 3, axis=-1), "RGB")

    verdict = classify_mono(image)
    assert verdict.kind is MonoKind.PHOTO
    assert verdict.neutral_ink_share > 0.9, "it *is* neutral"
    assert not verdict.eligible, "but it is not separable"


# --- individual stages, in isolation ----------------------------------------


def test_denoise_leaves_a_clean_plate_alone() -> None:
    """A median is exact on flat areas, which is why it is the default.

    It is *not* a no-op at a hard corner: the corner pixel's window holds five
    paper pixels and four ink ones, so the median is paper and the corner rounds
    by one pixel. That is inherent to a median, and it is why the stage is
    documented as a smoother rather than a sharpener.
    """

    clean = np.full((40, 40), 200, dtype=np.uint8)
    clean[10:30, 10:30] = 20
    working = WorkingImage(grey=clean)

    out, trace = denoise(working, MonoConfig())

    assert np.array_equal(out.grey[12:28, 12:28], clean[12:28, 12:28]), (
        "the interiors of both tones are untouched"
    )
    assert trace.changed_px == 4, "only the four square corners move"


def test_despeckle_removes_tiny_blobs_and_keeps_real_marks() -> None:
    ink = np.zeros((60, 60), dtype=bool)
    ink[5, 5] = True  # a single noise pixel
    ink[40:52, 40:52] = True  # a real mark, far above the limit

    out, trace = despeckle(WorkingImage(ink=ink), MonoConfig(despeckle_max_px=4))

    assert not out.ink[5, 5], "the speck is gone"
    assert out.ink[45, 45], "the real mark survives"
    assert trace.changed_px == 1


def test_despeckle_keeps_a_dot_that_is_bigger_than_the_limit() -> None:
    """An i-tittle is a real dot; the default limit must not eat it."""

    ink = np.zeros((40, 40), dtype=bool)
    ink[10:14, 10:14] = True  # 16 px, above the 4 px limit

    out, _trace = despeckle(WorkingImage(ink=ink), MonoConfig(despeckle_max_px=4))
    assert out.ink[11, 11]


def test_fill_holes_fills_enclosed_paper_only() -> None:
    ink = np.ones((50, 50), dtype=bool)
    ink[20:23, 20:23] = False  # a 9 px pinprick inside solid ink
    ink[0:5, 0:5] = False  # paper touching the border: negative space

    out, trace = fill_holes(WorkingImage(ink=ink), MonoConfig(fill_hole_max_px=9))

    assert out.ink[21, 21], "the enclosed pinprick is filled"
    assert not out.ink[2, 2], "the open corner is left alone"
    assert trace.changed_px == 9


def test_fill_holes_respects_the_size_limit() -> None:
    ink = np.ones((60, 60), dtype=bool)
    ink[20:35, 20:35] = False  # 225 px counter, larger than the limit

    out, _trace = fill_holes(WorkingImage(ink=ink), MonoConfig(fill_hole_max_px=4))
    assert not out.ink[27, 27], "a deliberate counter must survive"


def test_binarize_refuses_an_already_binary_image() -> None:
    """Stages declare which form they need, so a bad order fails loudly."""

    with pytest.raises(MonoStageError) as excinfo:
        binarize(WorkingImage(ink=np.zeros((10, 10), dtype=bool)), MonoConfig())
    assert "already binarized" in str(excinfo.value)


def test_despeckle_refuses_continuous_tone() -> None:
    with pytest.raises(MonoStageError) as excinfo:
        despeckle(WorkingImage(grey=np.zeros((10, 10), dtype=np.uint8)), MonoConfig())
    assert "continuous-tone" in str(excinfo.value)


# --- the output contract ----------------------------------------------------


def test_validate_rejects_a_blank_plate() -> None:
    with pytest.raises(TwoStateViolation) as excinfo:
        validate_two_state(WorkingImage(ink=np.zeros((10, 10), dtype=bool)))
    assert "no ink" in str(excinfo.value)


def test_validate_rejects_a_solid_plate() -> None:
    with pytest.raises(TwoStateViolation) as excinfo:
        validate_two_state(WorkingImage(ink=np.ones((10, 10), dtype=bool)))
    assert "solid ink" in str(excinfo.value)


def test_plate_is_rgba_not_mode_one() -> None:
    """A mode-1 PNG would lose the transparency the packer needs.

    Measured: a mode-1 file converted to RGBA reports alpha 255 everywhere, and
    the packer decides occupancy from alpha, so it would print a white box.
    """

    result = run_refinement(text_scan(), MonoConfig())
    plate = np.asarray(result.plate)

    assert plate.ndim == 3 and plate.shape[2] == 4, "RGBA, not a greyscale mode"
    ink = plate[..., 3] > 0
    assert np.all(plate[ink][:, :3] == 0), "ink is opaque black"
    assert np.all(plate[~ink][:, 3] == 0), "paper is fully transparent"
    # The occupancy the packer computes is the artwork, not the whole canvas.
    assert 0.0 < float(ink.mean()) < 1.0


# --- chain composition ------------------------------------------------------


def test_chain_can_run_one_stage_in_isolation() -> None:
    """The stages are swappable because the chain is just an ordered list."""

    chain = build_chain(["binarize"])
    result = run_chain(text_scan(), MonoConfig(), chain=chain)

    assert [trace.stage for trace in result.traces] == ["binarize", "validate"]


def test_chain_rejects_an_unknown_stage() -> None:
    with pytest.raises(MonoStageError) as excinfo:
        build_chain(["binarize", "sharpen"])
    assert excinfo.value.details["available"]


def test_default_chain_runs_binarize_before_the_cleanup_steps() -> None:
    names = [stage.name for stage in DEFAULT_CHAIN]
    assert names.index("binarize") < names.index("despeckle")
    assert names.index("denoise") < names.index("binarize"), (
        "the cut must be chosen from denoised pixels"
    )


def test_adaptive_threshold_fabricates_specks_that_despeckle_removes() -> None:
    """Why the chain puts despeckle after the cut, with measured numbers.

    Adaptive thresholding is the tool for a scan lit unevenly across the page,
    where a single global cut swallows a whole region. Its cost is that it
    threshold against a local mean, so a slightly noisy flat area produces specks
    of ink that were never in the artwork.

    Measured on this synthetic scan (paper ramping 252 -> 205 left to right, two
    solid glyphs, sigma 2 sensor noise): adaptive without cleanup invents three
    blobs of four pixels or fewer and scores IoU 0.5757 against the truth, while
    the same cut followed by despeckle invents none and scores 0.5758. Otsu scores
    1.0000 on this particular image, which is why it is the default and adaptive
    is the opt-in.
    """

    rng = np.random.default_rng(5)
    width, height = 400, 200
    field = np.tile(np.linspace(252, 205, width), (height, 1))
    field = field + rng.normal(0, 2.0, field.shape)
    glyph = np.zeros(field.shape)
    glyph[60:140, 60:120] = 1
    glyph[60:140, 260:320] = 1
    pixels = np.clip(np.where(glyph > 0, 20, field), 0, 255).astype(np.uint8)
    image = Image.fromarray(pixels, "L").convert("RGB")

    # The gate must let this through, or the test would prove nothing.
    verdict = classify_mono(image, MonoConfig())
    assert verdict.kind is MonoKind.MONO_INK, verdict.reason

    adaptive = MonoConfig(threshold_mode=ThresholdMode.ADAPTIVE)
    bare = run_refinement(image, adaptive, chain=build_chain(["binarize"]))
    cleaned = run_refinement(
        image, adaptive, chain=build_chain(["binarize", "despeckle", "fillHoles"])
    )
    assert bare.ran and cleaned.ran

    def tiny_blobs(plate) -> int:
        ink = (np.asarray(plate)[..., 3] > 0).astype(np.uint8)
        count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(ink, connectivity=8)
        return int((stats[1:, cv2.CC_STAT_AREA] <= 4).sum())

    assert tiny_blobs(bare.plate) > 0, "adaptive is expected to invent specks"
    assert tiny_blobs(cleaned.plate) == 0, "despeckle removes exactly those"


# --- presets ----------------------------------------------------------------


def test_every_preset_resolves_and_produces_a_valid_config() -> None:
    for name, preset in PRESETS.items():
        config = preset.config()
        assert isinstance(config, MonoConfig), name
        assert preset.allowed_kinds, f"{name} must declare which art it accepts"


def test_unknown_preset_is_refused_by_name() -> None:
    with pytest.raises(MonoStageError) as excinfo:
        resolve_preset("sharpen")
    assert "sharpen" in str(excinfo.value)
    assert excinfo.value.details["supported"]


def test_presets_never_widen_the_gate() -> None:
    """A preset can only narrow what the classifier allowed."""

    photo = regular_photo()
    for name, preset in PRESETS.items():
        result = run_refinement(photo, preset.config(), preset=preset)
        assert not result.ran, f"preset {name} must not touch a photo"


# --- configuration validation ------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"mono_eta_min": 0.0},
        {"mono_eta_min": 1.5},
        {"denoise_kernel": 4},
        {"adaptive_block": 40},
        {"adaptive_block": 1},
        {"upscale_factor": 9},
        {"despeckle_max_px": -1},
        {"morphology_open": 11},
    ],
)
def test_invalid_config_is_refused_immediately(overrides) -> None:
    with pytest.raises(MonoStageError):
        MonoConfig(**overrides)
