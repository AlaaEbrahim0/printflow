"""Unit conversion, contract loading and storage safety."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from printsheet_packer.contracts import ContractStore, load_pack_request, parse_pack_request
from printsheet_packer.errors import (
    ContractValidationError,
    InputImmutableError,
    MissingSourceError,
    OutputExistsError,
    UnsafePathError,
)
from printsheet_packer.storage import StorageRoot
from printsheet_packer.units import (
    ceil_pixels_for_millimeters,
    centimeters_for_pixels,
    pixels_for_centimeters,
    round_half_away_from_zero,
)

REPO = Path(__file__).resolve().parents[2]


def test_canonical_roll_width() -> None:
    assert pixels_for_centimeters(58, 300) == 6850
    assert pixels_for_centimeters("58", 300) == 6850
    assert pixels_for_centimeters(20, 300) == 2362
    assert pixels_for_centimeters(15, 300) == 1772


def test_round_half_away_from_zero() -> None:
    assert round_half_away_from_zero(0.5) == 1
    assert round_half_away_from_zero(1.5) == 2
    assert round_half_away_from_zero(2.5) == 3
    assert round_half_away_from_zero(-0.5) == -1
    assert round_half_away_from_zero(2.4999999) == 2


def test_clearances_round_up_never_down() -> None:
    assert ceil_pixels_for_millimeters(30, 300) == 355
    assert ceil_pixels_for_millimeters(0, 300) == 0
    assert ceil_pixels_for_millimeters(1, 72) == 3


def test_centimeters_round_trip_is_honest() -> None:
    back = centimeters_for_pixels(pixels_for_centimeters(58, 300), 300)
    assert back == pytest.approx(58.0017, 1e-3)


def test_store_finds_the_frozen_schemas_relative_to_the_package() -> None:
    store = ContractStore()
    assert store.schema_dir == REPO / "contracts" / "jsonschema"
    assert {"packer-request", "packer-response", "integrity-report"} <= set(store.names)


@pytest.mark.parametrize(
    "example",
    [
        "packer-request.json",
        "packer-response.json",
        "integrity-report.json",
        "integrity-report-failed.json",
    ],
)
def test_frozen_examples_still_validate(example: str) -> None:
    store = ContractStore()
    document = json.loads((REPO / "contracts" / "examples" / example).read_text(encoding="utf-8"))
    name = {
        "packer-request.json": "packer-request",
        "packer-response.json": "packer-response",
    }.get(example, "integrity-report")
    assert store.validate(name, document) == []


def test_request_parses_into_typed_values() -> None:
    request = load_pack_request(REPO / "contracts" / "examples" / "packer-request.json")
    assert request.sheet_width_px == 6850
    assert request.designs[0].display_name == "smoke-tee"
    assert request.output.preview_path.endswith("preview.png")


def test_invalid_request_is_refused_with_paths() -> None:
    store = ContractStore()
    errors = store.validate("packer-request", {"schemaVersion": "1.0"})
    assert errors
    with pytest.raises(ContractValidationError) as excinfo:
        parse_pack_request({"schemaVersion": "1.0"})
    assert excinfo.value.errors


# ----------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad",
    [
        "/etc/passwd",
        "../escape.png",
        "a/../../b.png",
        "a//b.png",
        "./a.png",
        "a/./b.png",
        "\\\\server\\share.png",
        "C:/windows.png",
        "a/b/",
        "",
    ],
)
def test_unsafe_relative_paths_are_rejected(root: StorageRoot, bad: str) -> None:
    with pytest.raises(UnsafePathError):
        root.resolve(bad)


def test_symlink_escape_is_rejected(root: StorageRoot, tmp_path: Path) -> None:
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"x")
    link = root / "b1" / "link.png"
    link.parent.mkdir(parents=True)
    link.symlink_to(outside)
    with pytest.raises(UnsafePathError):
        root.resolve("b1/link.png")


def test_reads_are_registered_and_outputs_are_protected(root: StorageRoot) -> None:
    (root / "b1").mkdir()
    (root / "b1" / "source.png").write_bytes(b"pixels")
    assert root.read_bytes("b1/source.png") == b"pixels"
    with pytest.raises(InputImmutableError):
        root.write_bytes(root / "b1" / "source.png", b"overwritten")


def test_existing_artifact_is_not_replaced_without_permission(root: StorageRoot) -> None:
    (root / "b1").mkdir()
    target = root / "b1" / "placements.json"
    target.write_text("{}")
    with pytest.raises(OutputExistsError):
        root.write_json(target, {"a": 1})
    root.write_json(target, {"a": 1}, overwrite=True)
    assert json.loads(target.read_text()) == {"a": 1}


def test_missing_source_is_a_structured_error(root: StorageRoot) -> None:
    with pytest.raises(MissingSourceError) as excinfo:
        root.read_bytes("b1/absent.png")
    assert excinfo.value.code == "source-missing"


def test_writes_are_atomic_and_leave_no_temporary_files(root: StorageRoot) -> None:
    directory = root / "b1" / "jobs"
    directory.mkdir(parents=True)
    target = directory / "out.bin"
    root.write_bytes(target, b"data")
    assert target.read_bytes() == b"data"
    assert [path.name for path in directory.iterdir()] == ["out.bin"]


def test_storage_root_must_exist(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        StorageRoot(tmp_path / "nope")
