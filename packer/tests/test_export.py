"""Manifest and exporter behaviour, verified with Pillow on the way out."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from helpers import circle, request_document, ring, solid, specs, write_storage
from PIL import Image

from printsheet_packer.contracts import ContractStore, parse_pack_request
from printsheet_packer.errors import (
    ContractValidationError,
    ExportFormatUnavailableError,
    InputImmutableError,
    MissingSourceError,
    OutputExistsError,
)
from printsheet_packer.export import (
    ALL_FORMATS,
    AVAILABLE_FORMATS,
    REFUSED_FORMATS,
    SheetSpec,
    build_rebuild_script,
    export_artifact,
    read_manifest,
    require_manifest_valid,
    resolve_format,
    verify_source_hashes,
    write_flat_png,
    write_flat_tiff,
    write_psd_bundle,
)
from printsheet_packer.pipeline import run_pack
from printsheet_packer.storage import StorageRoot

DPI = 300


@pytest.fixture
def packed(tmp_path):
    """A small real sheet: pack it, then export from the manifest on disk."""
    designs = specs([circle(64, 40), ring(50, 50), solid(30, 90)])
    request = parse_pack_request(
        request_document(
            designs, rollWidthCm=4, marginMm=1, edgeMarginMm=1, cellMm=1, randomizedOrderings=2
        )
    )
    root = StorageRoot(write_storage(tmp_path, designs))
    outcome = run_pack(request, root, preview=True)
    manifest_path = Path(outcome.written["manifest"])
    return outcome, root, manifest_path, read_manifest(manifest_path)


def pixels_of(path: Path, *, rows: int | None = None) -> np.ndarray:
    with Image.open(path) as image:
        image.load()
        return np.array(image.convert("RGBA"))


def test_manifest_round_trips_and_validates_on_read(packed) -> None:
    _outcome, _root, _path, manifest = packed
    assert manifest["kind"] == "printsheet.packer.manifest"
    assert manifest["schemaVersion"] == "1.0"
    assert manifest["sheet"]["widthPx"] == 472  # round(4 cm x 300 DPI / 2.54)
    assert {
        "filePath",
        "sha256",
        "rotationDeg",
        "xPx",
        "yPx",
        "widthPx",
        "heightPx",
        "xCm",
        "yCm",
        "widthCm",
        "heightCm",
        "sourceWidthPx",
        "sourceHeightPx",
    } <= set(manifest["placements"][0])
    assert ContractStore().validate("integrity-report", manifest["integrityReport"]) == []
    spec = SheetSpec.from_manifest(manifest)
    assert spec.dpi == DPI
    assert len(spec.placements) == len(manifest["placements"])


@pytest.mark.parametrize(
    "field",
    ["schemaVersion", "sheet", "parameters", "placements", "integrityReport", "generatedAt"],
)
def test_a_manifest_missing_a_required_field_is_refused(packed, field: str) -> None:
    _outcome, _root, _path, manifest = packed
    broken = json.loads(json.dumps(manifest))
    del broken[field]
    with pytest.raises(ContractValidationError):
        require_manifest_valid(broken)


def test_a_manifest_with_extra_fields_is_refused(packed) -> None:
    _outcome, _root, _path, manifest = packed
    broken = json.loads(json.dumps(manifest))
    broken["placements"][0]["surprise"] = 1
    with pytest.raises(ContractValidationError):
        require_manifest_valid(broken)


def test_a_rotated_placement_keeps_the_source_dimensions(packed) -> None:
    _outcome, _root, _path, manifest = packed
    for entry in manifest["placements"]:
        turned = entry["rotationDeg"] in (90, 270)
        assert entry["widthPx"] == (entry["sourceHeightPx"] if turned else entry["sourceWidthPx"])
        assert entry["heightPx"] == (entry["sourceWidthPx"] if turned else entry["sourceHeightPx"])
        assert entry["xPx"] % manifest["parameters"]["cellPx"] == 0


def test_flat_png_is_readable_at_the_right_size_and_dpi(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    out = tmp_path / "sheet.png"
    written = write_flat_png(manifest, root, out)
    with Image.open(written) as image:
        assert image.size == (manifest["sheet"]["widthPx"], manifest["sheet"]["heightPx"])
        assert image.mode == "RGBA"
        assert image.info["dpi"] == pytest.approx((DPI, DPI), abs=0.01)
    assert pixels_of(written)[..., 3].max() > 0


def test_flat_tiff_reports_size_mode_and_resolution(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    out = tmp_path / "sheet.tif"
    written = write_flat_tiff(manifest, root, out, strip_rows=32)
    with Image.open(written) as image:
        assert image.size == (manifest["sheet"]["widthPx"], manifest["sheet"]["heightPx"])
        assert image.mode == "RGBA"
        assert image.info["dpi"] == pytest.approx((DPI, DPI), abs=0.01)
        assert image.tag_v2[296] == 2  # inch
        assert float(image.tag_v2[282]) == DPI
        assert image.tag_v2[258] == (8, 8, 8, 8)
        assert image.tag_v2[277] == 4


def test_png_and_tiff_carry_the_same_pixels(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    png = write_flat_png(manifest, root, tmp_path / "a.png", strip_rows=37)
    tiff = write_flat_tiff(manifest, root, tmp_path / "a.tif", strip_rows=13)
    assert np.array_equal(pixels_of(png), pixels_of(tiff))


def test_strip_height_does_not_change_the_result(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    references = [
        pixels_of(write_flat_png(manifest, root, tmp_path / f"s{rows}.png", strip_rows=rows))
        for rows in (1, 7, 64, 4096)
    ]
    assert all(np.array_equal(references[0], other) for other in references[1:])


def test_exports_are_atomic_and_leave_nothing_behind_when_they_fail(
    packed, tmp_path
) -> None:
    _outcome, root, _path, manifest = packed
    broken = json.loads(json.dumps(manifest))
    broken["placements"][0]["filePath"] = "b1/gone/versions/absent.png"
    out_dir = tmp_path / "exports"
    out_dir.mkdir()
    target = out_dir / "never.png"
    with pytest.raises(MissingSourceError):
        write_flat_png(broken, root, target)
    assert not target.exists()
    assert [path.name for path in out_dir.iterdir()] == []


def test_an_existing_artifact_is_not_replaced(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    target = tmp_path / "sheet.png"
    write_flat_png(manifest, root, target)
    with pytest.raises(OutputExistsError):
        write_flat_png(manifest, root, target)
    write_flat_png(manifest, root, target, overwrite=True)


def test_an_input_file_can_never_be_an_export_target(packed) -> None:
    outcome, root, _path, manifest = packed
    design = outcome.request.designs[0]
    source = root / design.file_path
    before = source.read_bytes()
    root.read_bytes(design.file_path)  # registers it as an input of this run
    with pytest.raises(InputImmutableError):
        write_flat_png(manifest, root, source)
    assert source.read_bytes() == before


def test_psd_bundle_writes_flat_png_manifest_and_script(packed, tmp_path) -> None:
    _outcome, root, _path, manifest = packed
    directory = tmp_path / "bundle"
    written = write_psd_bundle(manifest, root, directory)
    assert {path.name for path in directory.iterdir()} == {
        "sheet.png",
        "placements.json",
        "rebuild.jsx",
    }
    assert read_manifest(written["manifest"])["integrityReport"] == manifest["integrityReport"]
    with Image.open(written["flatPng"]) as image:
        assert image.size == (manifest["sheet"]["widthPx"], manifest["sheet"]["heightPx"])
    script = written["script"].read_text(encoding="utf-8")
    assert "app.preferences.rulerUnits = Units.PIXELS" in script
    assert "SOURCE_ROOT" in script
    for entry in manifest["placements"]:
        assert entry["filePath"] in script
        assert str(entry["xPx"]) in script


def test_the_rebuild_script_negates_clockwise_rotations(packed) -> None:
    _outcome, _root, _path, manifest = packed
    spec = SheetSpec.from_manifest(manifest)
    script = build_rebuild_script(spec)
    assert "layer.rotate(-item.rotation" in script
    assert json.loads(script.split("var MANIFEST = ", 1)[1].split(";\n", 1)[0])


@pytest.mark.parametrize("name", REFUSED_FORMATS)
def test_layered_formats_are_refused_with_a_reason(packed, name: str) -> None:
    _outcome, root, _path, manifest = packed
    with pytest.raises(ExportFormatUnavailableError) as excinfo:
        export_artifact(name, manifest, root, Path("/tmp/nope"))
    assert excinfo.value.code == "export-format-unavailable"
    assert "psd-bundle" in str(excinfo.value)
    assert set(excinfo.value.details["available"]) == set(AVAILABLE_FORMATS)


def test_unknown_formats_are_listed_not_guessed() -> None:
    assert resolve_format("flat-png") == "flat-png"
    with pytest.raises(ExportFormatUnavailableError):
        resolve_format("tiff-layers")
    assert set(ALL_FORMATS) == set(AVAILABLE_FORMATS) | set(REFUSED_FORMATS)


def test_changed_sources_are_detected(packed, tmp_path) -> None:
    outcome, root, _path, manifest = packed
    assert verify_source_hashes(manifest, root) == []
    design = outcome.request.designs[0]
    (root / design.file_path).write_bytes(b"tampered")
    problems = verify_source_hashes(manifest, root)
    assert problems == [
        {"designId": design.design_id, "reason": "changed", "path": design.file_path}
    ]


def test_missing_sources_are_detected(packed) -> None:
    outcome, root, _path, manifest = packed
    (root / outcome.request.designs[0].file_path).unlink()
    problems = verify_source_hashes(manifest, root)
    assert problems[0]["reason"] == "missing"


def test_the_manifest_carries_the_integrity_report_id(packed) -> None:
    _outcome, _root, _path, manifest = packed
    spec = SheetSpec.from_manifest(manifest)
    assert spec.report_id == manifest["integrityReport"]["reportId"]
    assert spec.alpha_threshold == manifest["parameters"]["alphaThreshold"]
