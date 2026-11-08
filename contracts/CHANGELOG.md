# Contract Changelog

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
