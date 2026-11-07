"""``realesrgan-ncnn-vulkan`` adapter.

The CLI surface below is taken from the upstream usage block of
``Real-ESRGAN-ncnn-vulkan`` (xinntao), not guessed:

``-i`` input path, ``-o`` output path, ``-s`` scale (2/3/4), ``-t`` tile size
(``>=32``, ``0`` = auto), ``-m`` model folder, ``-n`` model name, ``-g`` gpu id
(``-1`` = CPU), ``-j`` load:proc:save threads, ``-f`` output format.

The binary is *not* a Python dependency: when it is missing the job fails with
the stable non-retryable code ``engine-unavailable``. We never substitute a
different upscaling algorithm behind the operator's back.
"""

from __future__ import annotations

from pathlib import Path

from app.config import Settings
from app.engines.command import CommandRunner, SubprocessCommandRunner, locate_binary
from app.errors import (
    EngineFailedError,
    EngineOutputInvalidError,
    EngineUnavailableError,
)
from app.imaging import make_warning

ENGINE_NAME = "realesrgan-ncnn-vulkan"
MIN_TILE_SIZE = 32
ENGINE_INPUT_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
_FORMAT_BY_SUFFIX = {".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp"}


class RealesrganEngine:
    """File-based Real-ESRGAN invocation with a configurable device policy."""

    name = ENGINE_NAME

    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self.settings = settings
        self.runner = runner or SubprocessCommandRunner()

    @property
    def binary(self) -> Path | None:
        return locate_binary(self.settings.realesrgan_binary)

    def normalize_tile_size(self, tile_size: int) -> tuple[int, dict | None]:
        """``0`` means auto; the binary rejects ``1..31``, so map those to auto too."""

        if 0 < tile_size < MIN_TILE_SIZE:
            return 0, make_warning(
                "tile-size-below-minimum",
                "info",
                f"Tile size {tile_size} is below the engine minimum of "
                f"{MIN_TILE_SIZE}px; using automatic tiling.",
                details={"requestedTileSize": tile_size, "minimumTileSize": MIN_TILE_SIZE},
            )
        return tile_size, None

    def resolve_device(self, gpu_requested: bool) -> tuple[int, dict | None]:
        """GPU index for ``-g``; ``-1`` selects the engine's CPU path."""

        if gpu_requested and self.settings.gpu_enabled:
            return self.settings.realesrgan_gpu_device_index, None
        warning = None
        if gpu_requested:
            warning = make_warning(
                "gpu-requested-cpu-fallback",
                "warning",
                "The job requested GPU but this worker has "
                "PRINTSHEET_GPU_ENABLED=false; Real-ESRGAN will run on the CPU "
                "and be much slower.",
                details={"gpuRequested": True, "gpuEnabled": False},
            )
        return -1, warning

    def build_command(
        self,
        *,
        input_path: Path,
        output_path: Path,
        scale: int,
        model: str,
        tile_size: int,
        gpu_index: int,
    ) -> list[str]:
        binary = self.binary or Path(str(self.settings.realesrgan_binary))
        suffix = output_path.suffix.lower()
        output_format = _FORMAT_BY_SUFFIX.get(suffix, "png")
        command: list[str] = [
            str(binary),
            "-i",
            str(input_path),
            "-o",
            str(output_path),
            "-s",
            str(scale),
            "-n",
            model,
            "-t",
            str(tile_size),
            "-f",
            output_format,
            "-g",
            str(gpu_index),
        ]
        if self.settings.realesrgan_model_dir is not None:
            command += ["-m", str(self.settings.realesrgan_model_dir)]
        if gpu_index < 0 and self.settings.realesrgan_cpu_threads > 0:
            # ncnn thread triple load:proc:save for the CPU path.
            threads = self.settings.realesrgan_cpu_threads
            command += ["-j", f"1:{threads}:{threads}"]
        return command

    def upscale(
        self,
        *,
        input_path: Path,
        output_path: Path,
        scale: int,
        model: str,
        tile_size: int,
        gpu: bool,
    ) -> list[dict]:
        """Run the engine into ``output_path``; returns the warnings it produced."""

        if self.binary is None:
            raise EngineUnavailableError(
                "realesrgan-ncnn-vulkan is not installed or "
                "PRINTSHEET_REALESRGAN_BINARY does not point at it",
                details={
                    "binary": str(self.settings.realesrgan_binary),
                    "setting": "PRINTSHEET_REALESRGAN_BINARY",
                    "hint": "install the release binary, or run scripts/run-worker-gpu.sh",
                },
                engine=ENGINE_NAME,
            )

        warnings: list[dict] = []
        effective_tile, tile_warning = self.normalize_tile_size(tile_size)
        if tile_warning:
            warnings.append(tile_warning)
        gpu_index, device_warning = self.resolve_device(gpu)
        if device_warning:
            warnings.append(device_warning)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        command = self.build_command(
            input_path=input_path,
            output_path=output_path,
            scale=scale,
            model=model,
            tile_size=effective_tile,
            gpu_index=gpu_index,
        )
        result = self.runner.run(command, timeout_seconds=self.settings.realesrgan_timeout_seconds)

        if not result.ok:
            details = {"returncode": result.returncode, "argv": command[:2]}
            if result.tail():
                details["stderr"] = result.tail()
            raise EngineFailedError(
                f"realesrgan-ncnn-vulkan exited with code {result.returncode}",
                retryable=True,
                details=details,
                engine=ENGINE_NAME,
            )
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise EngineOutputInvalidError(
                "realesrgan-ncnn-vulkan produced no output file",
                details={"outputPath": str(output_path)},
                engine=ENGINE_NAME,
            )
        return warnings
