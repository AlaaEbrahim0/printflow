"""trim: auto sampling, full-bleed refusal, manual rect fidelity, edge warnings."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import CODE_CROP_OUT_OF_BOUNDS, CropOutOfBoundsError
from app.processors import trim
from app.processors.trim import (
    EDGE_WARNING,
    FULL_BLEED_WARNING,
    NO_CONTENT_WARNING,
)
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    full_bleed_noise,
    gray_screenshot,
    job_document,
    put_image_file,
    run_processor,
    transparent_sticker,
    version_path,
)


def run_trim(storage, settings, image, *, parameters, source_name="source", output_name="trimmed"):
    source = put_image_file(storage, version_path(source_name), image)
    document = job_document(
        "trim",
        source,
        output_relative=version_path(output_name),
        parameters=parameters,
    )
    result = run_processor(trim.process, document, settings, storage)
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    return source, result


def warning_codes(result) -> list[str]:
    return [warning["code"] for warning in result["metadata"].get("warnings", [])]


def test_auto_trim_crops_to_content_plus_padding(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (300, 200), (250, 250, 250))
    image.paste(Image.new("RGB", (60, 40), (10, 10, 10)), (100, 60))

    _, result = run_trim(
        storage, settings, image, parameters={"mode": "auto", "paddingPx": 8, "tolerance": 12}
    )

    assert result["status"] == "succeeded"
    # Content box is x 100..159 / y 60..99; padded and clamped to the canvas.
    assert result["metadata"]["widthPx"] == 76
    assert result["metadata"]["heightPx"] == 56
    cropped = Image.open(storage.resolve(result["outputPath"]))
    assert cropped.size == (76, 56)


def test_auto_trim_uses_supplied_background_sample(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (200, 200), (5, 5, 5))
    image.paste(Image.new("RGB", (40, 40), (245, 245, 245)), (80, 80))

    _, result = run_trim(
        storage,
        settings,
        image,
        parameters={
            "mode": "auto",
            "paddingPx": 0,
            "tolerance": 8,
            "backgroundSample": {"kind": "black", "hex": "#050505", "alphaThreshold": 5},
        },
    )

    assert result["metadata"]["widthPx"] == 40
    assert result["metadata"]["heightPx"] == 40


def test_full_bleed_is_never_auto_cropped(storage: StorageRoot, settings) -> None:
    image = full_bleed_noise(size=(120, 90))
    source, result = run_trim(
        storage, settings, image, parameters={"mode": "auto", "paddingPx": 4, "tolerance": 12}
    )

    assert FULL_BLEED_WARNING in warning_codes(result)
    assert result["metadata"]["widthPx"] == 120
    assert result["metadata"]["heightPx"] == 90
    stored = np.asarray(Image.open(storage.resolve(result["outputPath"])))
    original = np.asarray(Image.open(storage.resolve(source)))
    assert np.array_equal(stored, original), "pass-through must not alter pixels"


def test_full_bleed_pass_through_copies_bytes_without_reencoding(
    storage: StorageRoot, settings
) -> None:
    image = full_bleed_noise(size=(64, 48))
    source, result = run_trim(
        storage, settings, image, parameters={"mode": "auto"}, source_name="bleed"
    )

    raw_source = storage.read_bytes(source)
    raw_output = storage.read_bytes(result["outputPath"])
    assert raw_source == raw_output, "same-suffix pass-through must be a byte copy"


def test_blank_canvas_warns_and_passes_through(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (80, 60), (255, 255, 255))
    _, result = run_trim(
        storage, settings, image, parameters={"mode": "auto", "tolerance": 12}
    )

    assert result["status"] == "succeeded"
    assert NO_CONTENT_WARNING in warning_codes(result)
    assert result["metadata"]["widthPx"] == 80


def test_manual_crop_honours_the_rectangle_exactly(storage: StorageRoot, settings) -> None:
    image = gray_screenshot(size=(200, 160))
    _, result = run_trim(
        storage,
        settings,
        image,
        parameters={"mode": "manual", "cropRect": {"x": 30, "y": 20, "width": 64, "height": 33}},
    )

    assert result["metadata"]["widthPx"] == 64
    assert result["metadata"]["heightPx"] == 33
    cropped = np.asarray(Image.open(storage.resolve(result["outputPath"])))
    expected = np.asarray(image)[20:53, 30:94]
    assert np.array_equal(cropped, expected)


def test_manual_crop_outside_the_source_fails_stably(storage: StorageRoot, settings) -> None:
    source = put_image_file(storage, version_path("source"), gray_screenshot(size=(100, 80)))
    document = job_document(
        "trim",
        source,
        output_relative=version_path("trimmed"),
        parameters={"mode": "manual", "cropRect": {"x": 60, "y": 10, "width": 60, "height": 40}},
    )

    with pytest.raises(CropOutOfBoundsError) as excinfo:
        run_processor(trim.process, document, settings, storage)
    assert excinfo.value.code == CODE_CROP_OUT_OF_BOUNDS
    assert not storage.resolve(document["outputPath"]).exists()


def test_manual_crop_warns_when_it_cuts_content(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (120, 80), (250, 250, 250))
    image.paste(Image.new("RGB", (80, 60), (10, 10, 10)), (20, 10))

    _, result = run_trim(
        storage,
        settings,
        image,
        parameters={"mode": "manual", "cropRect": {"x": 40, "y": 20, "width": 30, "height": 20}},
        output_name="cut",
    )

    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert codes.count(EDGE_WARNING) == 4  # artwork continues past every chosen edge
    edges = {
        warning["details"]["edge"]
        for warning in result["metadata"]["warnings"]
        if warning["code"] == EDGE_WARNING
    }
    assert edges == {"left", "right", "top", "bottom"}


def test_padding_is_clamped_to_the_canvas(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (100, 60), (250, 250, 250))
    image.paste(Image.new("RGB", (20, 20), (10, 10, 10)), (0, 0))

    _, result = run_trim(
        storage, settings, image, parameters={"mode": "auto", "paddingPx": 500, "tolerance": 12}
    )

    assert result["metadata"]["widthPx"] == 100
    assert result["metadata"]["heightPx"] == 60


def test_transparency_survives_the_crop(storage: StorageRoot, settings) -> None:
    image = transparent_sticker(size=(160, 120))
    _, result = run_trim(storage, settings, image, parameters={"mode": "auto", "paddingPx": 2})

    assert result["metadata"]["hasAlpha"] is True
    cropped = Image.open(storage.resolve(result["outputPath"]))
    assert cropped.mode == "RGBA"
    alpha = np.asarray(cropped.getchannel("A"))
    assert alpha.min() == 0 and alpha.max() == 255


def test_input_file_is_never_modified(storage: StorageRoot, settings) -> None:
    image = gray_screenshot()
    source, result = run_trim(storage, settings, image, parameters={"mode": "auto"})

    before = storage.read_bytes(source)
    assert result["outputPath"] != source
    assert storage.read_bytes(source) == before


def test_unknown_mode_is_rejected_by_the_contract(storage: StorageRoot, settings) -> None:
    """The frozen schema is the gate, so a bad mode never reaches the processor."""

    from app.errors import CODE_INVALID_JOB, JobContractError

    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document(
        "trim", source, output_relative=version_path("x"), parameters={"mode": "semantic"}
    )
    with pytest.raises(JobContractError) as excinfo:
        run_processor(trim.process, document, settings, storage)
    assert excinfo.value.code == CODE_INVALID_JOB
    assert excinfo.value.retryable is False


def test_metadata_reports_effective_dpi_at_target(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (400, 300), (250, 250, 250))
    image.paste(Image.new("RGB", (200, 150), (10, 10, 10)), (100, 75))

    _, result = run_trim(storage, settings, image, parameters={"mode": "auto", "paddingPx": 0})

    dpi = result["metadata"]["effectiveDpiAtTarget"]
    expected = min(
        result["metadata"]["widthPx"] / (20 / 2.54),
        result["metadata"]["heightPx"] / (15 / 2.54),
    )
    assert dpi == pytest.approx(expected)
