"""resize: fit modes, one-resample discipline and PrintUnits math."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import UnsupportedParameterError
from app.processors import resize
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    gray_screenshot,
    job_document,
    make_engines,
    put_image_file,
    run_processor,
    transparent_sticker,
    version_path,
)


def run_resize(storage, settings, image, parameters, engines=None, input_artifacts=None):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "resize",
        source,
        output_relative=version_path("final"),
        parameters=parameters,
        input_artifacts=input_artifacts,
    )
    result = run_processor(
        resize.process, document, settings, storage, engines or make_engines(settings)
    )
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    return source, result


def parameters(fit_mode: str, width_px: int, height_px: int, **overrides) -> dict:
    base = {
        "targetWidthCm": 20,
        "targetHeightCm": 15,
        "targetWidthPx": width_px,
        "targetHeightPx": height_px,
        "dpi": 300,
        "fitMode": fit_mode,
        "resample": "lanczos",
        "rasterizeFromVector": False,
    }
    base.update(overrides)
    return base


def test_width_fit_derives_the_other_axis(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage, settings, gray_screenshot(size=(1000, 500)), parameters("width", 2362, 1772)
    )

    assert result["metadata"]["widthPx"] == 2362
    assert result["metadata"]["heightPx"] == round(500 * 2362 / 1000)


def test_height_fit_derives_the_other_axis(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage, settings, gray_screenshot(size=(1000, 500)), parameters("height", 2362, 1772)
    )

    assert result["metadata"]["heightPx"] == 1772
    assert result["metadata"]["widthPx"] == round(1000 * 1772 / 500)


def test_contain_is_exactly_the_target_box_with_transparent_padding(
    storage: StorageRoot, settings
) -> None:
    _, result = run_resize(
        storage, settings, gray_screenshot(size=(3000, 1000)), parameters("contain", 600, 600)
    )

    assert (result["metadata"]["widthPx"], result["metadata"]["heightPx"]) == (600, 600)
    array = np.asarray(Image.open(storage.resolve(result["outputPath"])).convert("RGBA"))
    assert array[0, 300, 3] == 0, "letterboxed rows must be transparent"
    assert array[300, 300, 3] > 0, "the artwork is centred"
    assert array[599, 0, 3] == 0


def test_contain_never_stretches_or_crops(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (400, 100), (255, 255, 255))
    image.paste(Image.new("RGB", (400, 100), (0, 0, 0)), (0, 0))

    _, result = run_resize(storage, settings, image, parameters("contain", 200, 200))

    array = np.asarray(Image.open(storage.resolve(result["outputPath"])).convert("RGBA"))
    rows_with_content = np.where((array[..., 3] > 0).any(axis=1))[0]
    assert array[rows_with_content[0], 0, 0] == 0, "content keeps its 4:1 aspect"
    assert len(rows_with_content) == pytest.approx(50, rel=0.1)


def test_roll_width_target_is_6850_pixels(storage: StorageRoot, settings) -> None:
    """58 cm at 300 DPI is the roll width; PrintUnits and the worker must agree."""

    wide = gray_screenshot(size=(2000, 600))
    roll = parameters("width", 6850, 3000) | {"targetWidthCm": 58, "targetHeightCm": 25.4}

    _, result = run_resize(storage, settings, wide, roll)

    assert result["metadata"]["widthPx"] == 6850
    codes = [warning["code"] for warning in result["metadata"].get("warnings", [])]
    assert "target-px-cm-mismatch" not in codes


def test_pixel_centimetre_disagreement_is_warned(storage: StorageRoot, settings) -> None:
    off_by_one = parameters("width", 6851, 3000) | {"targetWidthCm": 58, "targetHeightCm": 25.4}

    _, result = run_resize(storage, settings, gray_screenshot(size=(2000, 600)), off_by_one)

    mismatch = [
        warning
        for warning in result["metadata"]["warnings"]
        if warning["code"] == "target-px-cm-mismatch"
    ]
    assert mismatch
    assert mismatch[0]["details"] == {
        "axis": "width",
        "providedPx": 6851,
        "printUnitsPx": 6850,
        "centimeters": 58,
        "dpi": 300,
    }
    # The explicit pixel target still wins, because the API is authoritative.
    assert result["metadata"]["widthPx"] == 6851


def test_only_one_resample_happens(storage: StorageRoot, settings, monkeypatch) -> None:
    calls: list[tuple] = []
    original = Image.Image.resize

    def counting_resize(self, size, *args, **kwargs):
        calls.append((size, args, kwargs))
        return original(self, size, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "resize", counting_resize)

    run_resize(storage, settings, gray_screenshot(size=(900, 600)), parameters("contain", 500, 500))

    # Calls made by the worker itself carry only (size, filter). Pillow re-enters
    # resize() with an explicit box when it resamples RGBA in premultiplied space,
    # which is the same single geometric resample, not a second one.
    ours = [call for call in calls if len(call[1]) == 1 and not call[2]]
    assert len(ours) == 1, "the final resize must resample exactly once"
    assert ours[0][0] == (500, 333), "contain fit for 900x600 inside a 500x500 box"
    assert ours[0][1] == (Image.Resampling.LANCZOS,), "Lanczos, and nothing else"
    assert {call[0] for call in calls} == {(500, 333)}, "no intermediate rescale"


def test_rgb_source_stays_rgb_for_a_width_fit(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage, settings, gray_screenshot(size=(300, 200)), parameters("width", 600, 400)
    )

    with Image.open(storage.resolve(result["outputPath"])) as stored:
        assert stored.mode == "RGB"
    assert result["metadata"]["hasAlpha"] is False


def test_rgba_source_keeps_its_alpha(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage, settings, transparent_sticker(size=(200, 200)), parameters("width", 100, 100)
    )

    with Image.open(storage.resolve(result["outputPath"])) as stored:
        assert stored.mode == "RGBA"
        assert np.asarray(stored.getchannel("A")).min() == 0
    assert result["metadata"]["hasAlpha"] is True


def test_physical_dpi_is_written_into_the_file(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage, settings, gray_screenshot(size=(200, 150)), parameters("width", 1000, 750)
    )

    with Image.open(storage.resolve(result["outputPath"])) as stored:
        assert stored.info.get("dpi") == pytest.approx((300, 300), abs=0.01)


def test_low_effective_dpi_of_the_source_is_warned(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage,
        settings,
        gray_screenshot(size=(120, 90)),
        parameters("contain", 2362, 1772),
    )

    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "very-low-effective-dpi" in codes
    # The reported DPI describes the source detail, not the upscaled canvas.
    assert result["metadata"]["effectiveDpiAtTarget"] < 100


def test_unknown_fit_mode_is_rejected_by_the_contract(storage: StorageRoot, settings) -> None:
    from app.errors import JobContractError

    source = put_image_file(storage, version_path("source"), gray_screenshot(size=(80, 60)))
    document = job_document(
        "resize",
        source,
        output_relative=version_path("final"),
        parameters=parameters("stretch", 100, 100) | {"fitMode": "stretch"},
    )
    with pytest.raises(JobContractError):
        run_processor(resize.process, document, settings, storage, make_engines(settings))


def test_rasterize_from_vector_is_retired(storage: StorageRoot, settings) -> None:
    with pytest.raises(UnsupportedParameterError) as excinfo:
        run_resize(
            storage,
            settings,
            gray_screenshot(size=(200, 150)),
            parameters("width", 1200, 900, rasterizeFromVector=True),
        )
    assert excinfo.value.details["parameter"] == "rasterizeFromVector"


def test_contain_on_a_dark_garment_keeps_transparency(storage: StorageRoot, settings) -> None:
    _, result = run_resize(
        storage,
        settings,
        transparent_sticker(size=(100, 100)),
        parameters("contain", 200, 100),
    )

    array = np.asarray(Image.open(storage.resolve(result["outputPath"])).convert("RGBA"))
    assert array[..., 3].min() == 0
    assert result["metadata"]["hasAlpha"] is True
