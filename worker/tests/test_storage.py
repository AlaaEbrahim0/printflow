"""Storage: traversal rejection, atomic writes and the immutability guard."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from PIL import Image

from app.errors import (
    CODE_INPUT_MISSING,
    CODE_OUTPUT_IS_INPUT,
    CODE_STORAGE_PATH_INVALID,
    InputUnavailableError,
    OutputIsInputError,
    StorageError,
)
from app.storage import StorageRoot, normalize_relative_path
from tests.conftest import BATCH_ID, DESIGN_ID, version_path


def test_accepts_contract_style_relative_path() -> None:
    relative = f"{BATCH_ID}/designs/{DESIGN_ID}/versions/original.png"
    assert normalize_relative_path(relative) == relative


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        ("/etc/passwd", "absolute"),
        ("../outside.png", "parent traversal"),
        ("batches/../../etc/passwd", "embedded traversal"),
        ("batches/../secrets.png", "mid-path traversal"),
        ("", "empty"),
        ("   ", "whitespace only"),
        ("batches\\designs\\a.png", "backslashes"),
        ("~/secrets.png", "home expansion"),
        ("batches//a.png", "empty segment"),
        ("./batches/a.png", "dot segment"),
        ("batches/a.png/../../b", "trailing traversal"),
        (".hidden/a.png", "leading dot"),
        ("a" * 600, "too long"),
        ("batches/\u0000a.png", "nul byte"),
    ],
)
def test_rejects_hostile_paths(value: str, reason: str) -> None:
    with pytest.raises(StorageError) as excinfo:
        normalize_relative_path(value)
    assert excinfo.value.code == CODE_STORAGE_PATH_INVALID, reason


def test_resolve_stays_inside_root_even_with_symlink(tmp_path: Path) -> None:
    root = tmp_path / "storage"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "victim.png").write_bytes(b"do not read me")
    os.symlink(outside, root / "escape")

    storage = StorageRoot(root)
    with pytest.raises(StorageError) as excinfo:
        storage.resolve("escape/victim.png")
    assert excinfo.value.code == CODE_STORAGE_PATH_INVALID


def test_write_creates_parents_and_is_atomic(storage: StorageRoot) -> None:
    relative = version_path("v1")
    payload = b"\x89PNG fake bytes"
    written = storage.write_bytes(relative, payload)

    assert written.read_bytes() == payload
    assert written.parent == storage.resolve(relative).parent
    assert written.parent.is_dir()
    leftovers = [path.name for path in written.parent.iterdir() if path.name.startswith(".")]
    assert leftovers == [], "temp file must not survive the write"


def test_failed_stage_leaves_previous_content_untouched(storage: StorageRoot) -> None:
    relative = version_path("v2")
    storage.write_bytes(relative, b"original")

    with pytest.raises(RuntimeError), storage.stage(relative) as staged:
        staged.write_bytes(b"half written")
        raise RuntimeError("engine died mid-write")

    assert storage.resolve(relative).read_bytes() == b"original"
    assert list(storage.resolve(relative).parent.glob(".*")) == []


def test_promote_moves_scratch_file_into_place(storage: StorageRoot) -> None:
    scratch = f"{BATCH_ID}/jobs/job-1/work.png"
    final = version_path("v3")
    storage.write_bytes(scratch, b"engine output")

    promoted = storage.promote(scratch, final)

    assert promoted.read_bytes() == b"engine output"
    assert not storage.resolve(scratch).exists()


def test_promote_rejects_missing_scratch(storage: StorageRoot) -> None:
    with pytest.raises(StorageError):
        storage.promote(f"{BATCH_ID}/jobs/job-1/nope.png", version_path("v4"))


def test_read_missing_input_reports_stable_code(storage: StorageRoot) -> None:
    with pytest.raises(InputUnavailableError) as excinfo:
        storage.read_bytes(version_path("absent"))
    assert excinfo.value.code == CODE_INPUT_MISSING


def test_output_path_equal_to_input_is_refused(storage: StorageRoot) -> None:
    original = version_path("original")
    storage.write_bytes(original, b"immutable upload")
    image = Image.new("RGB", (4, 4), (1, 2, 3))
    path = storage.resolve(original).parent / "reused.png"
    image.save(path)

    with pytest.raises(OutputIsInputError) as excinfo:
        storage.write_bytes(original, b"overwritten", protected=(original,))
    assert excinfo.value.code == CODE_OUTPUT_IS_INPUT
    assert storage.read_bytes(original) == b"immutable upload"


def test_scratch_relative_follows_documented_layout(storage: StorageRoot) -> None:
    assert storage.scratch_relative("batch", "job", "work.svg") == "batch/jobs/job/work.svg"


def test_construction_does_not_touch_the_filesystem(tmp_path: Path) -> None:
    root = tmp_path / "deep" / "storage"
    storage = StorageRoot(root)
    assert storage.resolved_root == root.resolve(strict=False)
    assert not root.exists()
