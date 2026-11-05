"""Storage-root path resolution and atomic, non-destructive writes.

Every path that crosses the packer boundary is relative to a caller-provided
storage root. This module is the single place that turns such a path into a
real filesystem path, and it refuses anything that could escape the root or
overwrite an input file.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from printsheet_packer.errors import (
    InputImmutableError,
    MissingSourceError,
    OutputExistsError,
    UnsafePathError,
)

_DRIVE = re.compile(r"^[A-Za-z]:")
_FORBIDDEN_CHARS = re.compile(r"[\x00-\x1f]")


class StorageRoot:
    """A validated view of one storage root.

    Reads are registered so that no write can land on an input file, which
    enforces the product rule "the original upload is never modified".
    """

    def __init__(self, root: os.PathLike[str] | str) -> None:
        candidate = Path(os.fspath(root))
        if not candidate.exists():
            raise UnsafePathError(f"Storage root does not exist: {candidate}")
        if not candidate.is_dir():
            raise UnsafePathError(f"Storage root is not a directory: {candidate}")
        self.root = candidate.resolve()
        self._inputs: set[Path] = set()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"StorageRoot({str(self.root)!r})"

    def __truediv__(self, relative: str) -> Path:
        """``root / "b1/design.png"`` resolves and validates the relative path."""
        if isinstance(relative, str):
            return self.resolve(relative)
        return NotImplemented

    # ------------------------------------------------------------------
    # path resolution
    # ------------------------------------------------------------------
    def resolve(self, relative_path: str, *, field: str = "path") -> Path:
        """Resolve ``relative_path`` under the root, refusing escapes."""
        if not isinstance(relative_path, str):
            raise UnsafePathError(f"{field} must be a string, got {type(relative_path).__name__}")
        if _FORBIDDEN_CHARS.search(relative_path):
            raise UnsafePathError(f"{field} contains control characters: {relative_path!r}")
        if relative_path.startswith(("/", "\\")):
            raise UnsafePathError(f"{field} must be relative to the storage root: {relative_path}")
        if _DRIVE.match(relative_path):
            raise UnsafePathError(f"{field} must not name a drive: {relative_path}")
        normalized = relative_path.replace("\\", "/")
        segments = normalized.split("/")
        if any(segment in ("", ".") for segment in segments):
            raise UnsafePathError(f"{field} has empty or '.' segments: {relative_path}")
        if any(segment == ".." for segment in segments):
            raise UnsafePathError(f"{field} contains '..': {relative_path}")

        target = (self.root / normalized).resolve()
        if not _is_within(target, self.root):
            raise UnsafePathError(f"{field} escapes the storage root: {relative_path}")
        return target

    def check_within(self, path: Path) -> Path:
        target = Path(os.fspath(path)).resolve()
        if not _is_within(target, self.root):
            raise UnsafePathError(f"Path is outside the storage root: {path}")
        return target

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------
    def register_input(self, path: Path) -> Path:
        """Mark ``path`` immutable for the lifetime of this root view."""
        resolved = self.check_within(path)
        self._inputs.add(resolved)
        return resolved

    def read_bytes(self, relative_path: str, *, field: str = "filePath") -> bytes:
        path = self.resolve(relative_path, field=field)
        resolved = self.register_input(path)
        try:
            return resolved.read_bytes()
        except FileNotFoundError as exc:
            raise MissingSourceError(
                f"Source file is missing: {relative_path}", path=relative_path
            ) from exc

    def open_read(self, relative_path: str, *, field: str = "filePath") -> Path:
        path = self.register_input(self.resolve(relative_path, field=field))
        if not path.is_file():
            raise MissingSourceError(f"Source file is missing: {relative_path}", path=relative_path)
        return path

    # ------------------------------------------------------------------
    # writes
    # ------------------------------------------------------------------
    def guard_output(self, target: os.PathLike[str] | str, *, overwrite: bool = False) -> Path:
        """An output destination: never an input, never an existing file unasked.

        ``--out`` may point anywhere the operator chooses; anything inside the
        storage root is additionally checked against the files this run read.
        """
        resolved = Path(os.fspath(target)).expanduser().resolve()
        if resolved in self._inputs:
            raise InputImmutableError(
                f"Refusing to overwrite an input file: {resolved}", path=str(resolved)
            )
        if not overwrite and resolved.exists():
            raise OutputExistsError(
                f"Refusing to overwrite an existing artifact: {resolved}", path=str(resolved)
            )
        return resolved

    def write_bytes(
        self, target: os.PathLike[str] | str, payload: bytes, *, overwrite: bool = False
    ) -> Path:
        destination = self.guard_output(target, overwrite=overwrite)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with atomic_write_binary(destination) as handle:
            handle.write(payload)
        return destination

    def write_text(
        self, target: os.PathLike[str] | str, payload: str, *, overwrite: bool = False
    ) -> Path:
        return self.write_bytes(target, payload.encode("utf-8"), overwrite=overwrite)

    def write_json(
        self,
        target: os.PathLike[str] | str,
        document: Any,
        *,
        indent: int = 2,
        overwrite: bool = False,
    ) -> Path:
        text = json.dumps(document, indent=indent, ensure_ascii=False, sort_keys=False)
        return self.write_text(target, text + "\n", overwrite=overwrite)


@contextmanager
def atomic_write_binary(destination: Path) -> Iterator[Any]:
    """Yield a binary handle that becomes ``destination`` only on success.

    The caller must fully write and close the container before the rename; a
    partial file is never published.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        dir=destination.parent, prefix=f".{destination.name}.", suffix=".part"
    )
    temp = Path(temp_name)
    written = False
    with os.fdopen(handle, "wb") as stream:
        try:
            yield stream
            stream.flush()
            os.fsync(stream.fileno())
            written = True
        finally:
            if not written and temp.exists():
                temp.unlink(missing_ok=True)
    if written:
        os.replace(temp, destination)


def _is_within(candidate: Path, parent: Path) -> bool:
    return candidate == parent or parent in candidate.parents


__all__ = ["StorageRoot", "atomic_write_binary"]
