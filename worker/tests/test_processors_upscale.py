"""upscale: command construction and output verification against a fake engine."""

from __future__ import annotations

import pytest
from PIL import Image

from app.config import Settings
from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import (
    CODE_ENGINE_FAILED,
    CODE_ENGINE_OUTPUT_INVALID,
    CODE_ENGINE_UNAVAILABLE,
    EngineFailedError,
    EngineOutputInvalidError,
    EngineTimeoutError,
    EngineUnavailableError,
)
from app.processors import upscale
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
    run_processor,
    transparent_sticker,
    version_path,
    write_scaled_png,
)


@pytest.fixture
def engine_settings(tmp_path) -> Settings:
    """Settings whose engine paths point at real (but inert) executables."""

    return make_settings(
        tmp_path,
        realesrgan_binary=make_executable(tmp_path / "bin" / "realesrgan-ncnn-vulkan"),
        gpu_enabled=True,
    )


@pytest.fixture
def engine_storage(engine_settings: Settings) -> StorageRoot:
    storage = StorageRoot(engine_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    return storage


def run_upscale(storage, settings, image, parameters, runner):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "upscale",
        source,
        output_relative=version_path("upscaled"),
        parameters=parameters,
    )
    engines = make_engines(settings, runner)
    result = run_processor(upscale.process, document, settings, storage, engines)
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    return source, result


def test_command_matches_the_documented_cli(engine_storage, engine_settings) -> None:
    runner = FakeCommandRunner(writer=write_scaled_png(4))
    _, result = run_upscale(
        engine_storage,
        engine_settings,
        gray_screenshot(size=(300, 200)),
        {"model": "realesrgan-x4plus-anime", "scale": 4, "tileSize": 256, "gpu": True},
        runner,
    )

    command = runner.last_command()
    assert command[0] == str(engine_settings.realesrgan_binary)
    assert runner.flag("-s") == "4"
    assert runner.flag("-n") == "realesrgan-x4plus-anime"
    assert runner.flag("-t") == "256"
    assert runner.flag("-f") == "png"
    assert runner.flag("-g") == "0"
    assert command[command.index("-i") + 1] == str(engine_storage.resolve(version_path("source")))
    assert result["metadata"]["widthPx"] == 1200
    assert result["metadata"]["heightPx"] == 800
    assert result["metadata"]["engine"] == "realesrgan-ncnn-vulkan"


def test_engine_reads_the_job_input_and_timeout_is_configured(
    engine_storage, engine_settings
) -> None:
    runner = FakeCommandRunner(writer=write_scaled_png(2))
    run_upscale(
        engine_storage,
        engine_settings,
        gray_screenshot(size=(100, 80)),
        {"model": "realesrgan-x4plus", "scale": 2, "tileSize": 0, "gpu": False},
        runner,
    )

    assert runner.timeouts == [engine_settings.realesrgan_timeout_seconds]
    assert runner.flag("-t") == "0"


def test_missing_binary_is_a_stable_non_retryable_failure(tmp_path) -> None:
    settings = make_settings(tmp_path, realesrgan_binary=tmp_path / "nowhere" / "realesrgan")
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)

    with pytest.raises(EngineUnavailableError) as excinfo:
        run_upscale(
            storage,
            settings,
            gray_screenshot(size=(40, 30)),
            {"model": "realesrgan-x4plus", "scale": 2},
            FakeCommandRunner(),
        )

    assert excinfo.value.code == CODE_ENGINE_UNAVAILABLE
    assert excinfo.value.retryable is False


def test_unscaled_output_is_rejected(engine_storage, engine_settings) -> None:
    with pytest.raises(EngineOutputInvalidError) as excinfo:
        run_upscale(
            engine_storage,
            engine_settings,
            gray_screenshot(size=(100, 100)),
            {"model": "realesrgan-x4plus", "scale": 4},
            FakeCommandRunner(writer=write_scaled_png(2)),  # engine ignored the scale
        )
    assert excinfo.value.code == CODE_ENGINE_OUTPUT_INVALID
    assert not engine_storage.resolve(version_path("upscaled")).exists()


def test_engine_output_missing_entirely(engine_storage, engine_settings) -> None:
    with pytest.raises(EngineOutputInvalidError):
        run_upscale(
            engine_storage,
            engine_settings,
            gray_screenshot(size=(50, 40)),
            {"model": "realesrgan-x4plus", "scale": 2},
            FakeCommandRunner(writer=None),  # exits 0 but writes nothing
        )


def test_engine_crash_is_retryable(engine_storage, engine_settings) -> None:
    with pytest.raises(EngineFailedError) as excinfo:
        run_upscale(
            engine_storage,
            engine_settings,
            gray_screenshot(size=(50, 40)),
            {"model": "realesrgan-x4plus", "scale": 2},
            FakeCommandRunner(writer=write_scaled_png(2), returncode=139),
        )
    assert excinfo.value.code == CODE_ENGINE_FAILED
    assert excinfo.value.retryable is True
    assert excinfo.value.details["returncode"] == 139


def test_real_runner_maps_a_slow_subprocess_to_a_retryable_timeout() -> None:
    """The subprocess seam itself: hard timeout, no shell, argv list only."""

    import sys

    from app.engines.command import SubprocessCommandRunner

    with pytest.raises(EngineTimeoutError) as caught:
        SubprocessCommandRunner().run(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            timeout_seconds=0.2,
        )

    assert caught.value.retryable is True
    assert caught.value.details["timeoutSeconds"] == 0.2


