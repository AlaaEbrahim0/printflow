"""vectorize: potrace/vtracer adapters, SVG artifacts and raster previews."""

from __future__ import annotations

import numpy as np
import pytest
from PIL import Image

from app.contracts import WORKER_RESULT_SCHEMA, describe_document
from app.errors import (
    CODE_ENGINE_MODE_UNSUPPORTED,
    CODE_ENGINE_UNAVAILABLE,
    CODE_SVG_RASTERIZER_UNAVAILABLE,
    EngineModeUnsupportedError,
    EngineOutputInvalidError,
    EngineUnavailableError,
    WorkerError,
)
from app.processors import vectorize
from app.storage import StorageRoot
from tests.conftest import (
    CONTRACTS_DIR,
    MINIMAL_SVG,
    FakeCommandRunner,
    FakeRasterizer,
    gray_screenshot,
    job_document,
    make_engines,
    make_executable,
    make_settings,
    put_image_file,
    run_processor,
    version_path,
    write_pgm,
    write_svg,
)


def rgba_array(path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGBA"))


def potrace_writer(svg: str = MINIMAL_SVG, luminance: int = 200):
    """Fake engine: SVG for the tracing call, PGM for the preview call."""

    def handler(command: list[str]) -> None:
        if "svg" in command:
            write_svg(svg)(command)
        else:
            write_pgm(luminance)(command)

    return handler


def run_vectorize(
    storage, settings, image, parameters, runner=None, engines=None, context=None
):
    source = put_image_file(storage, version_path("source"), image)
    document = job_document(
        "vectorize",
        source,
        output_relative=version_path("vector"),
        parameters=parameters,
        output_artifacts={
            "svg": version_path("vector").replace(".png", "/vector.svg")
        },
        context=context,
    )
    engines = engines or make_engines(settings, runner or FakeCommandRunner())
    result = run_processor(vectorize.process, document, settings, storage, engines)
    return source, result


def assert_valid(result) -> None:
    assert describe_document(WORKER_RESULT_SCHEMA, result, CONTRACTS_DIR) == []
    assert result["status"] == "succeeded"


@pytest.fixture
def potrace_settings(tmp_path):
    return make_settings(
        tmp_path,
        potrace_binary=make_executable(tmp_path / "bin" / "potrace"),
    )


@pytest.fixture
def potrace_storage(potrace_settings):
    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    return storage


def test_potrace_svg_command_uses_documented_flags(potrace_storage, potrace_settings) -> None:
    runner = FakeCommandRunner(writer=potrace_writer())

    run_vectorize(
        potrace_storage,
        potrace_settings,
        gray_screenshot(size=(120, 80)),
        {"engine": "potrace", "mode": "binary", "threshold": 100, "turdsize": 3},
        runner=runner,
    )

    svg_command = next(command for command in runner.commands if "svg" in command)
    assert svg_command[0] == str(potrace_settings.potrace_binary)
    assert svg_command[svg_command.index("-b") + 1] == "svg"
    assert svg_command[svg_command.index("-r") + 1] == "300"  # context.workingDpi
    assert svg_command[svg_command.index("-k") + 1] == "0.392157"  # 100/255
    assert svg_command[svg_command.index("-t") + 1] == "3"
    assert svg_command[-1].endswith(".pgm"), "potrace reads a bitmap, not a PNG"


def test_potrace_inverts_for_dark_garments(potrace_storage, potrace_settings) -> None:
    runner = FakeCommandRunner(writer=potrace_writer())

    run_vectorize(
        potrace_storage,
        potrace_settings,
        gray_screenshot(size=(100, 60)),
        {"engine": "potrace", "mode": "binary"},
        runner=runner,
        context={"workingDpi": 300, "garmentColor": {"kind": "dark"}},
    )

    svg_command = next(command for command in runner.commands if "-b" in command)
    assert "-i" in svg_command
    assert svg_command.index("-i") > svg_command.index("-b")


def test_potrace_produces_svg_and_rgba_preview(potrace_storage, potrace_settings) -> None:
    runner = FakeCommandRunner(writer=potrace_writer(luminance=40))

    _, result = run_vectorize(
        potrace_storage,
        potrace_settings,
        gray_screenshot(size=(100, 60)),
        {"engine": "potrace", "mode": "binary", "threshold": 128},
        runner=runner,
    )

    assert_valid(result)
    svg_relative = result["outputArtifacts"]["svg"]
    assert svg_relative.endswith("vector.svg")
    assert b"<svg" in potrace_storage.resolve(svg_relative).read_bytes()
    preview = Image.open(potrace_storage.resolve(result["outputPath"]))
    assert preview.mode == "RGBA"
    assert result["metadata"]["engine"] == "potrace"


def test_potrace_preview_is_a_transparent_ink_raster(potrace_storage, potrace_settings) -> None:
    # PGM paper (255) becomes fully transparent; traced ink (0) becomes opaque.
    runner = FakeCommandRunner(writer=potrace_writer(luminance=255))

    _, result = run_vectorize(
        potrace_storage,
        potrace_settings,
        gray_screenshot(size=(80, 60)),
        {"engine": "potrace", "mode": "binary"},
        runner=runner,
    )

    preview = rgba_array(potrace_storage.resolve(result["outputPath"]))
    assert preview[0, 0, 3] == 0, "outside the traced area is transparent"
    assert preview[20, 30, 3] == 255, "traced ink is fully opaque"
    assert preview[20, 30, :3].tolist() == [0, 0, 0], "potrace traces as black ink"


def test_potrace_colour_mode_is_refused_with_a_stable_code(
    potrace_storage, potrace_settings
) -> None:
    with pytest.raises(EngineModeUnsupportedError) as excinfo:
        run_vectorize(
            potrace_storage,
            potrace_settings,
            gray_screenshot(size=(60, 40)),
            {"engine": "potrace", "mode": "color", "colorCount": 8},
            runner=FakeCommandRunner(writer=potrace_writer()),
        )
    assert excinfo.value.code == CODE_ENGINE_MODE_UNSUPPORTED
    assert excinfo.value.retryable is False
    assert excinfo.value.details["suggest"] == "vtracer"


def test_potrace_binary_missing_is_engine_unavailable(tmp_path) -> None:
    settings = make_settings(tmp_path, potrace_binary=tmp_path / "absent" / "potrace")
    storage = StorageRoot(settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)

    with pytest.raises(EngineUnavailableError) as excinfo:
        run_vectorize(
            storage,
            settings,
            gray_screenshot(size=(60, 40)),
            {"engine": "potrace", "mode": "binary"},
            runner=FakeCommandRunner(writer=potrace_writer()),
        )
    assert excinfo.value.code == CODE_ENGINE_UNAVAILABLE


def test_potrace_empty_svg_output_is_rejected(potrace_storage, potrace_settings) -> None:
    with pytest.raises(EngineOutputInvalidError):
        run_vectorize(
            potrace_storage,
            potrace_settings,
            gray_screenshot(size=(60, 40)),
            {"engine": "potrace", "mode": "binary"},
            runner=FakeCommandRunner(writer=None),
        )


def test_vtracer_arguments_are_mapped(potrace_settings) -> None:
    from tests.conftest import fake_vtracer_module

    module = fake_vtracer_module(MINIMAL_SVG)
    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    engines = make_engines(
        potrace_settings,
        FakeCommandRunner(),
        vtracer_module=module,
        rasterizer=FakeRasterizer(),
    )

    _, result = run_vectorize(
        storage,
        potrace_settings,
        gray_screenshot(size=(120, 90)),
        {"engine": "vtracer", "mode": "color", "colorCount": 16, "turdsize": 5},
        engines=engines,
    )

    call = module.calls[-1]
    assert call["colormode"] == "color"
    assert call["filter_speckle"] == 5
    assert call["color_precision"] == 4  # ceil(log2(16))
    assert call["image"].endswith(".png")
    assert_valid(result)
    assert result["metadata"]["engine"] == "vtracer"
    codes = [warning["code"] for warning in result["metadata"]["warnings"]]
    assert "color-count-approximated" in codes


def test_vtracer_binary_mode_thresholds_the_input_itself(potrace_settings) -> None:
    from tests.conftest import fake_vtracer_module

    module = fake_vtracer_module(MINIMAL_SVG)
    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    engines = make_engines(
        potrace_settings,
        FakeCommandRunner(),
        vtracer_module=module,
        rasterizer=FakeRasterizer(),
    )

    run_vectorize(
        storage,
        potrace_settings,
        gray_screenshot(size=(64, 48)),
        {"engine": "vtracer", "mode": "binary", "threshold": 200},
        engines=engines,
    )

    fed = Image.open(module.calls[-1]["image"])
    values = set(np.asarray(fed.convert("L")).ravel().tolist())
    assert values <= {0, 255}, "the requested threshold is applied before tracing"


def test_vtracer_without_the_package_is_engine_unavailable(potrace_settings) -> None:
    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    engines = make_engines(potrace_settings, FakeCommandRunner(), vtracer_module=None)

    with pytest.raises(EngineUnavailableError):
        run_vectorize(
            storage,
            potrace_settings,
            gray_screenshot(size=(60, 40)),
            {"engine": "vtracer", "mode": "binary"},
            engines=engines,
        )


def test_vtracer_preview_uses_the_injected_rasterizer(potrace_settings) -> None:
    from tests.conftest import fake_vtracer_module

    rasterizer = FakeRasterizer(colour=(255, 0, 0, 255))
    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    engines = make_engines(
        potrace_settings,
        FakeCommandRunner(),
        vtracer_module=fake_vtracer_module(MINIMAL_SVG),
        rasterizer=rasterizer,
    )

    _, result = run_vectorize(
        storage,
        potrace_settings,
        gray_screenshot(size=(300, 200)),
        {"engine": "vtracer", "mode": "color", "targetWidthPx": 600, "targetHeightPx": 600},
        engines=engines,
    )

    assert rasterizer.requests == [(600, 400)], "contain box, aspect preserved"
    assert result["metadata"]["widthPx"] == 600
    assert result["metadata"]["heightPx"] == 600
    preview = rgba_array(storage.resolve(result["outputPath"]))
    assert preview[0, 0, 3] == 0, "letterboxing is transparent, not stretched"
    assert preview[300, 300, :3].tolist() == [255, 0, 0]


def test_no_rasterizer_fails_stably(potrace_settings) -> None:
    from tests.conftest import fake_vtracer_module

    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    engines = make_engines(
        potrace_settings,
        FakeCommandRunner(),
        vtracer_module=fake_vtracer_module(MINIMAL_SVG),
        no_rasterizer=True,
    )

    with pytest.raises(WorkerError) as excinfo:
        run_vectorize(
            storage,
            potrace_settings,
            gray_screenshot(size=(60, 40)),
            {"engine": "vtracer", "mode": "binary"},
            engines=engines,
        )
    assert excinfo.value.code == CODE_SVG_RASTERIZER_UNAVAILABLE
    assert excinfo.value.retryable is False


def test_vectorize_requires_an_svg_artifact_slot(potrace_settings) -> None:
    from app.errors import JobContractError

    storage = StorageRoot(potrace_settings.storage_root)
    storage.resolved_root.mkdir(parents=True, exist_ok=True)
    source = put_image_file(storage, version_path("source"), gray_screenshot(size=(60, 40)))
    document = job_document(
        "vectorize",
        source,
        output_relative=version_path("vector"),
        parameters={"engine": "potrace", "mode": "binary"},
    )

    with pytest.raises(JobContractError):
        run_processor(
            vectorize.process, document, potrace_settings, storage, make_engines(potrace_settings)
        )
