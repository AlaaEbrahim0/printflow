"""Command-line entry point: version, validate, pack, export, verify.

Everything is file-based. The packer never talks to the API, the worker or a
database; requests, placements, previews and exports travel as paths under one
storage root.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from printsheet_packer import CONTRACT_VERSION, __version__
from printsheet_packer.contracts import (
    discover_schema_dir,
    load_registry,
    parse_pack_request,
)
from printsheet_packer.errors import PackerError
from printsheet_packer.export import ALL_FORMATS, export_artifact, read_manifest
from printsheet_packer.pipeline import run_pack, verify_manifest
from printsheet_packer.storage import StorageRoot


def _repo_contract(name: str) -> Path:
    return discover_schema_dir() / name


def _validate(schema_path: Path, document_path: Path) -> int:
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    document = json.loads(document_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, registry=load_registry(schema_path.parent))
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.path))
    if not errors:
        print(f"VALID {document_path} against {schema_path}")
        return 0
    for error in errors:
        location = "/".join(str(part) for part in error.absolute_path) or "<root>"
        print(f"INVALID {document_path} at {location}: {error.message}", file=sys.stderr)
    return 1


def _add_force(subparser: argparse.ArgumentParser) -> None:
    subparser.add_argument(
        "--force",
        action="store_true",
        help="Allow replacing an existing artifact (never an input file)",
    )


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

    pack = subparsers.add_parser("pack", help="Nest a batch and write the sheet artifacts")
    pack.add_argument("--request", type=Path, required=True, help="PackerRequest JSON file")
    pack.add_argument("--storage-root", type=Path, required=True)
    pack.add_argument("--response", type=Path, help="Also write the PackerResponse here")
    pack.add_argument(
        "--no-preview", action="store_true", help="Do not write output.previewPath"
    )
    pack.add_argument(
        "--preview-width", type=int, default=900, help="Preview width in pixels (default 900)"
    )
    _add_force(pack)

    export = subparsers.add_parser("export", help="Write an export artifact from a manifest")
    export.add_argument("--manifest", type=Path, required=True)
    export.add_argument("--storage-root", type=Path, required=True)
    export.add_argument("--format", required=True, choices=ALL_FORMATS)
    export.add_argument(
        "--out", type=Path, required=True, help="Artifact path, or the directory for psd-bundle"
    )
    export.add_argument("--strip-rows", type=int, help="Rows per render strip (default 512/256)")
    _add_force(export)

    verify = subparsers.add_parser(
        "verify", help="Re-run the four blocking integrity checks against a manifest"
    )
    verify.add_argument("--manifest", type=Path, required=True)
    verify.add_argument("--storage-root", type=Path, required=True)
    return parser


def _emit(document: Any, path: Path | None) -> None:
    text = json.dumps(document, indent=2)
    print(text)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")


def _pack(args: argparse.Namespace) -> int:
    # parse_pack_request validates against the frozen schema before returning.
    request = parse_pack_request(json.loads(args.request.read_text(encoding="utf-8")))
    root = StorageRoot(args.storage_root)
    outcome = run_pack(
        request,
        root,
        preview=not args.no_preview,
        preview_width_px=args.preview_width,
        overwrite=args.force,
    )
    _emit(outcome.response, args.response)
    if not outcome.passed:
        failed = [check["id"] for check in outcome.report["checks"] if check["status"] != "passed"]
        print(
            f"integrity-failed: {', '.join(failed)}; the sheet must not be exported",
            file=sys.stderr,
        )
        return 1
    return 0


def _export(args: argparse.Namespace) -> int:
    manifest = read_manifest(args.manifest)
    root = StorageRoot(args.storage_root)
    result = export_artifact(
        args.format, manifest, root, args.out, strip_rows=args.strip_rows, overwrite=args.force
    )
    paths = [result] if isinstance(result, Path) else list(result.values())
    for path in paths:
        print(f"wrote {path}")
    return 0


def _verify(args: argparse.Namespace) -> int:
    root = StorageRoot(args.storage_root)
    outcome = verify_manifest(args.manifest, root)
    print(json.dumps(outcome.report, indent=2))
    for problem in outcome.source_problems:
        print(
            f"source-{problem['reason']}: design {problem['designId']} file "
            f"{problem['path']} ({problem['reason']})",
            file=sys.stderr,
        )
    if not outcome.report["passed"]:
        failed = [check["id"] for check in outcome.report["checks"] if check["status"] != "passed"]
        print(f"integrity-failed: {', '.join(failed)}", file=sys.stderr)
    return 0 if outcome.passed else 1


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

    handlers = {"pack": _pack, "export": _export, "verify": _verify}
    try:
        return handlers[args.command](args)
    except PackerError as error:
        print(str(error), file=sys.stderr)
        if error.details:
            print(json.dumps(error.to_dict(), indent=2), file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
