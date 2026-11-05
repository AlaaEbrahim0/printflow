"""Shared-storage access: traversal-safe paths and atomic writes.

The API and the worker agree on one root (``Settings.storage_root``) and pass
*relative* paths in JSON — image bytes never travel in a request body. Every
path that reaches the filesystem goes through :class:`StorageRoot` first:

* absolute paths, ``..`` segments, empty segments, backslashes, NUL bytes and
  anything the frozen ``relativePath`` pattern rejects are refused;
* the resolved target must remain inside the resolved root (symlink escape
  guard);
* writes land in a temp file inside the destination directory, are flushed and
  fsynced, then ``os.replace``d into place, so the API can never read a
  half-written version file;
* a job's input paths are registered as *protected* and cannot be overwritten,
  which enforces "the original upload is never modified".
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from app.errors import (
    InputUnavailableError,
    OutputIsInputError,
    StorageError,
)

# Mirrors ``$defs/relativePath`` in the frozen worker contracts. Kept here as an
# independent second line of defence: contract validation is the API's job, the
# worker must still refuse a hostile path it somehow received.
RELATIVE_PATH_PATTERN = re.compile(r"^(?!/)(?!.*(?:^|/)\.\.(?:/|$))[A-Za-z0-9][A-Za-z0-9._/-]*$")
MAX_PATH_LENGTH = 512


def normalize_relative_path(value: Any) -> str:
    """Validate a contract relative path and return its canonical form."""

    if not isinstance(value, str):
        raise StorageError(f"storage path must be a string, got {type(value).__name__}")
    text = value.strip()
    if not text:
        raise StorageError("storage path must not be empty")
    if len(text) > MAX_PATH_LENGTH:
        raise StorageError(f"storage path longer than {MAX_PATH_LENGTH} characters")
    if "\\" in text:
        raise StorageError(f"storage path must not contain backslashes: {value!r}")
    if "\x00" in text:
        raise StorageError("storage path must not contain NUL bytes")
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise StorageError(f"storage path must be relative to the storage root: {value!r}")
    if "~" in text:
        raise StorageError(f"storage path must not contain '~': {value!r}")
    segments = text.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise StorageError(f"storage path must not contain empty, '.' or '..' segments: {value!r}")
    if not RELATIVE_PATH_PATTERN.match(text):
        raise StorageError(f"storage path violates the relativePath contract pattern: {value!r}")
    return "/".join(segments)


class StorageRoot:
    """Filesystem facade pinned to one storage root."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._resolved_root = self.root.expanduser().resolve(strict=False)

    @property
    def resolved_root(self) -> Path:
        return self._resolved_root

    # --- paths ---------------------------------------------------------------
    def resolve(self, relative: str) -> Path:
        """Validate ``relative`` and return the absolute path inside the root."""

        normalized = normalize_relative_path(relative)
        candidate = (self._resolved_root / normalized).resolve(strict=False)
        if not candidate.is_relative_to(self._resolved_root) or candidate == self._resolved_root:
            raise StorageError(
                f"storage path escapes the root: {relative!r}",
                details={"root": str(self._resolved_root)},
            )
        return candidate

    def exists(self, relative: str) -> bool:
        return self.resolve(relative).is_file()

    # --- reads ---------------------------------------------------------------
    def read_bytes(self, relative: str) -> bytes:
        path = self.resolve(relative)  # validation happens before any I/O
        try:
            return path.read_bytes()
        except FileNotFoundError as exc:
            raise InputUnavailableError(
                f"input file is missing: {relative}",
                details={"relativePath": relative},
            ) from exc
        except OSError as exc:
            raise InputUnavailableError(
                f"input file could not be read: {relative}",
                details={"relativePath": relative, "reason": str(exc)},
            ) from exc

    # --- writes --------------------------------------------------------------
    @contextmanager
    def stage(self, relative: str, protected: Iterable[str] = ()) -> Iterator[Path]:
        """Yield a temp path in the destination directory for the caller to fill.

        On successful exit the temp file is fsynced and atomically renamed onto
        ``relative``. On any error the temp file is removed and the previous
        content of ``relative`` is untouched.
        """

        target = self.resolve(relative)
        self._assert_not_protected(target, relative, protected)
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - the fd is closed here on purpose
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        )
        staged = Path(handle.name)
        handle.close()
        try:
            yield staged
            self._sync_file(staged)
            os.chmod(staged, 0o644)
            os.replace(staged, target)
        except BaseException:
            staged.unlink(missing_ok=True)
            raise

    def write_bytes(self, relative: str, data: bytes, protected: Iterable[str] = ()) -> Path:
        with self.stage(relative, protected) as staged:
            staged.write_bytes(data)
        return self.resolve(relative)

    def write_json(
        self, relative: str, document: Any, protected: Iterable[str] = ()
    ) -> Path:
        payload = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
        return self.write_bytes(relative, payload.encode("utf-8"), protected)

    def promote(self, staged_relative: str, relative: str, protected: Iterable[str] = ()) -> Path:
        """Move a file the worker already wrote (engine scratch output) into place."""

        source = self.resolve(staged_relative)
        target = self.resolve(relative)
        self._assert_not_protected(target, relative, protected)
        if not source.is_file():
            raise StorageError(
                f"staged file is missing: {staged_relative}",
                details={"relativePath": staged_relative},
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
        self._sync_directory(target.parent)
        return target

    def scratch_relative(self, batch_id: str, job_id: str, filename: str) -> str:
        """``{batchId}/jobs/{jobId}/...`` scratch path from the storage layout."""

        return f"{batch_id}/jobs/{job_id}/{filename}"

    # --- guards --------------------------------------------------------------
    def _assert_not_protected(self, target: Path, relative: str, protected: Iterable[str]) -> None:
        for entry in protected:
            if self.resolve(entry) == target:
                raise OutputIsInputError(
                    "output path is a protected input file; the worker never "
                    "overwrites an input or an original",
                    details={"path": relative},
                )

    @staticmethod
    def _sync_file(path: Path) -> None:
        with open(path, "rb") as handle:
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _sync_directory(directory: Path) -> None:
        flag = os.O_RDONLY
        try:
            descriptor = os.open(directory, flag)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            # Some filesystems (and tmpfs in containers) reject directory fsync;
            # the rename itself is already atomic.
            pass
        finally:
            os.close(descriptor)
