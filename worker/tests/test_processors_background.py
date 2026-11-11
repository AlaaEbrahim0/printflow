"""background-removal: the colour key, the mask artifact, brush and shaping ops."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import (
    CODE_INVALID_JOB,
    CODE_MASK_MISMATCH,
    CODE_UNSUPPORTED_PARAMETERS,
    MaskMismatchError,
    UnsupportedParameterError,
)
from app.processors import background
from app.processors.background import apply_brush_ops, unmultiplied_color_to_alpha
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    job_document,
    make_engines,
    put_image_file,
    run_processor,
    version_path,
)


def warning_codes(result) -> list[str]:
    return [warning["code"] for warning in result["metadata"].get("warnings", [])]


def white_artwork(size: tuple[int, int] = (240, 160)) -> Image.Image:
    image = Image.new("RGB", size, (255, 255, 255))
    image.paste(Image.new("RGB", (80, 60), (20, 20, 20)), (60, 40))
    return image


def run_background(storage, settings, image, *, parameters, name="cutout", **kwargs):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "background-removal",
        source,
        output_relative=version_path(name),
        parameters=parameters,
        output_artifacts={"mask": f"{version_path(name)[:-4]}/mask.png"},
        **kwargs,
    )
    result = run_processor(
        background.process,
        document,
        settings,
        storage,
        engines=make_engines(settings),
    )
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    return source, result


# --- colour key --------------------------------------------------------------

def test_color_to_alpha_removes_the_key_and_keeps_artwork() -> None:
    rgb = np.full((10, 10, 3), 255, dtype=np.uint8)
    rgb[2:5, 2:5] = (10, 10, 10)

    alpha, colours = unmultiplied_color_to_alpha(rgb, np.array([255, 255, 255]), 0)

    assert (alpha[0, 0] == 0) and (alpha[9, 9] == 0)
    # The unmultiplied ramp keeps the near-black pixel effectively opaque
    # ((255-10)/255), which is what GIMP's colour-to-alpha produces too.
    assert alpha[3, 3] >= 240
    # Un-multiplying treats the pixel as a blend of the key and the foreground, so
    # dark ink reads back as near-black rather than the key colour.
    assert int(colours[3, 3].max()) <= 20


def test_color_to_alpha_tolerance_transparentises_near_key() -> None:
    rgb = np.full((4, 4, 3), 250, dtype=np.uint8)  # near-white, not exact

    opaque, _ = unmultiplied_color_to_alpha(rgb, np.array([255, 255, 255]), 0)
    wide, _ = unmultiplied_color_to_alpha(rgb, np.array([255, 255, 255]), 20)

    assert opaque[0, 0] > 0
    assert wide[0, 0] == 0


def test_color_to_alpha_job_writes_mask_and_cutout(storage: StorageRoot, settings) -> None:
    _, result = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={"mode": "color-to-alpha", "keyColor": "#ffffff"},
    )

    assert result["status"] == "succeeded"
    mask = Image.open(storage.resolve(result["outputArtifacts"]["mask"])).convert("L")
    cutout = Image.open(storage.resolve(result["outputPath"])).convert("RGBA")
    assert mask.size == cutout.size == (240, 160)
    # Background is transparent in both mask and cut-out; the block survives.
    assert np.asarray(mask)[5, 5] == 0
    assert np.asarray(mask)[70, 100] >= 230
    assert np.asarray(cutout)[:, :, 3][5, 5] == 0
    assert np.asarray(cutout)[:, :, 3][70, 100] >= 230


def test_invalid_hex_is_rejected(storage: StorageRoot, settings) -> None:
    # The frozen schema types keyColor as hexColor, so a bad value is rejected
    # before processing ever starts.
    with pytest.raises(Exception) as caught:
        run_background(
            storage,
            settings,
            white_artwork(),
            parameters={"mode": "color-to-alpha", "keyColor": "not-a-colour"},
        )
    assert getattr(caught.value, "code", None) == CODE_INVALID_JOB


# --- archived AI mode --------------------------------------------------------

def test_archived_ai_mode_fails_with_an_actionable_error(
    storage: StorageRoot, settings
) -> None:
    """BiRefNet is archived, so an old `ai` job must fail, not load a model."""

    with pytest.raises(UnsupportedParameterError) as caught:
        run_background(
            storage,
            settings,
            white_artwork(),
            parameters={"mode": "ai", "aiModel": "birefnet-massive"},
        )

    assert caught.value.code == CODE_UNSUPPORTED_PARAMETERS
    assert caught.value.details["archived"] == ["ai"]
    assert "color-to-alpha" in caught.value.details["supported"]


# --- none + brush ------------------------------------------------------------

def test_none_mode_reapplies_a_prior_mask_with_brush_ops(storage: StorageRoot, settings) -> None:
    prior = np.full((160, 240), 255, dtype=np.uint8)
    prior[:40, :] = 0
    prior_path = put_image_file(storage, f"{version_path('source')[:-4]}/mask.png", Image.fromarray(prior, "L"))

    _, result = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={
            "mode": "none",
            "maskFromVersionId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            "brushOps": [{"tool": "erase", "radiusPx": 10, "points": [[120, 120]]}],
        },
        input_artifacts={"mask": prior_path},
    )

    assert result["status"] == "succeeded"
    mask = np.asarray(Image.open(storage.resolve(result["outputArtifacts"]["mask"])))
    assert mask[10, 10] == 0       # kept from the prior mask
    assert mask[120, 120] == 0     # erased by the brush
    assert mask[120, 190] == 255   # untouched


def test_mask_mismatch_is_a_stable_error(storage: StorageRoot, settings) -> None:
    wrong = np.full((10, 10), 255, dtype=np.uint8)
    prior_path = put_image_file(storage, f"{version_path('source')[:-4]}/mask.png", Image.fromarray(wrong, "L"))

    with pytest.raises(MaskMismatchError) as caught:
        run_background(
            storage,
            settings,
            white_artwork(),
            parameters={
                "mode": "none",
                "maskFromVersionId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            },
            input_artifacts={"mask": prior_path},
        )
    assert caught.value.code == CODE_MASK_MISMATCH


def test_brush_op_off_canvas_is_reported() -> None:
    mask = Image.new("L", (100, 100), 255)

    warnings = apply_brush_ops(
        mask, [{"tool": "erase", "radiusPx": 5, "points": [[500, 500]]}]
    )

    assert [warning["code"] for warning in warnings] == ["brush-op-off-canvas"]
    assert np.asarray(mask).min() == 255


def test_edge_softness_emits_a_warning(storage: StorageRoot, settings) -> None:
    _, result = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={"mode": "color-to-alpha", "keyColor": "#ffffff", "edgeSoftness": 2},
    )

    assert "mask-edge-softened" in warning_codes(result)

# --- selection shaping -------------------------------------------------------

def _visible_columns(storage, result) -> int:
    mask = np.asarray(
        Image.open(storage.resolve(result["outputArtifacts"]["mask"])).convert("L")
    )
    return int((mask >= 128).sum())


def test_mask_grow_expands_the_selection(storage: StorageRoot, settings) -> None:
    parameters = {"mode": "color-to-alpha", "keyColor": "#ffffff"}
    _, base = run_background(
        storage, settings, white_artwork(), parameters=parameters, name="base"
    )
    _, grown = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={**parameters, "maskGrowPx": 6},
        name="grown",
    )

    assert _visible_columns(storage, grown) > _visible_columns(storage, base)
    assert "mask-selection-offset" in warning_codes(grown)


def test_mask_contract_shrinks_the_selection(storage: StorageRoot, settings) -> None:
    parameters = {"mode": "color-to-alpha", "keyColor": "#ffffff"}
    _, base = run_background(
        storage, settings, white_artwork(), parameters=parameters, name="base"
    )
    _, shrunk = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={**parameters, "maskGrowPx": -4},
        name="shrunk",
    )

    assert _visible_columns(storage, shrunk) < _visible_columns(storage, base)


def test_mask_levels_remap_the_alpha_ramp(storage: StorageRoot, settings) -> None:
    parameters = {
        "mode": "color-to-alpha",
        "keyColor": "#ffffff",
        "maskLevels": {"blackPoint": 0, "whitePoint": 255, "gamma": 2.0},
    }
    _, result = run_background(storage, settings, white_artwork(), parameters=parameters)

    mask = np.asarray(Image.open(storage.resolve(result["outputArtifacts"]["mask"])))
    # The block keeps its near-opaque alpha but the ramp is lifted: a gamma of 2
    # brightens the midtones, so 234 becomes brighter while 0 stays 0.
    assert mask[5, 5] == 0
    assert mask[70, 100] > 234
    assert "mask-levels-applied" in warning_codes(result)


def test_image_levels_change_colour_without_touching_the_mask(
    storage: StorageRoot, settings
) -> None:
    # Colour-to-alpha decontaminates the artwork against the key, which pins a
    # two-tone image to black and white; `none` keeps the source colours, so it is
    # the honest way to test an image-only levels adjustment.
    parameters = {"mode": "none"}
    _, plain = run_background(
        storage, settings, white_artwork(), parameters=parameters, name="plain"
    )
    _, toned = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={
            **parameters,
            "imageLevels": {"blackPoint": 0, "whitePoint": 128, "gamma": 1.0},
        },
        name="toned",
    )

    plain_rgb = np.asarray(Image.open(storage.resolve(plain["outputPath"])).convert("RGB"))
    toned_rgb = np.asarray(Image.open(storage.resolve(toned["outputPath"])).convert("RGB"))
    plain_mask = np.asarray(Image.open(storage.resolve(plain["outputArtifacts"]["mask"])))
    toned_mask = np.asarray(Image.open(storage.resolve(toned["outputArtifacts"]["mask"])))

    # The dark block gets brighter (the white point pulls 128 up to 255)...
    assert toned_rgb[70, 100].min() > plain_rgb[70, 100].min()
    # ...while the selection itself is untouched.
    assert np.array_equal(plain_mask, toned_mask)
    assert "image-levels-applied" in warning_codes(toned)


def test_invalid_levels_are_rejected_before_pixels_are_written(
    storage: StorageRoot, settings
) -> None:
    with pytest.raises(UnsupportedParameterError):
        run_background(
            storage,
            settings,
            white_artwork(),
            parameters={
                "mode": "color-to-alpha",
                "keyColor": "#ffffff",
                "maskLevels": {"blackPoint": 200, "whitePoint": 100},
            },
        )


def test_mask_artifact_is_required_by_the_contract(storage: StorageRoot, settings) -> None:
    # The non-destructive mask is the reviewable artifact, so the frozen schema
    # refuses a background-removal job that does not declare one.
    source = put_image_file(storage, version_path("source"), white_artwork())
    document = job_document(
        "background-removal",
        source,
        output_relative=version_path("cutout"),
        parameters={"mode": "color-to-alpha", "keyColor": "#ffffff"},
    )
    with pytest.raises(Exception) as caught:
        run_processor(background.process, document, settings, storage, make_engines(settings))
    assert getattr(caught.value, "code", None) == CODE_INVALID_JOB
