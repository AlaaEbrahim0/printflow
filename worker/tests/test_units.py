"""Unit conversion, DPI policy and colour-mode honesty (ARCHITECTURE §17 "resize pixel math")."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from app.errors import CODE_OUTPUT_FORMAT_UNSUPPORTED, OutputFormatError
from app.imaging import (
    build_metadata,
    centimeters_for_pixels,
    dpi_warnings,
    effective_dpi_at_target,
    image_has_alpha,
    normalize_source_mode,
    output_format_for,
    pixels_for_centimeters,
    round_half_away_from_zero,
    save_image,
    scale_to_fit,
)
from app.storage import StorageRoot
from tests.conftest import make_settings, version_path


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0.5, 1), (1.5, 2), (2.5, 3), (-0.5, -1), (-1.5, -2), (2.4, 2), (2.6, 3), (0.0, 0)],
)
def test_round_half_away_from_zero(value: float, expected: int) -> None:
    assert round_half_away_from_zero(value) == expected


@pytest.mark.parametrize(
    ("centimeters", "dpi", "pixels"),
    [
        (58, 300, 6850),  # the roll width: the number the packer is built around
        (20, 300, 2362),
        (12.5, 300, 1476),
        (4.43, 300, 523),
        (1, 300, 118),
        (10, 150, 591),
    ],
)
def test_pixels_for_centimeters_matches_print_units(
    centimeters: float, dpi: int, pixels: int
) -> None:
    assert pixels_for_centimeters(centimeters, dpi) == pixels


def test_centimeter_round_trip_is_within_a_pixel() -> None:
    assert centimeters_for_pixels(pixels_for_centimeters(58, 300), 300) == pytest.approx(
        58, abs=0.01
    )


def test_effective_dpi_uses_the_worse_axis() -> None:
    # The frozen classify example: 316x140 at 10cm x 4.43cm -> 80.264 DPI.
    assert effective_dpi_at_target(316, 140, 10, 4.43) == pytest.approx(80.264, abs=1e-3)
    assert effective_dpi_at_target(100, 100, None, None) is None
    assert effective_dpi_at_target(100, 100, 10, None) == pytest.approx(25.4, rel=1e-6)


def test_scale_to_fit_never_exceeds_the_box() -> None:
    assert scale_to_fit(1000, 500, 200, 200) == (200, 100)
    assert scale_to_fit(500, 1000, 200, 200) == (100, 200)
    assert scale_to_fit(100, 100, 200, 200) == (200, 200)  # may scale up, aspect preserved
    assert scale_to_fit(3, 7, 21, 1) == (1, 1)


def test_dpi_warnings_are_configurable(tmp_path) -> None:
    settings = make_settings(tmp_path, dpi_warn_below=150, dpi_strong_warn_below=100)
    assert dpi_warnings(190, settings) == []
    assert dpi_warnings(140, settings)[0]["code"] == "low-effective-dpi"
    assert dpi_warnings(90, settings)[0]["code"] == "very-low-effective-dpi"
    assert dpi_warnings(None, settings) == []

    stricter = make_settings(tmp_path, dpi_warn_below=300, dpi_strong_warn_below=200)
    assert dpi_warnings(250, stricter)[0]["code"] == "low-effective-dpi"
    assert dpi_warnings(150, stricter)[0]["code"] == "very-low-effective-dpi"


def test_palette_source_is_widened_with_a_warning() -> None:
    palette = Image.new("P", (8, 8), 1)
    converted, warnings = normalize_source_mode(palette)
    assert converted.mode == "RGBA"
    assert [warning["code"] for warning in warnings] == ["palette-converted"]
    assert warnings[0]["severity"] == "warning"


def test_sixteen_bit_source_is_widened_with_a_warning() -> None:
    source = Image.new("I;16", (8, 8))
    converted, warnings = normalize_source_mode(source)
    assert converted.mode == "RGBA"
    assert [warning["code"] for warning in warnings] == ["bit-depth-converted"]


def test_plain_modes_pass_through_quietly() -> None:
    for mode in ("RGB", "RGBA", "L", "LA"):
        image = Image.new(mode, (4, 4))
        converted, warnings = normalize_source_mode(image)
        assert converted.mode == mode
        assert warnings == []


def test_bitonal_source_is_expanded_with_an_info_warning() -> None:
    image = Image.new("1", (4, 4), 1)
    converted, warnings = normalize_source_mode(image)
    assert converted.mode == "L"
    assert warnings[0]["code"] == "bitonal-converted"
    assert warnings[0]["severity"] == "info"


def test_has_alpha_reports_channel_presence() -> None:
    assert image_has_alpha(Image.new("RGBA", (2, 2))) is True
    assert image_has_alpha(Image.new("LA", (2, 2))) is True
    assert image_has_alpha(Image.new("RGB", (2, 2))) is False

    palette_with_transparency = Image.new("P", (2, 2), 0)
    palette_with_transparency.info["transparency"] = 0
    assert image_has_alpha(palette_with_transparency) is True


def test_output_format_refuses_to_flatten_alpha() -> None:
    with pytest.raises(OutputFormatError) as excinfo:
        output_format_for(Path("version.jpg"), Image.new("RGBA", (2, 2)))
    assert excinfo.value.code == CODE_OUTPUT_FORMAT_UNSUPPORTED

    with pytest.raises(OutputFormatError):
        output_format_for(Path("version.heic"), Image.new("RGB", (2, 2)))

    assert output_format_for(Path("version.png"), Image.new("RGBA", (2, 2))) == "PNG"
    assert output_format_for(Path("version.jpg"), Image.new("RGB", (2, 2))) == "JPEG"


def test_save_image_writes_physical_dpi(tmp_path) -> None:
    storage = StorageRoot(tmp_path / "storage")
    relative = version_path("sized")
    image = Image.new("RGBA", (10, 10), (0, 0, 0, 0))


    save_image(storage, relative, image, (), dpi=300)
    with Image.open(storage.resolve(relative)) as stored:
        # PNG stores pHYs as pixels-per-metre, so 300 DPI round-trips approximately.
        assert stored.info.get("dpi") == pytest.approx((300, 300), abs=0.01)


def test_save_image_joins_format_warnings(tmp_path) -> None:
    storage = StorageRoot(tmp_path / "storage")
    relative = version_path("lossy").replace(".png", ".jpg")


    warnings = save_image(storage, relative, Image.new("RGB", (6, 6), (10, 20, 30)), (), dpi=300)
    assert [warning["code"] for warning in warnings] == ["lossy-reencode"]


def test_build_metadata_only_emits_schema_allowed_keys() -> None:
    metadata = build_metadata(
        Image.new("RGBA", (12, 8)),
        duration_ms=17,
        engine="pillow",
        model="contain",
        effective_dpi=187.96,
        warnings=[],
    )
    assert metadata == {
        "durationMs": 17,
        "widthPx": 12,
        "heightPx": 8,
        "hasAlpha": True,
        "effectiveDpiAtTarget": 187.96,
        "engine": "pillow",
        "model": "contain",
    }
