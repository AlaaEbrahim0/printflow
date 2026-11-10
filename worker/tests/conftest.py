"""Shared fixtures: synthetic images, storage roots and fake engines.

No binary files are committed and nothing here needs a GPU, a network, or the
real ``realesrgan-ncnn-vulkan``. External engines are replaced by fakes at their
own seams, so tests exercise command construction and output verification
rather than the tools themselves.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.context import Engines, JobScope, default_engines
from app.contracts import validate_job
from app.engines.birefnet import BirefnetEngine
from app.engines.command import CommandResult, CommandRunner
from app.engines.realesrgan import RealesrganEngine
from app.job_models import WorkerJob
from app.storage import StorageRoot

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = REPO_ROOT / "contracts" / "jsonschema"

BATCH_ID = "0b6e1f3a-1b2c-4d5e-8f90-1234567890ab"
DESIGN_ID = "11111111-1111-4111-8111-111111111111"


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "storage_root": tmp_path / "storage",
        "contracts_dir": CONTRACTS_DIR,
        "worker_id": "test-worker",
        "gpu_enabled": False,
        "log_level": "CRITICAL",
        "realesrgan_binary": tmp_path / "bin" / "realesrgan-ncnn-vulkan",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def storage(settings: Settings) -> StorageRoot:
    root = StorageRoot(settings.storage_root)
    root.resolved_root.mkdir(parents=True, exist_ok=True)
    return root


def version_path(name: str) -> str:
    return f"{BATCH_ID}/designs/{DESIGN_ID}/versions/{name}.png"


def put_image_file(storage: StorageRoot, relative: str, image: Image.Image) -> str:
    absolute = storage.resolve(relative)
    absolute.parent.mkdir(parents=True, exist_ok=True)
    image.save(absolute)
    return relative


def put_text_file(storage: StorageRoot, relative: str, text: str) -> str:
    absolute = storage.resolve(relative)
    absolute.parent.mkdir(parents=True, exist_ok=True)
    absolute.write_text(text, encoding="utf-8")
    return relative


# --- synthetic images --------------------------------------------------------
def gray_screenshot(size: tuple[int, int] = (300, 200), margin: int = 40) -> Image.Image:
    """A screenshot: uniform gray background with a dark flat rectangle."""

    array = np.full((size[1], size[0], 3), 184, dtype=np.uint8)
    array[margin : size[1] - margin, margin : size[0] - margin] = (30, 30, 30)
    return Image.fromarray(array, "RGB")


def transparent_sticker(size: tuple[int, int] = (120, 120)) -> Image.Image:
    """Transparent canvas with an opaque red disc in the middle."""

    center = (size[0] // 2, size[1] // 2)
    radius = min(size) // 4
    yy, xx = np.ogrid[: size[1], : size[0]]
    inside = (xx - center[0]) ** 2 + (yy - center[1]) ** 2 <= radius**2
    array = np.zeros((size[1], size[0], 4), dtype=np.uint8)
    array[..., :3] = (200, 30, 30)
    array[..., 3] = np.where(inside, 255, 0)
    return Image.fromarray(array, "RGBA")


def full_bleed_noise(size: tuple[int, int] = (120, 120), seed: int = 7) -> Image.Image:
    """Random content everywhere, so every border strip is non-uniform."""

    rng = np.random.default_rng(seed)
    array = rng.integers(0, 256, size=(size[1], size[0], 3), dtype=np.uint8)
    return Image.fromarray(array, "RGB")


def horizontal_gradient(width: int = 64, height: int = 8) -> Image.Image:
    """A black-keyed ramp that spans the full 0..255 range."""

    ramp = np.rint(np.linspace(0, 255, width)).astype(np.uint8)
    array = np.stack([np.tile(ramp, (height, 1))] * 3, axis=-1)
    return Image.fromarray(array, "RGB")


def vertical_gradient(width: int = 32, height: int = 32) -> Image.Image:
    ramp = np.repeat(
        np.linspace(0, 255, height, dtype=np.uint8)[:, None], width, axis=1
    )
    array = np.stack([ramp, ramp, ramp], axis=-1)
    return Image.fromarray(array, "RGB")


# --- job documents -----------------------------------------------------------
def job_document(
    job_type: str,
    input_relative: str,
    *,
    output_relative: str | None = None,
    parameters: Mapping[str, Any] | None = None,
    input_artifacts: Mapping[str, str] | None = None,
    output_artifacts: Mapping[str, str] | None = None,
    context: Mapping[str, Any] | None = None,
    job_id: str | None = None,
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "schemaVersion": "1.0",
        "jobId": job_id or str(uuid.uuid4()),
        "type": job_type,
        "batchId": BATCH_ID,
        "designId": DESIGN_ID,
        "inputPath": input_relative,
        "parameters": dict(parameters or {}),
        "context": dict(
            context
            or {
                "workingDpi": 300,
                "targetWidthCm": 20,
                "targetHeightCm": 15,
                "garmentColor": {"kind": "light"},
            }
        ),
    }
    if output_relative is not None:
        document["outputPath"] = output_relative
    if input_artifacts is not None:
        document["inputArtifacts"] = dict(input_artifacts)
    if output_artifacts is not None:
        document["outputArtifacts"] = dict(output_artifacts)
    return document


@pytest.fixture
def make_job() -> Callable[..., dict[str, Any]]:
    return job_document


@pytest.fixture
def example_dir() -> Path:
    return REPO_ROOT / "contracts" / "examples"


# --- fake engines ------------------------------------------------------------
class FakeCommandRunner:
    """Records argv and fabricates whatever output file the real tool would write."""

    def __init__(
        self,
        writer: Callable[[list[str]], None] | None = None,
        returncode: int = 0,
    ) -> None:
        self.writer = writer
        self.returncode = returncode
        self.commands: list[list[str]] = []
        self.timeouts: list[float] = []

    def run(self, argv, *, timeout_seconds: float) -> CommandResult:  # noqa: ANN001
        command = [str(part) for part in argv]
        self.commands.append(command)
        self.timeouts.append(timeout_seconds)
        if self.writer is not None:
            self.writer(command)
        stderr = "fake engine" if self.returncode else ""
        return CommandResult(returncode=self.returncode, stderr=stderr)

    def last_command(self) -> list[str]:
        assert self.commands, "the engine never invoked a command"
        return self.commands[-1]

    def flag(self, name: str) -> str | None:
        command = self.last_command()
        if name in command:
            index = command.index(name)
            if index + 1 < len(command):
                return command[index + 1]
        return None


def write_scaled_png(factor: int) -> Callable[[list[str]], None]:
    """Runner handler: write an output PNG at ``factor`` times the input size."""

    def handler(command: list[str]) -> None:
        input_path = Path(command[command.index("-i") + 1])
        output_path = Path(command[command.index("-o") + 1])
        with Image.open(input_path) as opened:
            width, height = opened.size
        target = (width * factor, height * factor)
        array = np.zeros((target[1], target[0], 3), dtype=np.uint8)
        array[..., 0] = 10
        Image.fromarray(array, "RGB").save(output_path)

    return handler


def make_engines(
    settings: Settings,
    runner: CommandRunner | None = None,
) -> Engines:
    resolved = runner or FakeCommandRunner()
    return Engines(
        realesrgan=RealesrganEngine(settings, resolved),
        cutout=BirefnetEngine(settings),
    )


@pytest.fixture
def engines_factory(tmp_path: Path):
    def build(runner: CommandRunner | None = None, **kwargs: Any) -> Engines:
        return make_engines(make_settings(tmp_path), runner, **kwargs)

    return build


def make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def alpha_of(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("RGBA").getchannel("A"), dtype=np.uint8)


def build_scope(
    document: dict[str, Any],
    settings: Settings,
    storage: StorageRoot,
    engines: Engines | None = None,
) -> JobScope:
    """Validate a job document and assemble the processor environment around it."""

    validated = validate_job(document, CONTRACTS_DIR)
    return JobScope(
        job=WorkerJob.from_document(validated),
        settings=settings,
        storage=storage,
        engines=engines or default_engines(settings),
        contracts_dir=CONTRACTS_DIR,
    )


@pytest.fixture
def scope_factory(settings: Settings, storage: StorageRoot):
    def build(document: dict[str, Any], engines: Engines | None = None) -> JobScope:
        return build_scope(document, settings, storage, engines)

    return build


def run_processor(processor, document, settings, storage, engines=None):
    """Call a processor with a validated scope and return its result envelope."""

    scope = build_scope(document, settings, storage, engines)
    return processor(scope.job, scope)
