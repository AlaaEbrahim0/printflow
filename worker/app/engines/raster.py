"""SVG rasterization boundary (vectorize previews and ``rasterizeFromVector``).

Detection order: an explicit ``PRINTSHEET_SVG_RASTERIZER``, then ``cairosvg``,
``resvg-py``, the ``rsvg-convert`` CLI and finally ``inkscape``. When nothing is
available the job fails with ``svg-rasterizer-unavailable`` instead of quietly
falling back to a raster resample — the operator would otherwise see a bitmap
where the design should be vector.

The two Python backends are optional dependencies that are not installed on this
development machine, so their call signatures are wrapped: an incompatible
build surfaces as a typed ``engine-failed`` rather than a traceback.
"""

from __future__ import annotations

import importlib
import shutil
from pathlib import Path
from typing import Protocol

from app.config import Settings
from app.engines.command import CommandRunner, SubprocessCommandRunner
from app.errors import (
    CODE_SVG_RASTERIZER_UNAVAILABLE,
    EngineFailedError,
    EngineOutputInvalidError,
    WorkerError,
)

RASTERIZER_ORDER = ("cairosvg", "resvg-py", "rsvg-convert", "inkscape")


class SvgRasterizer(Protocol):
    name: str

    def is_available(self) -> bool: ...

    def rasterize(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> None: ...


class RsvgConvertRasterizer:
    """librsvg CLI. The only backend that needs no Python dependency."""

    name = "rsvg-convert"

    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self.settings = settings
        self.runner = runner or SubprocessCommandRunner()

    def is_available(self) -> bool:
        return shutil.which(self.name) is not None

    def build_command(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> list[str]:
        return [
            self.name,
            "-f",
            "png",
            "-w",
            str(width_px),
            "-h",
            str(height_px),
            "-o",
            str(output_path),
            str(svg_path),
        ]

    def rasterize(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> None:
        if not self.is_available():
            raise unavailable(self.name)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        command = self.build_command(
            svg_path=svg_path, output_path=output_path, width_px=width_px, height_px=height_px
        )
        result = self.runner.run(command, timeout_seconds=self.settings.svg_raster_timeout_seconds)
        if not result.ok:
            raise EngineFailedError(
                f"{self.name} exited with code {result.returncode}",
                retryable=False,
                details={"stderr": result.tail(), "engine": self.name},
                engine=self.name,
            )
        require_output(output_path, self.name)


class InkscapeRasterizer(RsvgConvertRasterizer):
    """Inkscape CLI, used when librsvg is absent but Inkscape is installed."""

    name = "inkscape"

    def build_command(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> list[str]:
        return [
            self.name,
            "--export-type=png",
            f"--export-filename={output_path}",
            "-w",
            str(width_px),
            "-h",
            str(height_px),
            str(svg_path),
        ]


class CairoSvgRasterizer:
    name = "cairosvg"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def is_available(self) -> bool:
        try:
            importlib.import_module("cairosvg")
        except ImportError:
            return False
        return True

    def rasterize(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> None:
        if not self.is_available():
            raise unavailable(self.name)
        module = importlib.import_module("cairosvg")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            module.svg2png(
                url=str(svg_path),
                write_to=str(output_path),
                output_width=int(width_px),
                output_height=int(height_px),
            )
        except (TypeError, AttributeError) as exc:
            raise incompatible(self.name, exc) from exc
        require_output(output_path, self.name)


class ResvgPyRasterizer:
    name = "resvg-py"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def is_available(self) -> bool:
        try:
            importlib.import_module("resvg_py")
        except ImportError:
            return False
        return True

    def rasterize(
        self, *, svg_path: Path, output_path: Path, width_px: int, height_px: int
    ) -> None:
        if not self.is_available():
            raise unavailable(self.name)
        module = importlib.import_module("resvg_py")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            payload = module.svg_to_bytes(
                file_path=str(svg_path), width=int(width_px), height=int(height_px)
            )
        except (TypeError, AttributeError) as exc:
            raise incompatible(self.name, exc) from exc
        output_path.write_bytes(payload)
        require_output(output_path, self.name)


def unavailable(name: str) -> WorkerError:
    return WorkerError(
        f"no SVG rasterizer is available; {name} is not installed. Install one "
        "with pip install -e '.[vector]' or point PRINTSHEET_SVG_RASTERIZER at a "
        "working backend.",
        code=CODE_SVG_RASTERIZER_UNAVAILABLE,
        retryable=False,
        details={"tried": list(RASTERIZER_ORDER)},
        engine=name,
    )


def incompatible(name: str, exc: Exception) -> WorkerError:
    return WorkerError(
        f"installed {name} API is incompatible: {exc}",
        code="engine-failed",
        retryable=False,
        details={"engine": name},
        engine=name,
    )


def require_output(output_path: Path, name: str) -> None:
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise EngineOutputInvalidError(
            f"{name} produced no raster output",
            details={"outputPath": str(output_path), "engine": name},
            engine=name,
        )


def build_rasterizers(settings: Settings) -> list[SvgRasterizer]:
    return [
        CairoSvgRasterizer(settings),
        ResvgPyRasterizer(settings),
        RsvgConvertRasterizer(settings),
        InkscapeRasterizer(settings),
    ]


def detect_rasterizer(settings: Settings) -> SvgRasterizer | None:
    """First usable rasterizer, honouring ``PRINTSHEET_SVG_RASTERIZER``."""

    rasterizers = build_rasterizers(settings)
    if settings.svg_rasterizer:
        for candidate in rasterizers:
            if candidate.name == settings.svg_rasterizer:
                return candidate if candidate.is_available() else None
        return None
    for candidate in rasterizers:
        if candidate.is_available():
            return candidate
    return None
