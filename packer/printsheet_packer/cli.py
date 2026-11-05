"""Command-line entry point.

Phase 0 only exposes version and contract-validation commands. The file-based
``pack`` command, integrity checks and exporters are implemented in Phase 1 C.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from jsonschema import Draft202012Validator

from printsheet_packer import CONTRACT_VERSION, __version__


def _repo_contract(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "contracts" / "jsonschema" / name


def _validate(schema_path: Path, document_path: Path) -> int:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    document = json.loads(document_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.path))
    if not errors:
        print(f"VALID {document_path} against {schema_path}")
        return 0
    for error in errors:
        location = "/".join(str(part) for part in error.absolute_path) or "<root>"
        print(f"INVALID {document_path} at {location}: {error.message}", file=sys.stderr)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="printsheet-packer")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("version", help="Print version and contract version")

    validate = subparsers.add_parser("validate", help="Validate a JSON document against a contract")
    validate.add_argument("--schema", type=Path, required=False)
    validate.add_argument("--document", type=Path, required=True)
    validate.add_argument(
        "--contract",
        choices=["packer-request", "packer-response", "integrity-report", "worker-job"],
        default="packer-request",
        help="Built-in contract when --schema is omitted",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.command == "version":
        print(f"printsheet-packer {__version__} (contract {CONTRACT_VERSION})")
        return 0

    if args.command == "validate":
        schema_path = args.schema or _repo_contract(f"{args.contract}.schema.json")
        if not schema_path.exists():
            print(f"Schema not found: {schema_path}", file=sys.stderr)
            return 2
        return _validate(schema_path, args.document)

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
