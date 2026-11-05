import json
from pathlib import Path

from printsheet_packer.cli import main
from printsheet_packer import CONTRACT_VERSION, __version__


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
