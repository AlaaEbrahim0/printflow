"""``potrace`` adapter (binary tracing engine).

Option set taken from the potrace 1.16 manual page, not guessed:
``-b/--backend``, ``-o/--output``, ``-k/--blacklevel`` (0..1 threshold, pixels
*dimmer* than the level become black), ``-t/--turdsize`` (suppress speckles up
to N px), ``-a/--alphamax`` (corner threshold), ``-O/--opttolerance``,
``-r/--resolution`` (dpi for dimension-based backends), ``-x/--scale`` for
pixel-based backends, ``-i/--invert``.

potrace only traces bitmaps, so the processor feeds it a grayscale PGM of the
design composited over the garment colour and, for dark garments, ``--invert``
so the light artwork becomes the ink. potrace has no PNG backend; the raster
preview comes from its antialiased ``pgm`` backend, which the processor paints
into an RGBA PNG.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from app.config import Settings
from app.engines.command import CommandRunner, SubprocessCommandRunner
from app.errors import EngineFailedError, EngineOutputInvalidError, EngineUnavailableError

ENGINE_NAME = "potrace"


class PotraceEngine:
    """Binary-backed SVG/PGM tracing with a deterministic, non-retryable failure model."""

    name = ENGINE_NAME

    def __init__(self, settings: Settings, runner: CommandRunner | None = None) -> None:
        self.settings = settings
        self.runner = runner or SubprocessCommandRunner()

    @property
    def binary(self) -> Path | None:
        found = shutil.which(str(self.settings.potrace_binary))
        if found:
            return Path(found)
        explicit = Path(str(self.settings.potrace_binary))
        if explicit.is_file():
            return explicit
        return None

    def _algorithm_options(self, *, blacklevel: float, turdsize: int) -> list[str]:
        return [
            "-k",
            f"{min(max(blacklevel, 0.0), 1.0):.6f}",
            "-t",
            str(int(turdsize)),
            "-a",
            f"{self.settings.potrace_corner_threshold:g}",
            "-O",
            f"{self.settings.potrace_optimize_tolerance:g}",
        ]

    def build_svg_command(
        self,
        *,
        input_path: Path,
        output_path: Path,
        blacklevel: float,
        turdsize: int,
        dpi: int,
        invert: bool,
    ) -> list[str]:
        binary = self.binary or Path(str(self.settings.potrace_binary))
        command = [
            str(binary),
            "-b",
            "svg",
            "-o",
            str(output_path),
            "-r",
            str(dpi),
            *self._algorithm_options(blacklevel=blacklevel, turdsize=turdsize),
        ]
        if invert:
            command.append("-i")
        command.append(str(input_path))
        return command

    def build_pgm_command(
        self,
        *,
        input_path: Path,
        output_path: Path,
        blacklevel: float,
        turdsize: int,
        scale: float,
        invert: bool,
    ) -> list[str]:
        binary = self.binary or Path(str(self.settings.potrace_binary))
        command = [
            str(binary),
            "-b",
            "pgm",
            "-o",
            str(output_path),
            "-x",
            f"{scale:.6f}",
            *self._algorithm_options(blacklevel=blacklevel, turdsize=turdsize),
        ]
        if invert:
            command.append("-i")
        command.append(str(input_path))
        return command

    def _execute(self, command: list[str], output_path: Path, purpose: str) -> None:
        if self.binary is None:
            raise EngineUnavailableError(
                "potrace is not installed or PRINTSHEET_POTRACE_BINARY does not point at it",
                details={
                    "binary": str(self.settings.potrace_binary),
                    "setting": "PRINTSHEET_POTRACE_BINARY",
                },
                engine=ENGINE_NAME,
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        result = self.runner.run(command, timeout_seconds=self.settings.potrace_timeout_seconds)
        if not result.ok:
            details = {"returncode": result.returncode, "purpose": purpose}
            if result.tail():
                details["stderr"] = result.tail()
            raise EngineFailedError(
                f"potrace failed while producing {purpose} (exit {result.returncode})",
                # A deterministic tracing tool failing on this bitmap will fail
                # again on a retry, so the API should not burn attempts.
                retryable=False,
                details=details,
                engine=ENGINE_NAME,
            )
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise EngineOutputInvalidError(
                f"potrace produced no {purpose} output",
                details={"outputPath": str(output_path), "purpose": purpose},
                engine=ENGINE_NAME,
            )

    def trace_to_svg(
        self,
        *,
        input_path: Path,
        output_path: Path,
        blacklevel: float,
        turdsize: int,
        dpi: int,
        invert: bool,
    ) -> None:
        self._execute(
            self.build_svg_command(
                input_path=input_path,
                output_path=output_path,
                blacklevel=blacklevel,
                turdsize=turdsize,
                dpi=dpi,
                invert=invert,
            ),
            output_path,
            "svg",
        )

    def trace_to_pgm(
        self,
        *,
        input_path: Path,
        output_path: Path,
        blacklevel: float,
        turdsize: int,
        scale: float,
        invert: bool,
    ) -> None:
        self._execute(
            self.build_pgm_command(
                input_path=input_path,
                output_path=output_path,
                blacklevel=blacklevel,
                turdsize=turdsize,
                scale=scale,
                invert=invert,
            ),
            output_path,
            "preview raster",
        )
