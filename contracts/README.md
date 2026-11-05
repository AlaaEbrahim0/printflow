# PrintSheet Contracts — v1.0.0

These files are the frozen interface between API, worker, packer and web.
Contract changes are not free: update the schema, its examples, the changelog,
and notify every track in the handoff summary.

## Files

| File | Purpose |
| --- | --- |
| `openapi/printsheet-api.yaml` | HTTP API, OpenAPI 3.0.3 |
| `jsonschema/worker-job.schema.json` | Canonical worker request (type-specific parameters) |
| `jsonschema/worker-result.schema.json` | Canonical worker completion/failure result |
| `jsonschema/packer-request.schema.json` | File-based packer input |
| `jsonschema/packer-response.schema.json` | Placements, artifacts, embedded IntegrityReport |
| `jsonschema/integrity-report.schema.json` | Blocking pre-export integrity report |
| `examples/*.json` | Executable examples validated in CI |

The OpenAPI internal worker endpoints mirror the top-level worker envelope for
transport. The standalone JSON Schemas are canonical for per-type validation.
`packer-response.schema.json` references `integrity-report.schema.json` by
`$id`; validators must load both schemas into a registry (see
`scripts/validate_contracts.py`).

## Validate

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements-dev.txt
.venv/bin/python scripts/validate_contracts.py
```

The packer CLI can validate a single document:

```bash
cd packer
.venv/bin/python -m printsheet_packer validate \
  --contract packer-request \
  --document ../contracts/examples/packer-request.json
```

## Invariants encoded here

- All service-to-service file exchange uses relative paths under the shared
  storage root. Paths must not be absolute or contain `..`.
- Worker jobs never carry image bytes.
- Packer placements use top-left origin and centimetres; rotation is exactly
  `0 | 90 | 180 | 270`.
- The packer never resamples. Width/height in a response are the post-rotation
  dimensions.
- The four blocking integrity checks are fixed IDs:
  `visible-pixels-inside-sheet`, `dilated-masks-no-overlap`,
  `minimum-gap`, `pixel-equality`.
- An export is only allowed when `IntegrityReport.passed == true` for the same
  sheet revision.
- `IntegrityReport.passed` is false if any check is `failed` or `skipped`.

## Change policy

1. Update the schema and all affected examples.
2. Run `scripts/validate_contracts.py`.
3. Bump `info.version` / `schemaVersion` for breaking changes; additive changes
   still require a changelog entry.
4. Add a note in `AGENTS.md` under “Contract change notifications” and in the
   phase summary.
5. Phase 1 tracks may not invent fields that are not in these contracts without
   following the same process.

## Examples

- `worker-job-*.json`: every job type, including classify (no output path).
- `worker-result-*.json`: success with raster, success with mask artifact,
  classify suggestions, retryable failure.
- `packer-request.json` / `packer-response.json`: two placements, one rotated.
- `integrity-report.json` / `integrity-report-failed.json`: pass and fail.
