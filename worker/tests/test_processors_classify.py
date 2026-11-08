"""Classifier features and suggestion rules (§17: "classifier features")."""

from __future__ import annotations

import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.processors import classify
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    full_bleed_noise,
    gray_screenshot,
    job_document,
    put_image_file,
    run_processor,
    version_path,
)


def classify_result(
    storage: StorageRoot,
    settings,
    image: Image.Image,
    *,
    context: dict | None = None,
    name: str = "source",
    **parameters,
) -> dict:
    relative = put_image_file(storage, version_path(name), image)
    document = job_document(
        "classify", relative, parameters=parameters, context=context
    )
    return run_processor(classify.process, document, settings, storage)


def test_features_match_the_frozen_shape(storage: StorageRoot, settings) -> None:
    result = classify_result(
        storage, settings, gray_screenshot(), targetWidthCm=20, targetHeightCm=15
    )

    assert result["status"] == "succeeded"
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    features = result["suggestions"]["features"]
    assert set(features) == {
        "flatColorRatio",
        "edgeDensity",
        "uniqueColorCount",
        "sampledBackground",
        "fullBleed",
    }
    assert 0 <= features["flatColorRatio"] <= 1
    assert 0 <= features["edgeDensity"] <= 1
    assert features["uniqueColorCount"] >= 1
    assert features["sampledBackground"]["kind"] in (
        "transparent",
        "black",
        "white",
        "gray",
        "custom",
    )
    assert isinstance(features["fullBleed"], bool)
    assert result["metadata"]["engine"] == "heuristic-v1"
    assert set(result["suggestions"]["suggestions"]) == {"trim", "upscale"}


def test_uniform_border_is_detected_as_gray_background(storage: StorageRoot, settings) -> None:
    result = classify_result(storage, settings, gray_screenshot())
    background = result["suggestions"]["features"]["sampledBackground"]

    assert background["kind"] == "gray"
    assert background["hex"] == "#B8B8B8"
    assert background["confidence"] > 0.9


def test_full_bleed_always_rejects_auto_trim(storage: StorageRoot, settings) -> None:
    """Product rule 12: a full-bleed input must never get an auto-trim proposal."""

    result = classify_result(storage, settings, full_bleed_noise())

    assert result["suggestions"]["features"]["fullBleed"] is True
    assert result["suggestions"]["suggestions"]["trim"]["recommended"] is False
    assert "full bleed" in result["suggestions"]["suggestions"]["trim"]["reason"].lower()


@pytest.mark.parametrize("seed", [3, 11, 29, 47])
def test_full_bleed_holds_for_any_busy_artwork(storage: StorageRoot, settings, seed: int) -> None:
    result = classify_result(storage, settings, full_bleed_noise(seed=seed))
    features = result["suggestions"]["features"]
    assert features["fullBleed"] is True
    assert features["sampledBackground"]["confidence"] < 0.9


def test_trim_is_suggested_when_dead_margin_exists(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (200, 120), (250, 250, 250))
    block = Image.new("RGB", (60, 40), (10, 10, 10))
    image.paste(block, (70, 40))

    result = classify_result(storage, settings, image)
    trim = result["suggestions"]["suggestions"]["trim"]

    assert trim["recommended"] is True
    assert trim["box"]["x"] >= 60
    assert trim["box"]["width"] < 200
    assert trim["paddingPx"] >= 0
    assert 0 <= trim["tolerance"] <= 255


def test_upscale_scale_tracks_effective_dpi(storage: StorageRoot, settings) -> None:
    tiny = gray_screenshot(size=(80, 60))

    desperate = classify_result(storage, settings, tiny, targetWidthCm=20, targetHeightCm=15)
    comfortable = classify_result(storage, settings, tiny, targetWidthCm=2, targetHeightCm=1.5)

    assert desperate["suggestions"]["source"]["effectiveDpiAtTarget"] < 100
    assert desperate["suggestions"]["suggestions"]["upscale"]["scale"] == 4
    assert comfortable["suggestions"]["suggestions"]["upscale"]["scale"] == 2
    assert (
        desperate["suggestions"]["suggestions"]["upscale"]["confidence"]
        > comfortable["suggestions"]["suggestions"]["upscale"]["confidence"]
    )


def test_missing_target_omits_effective_dpi(storage: StorageRoot, settings) -> None:
    result = classify_result(storage, settings, gray_screenshot(), context={"workingDpi": 300})

    assert "effectiveDpiAtTarget" not in result["suggestions"]["source"]
    assert "effectiveDpiAtTarget" not in result["metadata"]


def test_classify_is_read_only(storage: StorageRoot, settings) -> None:
    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document("classify", source)
    before = sorted(path.name for path in storage.resolve(source).parent.iterdir())

    result = run_processor(classify.process, document, settings, storage)

    assert "outputPath" not in result
    assert sorted(path.name for path in storage.resolve(source).parent.iterdir()) == before


def test_low_resolution_produces_a_strong_warning(storage: StorageRoot, settings) -> None:
    result = classify_result(
        storage, settings, gray_screenshot(size=(120, 80)), targetWidthCm=40, targetHeightCm=30
    )
    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "very-low-effective-dpi" in codes
