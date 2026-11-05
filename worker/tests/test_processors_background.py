"""background-removal: unmultiplied keying math, masks, brushes, modes (§17)."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import (
    CODE_AI_UNAVAILABLE,
    CODE_MASK_DIMENSION_MISMATCH,
    AiUnavailableError,
    MaskMismatchError,
)
from app.processors import background
from app.processors.background import (
    apply_brush_ops,
    unmultiplied_color_to_alpha,
)
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    alpha_of,
    fake_rembg_module,
    gray_screenshot,
    horizontal_gradient,
    job_document,
    make_engines,
    put_image_file,
    run_processor,
    transparent_sticker,
    version_path,
)


def run_background(
    storage: StorageRoot,
    settings,
    image: Image.Image,
    parameters: dict,
    *,
    engines=None,
    input_artifacts=None,
    source_name: str = "source",
    output_name: str = "cutout",
):
    source = put_image_file(storage, version_path(source_name), image)
    document = job_document(
        "background-removal",
        source,
        output_relative=version_path(output_name),
        parameters=parameters,
        input_artifacts=input_artifacts,
        output_artifacts={
            "mask": version_path(output_name).replace(".png", "/mask.png")
        },
    )
    result = run_processor(background.process, document, settings, storage, engines)
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    return source, result


def mask_of(storage: StorageRoot, result) -> np.ndarray:
    return np.asarray(
        Image.open(storage.resolve(result["outputArtifacts"]["mask"])), dtype=np.uint8
    )


# --- the unmultiplied math, tested directly ---------------------------------
def test_pure_key_becomes_fully_transparent() -> None:
    rgb = np.full((1, 4, 3), 200, dtype=np.uint8)
    alpha, colours = unmultiplied_color_to_alpha(rgb, np.array([200.0, 200.0, 200.0]), 0)

    assert alpha.tolist() == [[0, 0, 0, 0]]
    # Nothing visible, but the original colour is preserved so a later brush
    # "restore" reveals artwork instead of a key-colour hole.
    assert np.array_equal(colours[0], rgb[0])


def test_gradient_keeps_its_hue_instead_of_darkening() -> None:
    """Black key on a black->white ramp: colours must un-multiply back to white."""

    ramp = np.rint(np.linspace(0, 255, 256)).astype(np.uint8)
    rgb = np.stack([np.tile(ramp, (1, 1))] * 3, axis=-1).astype(np.uint8)
    alpha, colours = unmultiplied_color_to_alpha(rgb, np.zeros(3), 0)

    assert alpha.shape == (1, 256)
    assert alpha[0, 0] == 0
    assert alpha[0, -1] == 255
    # Every partially transparent pixel un-multiplies to ~255 rather than keeping
    # the dark blended value: that is the difference between a clean edge and a
    # black fringe around the artwork.
    interior = colours[0, 8:250]
    assert interior[..., 0].min() >= 250
    assert interior[..., 1].min() >= 250


def test_white_key_recovers_dark_artwork_colour() -> None:
    """A 50% grey edge over white is a half-covered black pixel, not grey."""

    rgb = np.full((1, 1, 3), 128, dtype=np.uint8)
    alpha, colours = unmultiplied_color_to_alpha(rgb, np.full(3, 255.0), 0)

    assert alpha[0, 0] == pytest.approx(127, abs=2)
    assert colours[0, 0].tolist() == [0, 0, 0]


def test_fully_opaque_pixel_is_unchanged() -> None:
    """A channel that is the opposite extreme of the key forces alpha 255."""

    rgb = np.array([[[0, 200, 60]]], dtype=np.uint8)
    alpha, colours = unmultiplied_color_to_alpha(rgb, np.array([255.0, 255.0, 255.0]), 0)

    assert alpha[0, 0] == 255
    assert colours[0, 0].tolist() == [0, 200, 60]


def test_partially_translucent_pixel_unmultiplies_its_colour() -> None:
    """Not a bug: keying re-derives the colour *behind* the blend."""

    rgb = np.array([[[128, 128, 128]]], dtype=np.uint8)
    alpha, colours = unmultiplied_color_to_alpha(rgb, np.array([255.0, 255.0, 255.0]), 0)

    assert alpha[0, 0] == pytest.approx(127, abs=2)
    assert colours[0, 0].tolist() == [0, 0, 0]


def test_tolerance_swallows_near_key_pixels() -> None:
    rgb = np.tile(np.arange(256, dtype=np.uint8)[None, :, None], (1, 1, 3)).astype(np.uint8)
    alpha, _ = unmultiplied_color_to_alpha(rgb, np.zeros(3), tolerance=64)

    assert alpha[0, : 64].max() == 0
    assert alpha[0, -1] == 255
    # The ramp is rescaled, so it stays monotonic instead of jumping.
    assert np.all(np.diff(alpha[0]) >= 0)


# --- end-to-end through the processor ----------------------------------------
def test_color_to_alpha_writes_mask_and_multiplies_source_alpha(
    storage: StorageRoot, settings
) -> None:
    source, result = run_background(
        storage,
        settings,
        horizontal_gradient(width=64, height=8),
        {"mode": "color-to-alpha", "keyColor": "#000000", "tolerance": 0},
    )

    mask = mask_of(storage, result)
    assert mask.shape == (8, 64)
    assert mask[0, 0] == 0
    assert mask[0, -1] == 255
    output_alpha = alpha_of(Image.open(storage.resolve(result["outputPath"])))
    assert np.array_equal(output_alpha, mask), "opaque source: alpha == mask"
    assert result["metadata"]["engine"] == "color-to-alpha"
    assert result["metadata"]["model"] == "unmultiplied-key-color"


def test_source_alpha_is_multiplied_not_replaced(storage: StorageRoot, settings) -> None:
    image = transparent_sticker(size=(64, 64))
    image.putalpha(Image.fromarray(np.full((64, 64), 128, dtype=np.uint8)))

    _, result = run_background(
        storage,
        settings,
        image,
        {"mode": "color-to-alpha", "keyColor": "#000000", "tolerance": 0},
    )

    alpha = alpha_of(Image.open(storage.resolve(result["outputPath"])))
    mask = mask_of(storage, result)
    expected = (128 * mask.astype(np.uint16) + 127) // 255
    assert np.array_equal(alpha, expected.astype(np.uint8))


def test_edge_softness_feathers_only_the_keying_ramp(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (40, 8), (255, 255, 255))
    image.paste(Image.new("RGB", (10, 8), (0, 0, 0)), (15, 0))

    _, sharp = run_background(
        storage,
        settings,
        image,
        {"mode": "color-to-alpha", "keyColor": "#FFFFFF"},
        source_name="s1",
        output_name="sharp",
    )
    _, soft = run_background(
        storage,
        settings,
        image,
        {"mode": "color-to-alpha", "keyColor": "#FFFFFF", "edgeSoftness": 2.0},
        source_name="s2",
        output_name="soft",
    )

    sharp_mask = mask_of(storage, sharp)
    soft_mask = mask_of(storage, soft)
    intermediate = int(np.sum((soft_mask > 0) & (soft_mask < 255)))
    assert intermediate > int(np.sum((sharp_mask > 0) & (sharp_mask < 255)))
    assert "mask-edge-softened" in [w["code"] for w in soft["metadata"]["warnings"]]


def test_brush_erase_then_restore_is_a_clean_undo(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (60, 20), (10, 10, 10))
    engines = make_engines(settings, None, rembg_module=fake_rembg_module())
    _, erased = run_background(
        storage,
        settings,
        image,
        {
            "mode": "ai",
            "brushOps": [{"tool": "erase", "radiusPx": 8, "points": [[30, 10]]}],
        },
        source_name="erase",
        engines=engines,
    )
    mask = mask_of(storage, erased)
    assert mask[10, 30] == 0
    assert mask[10, 0] == 255

    _, restored = run_background(
        storage,
        settings,
        image,
        {
            "mode": "ai",
            "brushOps": [
                {"tool": "erase", "radiusPx": 8, "points": [[30, 10]]},
                {"tool": "restore", "radiusPx": 10, "points": [[30, 10]]},
            ],
        },
        source_name="restore",
        engines=engines,
    )
    restored_mask = mask_of(storage, restored)
    assert restored_mask[10, 30] == 255
    alpha = alpha_of(Image.open(storage.resolve(restored["outputPath"])))
    assert alpha[10, 30] == 255


def test_brush_op_fully_off_canvas_is_reported(storage: StorageRoot, settings) -> None:
    image = Image.new("RGB", (40, 40), (9, 9, 9))
    engines = make_engines(settings, None, rembg_module=fake_rembg_module())
    _, result = run_background(
        storage,
        settings,
        image,
        {
            "mode": "ai",
            "brushOps": [
                {"tool": "erase", "radiusPx": 2, "points": [[10000, 10000]]},
                {"tool": "erase", "radiusPx": 4, "points": [[20, 20]]},
            ],
        },
        engines=engines,
    )

    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "brush-op-off-canvas" in codes
    assert mask_of(storage, result)[20, 20] == 0


def test_brush_strokes_do_not_touch_the_original_file(storage: StorageRoot, settings) -> None:
    image = gray_screenshot(size=(120, 80))
    engines = make_engines(settings, None, rembg_module=fake_rembg_module())
    source, result = run_background(
        storage,
        settings,
        image,
        {"mode": "ai", "brushOps": [{"tool": "erase", "radiusPx": 30, "points": [[60, 40]]}]},
        engines=engines,
    )

    before = np.asarray(Image.open(storage.resolve(source)))
    assert np.array_equal(before, np.asarray(image))
    assert result["outputPath"] != source


def test_mask_from_previous_version_is_loaded_and_combined(
    storage: StorageRoot, settings
) -> None:
    prior = Image.fromarray(
        np.array([[255, 255, 0, 0]] * 4, dtype=np.uint8),
        "L",
    )
    prior_relative = version_path("prior").replace(".png", "/mask.png")
    put_image_file(storage, prior_relative, prior)
    image = Image.new("RGB", (4, 4), (5, 5, 5))

    _, result = run_background(
        storage,
        settings,
        image,
        {"mode": "none", "maskFromVersionId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"},
        input_artifacts={"mask": prior_relative},
    )

    mask = mask_of(storage, result)
    assert mask[:, :2].max() == 255
    assert mask[:, 2:].max() == 0


def test_mismatched_prior_mask_fails_stably(storage: StorageRoot, settings) -> None:
    prior_relative = version_path("prior").replace(".png", "/mask.png")
    put_image_file(storage, prior_relative, Image.new("L", (9, 9), 255))

    with pytest.raises(MaskMismatchError) as excinfo:
        run_background(
            storage,
            settings,
            Image.new("RGB", (6, 6), (1, 2, 3)),
            {"mode": "none", "maskFromVersionId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"},
            input_artifacts={"mask": prior_relative},
        )
    assert excinfo.value.code == CODE_MASK_DIMENSION_MISMATCH


def test_ai_mode_uses_the_injected_cutout_module(storage: StorageRoot, settings) -> None:
    cutout = Image.new("RGBA", (12, 12), (200, 20, 20, 0))
    cutout.paste(Image.new("RGBA", (6, 6), (200, 20, 20, 255)), (3, 3))
    module = fake_rembg_module(cutout)
    engines = make_engines(settings, None, rembg_module=module)

    _, result = run_background(
        storage,
        settings,
        Image.new("RGB", (12, 12), (240, 240, 240)),
        {"mode": "ai", "aiModel": "birefnet-general"},
        engines=engines,
    )

    assert result["metadata"]["engine"] == "rembg"
    assert result["metadata"]["model"] == "birefnet-general"
    assert module.calls["model"] == "birefnet-general"
    mask = mask_of(storage, result)
    assert mask[6, 6] == 255
    assert mask[0, 0] == 0


def test_ai_mode_fails_structurally_when_the_library_is_absent(
    storage: StorageRoot, settings
) -> None:
    engines = make_engines(settings, None, rembg_module=None)

    with pytest.raises(AiUnavailableError) as excinfo:
        run_background(
            storage,
            settings,
            Image.new("RGB", (12, 12), (240, 240, 240)),
            {"mode": "ai"},
            engines=engines,
        )
    assert excinfo.value.code == CODE_AI_UNAVAILABLE
    assert excinfo.value.retryable is False


def test_none_mode_passes_pixels_through_unchanged(storage: StorageRoot, settings) -> None:
    image = gray_screenshot(size=(100, 60))
    _, result = run_background(storage, settings, image, {"mode": "none"})

    stored = np.asarray(Image.open(storage.resolve(result["outputPath"])))
    assert np.array_equal(stored, np.asarray(image))
    assert mask_of(storage, result).min() == 255
    assert result["metadata"]["engine"] == "passthrough"


def test_mask_artifact_is_eight_bit_grayscale(storage: StorageRoot, settings) -> None:
    _, result = run_background(
        storage,
        settings,
        horizontal_gradient(width=32, height=4),
        {"mode": "color-to-alpha", "keyColor": "#000000"},
    )

    with Image.open(storage.resolve(result["outputArtifacts"]["mask"])) as mask:
        assert mask.mode == "L"


def test_apply_brush_ops_rejects_an_unknown_tool() -> None:
    from app.errors import UnsupportedParameterError

    mask = Image.new("L", (8, 8), 255)
    with pytest.raises(UnsupportedParameterError):
        apply_brush_ops(mask, [{"tool": "smudge", "radiusPx": 2, "points": [[4, 4]]}])
