"""refine-mono processor: job plumbing, the gate, and the written file.

These tests go through the same path a real job does — a document validated
against the frozen JSON Schema, a :class:`JobScope`, the processor — so they
catch contract drift that a library-level test cannot.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from app.contracts import validate_result
from app.errors import JobContractError, UnsupportedParameterError
from app.job_models import WorkerJob
from app.mono import MonoConfig, MonoStageError, ThresholdMode
from app.processors import refine_mono
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    job_document,
    make_engines,
    put_image_file,
    run_processor,
    version_path,
)


def text_scan(width: int = 420, height: int = 260) -> Image.Image:
    array = np.full((height, width), 246, dtype=np.uint8)
    for row in range(40, height - 40, 46):
        for column in range(30, width - 30, 34):
            array[row : row + 26, column : column + 20] = 18
            array[row + 10 : row + 13, column : column + 20] = 246
    return Image.fromarray(array, "L").convert("RGB")


def flat_colour_logo(width: int = 300, height: int = 300) -> Image.Image:
    array = np.zeros((height, width, 4), dtype=np.uint8)
    array[40:260, 60:240] = (30, 90, 170, 255)
    array[110:190, 100:200] = (250, 250, 250, 255)
    return Image.fromarray(array, "RGBA")


def photograph(width: int = 320, height: int = 240) -> Image.Image:
    rng = np.random.default_rng(11)
    ramp = np.linspace(0, 255, width)[None, :]
    base = np.repeat(ramp, height, axis=0)
    grey = np.clip(base + rng.normal(0, 18, (height, width)), 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack([grey] * 3, axis=-1), "RGB")


def compressed(image: Image.Image, quality: int = 8) -> Image.Image:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, "JPEG", quality=quality)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


def run_refine(
    storage: StorageRoot,
    settings,
    image: Image.Image,
    parameters: dict | None = None,
    *,
    output_name: str = "final",
):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "refine-mono",
        source,
        output_relative=version_path(output_name),
        parameters=parameters or {},
    )
    result = run_processor(
        refine_mono.process, document, settings, storage, make_engines(settings)
    )
    # Every result must satisfy the frozen contract, whatever the branch.
    validate_result(result, CONTRACTS_DIR)
    return result


def read_output(storage: StorageRoot, name: str = "final") -> Image.Image:
    with Image.open(storage.resolve(version_path(name))) as opened:
        opened.load()
        return opened.copy()


# --- the binarizing path -----------------------------------------------------


def test_text_scan_writes_exactly_two_pixel_states(storage, settings) -> None:
    result = run_refine(storage, settings, text_scan(), {"preset": "text"})

    assert result["status"] == "succeeded"
    mono = result["metadata"]["mono"]
    assert mono["classification"]["kind"] == "mono-ink"
    assert mono["binarized"] is True
    assert "skipped" not in mono
    # The two-state counts must add up to the plate.
    counts = mono["twoState"]
    assert counts["inkPx"] + counts["paperPx"] == (
        result["metadata"]["widthPx"] * result["metadata"]["heightPx"]
    )

    written = read_output(storage)
    array = np.asarray(written)
    assert written.mode == "RGBA"
    # Exactly two RGBA tuples on disk: opaque black ink, transparent paper.
    distinct = np.unique(array.reshape(-1, 4), axis=0)
    assert distinct.tolist() == [[0, 0, 0, 255], [255, 255, 255, 0]]

    # DTF needs transparency, so the packer must see the artwork as occupied.
    occupancy = array[..., 3] > 5
    assert 0.0 < float(occupancy.mean()) < 1.0


def test_the_written_plate_keeps_the_working_dpi(storage, settings) -> None:
    run_refine(storage, settings, text_scan(), {"preset": "text"})

    written = read_output(storage)
    dpi = written.info.get("dpi")
    assert dpi is not None, "physical resolution must survive the stage"
    assert round(dpi[0]) == 300


def test_a_compressed_scan_reports_the_cleanup_it_did(storage, settings) -> None:
    damaged = compressed(text_scan(), quality=8)
    result = run_refine(storage, settings, damaged, {"preset": "text"})

    stages = {trace["stage"]: trace for trace in result["metadata"]["mono"]["stages"]}
    assert stages["denoise"]["changedPx"] > 0, "the ringing was actually smoothed"
    assert stages["validate"]["detail"]["inkPx"] > 0

    array = np.asarray(read_output(storage))
    assert len(np.unique(array.reshape(-1, 4), axis=0)) == 2


# --- the gate ----------------------------------------------------------------


def test_a_photograph_succeeds_and_is_passed_through(storage, settings) -> None:
    """Not a failure: the queue must not show every photo as broken."""

    result = run_refine(storage, settings, photograph())

    assert result["status"] == "succeeded"
    mono = result["metadata"]["mono"]
    assert mono["classification"]["kind"] == "photo"
    assert mono["binarized"] is False
    assert mono["skipped"] is True
    assert mono["stages"] == []

    codes = [warning["code"] for warning in result["metadata"].get("warnings", [])]
    assert "mono-skipped" in codes

    # The pixels are untouched: the file is not two-state and keeps its tones.
    written = np.asarray(read_output(storage))
    assert len(np.unique(written[..., :3])) > 2


def test_a_photo_is_refused_even_with_the_logo_preset(storage, settings) -> None:
    """A preset can narrow the gate, never widen it.

    The classifier's verdict is reported first, so the reason an operator sees is
    always the real one — "these tones are not separable" — rather than a
    confusing "the logo preset does not apply", whatever preset they picked.
    """

    result = run_refine(storage, settings, photograph(), {"preset": "logo"})
    mono = result["metadata"]["mono"]
    assert mono["binarized"] is False
    assert mono["classification"]["kind"] == "photo"
    assert mono["skipped"] is True

    codes = [warning["code"] for warning in result["metadata"].get("warnings", [])]
    assert codes == ["mono-skipped"]
    assert "separability" in result["metadata"]["warnings"][0]["message"]


def test_flat_colour_is_not_binarized_without_consent(storage, settings) -> None:
    result = run_refine(storage, settings, flat_colour_logo(), {"preset": "clean-only"})

    mono = result["metadata"]["mono"]
    assert mono["classification"]["kind"] == "flat-colour"
    assert mono["binarized"] is False

    written = np.asarray(read_output(storage))
    # The colour survived: cleaning must not throw the palette away.
    colours = np.unique(written[..., :3].reshape(-1, 3), axis=0)
    assert len(colours) > 2


def test_flat_colour_is_binarized_when_the_operator_consents(storage, settings) -> None:
    result = run_refine(
        storage,
        settings,
        flat_colour_logo(),
        {"preset": "illustration", "binarizeFlatColour": True},
    )

    mono = result["metadata"]["mono"]
    assert mono["classification"]["kind"] == "flat-colour"
    assert mono["binarized"] is True

    array = np.asarray(read_output(storage))
    assert np.unique(array.reshape(-1, 4), axis=0).tolist() == [
        [0, 0, 0, 255],
        [255, 255, 255, 0],
    ]


def test_a_flat_colour_logo_declines_when_no_preset_fits(storage, settings) -> None:
    """``text`` does not accept flat colour, so nothing is destroyed."""

    result = run_refine(storage, settings, flat_colour_logo(), {"preset": "text"})
    assert result["metadata"]["mono"]["binarized"] is False
    assert result["metadata"]["mono"]["skipped"] is True


def test_clean_only_with_binarize_consent_is_refused() -> None:
    """The two instructions contradict, so neither may be silently dropped.

    ``clean-only`` is defined by keeping the colours; consenting to binarize in
    the same job asks for the opposite. Honouring either one would override
    something the operator explicitly said, so the job fails with a message that
    names both. The schema cannot express this (it is a cross-field rule), so the
    processor is the layer that enforces it.
    """

    job = WorkerJob.from_document(
        {
            "schemaVersion": "1.0",
            "jobId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "type": "refine-mono",
            "batchId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "designId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "inputPath": version_path("source"),
            "outputPath": version_path("final"),
            "parameters": {"preset": "clean-only", "binarizeFlatColour": True},
            "context": {"workingDpi": 300},
        }
    )

    with pytest.raises(UnsupportedParameterError) as caught:
        refine_mono.process(job, scope=None)  # refused before any pixel is read

    assert "clean-only" in str(caught.value)
    assert "binarizeFlatColour" in str(caught.value)


# --- parameters --------------------------------------------------------------


def test_parameters_override_the_preset(storage, settings) -> None:
    result = run_refine(
        storage,
        settings,
        text_scan(),
        {"preset": "text", "thresholdMode": "fixed", "fixedThreshold": 100},
    )

    binarize = next(
        trace
        for trace in result["metadata"]["mono"]["stages"]
        if trace["stage"] == "binarize"
    )
    assert binarize["detail"]["mode"] == "fixed"
    assert binarize["detail"]["threshold"] == 100


def test_a_preset_can_be_tuned_per_job(storage, settings) -> None:
    result = run_refine(
        storage, settings, text_scan(), {"preset": "text", "despeckleMaxPx": 0}
    )
    despeckle = next(
        trace
        for trace in result["metadata"]["mono"]["stages"]
        if trace["stage"] == "despeckle"
    )
    assert despeckle["detail"]["maxPx"] == 0


def test_the_schema_rejects_an_unknown_parameter_first(storage, settings) -> None:
    """Layer one: the frozen contract refuses parameters it does not define."""

    with pytest.raises(JobContractError) as excinfo:
        run_refine(storage, settings, text_scan(), {"sharpen": 3})
    assert "worker-job.schema.json" in str(excinfo.value)


def test_the_processor_also_rejects_an_unknown_parameter() -> None:
    """Layer two: a job that never went through the schema still cannot sneak one in.

    The processor re-checks because :class:`WorkerJob` is constructible from any
    mapping, and a silently ignored parameter is worse than a refused one.
    """

    job = WorkerJob.from_document(
        {
            "schemaVersion": "1.0",
            "jobId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "type": "refine-mono",
            "batchId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "designId": "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab",
            "inputPath": version_path("source"),
            "outputPath": version_path("final"),
            "parameters": {"sharpen": 3},
            "context": {"workingDpi": 300},
        }
    )
    with pytest.raises(UnsupportedParameterError) as excinfo:
        refine_mono._reject_unknown_parameters(job)
    assert excinfo.value.details["unknown"] == ["sharpen"]


def test_an_unknown_preset_is_refused(storage, settings) -> None:
    with pytest.raises(JobContractError):
        run_refine(storage, settings, text_scan(), {"preset": "posterize"})


def test_an_out_of_range_parameter_is_refused_by_the_config() -> None:
    """The schema's enum is layer one; ``MonoConfig`` is layer two.

    ``denoise_kernel`` is validated in ``__post_init__``, so a value that slipped
    past a contract (a future caller, a stored job) still fails with the
    parameter named rather than producing a strange plate.
    """

    with pytest.raises(MonoStageError) as excinfo:
        MonoConfig(denoise_kernel=4)
    assert "denoiseKernel" in str(excinfo.value)


def test_an_unknown_threshold_mode_lists_the_alternatives() -> None:
    with pytest.raises(UnsupportedParameterError) as excinfo:
        refine_mono._enum(ThresholdMode, "sauvola", "thresholdMode")
    assert excinfo.value.details["supported"] == ["otsu", "adaptive", "fixed"]
