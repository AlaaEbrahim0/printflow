"""Pipeline: structured failure envelopes, duration stamping, scratch hygiene."""

from __future__ import annotations

import numpy as np
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import CODE_INVALID_JOB, CODE_RESULT_INVALID, WorkerError
from app.pipeline import (
    NIL_JOB_ID,
    failure_envelope,
    process_document,
    sanitize,
    summarize_parameters,
)
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    FakeCommandRunner,
    gray_screenshot,
    job_document,
    make_engines,
    make_executable,
    make_settings,
    put_image_file,
    version_path,
    write_scaled_png,
)


def test_valid_trim_job_returns_a_schema_clean_result(storage: StorageRoot, settings) -> None:
    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document(
        "trim",
        source,
        output_relative=version_path("trimmed"),
        parameters={"mode": "auto", "paddingPx": 4},
    )

    processed = process_document(document, settings, storage=storage)

    assert processed.succeeded
    assert processed.result["status"] == "succeeded"
    assert processed.result["outputPath"] == version_path("trimmed")
    assert isinstance(processed.result["metadata"]["durationMs"], int)
    assert processed.result["metadata"]["durationMs"] >= 0
    assert describe_document(WORKER_RESULT_SCHEMA, processed.result, CONTRACTS_DIR) == []
    assert storage.resolve(processed.result["outputPath"]).is_file()


def test_malformed_job_is_a_structured_failure_not_a_traceback(settings, storage) -> None:
    document = job_document("classify", version_path("source"))
    del document["batchId"]

    processed = process_document(document, settings, storage=storage)

    assert processed.succeeded is False
    error = processed.result["error"]
    assert error["code"] == CODE_INVALID_JOB
    assert error["retryable"] is False
    assert error["details"]["errors"]
    assert describe_document(WORKER_RESULT_SCHEMA, processed.result, CONTRACTS_DIR) == []


def test_unhandled_bug_becomes_a_retryable_internal_error(
    storage: StorageRoot, settings, monkeypatch
) -> None:
    from app.processors import PROCESSORS

    def explode(job, scope):
        raise ValueError("kaboom")

    monkeypatch.setitem(PROCESSORS, "classify", explode)
    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document("classify", source)

    processed = process_document(document, settings, storage=storage)

    assert processed.result["error"]["code"] == "internal-error"
    assert processed.result["error"]["retryable"] is True
    assert "kaboom" in processed.result["error"]["message"]


def test_result_that_breaks_the_contract_is_reported(
    storage: StorageRoot, settings, monkeypatch
) -> None:
    from app.processors import PROCESSORS

    def bad_result(job, scope):
        return {
            "schemaVersion": "1.0",
            "jobId": job.job_id,
            "status": "succeeded",
            "metadata": {"durationMs": 1},
            "outputPath": "../escaped.png",
        }

    monkeypatch.setitem(PROCESSORS, "classify", bad_result)
    source = put_image_file(storage, version_path("source"), gray_screenshot())

    processed = process_document(job_document("classify", source), settings, storage=storage)

    assert processed.result["status"] == "failed"
    assert processed.result["error"]["code"] == CODE_RESULT_INVALID


def test_failure_envelope_without_a_usable_job_id(tmp_path) -> None:
    error = WorkerError("bad input")

    envelope = failure_envelope({"type": "trim"}, error, 12)

    assert envelope["jobId"] == NIL_JOB_ID
    assert envelope["metadata"] == {"durationMs": 12}


def test_engine_name_is_carried_into_failure_metadata() -> None:
    error = WorkerError("no engine", engine="realesrgan-ncnn-vulkan")

    envelope = failure_envelope({"jobId": "abc"}, error, 3)

    assert envelope["metadata"]["engine"] == "realesrgan-ncnn-vulkan"


def test_numpy_values_are_sanitized_before_validation(settings, storage) -> None:
    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document(
        "trim",
        source,
        output_relative=version_path("trimmed"),
        parameters={"mode": "auto", "paddingPx": int(np.int64(3))},
    )

    processed = process_document(document, settings, storage=storage)

    assert describe_document(WORKER_RESULT_SCHEMA, processed.result, CONTRACTS_DIR) == []
    sanitized = sanitize(
        {
            "value": np.float32(1.5),
            "count": np.int64(7),
            "path": storage.resolved_root,
            "array": np.array([1, 2]),
        }
    )
    assert sanitized == {
        "value": 1.5,
        "count": 7,
        "path": str(storage.resolved_root),
        "array": [1, 2],
    }


def test_scratch_files_never_survive_a_job(tmp_path) -> None:
    """An upscale writes engine scratch under jobs/{jobId}; it must be cleaned up."""

    settings = make_settings(
        tmp_path,
        realesrgan_binary=make_executable(tmp_path / "bin" / "realesrgan-ncnn-vulkan"),
        gpu_enabled=True,
    )
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    source = put_image_file(storage, version_path("source"), gray_screenshot(size=(60, 40)))
    document = job_document(
        "upscale",
        source,
        output_relative=version_path("up"),
        parameters={"model": "realesrgan-x4plus", "scale": 2},
    )

    processed = process_document(
        document,
        settings,
        storage=storage,
        engines=make_engines(settings, FakeCommandRunner(writer=write_scaled_png(2))),
    )

    assert processed.succeeded, processed.result
    scratch_dir = storage.resolve(f"{document['batchId']}/jobs/{document['jobId']}")
    assert not scratch_dir.exists() or list(scratch_dir.iterdir()) == []


def test_summarize_parameters_collapses_brush_strokes() -> None:
    summary = summarize_parameters(
        {
            "mode": "color-to-alpha",
            "tolerance": 12,
            "brushOps": [{"tool": "erase"}, {"tool": "restore"}],
            "backgroundSample": {"kind": "gray", "hex": "#808080"},
        }
    )

    assert summary["brushOps"] == {"items": 2}
    assert summary["mode"] == "color-to-alpha"
    assert summary["backgroundSample"]["kind"] == "gray"


def test_contracts_directory_defaults_to_the_repository(settings) -> None:
    processed = process_document({"schemaVersion": "1.0"}, settings, storage=None)
    assert processed.contracts_dir == CONTRACTS_DIR.resolve(strict=False)
    assert processed.result["status"] == "failed"


def test_storage_root_is_used_when_supplied(storage: StorageRoot, settings) -> None:
    source = put_image_file(storage, version_path("source"), gray_screenshot())
    document = job_document(
        "trim", source, output_relative=version_path("trimmed"), parameters={"mode": "auto"}
    )

    processed = process_document(document, settings, storage=storage)

    assert processed.succeeded
    with Image.open(storage.resolve(version_path("trimmed"))) as trimmed:
        assert trimmed.width < 300
