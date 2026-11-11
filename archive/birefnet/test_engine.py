"""birefnet engine: tiling geometry, device policy, and the tile budget."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.engines.birefnet import DEFAULT_MODEL, BirefnetEngine, tile_count
from app.errors import EngineUnavailableError


def make_settings(tmp_path, **overrides) -> Settings:
    path = Path(tmp_path)
    values = {
        "cutout_model_dir": path / "models",
        "cutout_tile_source_px": 1200,
        "cutout_tile_overlap_px": 96,
        "cutout_max_tiles": 64,
        "gpu_enabled": False,
    }
    values.update(overrides)
    return Settings(**values)


def fake_engine(tmp_path, **overrides) -> BirefnetEngine:
    engine = BirefnetEngine(make_settings(tmp_path, **overrides))
    # Skip ONNX entirely: every forward pass returns a constant matte.
    engine._session = lambda model: object()  # type: ignore[assignment]
    engine._predict = lambda session, patch: np.full((1024, 1024), 1.0, np.float32)  # type: ignore[assignment]
    return engine


def test_windows_cover_the_axis_flush_to_the_edge() -> None:
    engine = BirefnetEngine(make_settings("/tmp"))

    starts = engine._windows(3600, 1200, 96)

    assert starts[0] == 0
    assert starts[-1] + 1200 == 3600
    assert all(b > a for a, b in zip(starts, starts[1:]))


def test_whole_image_path_is_one_tile(tmp_path) -> None:
    engine = fake_engine(tmp_path)
    image = Image.new("RGB", (800, 600), (255, 255, 255))

    result = engine.cutout(image, DEFAULT_MODEL)

    assert result.tiles == 1
    assert result.image.size == (800, 600)
    assert [w["code"] for w in result.warnings] == []


def test_large_source_is_tiled(tmp_path) -> None:
    engine = fake_engine(tmp_path, cutout_max_tiles=256)
    image = Image.new("RGB", (2400, 2400), (255, 255, 255))

    result = engine.cutout(image, DEFAULT_MODEL)

    assert result.tiles == tile_count(2400, 2400, 1200, 96)
    assert result.image.size == (2400, 2400)
    assert "cutout-tiled" in [w["code"] for w in result.warnings]


def test_tile_budget_falls_back_to_a_single_pass(tmp_path) -> None:
    engine = fake_engine(tmp_path, cutout_max_tiles=2)
    image = Image.new("RGB", (5000, 5000), (255, 255, 255))

    result = engine.cutout(image, DEFAULT_MODEL)

    codes = [w["code"] for w in result.warnings]
    assert result.tiles == 1
    assert "cutout-tile-budget-exceeded" in codes
    assert result.image.size == (5000, 5000)


def test_gpu_fallback_is_reported(tmp_path) -> None:
    engine = fake_engine(tmp_path, gpu_enabled=True)
    image = Image.new("RGB", (400, 400), (255, 255, 255))

    result = engine.cutout(image, DEFAULT_MODEL)

    assert result.device == "cpu"
    codes = [w["code"] for w in result.warnings]
    assert "cutout-gpu-fallback" in codes


def test_missing_weights_raise_engine_unavailable(tmp_path) -> None:
    engine = BirefnetEngine(make_settings(tmp_path))

    with pytest.raises(EngineUnavailableError):
        engine.cutout(Image.new("RGB", (100, 100)), DEFAULT_MODEL)


def test_unknown_model_is_engine_unavailable(tmp_path) -> None:
    engine = BirefnetEngine(make_settings(tmp_path))

    with pytest.raises(EngineUnavailableError):
        engine.require_model_path("no-such-model")


def test_tile_count_matches_windows() -> None:
    assert tile_count(800, 600, 1200, 96) == 1
    assert tile_count(3600, 3600, 1200, 96) == 16
