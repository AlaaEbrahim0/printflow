"""CLI: the version/validate shell from Phase 0 plus pack, export and verify."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from helpers import circle, request_document, ring, solid, specs, write_storage
from PIL import Image

from printsheet_packer import CONTRACT_VERSION, __version__
from printsheet_packer.cli import main
from printsheet_packer.contracts import ContractStore


def test_version(capsys) -> None:
    assert main(["version"]) == 0
    output = capsys.readouterr().out
    assert __version__ in output
    assert CONTRACT_VERSION in output


def test_validate_reports_errors(tmp_path: Path, capsys) -> None:
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["rollWidthCm"],
        "properties": {"rollWidthCm": {"type": "number", "exclusiveMinimum": 0}},
    }
    schema_path = tmp_path / "schema.json"
    document_path = tmp_path / "document.json"
    schema_path.write_text(json.dumps(schema), encoding="utf-8")
    document_path.write_text(json.dumps({"rollWidthCm": 0}), encoding="utf-8")

    assert main(["validate", "--schema", str(schema_path), "--document", str(document_path)]) == 1
    assert "INVALID" in capsys.readouterr().err


@pytest.fixture
def batch(tmp_path: Path):
    designs = specs([circle(70, 50), ring(60, 40), solid(40, 96)])
    storage = write_storage(tmp_path, designs)
    document = request_document(
        designs,
        rollWidthCm=6,
        marginMm=2,
        edgeMarginMm=1,
        cellMm=1,
        randomizedOrderings=2,
        timeBudgetMs=4000,
        seed=20261105,
    )
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(document), encoding="utf-8")
    return tmp_path, storage, request_path, document


def run_pack_cli(batch, capsys, extra: list[str] = ()) -> dict:
    tmp_path, storage, request_path, _document = batch
    response_path = tmp_path / "response.json"
    code = main(
        [
            "pack",
            "--request",
            str(request_path),
            "--storage-root",
            str(storage),
            "--response",
            str(response_path),
            *extra,
        ]
    )
    stdout = capsys.readouterr().out
    assert code == 0, stdout
    response = json.loads(stdout)
    assert json.loads(response_path.read_text(encoding="utf-8")) == response
    return response


def test_pack_writes_a_valid_response_manifest_and_preview(batch, capsys) -> None:
    tmp_path, storage, _request, _document = batch
    response = run_pack_cli(batch, capsys)
    assert ContractStore().validate("packer-response", response) == []
    assert response["integrityReport"]["passed"] is True
    assert [check["id"] for check in response["integrityReport"]["checks"]] == [
        "visible-pixels-inside-sheet",
        "dilated-masks-no-overlap",
        "minimum-gap",
        "pixel-equality",
        "all-designs-placed",
    ]
    manifest_path = storage / response["outputs"]["manifestPath"]
    preview_path = storage / response["outputs"]["previewPath"]
    assert manifest_path.is_file() and preview_path.is_file()
    with Image.open(preview_path) as preview:
        assert preview.width <= 900
    assert response["stats"]["seed"] == 20261105


def test_no_preview_keeps_the_field_out_of_the_response(batch, capsys) -> None:
    _tmp_path, storage, _request, _document = batch
    response = run_pack_cli(batch, capsys, extra=["--no-preview"])
    assert "previewPath" not in response["outputs"]
    assert not (storage / "b1/sheets/preview.png").exists()


def test_verify_passes_a_fresh_sheet(batch, capsys) -> None:
    _tmp_path, storage, _request_path, _document = batch
    response = run_pack_cli(batch, capsys)
    capsys.readouterr()
    manifest_path = storage / response["outputs"]["manifestPath"]
    code = main(["verify", "--manifest", str(manifest_path), "--storage-root", str(storage)])
    report = json.loads(capsys.readouterr().out)
    assert code == 0
    assert report["passed"] is True
    assert [check["status"] for check in report["checks"]] == ["passed"] * 5


def test_verify_fails_when_a_placement_is_moved_into_a_collision(batch, capsys) -> None:
    tmp_path, storage, _request, _document = batch
    response = run_pack_cli(batch, capsys)
    manifest_file = storage / response["outputs"]["manifestPath"]
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    manifest["placements"][1]["xPx"] = manifest["placements"][0]["xPx"]
    manifest["placements"][1]["yPx"] = manifest["placements"][0]["yPx"]
    tampered = tmp_path / "tampered.json"
    tampered.write_text(json.dumps(manifest), encoding="utf-8")

    code = main(["verify", "--manifest", str(tampered), "--storage-root", str(storage)])
    captured = capsys.readouterr()
    report = json.loads(captured.out)
    assert code == 1
    assert report["passed"] is False
    assert "dilated-masks-no-overlap" in captured.err
    assert "integrity-failed" in captured.err


def test_verify_fails_when_a_source_file_changed(batch, capsys) -> None:
    tmp_path, storage, _request, document = batch
    response = run_pack_cli(batch, capsys)
    manifest_file = storage / response["outputs"]["manifestPath"]
    target = storage / document["designs"][0]["filePath"]
    target.write_bytes(np.zeros((4, 4, 4), dtype=np.uint8).tobytes())

    code = main(["verify", "--manifest", str(manifest_file), "--storage-root", str(storage)])
    captured = capsys.readouterr()
    assert code == 1
    assert "source-changed" in captured.err


def test_export_writes_each_available_format(batch, capsys) -> None:
    _tmp, storage, _request, _document = batch
    response = run_pack_cli(batch, capsys)
    manifest_file = storage / response["outputs"]["manifestPath"]
    out_dir = storage / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    capsys.readouterr()

    assert main(
        ["export", "--manifest", str(manifest_file), "--storage-root", str(storage),
         "--format", "flat-png", "--out", str(out_dir / "sheet.png")]
    ) == 0
    assert main(
        ["export", "--manifest", str(manifest_file), "--storage-root", str(storage),
         "--format", "flat-tiff", "--out", str(out_dir / "sheet.tif")]
    ) == 0
    assert main(
        ["export", "--manifest", str(manifest_file), "--storage-root", str(storage),
         "--format", "psd-bundle", "--out", str(out_dir / "bundle")]
    ) == 0
    printed = capsys.readouterr().out
    assert printed.count("wrote") == 5

    for name in ("sheet.png", "sheet.tif"):
        with Image.open(out_dir / name) as image:
            image.load()
            assert image.size == (response["sheet"]["widthPx"], response["sheet"]["heightPx"])
            assert image.mode == "RGBA"
            assert image.info["dpi"][0] == pytest.approx(300, abs=0.01)
    assert {path.name for path in (out_dir / "bundle").iterdir()} == {
        "sheet.png",
        "placements.json",
        "rebuild.jsx",
    }


def test_export_refuses_layered_psd(batch, capsys) -> None:
    _tmp, storage, _request, _document = batch
    response = run_pack_cli(batch, capsys)
    manifest_file = storage / response["outputs"]["manifestPath"]
    capsys.readouterr()
    code = main(
        [
            "export",
            "--manifest",
            str(manifest_file),
            "--storage-root",
            str(storage),
            "--format",
            "layered-psb",
            "--out",
            str(storage / "nope.psb"),
        ]
    )
    captured = capsys.readouterr()
    assert code == 1
    assert "export-format-unavailable" in captured.err
    assert not (storage / "nope.psb").exists()


def test_pack_reports_a_design_wider_than_the_roll(batch, capsys) -> None:
    tmp_path, storage, _request, _document = batch
    too_wide = specs([solid(4000, 30)], allow_rotation=False)
    document = request_document(too_wide, rollWidthCm=10)
    write_storage(tmp_path, too_wide)
    request_path = tmp_path / "wide.json"
    request_path.write_text(json.dumps(document), encoding="utf-8")
    capsys.readouterr()

    assert main(["pack", "--request", str(request_path), "--storage-root", str(storage)]) == 1
    captured = capsys.readouterr()
    response = json.loads(captured.out)
    assert response["unplacedDesigns"][0]["reason"] == "exceeds-roll"
    assert response["integrityReport"]["passed"] is False
    assert "all-designs-placed" in captured.err


def test_pack_rejects_a_request_that_violates_the_contract(tmp_path: Path, storage, capsys) -> None:
    broken = request_document([circle(30, 30)])
    broken["alphaThreshold"] = 300
    request_path = tmp_path / "broken.json"
    request_path.write_text(json.dumps(broken), encoding="utf-8")
    assert main(["pack", "--request", str(request_path), "--storage-root", str(storage)]) == 1
    assert "contract-invalid" in capsys.readouterr().err


def test_validate_still_works_on_a_generated_request(batch, capsys) -> None:
    _tmp, _storage, request_path, _document = batch
    assert (
        main(["validate", "--contract", "packer-request", "--document", str(request_path)]) == 0
    )
    assert "VALID" in capsys.readouterr().out
