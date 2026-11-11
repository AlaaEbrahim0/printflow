# Contract Changelog

## Additive changes — 2026-11-10

No breaking change; the OpenAPI version stays `2.0.0`. `POST
/api/v1/designs/{designId}/steps/background-removal` is back (it was removed in
2.0.0) and the worker job schema gained optional mask-shaping parameters. Every
addition is optional, so existing clients keep working unchanged.

- `BackgroundRemovalStepRequest` accepts `mode: "color-to-alpha"` (flat colour
  key: `keyColor`, `tolerance`, `edgeSoftness`) and `mode: "none"` (re-apply
  brush strokes and shaping to `maskFromVersionId`).
- `mode: "ai"` and `aiModel` remain in the schema — marked deprecated — so
  historical job records still validate and render. The API rejects them with
  `invalid-request` and the worker with `unsupported-parameters`; BiRefNet is
  archived in `archive/birefnet/`.
- New optional `maskGrowPx` (−100..100) grows (positive) or contracts (negative)
  the selection edge by that many source pixels. The offset is circular
  (Euclidean), so diagonal edges move the same distance as straight ones.
- New optional `maskLevels` and `imageLevels`, both `LevelsAdjustment`: input
  black/white points, midtone `gamma` and an optional output range, applied
  through a 256-entry lookup table. `maskLevels` reshapes the transparency;
  `imageLevels` moves the colour of the surviving pixels. They are independent.
- The worker emits `mask-selection-offset`, `mask-edge-softened`,
  `mask-levels-applied` and `image-levels-applied` warnings so the review screen
  can show what shaping was actually applied.

## Additive changes — 2026-11-09

No breaking change; the OpenAPI version stays `2.0.0`. Both additions are new
optional surface, so existing clients keep working unchanged.

- `GET /api/v1/designs/{designId}/versions/{versionId}/file` accepts an optional
  `maxPx` query parameter (32–2048). With it, the API returns a derived,
  alpha-preserving PNG whose longest side is at most `maxPx`; smaller versions
  are never enlarged. Without it, the immutable full-resolution file is
  returned exactly as before. Thumbnails are read-only derivatives keyed by the
  immutable version id, served with `Cache-Control: public, max-age=31536000,
  immutable` and an `ETag`, and revalidated with `304 Not Modified`.
- `GET /api/v1/jobs` lists jobs across every batch (optional `status`, `type`,
  and `limit`), for the global work-queue screen. `GET
  /api/v1/batches/{batchId}/jobs` is unchanged.
- Documented status codes now match the implementation: a missing batch, design,
  version, job, sheet or export returns `404 Not Found` rather than `422
  Unprocessable Entity`. Request validation failures remain `422`.

## 2.0.0 — 2026-11-08

Breaking API change: removed the vectorization and background-removal proposal
endpoints. Existing version metadata, stored artifacts, job records, and worker
job schema values remain readable for historical compatibility; new work cannot
submit these operations.

- New classifier results may omit the historical `backgroundRemoval` and
  `vectorize` suggestion fields. Worker schemas continue to accept older
  results that contain them.
- Worker job/result envelope versions remain `1.0`; their API-level contract is
  versioned independently.

## 1.0.0 — 2026-11-05

Initial Phase 0 freeze.

- OpenAPI 3.0.3 for batches, designs, versions, jobs, sheets, exports,
  settings and internal worker endpoints.
- Worker job/result JSON Schemas with per-type parameters.
- Packer request/response JSON Schemas.
- Blocking IntegrityReport schema with four fixed check IDs.
- Executable examples for every job type and both integrity outcomes.

### Additive clarification — 2026-11-07

- Allow `mode: "none"` worker jobs to carry `brushOps` when
  `maskFromVersionId` supplies the existing mask; without a mask source, brush
  operations remain invalid for `none`.
- Updated the background-removal example to cover brush-only mask reapplication.
- Permit `outputPath: null` for classify jobs, which produce suggestions but no
  raster artifact; all raster-producing worker jobs still require a safe path.
