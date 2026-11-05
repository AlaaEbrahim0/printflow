"""Subprocess boundary used by the external-engine adapters.

Engines are always invoked as an argument *list* — never ``shell=True``, never
``eval`` — with a hard timeout, so a hung ``realesrgan-ncnn-vulkan`` cannot
wedge the worker. Tests inject a fake runner and therefore need neither a GPU
nor any of the binaries installed.
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from app.errors import EngineTimeoutError

MAX_CAPTURED_CHARS = 4000


class CommandRunner(Protocol):
    """Minimal seam around ``subprocess``."""

    def run(self, argv: Sequence[str], *, timeout_seconds: float) -> CommandResult: ...


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    def tail(self) -> str:
        """Short, log-safe excerpt of the engine's stderr."""

        text = (self.stderr or self.stdout or "").strip()
        if len(text) > MAX_CAPTURED_CHARS:
            text = text[-MAX_CAPTURED_CHARS:]
        return text


class SubprocessCommandRunner:
    """The real runner."""

    def run(self, argv: Sequence[str], *, timeout_seconds: float) -> CommandResult:
        command = [str(part) for part in argv]
        try:
            completed = subprocess.run(
                command,  # argv list, never a shell string
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise EngineTimeoutError(
                f"engine timed out after {timeout_seconds}s",
                details={
                    "timeoutSeconds": timeout_seconds,
                    "argv0": Path(command[0]).name,
                },
            ) from exc
        return CommandResult(
            returncode=completed.returncode,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
        )


def locate_binary(candidate: str | Path) -> Path | None:
    """Absolute path of a configured binary, or ``None`` when it is not installed."""

    text = str(candidate)
    if not text:
        return None
    found = shutil.which(text)
    if found:
        return Path(found)
    explicit = Path(text)
    if explicit.is_file() and explicit.stat().st_mode & 0o111:
        return explicit.expanduser().resolve(strict=False)
    return None
