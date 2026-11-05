#!/usr/bin/env python3
"""Validate the frozen PrintSheet contracts and their examples.

Requirements:
    pip install jsonschema openapi-spec-validator pyyaml

Run from anywhere:
    python3 scripts/validate_contracts.py
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "contracts" / "jsonschema"
EXAMPLE_DIR = ROOT / "contracts" / "examples"
OPENAPI = ROOT / "contracts" / "openapi" / "printsheet-api.yaml"


def load_schemas() -> dict[str, dict]:
    schemas: dict[str, dict] = {}
    for path in sorted(SCHEMA_DIR.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        schema_id = schema.get("$id")
        if not schema_id:
            raise ValueError(f"{path} has no $id")
        schemas[schema_id] = schema
    return schemas


def validate_schema_files(schemas: dict[str, dict]) -> list[str]:
    errors: list[str] = []
    for schema_id, schema in schemas.items():
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:  # noqa: BLE001 - report the contract failure plainly
            errors.append(f"{schema_id}: invalid JSON Schema: {exc}")
    return errors


def validate_examples(schemas: dict[str, dict]) -> list[str]:
    registry = Registry().with_resources(
        [(schema_id, Resource.from_contents(schema)) for schema_id, schema in schemas.items()]
    )
    mapping = {
        "worker-job.schema.json": sorted(EXAMPLE_DIR.glob("worker-job-*.json")),
        "worker-result.schema.json": sorted(EXAMPLE_DIR.glob("worker-result-*.json")),
        "packer-request.schema.json": [EXAMPLE_DIR / "packer-request.json"],
        "packer-response.schema.json": [EXAMPLE_DIR / "packer-response.json"],
        "integrity-report.schema.json": sorted(EXAMPLE_DIR.glob("integrity-report*.json")),
    }

    errors: list[str] = []
    for schema_name, paths in mapping.items():
        schema_id = f"https://printsheet.local/schemas/{schema_name}"
        if schema_id not in schemas:
            errors.append(f"missing canonical schema: {schema_name}")
            continue
        validator = Draft202012Validator(schemas[schema_id], registry=registry)
        for path in paths:
            if not path.exists():
                errors.append(f"missing example: {path.relative_to(ROOT)}")
                continue
            document = json.loads(path.read_text(encoding="utf-8"))
            for error in sorted(validator.iter_errors(document), key=lambda e: list(e.path)):
                location = "/".join(str(part) for part in error.absolute_path) or "<root>"
                errors.append(
                    f"{path.relative_to(ROOT)} at {location}: {error.message}"
                )
    return errors


def validate_openapi() -> list[str]:
    try:
        import yaml
        from openapi_spec_validator import validate
        from openapi_spec_validator.readers import read_from_filename
    except ImportError as exc:
        return [f"OpenAPI validation dependencies missing: {exc}"]

    if not OPENAPI.exists():
        return [f"missing OpenAPI spec: {OPENAPI.relative_to(ROOT)}"]

    spec = yaml.safe_load(OPENAPI.read_text(encoding="utf-8"))
    errors: list[str] = []
    try:
        validate(spec)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"OpenAPI invalid: {exc}")
        return errors

    operation_ids = [
        operation.get("operationId")
        for path in spec.get("paths", {}).values()
        for operation in path.values()
        if isinstance(operation, dict) and operation.get("operationId")
    ]
    duplicates = [name for name, count in Counter(operation_ids).items() if count > 1]
    if duplicates:
        errors.append(f"duplicate operationIds: {', '.join(sorted(duplicates))}")

    if spec.get("info", {}).get("version") != "1.0.0":
        errors.append("OpenAPI info.version must be 1.0.0 for the frozen contract")

    return errors


def main() -> int:
    schemas = load_schemas()
    errors: list[str] = []
    errors.extend(validate_schema_files(schemas))
    errors.extend(validate_examples(schemas))
    errors.extend(validate_openapi())

    if errors:
        print(f"CONTRACT VALIDATION FAILED ({len(errors)} issue(s))", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    example_count = len(list(EXAMPLE_DIR.glob("*.json")))
    print(
        f"Contracts valid: {len(schemas)} JSON Schemas, {example_count} examples, "
        f"1 OpenAPI spec (v1.0.0)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
