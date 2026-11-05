"""Analysis primitives: border bands, background kinds, edges, quantisation."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.analysis import (
    BLACK,
    CUSTOM,
    GRAY,
    TRANSPARENT,
    WHITE,
    analysis_copy,
    background_matches,
    border_band_size,
    classify_color_name,
    content_bbox,
    edge_density,
    edge_margin_ratios,
    feature_report,
    flat_color_ratio,
    is_full_bleed,
    sample_background,
    to_arrays,
    touches_all_edges,
    unique_color_count,
)
from tests.conftest import full_bleed_noise, gray_screenshot, transparent_sticker


def arrays_for(image: Image.Image):
    return to_arrays(image.convert("RGBA"))


def test_border_band_is_clamped(settings) -> None:
    assert border_band_size(1000, 1000, settings) == 40  # 4% of the short side
    assert border_band_size(40, 40, settings) == settings.border_band_min_px
    assert border_band_size(4000, 4000, settings) == settings.border_band_max_px
    assert border_band_size(2000, 3, settings) <= 1


def test_background_kinds(settings) -> None:
    small = {"background_match_tolerance": 12}
    tuned = settings.model_copy(update=small)
    for rgb, expected in (
        ((5, 5, 5), BLACK),
        ((250, 250, 250), WHITE),
        ((128, 128, 128), GRAY),
        ((200, 40, 40), CUSTOM),
    ):
        assert classify_color_name(np.array(rgb), tuned) == expected


def test_transparent_border_is_reported_as_transparent(settings) -> None:
    arrays = arrays_for(transparent_sticker())
    sample = sample_background(arrays, settings)

    assert sample.kind == TRANSPARENT
    assert sample.hex is None
    assert sample.key_hex() is None
    assert sample.confidence > 0.5


def test_background_match_respects_alpha_threshold(settings) -> None:
    arrays = arrays_for(transparent_sticker())
    background = background_matches(
        arrays, sample_background(arrays, settings), tolerance=0, alpha_threshold=5
    )

    assert background[0, 0] is np.True_  # corner is fully transparent -> background
    centre = (arrays.height // 2, arrays.width // 2)
    assert background[centre] is np.False_


def test_content_bbox_and_padding(settings) -> None:
    content = np.zeros((100, 100), dtype=bool)
    content[40:60, 10:30] = True

    assert content_bbox(content) == (10, 40, 20, 20)
    assert content_bbox(content, padding_px=5) == (5, 35, 30, 30)
    assert content_bbox(content, padding_px=500) == (0, 0, 100, 100)
    assert content_bbox(np.zeros((10, 10), dtype=bool)) is None


def test_touches_all_edges(settings) -> None:
    full = np.ones((10, 10), dtype=bool)
    assert touches_all_edges(full) is True

    inset = np.zeros((10, 10), dtype=bool)
    inset[3:7, 3:7] = True
    assert touches_all_edges(inset) is False

    left_only = np.zeros((10, 10), dtype=bool)
    left_only[:, 0] = True
    assert touches_all_edges(left_only) is False


def test_edge_ratios_and_full_bleed(settings) -> None:
    clean = arrays_for(gray_screenshot())
    background = background_matches(
        clean, sample_background(clean, settings), tolerance=12, alpha_threshold=5
    )
    ratios = edge_margin_ratios(clean, background, settings)
    assert set(ratios) == {"top", "bottom", "left", "right"}
    assert is_full_bleed(ratios, settings) is False

    busy = arrays_for(full_bleed_noise())
    busy_ratios = edge_margin_ratios(
        busy,
        background_matches(
            busy, sample_background(busy, settings), tolerance=8, alpha_threshold=5
        ),
        settings,
    )
    assert max(busy_ratios.values()) < settings.edge_uniform_ratio
    assert is_full_bleed(busy_ratios, settings) is True


def test_quantised_colour_counts_and_flat_ratio(settings) -> None:
    rgb = np.zeros((50, 50, 3), dtype=np.uint8)
    rgb[10:20, :, :] = 250

    assert unique_color_count(rgb, levels=32) == 2
    assert flat_color_ratio(rgb, levels=32, tolerance=10) == pytest.approx(0.8, abs=0.02)
    ramp = np.stack([np.arange(256, dtype=np.uint8)] * 3, axis=-1).reshape(1, 256, 3)
    assert unique_color_count(ramp, levels=256) == 256


def test_edge_density_separates_flat_art_from_noise(settings) -> None:
    flat = np.full((64, 64), 128.0, dtype=np.float32)
    assert edge_density(flat, settings.classify_edge_threshold) == 0.0

    rng = np.random.default_rng(1)
    noisy = rng.integers(0, 256, size=(64, 64)).astype(np.float32)
    assert edge_density(noisy, settings.classify_edge_threshold) > 0.5


def test_analysis_copy_downscales_only_when_needed(settings) -> None:
    small = Image.new("RGB", (200, 200))
    copy, resized = analysis_copy(small, settings)
    assert resized is False and copy.size == (200, 200)

    big = Image.new("RGB", (4000, 2000))
    copy, resized = analysis_copy(big, settings)
    assert resized is True
    assert max(copy.size) == settings.classify_analysis_max_px


def test_feature_report_exposes_the_five_frozen_features(settings) -> None:
    image = gray_screenshot().convert("RGBA")
    arrays = arrays_for(image)
    sample = sample_background(arrays, settings)

    features, warnings = feature_report(image, arrays, sample, settings)

    assert set(features) == {
        "flatColorRatio",
        "edgeDensity",
        "uniqueColorCount",
        "sampledBackground",
        "fullBleed",
    }
    assert features["fullBleed"] is False  # the caller sets it from full-resolution edges
    assert warnings == []
