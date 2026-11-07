"""What a processor is handed: the validated job, settings, storage, engines.

:class:`JobScope` is the only seam between the processing code and the outside
world. It owns three safety properties the product rules depend on:

* every read goes through :class:`app.storage.StorageRoot`, which validates the
  relative path *before* touching the filesystem;
* the job's own input paths are registered as protected, so no processor can
  overwrite an input, a mask or the original upload;
* scratch files live under ``{batchId}/jobs/{jobId}/`` only and are removed when
  the job ends, success or failure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.engines.command import CommandRunner, SubprocessCommandRunner
from app.engines.cutout import AiCutoutEngine
from app.engines.potrace import PotraceEngine
from app.engines.raster import SvgRasterizer, detect_rasterizer
from app.engines.realesrgan import RealesrganEngine
from app.engines.vtracer import VtracerEngine
from app.errors import MissingInputArtifactError
from app.imaging import (
    image_has_alpha,
    load_image,
    make_warning,
    normalize_source_mode,
    save_image,
)
from app.job_models import WorkerJob
from app.storage import StorageRoot


@dataclass
class Engines:
    """Injectable engine bundle. ``rasterizer`` is resolved lazily and cached."""

    realesrgan: RealesrganEngine
    potrace: PotraceEngine
    vtracer: VtracerEngine
    ai_cutout: AiCutoutEngine
    _rasterizer: SvgRasterizer | None = None
    _rasterizer_resolved: bool = False

    @property
    def rasterizer(self) -> SvgRasterizer | None:
        return self._rasterizer

    def resolve_rasterizer(self, settings: Settings) -> SvgRasterizer | None:
        if not self._rasterizer_resolved:
            self._rasterizer = detect_rasterizer(settings)
            self._rasterizer_resolved = True
        return self._rasterizer


def default_engines(settings: Settings, runner: CommandRunner | None = None) -> Engines:
    resolved_runner = runner or SubprocessCommandRunner()
    return Engines(
        realesrgan=RealesrganEngine(settings, resolved_runner),
        potrace=PotraceEngine(settings, resolved_runner),
        vtracer=VtracerEngine(settings),
        ai_cutout=AiCutoutEngine(settings),
    )


@dataclass(frozen=True)
class ScratchFile:
    relative: str
    absolute: Path


@dataclass(frozen=True)
class SourceImage:
    """The job input in a processable mode, plus the truth about the stored file.

    ``has_alpha`` describes the *original file*, not the working copy: a palette
    PNG with ``tRNS`` carries transparency, a 16-bit TIFF or an RGB screenshot
    does not, even though both are widened to RGBA for processing. That is the
    value reported in result metadata.
    """

    image: Image.Image
    warnings: list[dict]
    original_mode: str
    has_alpha: bool


@dataclass
class JobScope:
    """Per-job environment passed to every processor."""

    job: WorkerJob
    settings: Settings
    storage: StorageRoot
    engines: Engines
    contracts_dir: Path | None = None
    scratch_files: list[str] = field(default_factory=list)

    # --- protected paths -----------------------------------------------------
    @property
    def protected(self) -> tuple[str, ...]:
        return self.job.protected_inputs()

    # --- reads ---------------------------------------------------------------
    def open(self, relative: str) -> Image.Image:
        return load_image(self.storage, relative, self.settings)

    def open_input(self) -> SourceImage:
        """The job input in a processable mode, plus conversion warnings."""

        raw = self.open(self.job.input_path)
        original_mode = raw.mode
        had_alpha = image_has_alpha(raw)
        image, warnings = normalize_source_mode(raw)
        return SourceImage(
            image=image,
            warnings=warnings,
            original_mode=original_mode,
            has_alpha=had_alpha,
        )

    def require_input_artifact(self, name: str, *, why: str) -> str:
        relative = self.job.artifact_input(name)
        if not relative:
            raise MissingInputArtifactError(
                f"a {name} input artifact is required to {why}",
                details={"artifact": name, "available": sorted(self.job.input_artifacts)},
            )
        return relative

    def open_optional_input_artifact(self, name: str) -> Image.Image | None:
        relative = self.job.artifact_input(name)
        if not relative:
            return None
        return self.open(relative)

    # --- writes --------------------------------------------------------------
    def save_image(self, relative: str, image: Image.Image) -> list[dict]:
        return save_image(self.storage, relative, image, self.protected)

    def save_image_with_dpi(self, relative: str, image: Image.Image, dpi: int) -> list[dict]:
        return save_image(self.storage, relative, image, self.protected, dpi)

    def write_bytes(self, relative: str, data: bytes) -> Path:
        return self.storage.write_bytes(relative, data, self.protected)

    def write_json(self, relative: str, document: object) -> Path:
        return self.storage.write_json(relative, document, self.protected)

    # --- scratch -------------------------------------------------------------
    def scratch(self, filename: str) -> ScratchFile:
        relative = self.storage.scratch_relative(self.job.batch_id, self.job.job_id, filename)
        absolute = self.storage.resolve(relative)
        absolute.parent.mkdir(parents=True, exist_ok=True)
        self.scratch_files.append(relative)
        return ScratchFile(relative=relative, absolute=absolute)

    def cleanup_scratch(self) -> None:
        """Delete only files inside this job's own scratch prefix."""

        prefix = self.storage.scratch_relative(self.job.batch_id, self.job.job_id, "")
        for relative in dict.fromkeys(self.scratch_files):
            if not relative.startswith(prefix):
                continue
            path = self.storage.resolve(relative)
            if path.is_file():
                path.unlink(missing_ok=True)
        self.scratch_files.clear()

    def warning(self, code: str, severity: str, message: str, **details: object) -> dict:
        return make_warning(code, severity, message, details or None)
