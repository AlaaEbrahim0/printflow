# PrintSheet Contracts — v2.0.0

These files define the interface between API, worker, packer and web.
Contract changes are not free: update the schema, its examples, the changelog,
and notify every track in the handoff summary.

The API contract is v2.0.0. Background removal is live again as a `color-to-alpha`
colour key plus optional mask shaping (`maskGrowPx`, `edgeSoftness`,
`maskLevels`, `imageLevels`). Its `ai` (BiRefNet) mode and the historical
`vectorize` type remain in the schemas and persisted models so existing records
stay readable, but neither accepts new work.

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
- The packer renders approved source pixels at an operator-selected physical
  target size; absent an explicit target, it preserves source resolution.
- The five blocking integrity checks are fixed IDs:
  `visible-pixels-inside-sheet`, `dilated-masks-no-overlap`,
  `minimum-gap`, `pixel-equality`, `all-designs-placed`. Reports use
  `schemaVersion` `2.0`; old `1.0` reports remain valid documents with four
  checks.
- An export is only allowed when `IntegrityReport.passed == true` for the same
  sheet revision.
- `IntegrityReport.passed` is false if any check is `failed` or `skipped`, or if
  any requested design is unplaced. A subset `designIds` pack reports omitted
  designs as `not-selected` and therefore cannot pass export.
- New worker jobs support `classify`, `trim`, `upscale`, `resize` and
  `background-removal`. The background-removal `ai` mode and the `vectorize` type
  remain in the schema only for historical readability; the worker rejects them
  (`unsupported-parameters` for `ai`, `retired` for `vectorize`).
- Classify jobs have no raster output and may carry `outputPath: null`; every
  other worker job must provide a relative output path.
- Intake supports two modes. Enhancement intake requires target centimetres and
  queues classification. Ready-to-pack intake (`readyToPack=true`) is the
  operator's Photoshop-exported PNG: the API copies it into a separate approved
  `resize` version, derives target centimetres from pixels at the batch working
  DPI when they are omitted, and queues no job. Supplied centimetres must map to
  exactly the uploaded pixels.

## Change policy

1. Update the schema and all affected examples.
2. Run `scripts/validate_contracts.py`.
3. Bump the OpenAPI `info.version` for breaking API changes. Worker and packer
   `schemaVersion` values version their respective envelopes independently.
   Additive changes still require a changelog entry.
4. Add a note in `AGENTS.md` under “Contract change notifications” and in the
   phase summary.
5. Phase 1 tracks may not invent fields that are not in these contracts without
   following the same process.

## Examples

- `worker-job-*.json`: every job type, including classify (nullable output path).
- `worker-result-*.json`: success with raster, success with mask artifact,
  classify suggestions, retryable failure.
- `packer-request.json` / `packer-response.json`: two placements, one rotated.
- `integrity-report.json` / `integrity-report-failed.json`: pass and fail.