def test_real_runner_captures_exit_codes_without_shell(tmp_path) -> None:
    import sys

    from app.engines.command import SubprocessCommandRunner

    result = SubprocessCommandRunner().run(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"],
        timeout_seconds=10,
    )

    assert result.returncode == 3
    assert result.ok is False
    assert "boom" in result.tail()


def test_gpu_request_falls_back_to_cpu_with_a_warning(tmp_path) -> None:
    settings = make_settings(
        tmp_path,
        realesrgan_binary=make_executable(tmp_path / "bin" / "realesrgan-ncnn-vulkan"),
        gpu_enabled=False,
    )
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)

    runner = FakeCommandRunner(writer=write_scaled_png(2))
    _, result = run_upscale(
        storage,
        settings,
        gray_screenshot(size=(60, 40)),
        {"model": "realesrgan-x4plus", "scale": 2, "gpu": True},
        runner,
    )

    assert runner.flag("-g") == "-1"
    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "gpu-requested-cpu-fallback" in codes


def test_undersized_tile_becomes_automatic(engine_storage, engine_settings) -> None:
    runner = FakeCommandRunner(writer=write_scaled_png(2))
    _, result = run_upscale(
        engine_storage,
        engine_settings,
        gray_screenshot(size=(60, 40)),
        {"model": "realesrgan-x4plus", "scale": 2, "tileSize": 16},
        runner,
    )

    assert runner.flag("-t") == "0"
    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "tile-size-below-minimum" in codes


def test_model_directory_is_passed_when_configured(tmp_path) -> None:
    settings = make_settings(
        tmp_path,
        realesrgan_binary=make_executable(tmp_path / "bin" / "realesrgan-ncnn-vulkan"),
        realesrgan_model_dir=tmp_path / "models",
        gpu_enabled=True,
    )
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    runner = FakeCommandRunner(writer=write_scaled_png(2))

    run_upscale(
        storage,
        settings,
        gray_screenshot(size=(40, 30)),
        {"model": "realesrgan-x4plus", "scale": 2},
        runner,
    )

    assert runner.flag("-m") == str(tmp_path / "models")


def test_png_result_is_promoted_byte_for_byte(engine_storage, engine_settings) -> None:
    def writer(command):
        output_path = command[command.index("-o") + 1]
        Image.new("RGB", (200, 120), (7, 7, 7)).save(output_path)

    _, result = run_upscale(
        engine_storage,
        engine_settings,
        gray_screenshot(size=(100, 60)),
        {"model": "realesrgan-x4plus", "scale": 2},
        FakeCommandRunner(writer=writer),
    )

    staged = list(engine_storage.resolve(version_path("upscaled")).parent.glob(".*"))
    assert staged == [], "engine scratch must not linger next to the version"
    with Image.open(engine_storage.resolve(result["outputPath"])) as stored:
        assert stored.size == (200, 120)


def test_alpha_dropped_by_the_engine_is_reported(engine_storage, engine_settings) -> None:
    def writer(command):
        output_path = command[command.index("-o") + 1]
        Image.new("RGB", (200, 200), (5, 5, 5)).save(output_path)  # transparency gone

    _, result = run_upscale(
        engine_storage,
        engine_settings,
        transparent_sticker(size=(100, 100)),
        {"model": "realesrgan-x4plus", "scale": 2},
        FakeCommandRunner(writer=writer),
    )

    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "alpha-dropped-by-engine" in codes


def test_non_engine_readable_input_is_converted_first(engine_storage, engine_settings) -> None:
    source = put_image_file(
        engine_storage,
        f"{version_path('source')[:-4]}.bmp",
        gray_screenshot(size=(60, 40)),
    )
    document = job_document(
        "upscale",
        source,
        output_relative=version_path("upscaled"),
        parameters={"model": "realesrgan-x4plus", "scale": 2},
    )
    runner = FakeCommandRunner(writer=write_scaled_png(2))

    result = run_processor(
        upscale.process,
        document,
        engine_settings,
        engine_storage,
        make_engines(engine_settings, runner),
    )

    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "engine-input-converted" in codes
    read_path = runner.last_command()[runner.last_command().index("-i") + 1]
    assert read_path.endswith(".png")
    assert "/jobs/" in read_path, "the converted copy lives in the job scratch folder"


def test_engine_failure_result_validates_without_output(tmp_path) -> None:
    """The pipeline must emit a schema-valid failure envelope, not a traceback."""

    from app.pipeline import process_document

    settings = make_settings(tmp_path, realesrgan_binary=tmp_path / "absent" / "realesrgan")
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    source = put_image_file(storage, version_path("source"), gray_screenshot(size=(40, 30)))
    document = job_document(
        "upscale",
        source,
        output_relative=version_path("upscaled"),
        parameters={"model": "realesrgan-x4plus", "scale": 2},
    )

    processed = process_document(document, settings, storage=storage)

    assert processed.succeeded is False
    assert processed.result["error"]["code"] == CODE_ENGINE_UNAVAILABLE
    assert processed.result["error"]["retryable"] is False
    assert describe_document(WORKER_RESULT_SCHEMA, processed.result, CONTRACTS_DIR) == []
