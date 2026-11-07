"""pytest fixtures for the packer tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from printsheet_packer.storage import StorageRoot


@pytest.fixture
def storage(tmp_path: Path) -> Path:
    root = tmp_path / "storage"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.fixture
def root(storage: Path) -> StorageRoot:
    return StorageRoot(storage)
