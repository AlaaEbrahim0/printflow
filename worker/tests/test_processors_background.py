"""background-removal: three modes, the mask artifact, and brush strokes."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.context import Engines
from app.engines.birefnet import BirefnetEngine, CutoutResult
from app.errors import (
    CODE_INVALID_JOB,
    CODE_MASK_MISMATCH,
    EngineUnavailableError,
    MaskMismatchError,
)
from app.processors import background
from app.processors.background import apply_brush_ops, unmultiplied_color_to_alpha
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    job_document,
    make_engines,
    make_settings,
    put_image_file,
    run_processor,
    version_path,
)


class FakeCutoutEngine:
    """Returns a fixed alpha without loading a model, so tests stay fast."""

    def __init__(self, alpha: np.ndarray | None = None) -> None:
        self.alpha = alpha
        self.calls: list[dict] = []

    def cutout(self, image: Image.Image, model: str) -> CutoutResult:
        self.calls.append({"model": model, "size": image.size})
        alpha = self.alpha
        if alpha is None:
            alpha = np.full((image.height, image.width), 255, dtype=np.uint8)
        result = image.convert("RGBA")
        result.putalpha(Image.fromarray(alpha, "L"))
        return CutoutResult(image=result, warnings=[], tiles=1, device="cpu")


def warning_codes(result) -> list[str]:
    return [warning["code"] for warning in result["metadata"].get("warnings", [])]


def white_artwork(size: tuple[int, int] = (240, 160)) -> Image.Image:
    image = Image.new("RGB", size, (255, 255, 255))
    image.paste(Image.new("RGB", (80, 60), (20, 20, 20)), (60, 40))
    return image


def run_background(storage, settings, image, *, parameters, engines=None, **kwargs):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "background-removal",
        source,
        output_relative=version_path("cutout"),
        parameters=parameters,
        output_artifacts={"mask": f"{version_path('cutout')[:-4]}/mask.png"},
        **kwargs,
    )
    result = run_processor(
        background.process,
        document,
        settings,
        storage,
        engines=engines or make_engines(settings),
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


# --- AI ----------------------------------------------------------------------

def test_ai_mode_uses_engine_alpha_as_the_mask(storage: StorageRoot, settings) -> None:
    alpha = np.full((160, 240), 255, dtype=np.uint8)
    alpha[:40, :] = 0  # a transparent band
    fake = FakeCutoutEngine(alpha)
    engines = Engines(realesrgan=make_engines(settings).realesrgan, cutout=fake)

    _, result = run_background(
        storage,
        settings,
        white_artwork(),
        parameters={"mode": "ai", "aiModel": "birefnet-massive"},
        engines=engines,
    )

    assert result["status"] == "succeeded"
    assert fake.calls == [{"model": "birefnet-massive", "size": (240, 160)}]
    mask = np.asarray(Image.open(storage.resolve(result["outputArtifacts"]["mask"])))
    assert mask[10, 10] == 0 and mask[120, 120] == 255


def test_ai_mode_fails_when_weights_are_missing(storage: StorageRoot, settings) -> None:
    # The default engine resolves no model under the configured (absent) dir.
    missing = settings.model_copy(update={"cutout_model_dir": settings.storage_root / "nope"})
    with pytest.raises(EngineUnavailableError):
        run_background(
            storage,
            settings,
            white_artwork(),
            parameters={"mode": "ai"},
            engines=Engines(
                realesrgan=make_engines(settings).realesrgan,
                cutout=BirefnetEngine(missing),
            ),
        )


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
