# Contract Changelog

## 3.3.0 — 2026-11-24

Additive: opt-in removal of enclosed background regions (letter counters). A
cut-out can now clear the background colour that survives *inside* artwork — the
inside of an `o`, the two bowls of a `B`, the black stripes inside a badge —
because providers only matte background reachable from the frame edge. No
existing request or response changed shape.

- `BackgroundRemovalStepRequest.removeEnclosedBackground` (boolean, nullable).
  Omit it, or send `null`, to take
  `BackgroundRemoval:RemoveEnclosedBackgroundByDefault` (default `false`); the
  resolved value is stored on the job, so a queued job is never re-interpreted
  when configuration changes. The pass runs after the compositor and before
  decontamination, so the anti-aliased ramp it rebuilds is decontaminated too.
- Job metadata when the pass is requested: `enclosedBackgroundApplied`,
  `enclosedBackgroundRegionsCleared`, `enclosedBackgroundPixelsCleared`, plus
  `enclosedBackgroundSkipped` (`no-background-key` | `region-too-large` |
  `no-enclosed-regions`) when it declined. Absent entirely when it was not
  requested, so "not asked for" stays distinguishable from "asked, nothing
  enclosed".
- A refusal is a **successful job**: refusing is the correct outcome for a design
  whose ink is the background colour. Safety is enforced by
  `BackgroundRemoval:MinCounterAreaPx` (default 64 px) and
  `BackgroundRemoval:MaxCounterAreaFraction` (default 0.10), both configuration,
  so tuning them is not a contract change. The cap is **per region**, not on the
  total enclosed area: a white "Bo8" on black is five legitimate counters adding
  up to 15% of the canvas, while an inverted logo is one region the size of the
  design.
- Preflight legitimately reports `hole-area` on the cleared counters, and
  `fill-holes` (`POST /api/v1/preflight` with `fix=true`) would put them back.
  Preflight inside the cut-out is report-only and never applies fixes.
- Tracks: API A and web D (a checkbox in the cutout step). Worker B and packer C
  are unaffected: the pass is API-side pixel work on the composited PNG, and a
  cleared counter is just alpha in an immutable version.

## 3.2.0 — 2026-11-23

Additive: DTF preflight. A cut-out now always produces a report next to its
output, and the same report can be requested for any PNG before it becomes a
version. No existing request or response changed shape.

- New `POST /api/v1/preflight` (multipart, report-only by default, `fix=true`
  returns the repaired PNG as `fixedImageBase64`). Omit the target size to judge
  the file on its own canvas at `dpi`.
- New schemas `PreflightResponse`, `PreflightReport`, `PreflightSpecSummary`,
  `PreflightFinding`, `PreflightRegion`, `PreflightMetric` and
  `PreflightFixRecord`. The report is byte-stable: findings and fixes are sorted
  by code and nothing time- or machine-dependent is serialised.
- `POST /api/v1/designs/{designId}/steps/background-removal` documents that
  preflight always runs report-only after the cut-out and writes
  `<output>.preflight.json`; job metadata gains `preflightReportPath`,
  `preflightVerdict` and `preflightFindingCount`.
- `BackgroundRemovalStepRequest.provider` also accepts `solid` and `auto`.
- Thresholds live in `Preflight:Profile` (DTO-independent options), so a profile
  change is configuration, not a contract change.
- Tracks: API A only. Worker B, packer C and web D are unaffected; the web review
  page adds the `solid` and `auto` provider buttons.

## 3.1.0 — 2026-11-21

Additive: background removal returns as a first-class step, but on a different
execution model than the 2.x cutout it replaces. The API runs the job itself
through the pluggable provider adapters (Poof or self-hosted withoutBG); the
worker is not involved and `background-removal` is **not** a worker job type.

- New `POST /api/v1/designs/{designId}/steps/background-removal` returning `202`
  with a `background-removal` job. The request body is optional and only carries
  a `provider` override.
- `JobType`/`StepType` `background-removal` are produced again. `StepType` already
  kept the value for historical readability, so no enum removal is reversed.
- New job capability `cutout`, which no worker may claim: the claim endpoint
  ignores it and never leases an in-process job to an image worker. This keeps
  the 3.0.0 promise that the worker has no cutout processor.
- `worker-job.schema.json` is unchanged; `background-removal` stays absent from
  the worker job type enum on purpose.
- The 20 MB provider upload cap is enforced on the cropped image that is actually
  uploaded, not on the untouched original.

## 3.0.0 — 2026-11-20

Breaking API change: removed background-removal and manual-edit proposal endpoints
and their worker job types. The `background-removal` and `manual-edit` step types
remain in the `StepType` enum for historical record readability; new work cannot
submit these operations. Worker job schema dropped `background-removal` from the
type enum and all mask-shaping fields (`maskMinAreaPx`, `maskGrowPx`,
`maskLevels`, `imageLevels`, `aiModel`, `brushOps`). The `IntegrityReport`
schema is unchanged at version `2.0`. Packer contracts are unchanged.

- Deleted `POST /api/v1/designs/{designId}/steps/background-removal`
- Deleted `POST /api/v1/designs/{designId}/steps/manual-edit`
- Worker job types: `classify`, `trim`, `upscale`, `vectorize`, `resize`
- Web workbench: cutout tool, manual editor, Quick Levels, Background Readout,
  and Clean button removed. `AlphaPreview` and `BackgroundPicker` retained.

## Additive changes — 2026-11-13

No breaking change; the OpenAPI version stays `2.0.0`.

- `mode: "ai"` is live again with the withoutBG open-weights matte. `aiModel`
  now documents `withoutbg-open` as the only supported value; the archived
  BiRefNet ids are refused by the API (`invalid-request`) and the worker
  (`unsupported-parameters`) instead of being silently substituted.
- New optional `maskMinAreaPx` (0..100000) on the background-removal step and
  the worker job. Opaque islands and background pinholes smaller than that area
  are dropped before grow/feather, and the worker reports `mask-regions-refined`.
  DTF prints every opaque pixel, so this is the pass that keeps specks off the
  garment.
- The worker reports `ai-cutout-applied` when the matte ran and
  `source-alpha-used` when the upload already carried a transparent background
  (its own alpha is then the selection and no inference is spent).
- No other schema changed: the AI matte feeds the same mask as the colour key, so
  `brushOps`, `maskGrowPx`, `maskLevels`, `imageLevels` and
  `maskFromVersionId` keep their existing meaning.

## Additive changes — 2026-11-11

No breaking change; the OpenAPI version stays `2.0.0`.

- New `POST /api/v1/designs/{designId}/steps/manual-edit` accepts
  `multipart/form-data` with `file` (PNG, 50 MB maximum), `sourceVersionId` and
  an optional `parameters` JSON string. It stores an immutable proposed
  `manual-edit` version and returns `201` with the updated `DesignDetail`.
  Dimensions must match the current source version; stale or pending proposals
  return `409`.
- `StepType` gained `manual-edit`. Existing versions and job records are
  unchanged.

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
