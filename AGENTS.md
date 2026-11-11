# AGENTS.md — PrintSheet Workbench

This file is the operating manual for any AI agent (or human) picking up this
repository. Read it first, then `ARCHITECTURE.md`, `docs/domain-model.md`, the
ADRs, and the frozen contracts before changing code.

**If you are close to a token limit, stop feature work and update the “Live
status” and “Handoff log” sections at the bottom of this file before you run
out.** Do not leave the next agent guessing.

---

## 1. Project in one paragraph

PrintSheet Workbench is an internal, review-driven tool for a custom T-shirt
DTF printing business. Staff upload ~20 customer designs per batch (often
low-quality PNG screenshots). The tool proposes trim, crop, upscale and final
print sizing. Background removal and vectorization were retired in contract
v2.0.0; their historical versions stay readable. A human approves every step. The
packer nests approved designs onto a master sheet that is exactly 58 cm wide
(6850 px at 300 DPI); sheet height is minimized because print cost is
proportional to height. Every processing step creates a new immutable
`DesignVersion`; originals are never overwritten; exports are blocked unless a
machine-readable integrity check passes.

**Core rule:** the machine proposes, the human approves, nothing is lost.

**Workflow objective:** minimize staff time spent cropping, enhancing, and
packing while keeping the workbench human-led. Staff will review and update the
Photoshop sheet at the end; the product must assist that handoff, not automate
the whole workflow or silently approve image changes.

---

## 2. Non-negotiable product rules

1. The original upload is never modified or overwritten.
2. Every processing step creates a new immutable `DesignVersion` (file + step
   type + parameters + parent). “Current version” is only a pointer. Reject,
   undo, and revert-to-any-earlier-version must work. Always copy.
3. Rejecting a preview returns to the previous version and offers: adjust
   parameters, use the manual tool, or skip.
4. Previews must be honest: checkerboard **and** selectable solid colors
   (white/black/custom garment color). Halos and fringes only show there.
5. The packer never recolors or crops pixels, and only translates and rotates
   by multiples of 90°. Its single resampling exception is fitting an approved
   image into an explicitly selected physical target box with Lanczos; that
   emits a `target-resampled` warning and remains reviewable. Rendering uses the
   approved full-resolution pixels.
6. A blocking integrity check runs before every export.
7. Sizes are stored in physical units (cm) **and** pixels. Working resolution is
   300 DPI (configurable).
8. Never silently alter a design: anything that can change visible pixels is a
   proposal requiring approval.
9. Only approved versions may become current.
10. A batch can be packed only when every non-excluded design is `ready`.
    Packing a selected subset is a preview: omitted designs are reported as
    `not-selected`, and the sheet cannot pass integrity/export until they are
    packed too or explicitly excluded.
11. Placements are invalidated when any design, target size, or batch geometry
    changes after packing.
12. Designs wider than the roll are rejected or scaled only by explicit user
    choice — never silently.

---

## 3. Assignment and phase boundaries

The original prompt references a `YOUR ASSIGNMENT` section that was **not
present** in the conversation. The agent working on 2026-11-05 assumed the
assignment was **Phase 0**, because Phase 0 is explicitly single-agent and
blocks every other track. That assumption is recorded here.

**Current phase: Phase 3 real-world image-quality and GPU validation.** Phase 2
integration and Compose runtime verification are complete. Focus is image
enhancement and upscaling: enhancement quality, fast GPU execution,
source-resolution guidance, and review UX. The final Photoshop sheet remains
human-reviewed and updated.

Contract v2.0.0 retired background removal and vectorization, added optional
packing of a selected subset, made `all-designs-placed` the fifth blocking
integrity check, and versioned IntegrityReport as `2.0`. The API, worker,
packer, web and Compose images are aligned on v2.0.0; the fixture E2E and a
live GPU upscale both pass.

Phase 0 deliverables:

- [x] Repo skeleton: `api/`, `worker/`, `packer/`, `web/`, `contracts/`,
      `docs/`, `fixtures/`, `scripts/`
- [x] .NET Clean Architecture skeleton with health check and unit conversion
- [x] Worker FastAPI skeleton with health endpoint
- [x] Packer package/CLI shell and contract validator
- [x] Web Vite/React shell with live API health check
- [x] PSD/PSB spike executed
- [x] `ARCHITECTURE.md`
- [x] ADRs: stack split, queue choice, PSD limits, packer algorithm, storage,
      immutable versioning
- [x] Domain model document
- [x] OpenAPI 3.0.3 API contract
- [x] JSON Schemas: worker job, worker result, packer request/response,
      integrity report
- [x] Contract examples + validation script, all green
- [x] PSD spike report in `docs/spikes/psd-spike/` (scripts + results + report)
- [x] `/fixtures` realistic sample inputs + manifest (generated, not committed)
- [x] `docker-compose.yml` + Dockerfiles verified with `make up`; all services
      become healthy, the smoke test passes, and the fixture flow completes
      through export.
- [x] Native run scripts / Makefile
- [x] Root `README.md`
- [x] Final Phase 0 verification and handoff summary (all gates green except the
      Docker run noted above)

Phase 1 track status:

- **A — API:** core aggregates, state machine, versioning, job services,
  endpoints, and persistence are implemented in the current worktree. The
  existing 10 domain tests pass; live workflow coverage is added in Phase 2.
- **B — Worker:** image processing implementation is integrated; 234 tests
  pass.
- **C — Packer:** nesting, integrity checks, and export implementation is
  integrated; the complete packer suite has 157 passing tests.
- **D — Web:** batch/design/sheet/settings workflow screens are implemented
  against the mock API. Brush editing is now wired to immutable mask proposals.
  The web suite has 111 passing tests.

Phase 2 progress:

- The packer runner claims pack, integrity and export jobs, heartbeats leases,
  invokes the packer CLI and reports results through the internal API protocol.
- Compose and the native worker launch script enable the worker job loop.
- `scripts/e2e_fixture_flow.py` and `make e2e-fixtures` exercise intake through
  resize approval, packing, integrity verification and PNG export.
- Settings screens and API settings were implemented in Phase 1; reviewed for
  Phase 2 and remain part of the end-to-end app.
- Native and Compose fixture workflows pass through export. The next phase is
  validating real enhancement outputs and GPU behavior on
  representative print artwork, without replacing human review.

---

## 4. Repository map

```text
.
├── AGENTS.md                    ← this file (keep status current)
├── README.md                    ← quick start, contracts, gates, guardrails
├── ARCHITECTURE.md              ← system design and deployment
├── docker-compose.yml           ← postgres + api + worker + packer + web
├── Makefile                     ← setup/up/test/fixtures/E2E/clean entry points
├── api/                         ← ASP.NET Core 10 LTS, Clean Architecture
│   ├── PrintSheet.slnx          ← note: .NET 10 uses .slnx, not .sln
│   ├── src/PrintSheet.Domain/   ← aggregates/value objects; no infrastructure
│   ├── src/PrintSheet.Application/
│   ├── src/PrintSheet.Infrastructure/
│   ├── src/PrintSheet.Api/
│   └── tests/PrintSheet.Domain.Tests/
├── worker/                      ← Python FastAPI job loop + image processors
├── packer/                      ← standalone Python CLI/library + API job runner
│   ├── printsheet_packer/
│   └── spikes/psd-spike/        ← executable PSD/PSB reproducer
├── web/                         ← React 19 + TypeScript + Vite shell
├── contracts/
│   ├── openapi/                 ← printsheet-api.yaml (3.0.3, v2.0.0)
│   ├── jsonschema/              ← 5 worker/packer/integrity contracts
│   └── examples/                ← 15 validated examples
├── docs/
│   ├── domain-model.md          ← aggregates, state machines, invariants
│   ├── adr/                     ← 0001–0007 + index
│   └── spikes/psd-spike/        ← report + measured JSON results
├── fixtures/                    ← README + generator; generated/ is ignored
└── scripts/                     ← run, smoke-test, fixtures, contract validation
```

Runtime storage layout (never write outside this shape):

```text
storage/{batchId}/{designId}/{versionId}.png
storage/{batchId}/{designId}/versions/{versionId}/mask.png
storage/{batchId}/{designId}/versions/{versionId}/vector.svg
storage/{batchId}/jobs/{jobId}/...
storage/{batchId}/exports/{exportId}/...
```

The exact storage convention can be refined in Phase 1 but is frozen in spirit:
files are exchanged through the shared storage directory, never embedded in
request bodies between services. Intake upload is the sole HTTP-body exception
(multipart upload is stored immutably).

---

## 5. Tech stack and local toolchain facts

Verified on the development machine on 2026-11-05:

| Tool | Local version | Container target |
| --- | --- | --- |
| .NET SDK | 10.0.402 (LTS) | `mcr.microsoft.com/dotnet/sdk:10.0` |
| Node | 26.12.1 | `node:24-alpine` (web Dockerfile) |
| npm | 11.20.0 | — |
| Python | 3.14.8 | `python:3.12-slim` (worker) |
| Docker | 29.9.2 | — |
| Docker Compose | 5.6.1 | — |
| ImageMagick | 7.1.2-34 | used only in PSD spike |

Docker daemon access was initially blocked on 2026-11-05, but was granted for
Phase 2 runtime verification on 2026-11-07. `make up`, the Compose smoke test,
and the fixture E2E now pass.

NuGet versions restored by the skeleton:

- `Microsoft.EntityFrameworkCore` 10.0.14
- `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14
- `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` 10.0.14

Python packages are specified with ranges in `worker/pyproject.toml` and
`packer/pyproject.toml`. Pin exact versions in Phase 1 only after testing the
actual GPU/runtime environment. Do not invent APIs — inspect the installed
version or docs first.

---

## 6. Current service implementations

### API (`api/`)

- .NET 10 Clean Architecture API with batch/design/version state, intake,
  approvals/reverts, step and packer jobs, settings, sheets, integrity checks,
  and exports.
- EF Core persistence supports PostgreSQL in Compose and SQLite in Development;
  `/healthz` checks the configured database and `/api/v1/info` returns contract
  version `2.0.0`.
- Supported new steps are classify, trim/manual crop, upscale and resize.
  Background-removal and vectorize versions remain readable but cannot be
  proposed; their stored mask/SVG endpoints still serve history.
- Processing steps create immutable proposed versions. The current pointer
  changes only on approval; files are stored under the shared storage root.
- `PrintUnits` implements cm↔px and effective DPI; domain tests cover it.
- Build/test commands:

```bash
cd api
dotnet build PrintSheet.slnx
dotnet test PrintSheet.slnx
```

- The API Dockerfile uses `PrintSheet.slnx` and installs `curl` for health checks.
- Development profile: SQLite (`printsheet.dev.db`), storage root `storage`.
- Compose profile: PostgreSQL, storage `/data/storage`.

### Worker (`worker/`)

- FastAPI processing service with health and worker/job endpoints.
- `PRINTSHEET_*` settings via `pydantic-settings`.
- `PRINTSHEET_MAX_GPU_JOBS` is constrained to 1 (GTX 1650 Ti, 4 GB VRAM).
- Image processing covers trim/crop, upscale, resize and classify. GPU jobs are
  constrained to one at a time. The retired background-removal/vectorize job
  types fail with a structured `retired` reason; the schema still accepts old
  documents so historical records remain readable.
- Job polling starts only when `PRINTSHEET_RUN_JOBS=true`; Compose and
  `scripts/run-worker.sh` enable it. Health-only app/test runs keep the default
  false.
- Current test suite: 195 tests.
- Tests:

```bash
cd worker
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

### Packer (`packer/`)

- Standalone package + CLI; no imports from API/worker.
- Implements conservative bitmap placement (max-pooled occupancy grid plus FFT
  free-space search), full-raster containment, sheet rendering, the five
  blocking integrity checks (including `all-designs-placed`) and supported
  export artifacts. Exact alpha silhouettes are built lazily; the search never
  buffers them. It Lanczos-resizes only when an explicit target box differs
  from the approved pixels, and warns.
- The contract validator loads all schemas into a `referencing` registry so
  packer responses can resolve the integrity-report `$ref`.
- `printsheet-packer-runner` (or `python -m printsheet_packer.runner`) claims
  packer/export jobs, heartbeats leases while subprocesses run, and reports
  results to the API. It validates storage-relative input and output paths.
- Current test suite includes runner, property and rendering coverage.
- Tests:

```bash
cd packer
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

### Web (`web/`)

- React 19 + TypeScript + Vite 8 workbench with batch intake, design review,
  preview background selection, crop and enhancement controls, sheet placement
  (including partial-selection previews), integrity/export controls, and
  settings.
- Component tests use a mock API; browser requests remain relative. The
  fixture E2E script exercises the real API and job runners.
- Proxy target: `VITE_API_PROXY_TARGET` (default `http://localhost:8080`).
- Build/lint and tests:

```bash
cd web
npm ci
npm run build
npm run lint
npm test
```

---

## 7. Frozen contracts

Contract version: **2.0.0** (breaking change 2026-11-08; frozen 1.0.0 was
2026-11-05).

Canonical files:

- `contracts/openapi/printsheet-api.yaml` — HTTP API, OpenAPI 3.0.3, 36 paths,
  66 schemas.
- `contracts/jsonschema/worker-job.schema.json` — worker request envelope with
  per-type parameters.
- `contracts/jsonschema/worker-result.schema.json` — worker completion result,
  success/failure and classifier suggestions.
- `contracts/jsonschema/packer-request.schema.json` — file-based packer input.
- `contracts/jsonschema/packer-response.schema.json` — placements + outputs,
  referencing the integrity report.
- `contracts/jsonschema/integrity-report.schema.json` — five blocking checks
  (`schemaVersion` 2.0).
- `contracts/examples/` — 15 validated examples covering every supported worker
  job type and both integrity outcomes.
- `contracts/CHANGELOG.md`, `contracts/README.md` — change policy.

Contract rules:

1. All service-to-service file exchange is by **relative storage path**, never
   base64 or file bytes in JSON.
2. Paths are relative to the shared storage root and must not contain `..`.
3. Supported worker job types: `classify`, `trim`, `upscale`, `resize`. Manual
   crop is a trim job with a manual crop rect but is recorded as a `crop`
   DesignVersion. `background-removal` and `vectorize` remain in the schema only
   so historical documents stay readable; the worker rejects new ones.
4. Packer request/response uses top-left origin, cm for placements, pixels for
   geometry, 90° rotation steps only; `designIds` may select a subset for a
   preview, and omitted designs are reported unplaced.
5. `IntegrityReport.passed` is true only when all five blocking checks pass:
   `visible-pixels-inside-sheet`, `dilated-masks-no-overlap`, `minimum-gap`,
   `pixel-equality`, `all-designs-placed`.
6. Any contract change requires:
   - updating the schema **and** examples,
   - updating this file if the change is structural,
   - notifying the other tracks in the handoff/summary,
   - a version bump for breaking changes.

---

## 8. Domain decisions already made

These are documented in detail in `docs/domain-model.md`, but agents
must not accidentally reverse them:

- `Batch` is the aggregate root; `Design` and `DesignVersion` are entities
  inside it for the MVP (20–40 designs, modest version counts).
- Batch statuses: `collecting`, `ready-to-pack`, `packed`, `exported`.
- Design statuses: `received`, `in-progress`, `ready`, `needs-better-source`,
  `excluded`.
- Version statuses: `proposed`, `approved`, `rejected`.
- Step types: `original`, `trim`, `crop`, `upscale`, `resize`. Historical
  `vectorize` and `background-removal` values remain readable but are retired
  for new proposals.
- Only one `proposed` version per design. A stale proposal (parent no longer
  current) must be rejected, not quietly rebased.
- A design becomes `ready` only when the current approved version is a `resize`
  and target dimensions are set.
- Reverting sets the current pointer to an earlier approved version; it does
  **not** create or delete a version. If the target is not a current-matching
  resize, the design returns to `in-progress`.
- The final `resize` step resamples exactly once with Lanczos to
  `round(cm * dpi / 2.54)` pixels. During packing, an approved image is
  Lanczos-fitted into an explicitly selected physical target box only when its
  pixels differ from that box; this emits `target-resampled`.
- `PrintUnits.PixelsForCentimeters` uses round-half-away-from-zero:
  58 cm × 300 DPI → 6850 px.
- Low-DPI warnings: warn below 150 DPI, strongly warn below 100 DPI. These are
  configurable settings, not scattered magic numbers.
- Full-bleed inputs (all four edges non-uniform) must not get an auto-trim
  proposal.
- Historical background-removal masks and vector SVGs stay readable and
  downloadable; they are never edited. The brush editor and new mask proposals
  are gone.
- `all-designs-placed` is the fifth blocking check. Subset packs report omitted
  designs with reason `not-selected`; any unplaced design makes
  `IntegrityReport.passed` false and blocks export.
- Job statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
  DB-backed queue with leases; GPU jobs serialized to one at a time.

---

## 9. PSD / PSB spike findings (already measured)

Environment: psd-tools **1.26.0**, Pillow 13.0.0, Python 3.14.8, ImageMagick
7.1.2-34. No Photoshop available on this machine.

Key facts:

1. psd-tools writes classic PSD at exactly 30,000 px per side.
2. At 30,001 px it automatically writes a PSB (version 2) header, including
   layers; ImageMagick reads the PSB and extracts layer rasters correctly.
3. psd-tools still enforces the **PSD 30,000 px limit** in
   `check_pixel_size`, even for PSB. Consequently it cannot composite a preview
   or read back a layer raster above 30,000 px. It can open the PSB structure
   and read layer names/bboxes.
4. Workaround: set the private `doc._updated = False` before `save()` to skip
   the >30k preview rebuild. This yields a PSB with a stale/initial composite
   preview and relies on a private attribute. Do not use as the production
   primary path.
5. `ResoulutionInfo` (sic) has a writer signature bug in 1.26.0 when written
   through `ImageResources`. Use an `ImageResource` with raw bytes
   (`300 << 16`, unit 1 = inches) to embed 300 DPI; ImageMagick then reports
   `Resolution: 300x300 PixelsPerInch`.
6. A 6850 × 31,000 PSB with one layer took ~0.63 s and ~1.2 GB peak traced
   memory; the file was 637 MB because `PSDImage.new` defaults to RAW canvas
   compression. A 6850 × 5900 PSD with 4 layers took ~0.56 s and 231 MB peak.
   Extrapolating to 6850 × 59,000 (~404 MP) is ~2.3 GB peak — not strip-based.
7. Recommended decision: guarantee flat PNG/TIFF + JSON placements manifest +
   Photoshop `.jsx` rebuild bundle; treat true layered PSD/PSB as optional for
   sheets within validated limits until a strip-based writer exists and
   Photoshop smoke tests pass. Recorded in
   `docs/adr/0003-layered-export-format.md`.

Full method, table and caveats:
`docs/spikes/psd-spike/README.md`. Raw measurements:
`docs/spikes/psd-spike/results/*.json`. The executable reproducer lives in
`packer/spikes/psd-spike/`; its large binary artifacts are git-ignored.

---

## 10. Commands and verification gates

Root entry points live in the `Makefile`:

```bash
make help          # list targets
make setup         # NuGet + worker/packer venvs + npm ci + contract venv
make up            # Compose build/start, wait for health, smoke test
make down          # stop, keep volumes
make reset         # stop and delete database + storage volumes
make logs          # follow logs
make smoke         # verify a running stack over HTTP
make test          # contracts + API + worker + packer + web
make test-api      # dotnet test PrintSheet.slnx
make test-worker   # pytest
make test-packer   # pytest
make test-web      # tsc build + oxlint
make test-contracts
make fixtures      # regenerate fixtures/generated
make e2e-fixtures  # live intake -> resize -> pack -> integrity -> export flow
make api / worker / web / worker-gpu
```

Raw commands, if you need them:

```bash
cd api && dotnet test PrintSheet.slnx
cd worker && .venv/bin/python -m pytest
cd packer && .venv/bin/python -m pytest
cd web && npm run build && npm run lint
.venv-contracts/bin/python scripts/validate_contracts.py
./scripts/e2e_fixture_flow.py  # requires a running API, worker and packer runner
```

Every logical step should pass its relevant gate before commit. The fixture
flow complements, but does not replace, packer property/adversarial tests.

---

## 11. Engineering conventions

- Clean Architecture: dependencies point inward. Domain has no infrastructure
  references. Expected failures use explicit result types, not exceptions for
  control flow.
- SOLID and dependency inversion via ports (`IImageProcessor`, `IPacker`,
  `ISheetExporter`, `IFileStore`, `IIntakeSource`).
- Configuration via options classes/env vars; no magic numbers in logic.
- Structured logging. Every job records parameters and duration.
- Immutable versions: always write a new file; never mutate an existing version
  file. Reject/revert only move pointers and record audit events.
- IDs: UUIDs.
- JSON casing: lowercase kebab statuses/enums (`in-progress`, `needs-better-source`),
  camelCase field names.
- Time: ISO-8601 UTC (`Z`) in contracts.
- Physical units: cm in API/packer placements; mm in batch margin settings;
  pixels at explicit DPI for image geometry.
- No removal of user work. If you find unfamiliar files, inspect before
  overwriting.
- Commit in small logical steps with imperative messages. The repo may not be
  committed yet when you read this; check `git log`.
- Update this file’s live status before ending a session.

---

## 12. Known pitfalls / gotchas

- .NET 10 templates create `PrintSheet.slnx`, not `.sln`. Dockerfile and docs
  must match.
- API health depends on the database. In native Development mode use SQLite;
  in Compose use PostgreSQL. Startup creates the schema for either provider;
  health checks also verify database connectivity.
- Vite dev server proxies `/healthz` and `/api`. Do not hardcode
  `http://localhost:8080` in browser code.
- The worker Docker image is CPU-only. GPU work must run natively through the
  fallback script (Windows GPU passthrough is painful).
- Python 3.14 is used locally, but worker image is 3.12. Verify package
  compatibility in both if you add pinned deps.
- `web/` uses oxlint, not ESLint.
- Do not embed image bytes in worker/packer JSON. Use relative paths + shared
  storage.
- Packer collision masks use alpha threshold 5/255 by default so faint smoke
  counts as occupied. Do not raise this silently.
- Occupancy grid rounds **up** (conservative): it may overestimate, never
  underestimate.
- The packer search cell is a power of two keeping the roll at roughly 128
  cells wide (`TARGET_CELLS_WIDE`, 64 px at 58 cm/300 DPI) and is capped at
  `COARSEST_SEARCH_CELL_MM = 5.0`. Do not feed exact per-pixel polygons or
  Shapely buffers back into the placement search; that is the path that took
  minutes on real artwork. Exact geometry is lazy and the full-resolution
  integrity gate stays authoritative.
- Clearance must be Chebyshev. The search certifies it by single-sided
  dilation (`d * cell_px + 1 >= margin_px`), and `collision_radius_px()` is
  `margin_px / sqrt(2)` for any polygon-buffer fallback. `margin_px / 2 + 1`
  is ~29% short on a diagonal and can produce a layout the gate rejects.
- Rotations are exactly 0/90/180/270. Never use PIL `rotate()` with arbitrary
  angles or resampling for packing.
- Export integrity failures must block, not warn. If a check is skipped, the
  report is not passed.
- PSD classic limit is 30,000 px per side (~254 cm at 300 DPI). Real sheets can
  reach ~59,000 px tall, requiring PSB or the rebuild bundle.

---

## 13. Recommended agent workflow

1. Read this file end-to-end.
2. Read `ARCHITECTURE.md` and the relevant ADR/domain section when they exist.
3. Read the frozen contract you are about to implement. Do not guess field
   names.
4. Inspect installed library versions/source before using an API.
5. Make the smallest change that satisfies the current phase.
6. Run the relevant tests/validation.
7. Commit.
8. Update **Live status** below (done / in progress / next / blockers).
9. If a contract changed, add a note under **Contract change notifications**.

If context is running low, prioritize in this order:

1. Leave the repo buildable/testing green.
2. Update this file with exact state and next action.
3. Commit work-in-progress on a branch or at least ensure files are saved.
4. Do not start a large new feature you cannot finish.

---

## 14. Live status

**Last updated:** 2026-11-11 (design review page: Photopea retry, slider fit, capped preview, approve/reject modal, live-jobs badge)

**Done and verified:**

- Git repo initialized (`main`); skeleton commit `d0d44b9`; Phase 0 deliverable
  commit `9f52d0b`.
- API Clean Architecture implementation builds; 11 domain tests and 5
  infrastructure tests pass. The live fixture-flow script covers the API job
  lifecycle.
- Worker processing covers classify, trim/crop, upscale, resize and
  background-removal; 225 tests pass. Background removal runs a colour key
  (`color-to-alpha`) or reapplies brush edits to an earlier mask (`none`) and
  produces a non-destructive mask artifact; its `ai` (BiRefNet) mode is archived
  and fails with `unsupported-parameters`. Retired vectorize jobs fail with a
  structured `retired` reason while historical schema documents stay readable.
- Packer conservative-bitmap nesting/integrity/export implementation is
  integrated. Lease-based API runner has targeted tests for pack, integrity,
  export, path safety, failure payloads and lease loss; the complete packer
  suite has 161 passing tests. Full source rasters remain inside sheet bounds,
  integrity rejects clipped source padding, and `all-designs-placed` blocks
  export when a selected design is unplaced.
- **Packer performance defect fixed (2026-11-09).** The old placement search
  unioned exact Shapely alpha silhouettes and buffered them for all four
  rotations. On real full-resolution artwork that took minutes before a single
  design was placed. The search now runs on a max-pooled occupancy bitmap and
  finds positions by FFT cross-correlation of the free grid against each
  rotated query mask. Exact `DesignMask.geometry` is lazy, so the search never
  builds silhouette polygons. The search cell is a power of two that keeps the
  roll at roughly 128 cells (`TARGET_CELLS_WIDE`; 64 px at 58 cm/300 DPI) and
  is capped at `COARSEST_SEARCH_CELL_MM = 5.0`.
- **Packer diagonal gap-certificate defect fixed.** The blocking `minimum-gap`
  check measures a Chebyshev gap, while a radial (mitre) buffer of `r` only
  certifies `2r / sqrt(2)`. `collision_radius_px(margin_px)` is now
  `margin_px / sqrt(2)` (the old `margin_px / 2 + 1` was ~29% short), and the
  raster path certifies clearance by single-sided dilation so empty cells imply
  at least `d * cell_px + 1` pixels. The previous strict-xfail regression test
  now passes normally.
- **Live user-batch validation (2026-11-09).** Ten ready PNGs from
  `~/Downloads/test` (3000–3500 px per side) pack with 31 orderings and a
  20 s budget: search ~5 s, whole `run_pack` ~16 s (integrity ~11 s), sheet
  6850 × 11190 px, all ten designs placed, all five integrity checks passing.
  CLI `pack` and `verify` both exit 0. Full packer benchmark on synthetic
  blobs: 1 design 0.7 s, 10 designs 10.3 s, 40 designs 67 s with 1.26 GB peak
  RSS; all five checks pass.
- Web workflow routes (including partial-selection packing previews) are
  implemented. `npm test`: 200 passed across 16 files. `npm run build` succeeds;
  `npm run lint` exits successfully with existing React-hook/fast-refresh
  warnings.
- PSD/PSB spike rerun from the committed reproducer; report and JSON results in
  `docs/spikes/psd-spike/`.
- Frozen contracts complete at v2.0.0: 5 JSON Schemas, 15 examples, OpenAPI
  3.0.3 with 36 paths / 66 schemas. `scripts/validate_contracts.py` green.
- `ARCHITECTURE.md`, `docs/domain-model.md`, ADRs 0001–0007 with index. ADR 0004
  is superseded by 0007 for the placement-geometry and scope change.
- `scripts/generate_fixtures.py` produces 10 realistic inputs + manifest +
  contact sheet under `fixtures/generated/` (git-ignored).
- `docker-compose.yml`, `Makefile`, native run scripts, smoke test, root
  `README.md`.
- Compose `make up` builds and starts all services; `make smoke` passes and
  `docker compose ps` reports API, PostgreSQL, worker and web healthy.
- Compose storage is bind-mounted from the ignored repository `storage/`
  directory. API, packer, web, PostgreSQL, and the CPU worker are running; the
  worker health check reports writable storage and image-only capability.
  The native GPU worker uses port 8001 and claims GPU jobs only, so it can run
  alongside the Compose CPU worker on port 8000.
- `make test` passes after the v2.0.0 alignment: contracts, 11 API domain tests,
  5 infrastructure tests, 195 worker tests, 161 packer tests, and the web
  build/lint. Separately, `npm test` passes all 109 web tests.
- Compose `make e2e-fixtures` passes intake, resize approval, packing,
  five-check integrity, and PNG export (batch
  `1de0e8d2-221b-4fea-b62e-6eba25ff4157`, report `schemaVersion` 2.0).
- Release API image builds with SkiaSharp instead of the licensed ImageSharp
  package; API/domain and image-inspector tests pass.
- The pinned, checksum-verified Real-ESRGAN Linux installer and native GPU
  launcher are in place. Vulkan device 1 is the GTX 1650 Ti on this host.
  Earlier AC-powered runs: a 360 × 240 photo fixture scaled 4× to 1440 × 960 in
  7.835 s; a 960 × 320 thin signature scaled 2× in 15.560 s versus 98.159 s on
  Intel Vulkan device 0. On 2026-11-08 the host was **discharging on battery**:
  the same direct 360 × 240 ×4 run took ~28 s while the GPU stayed at 300 MHz /
  P8 (100% utilization, no boost). Plug in AC and use a performance power
  profile before judging GPU speed.
- A live API GPU job on 2026-11-08 routed to the native worker and produced
  1440 × 960 from the low-res fixture in 33.1 s, correctly retaining the
  91.0 DPI `very-low-effective-dpi` warning.
- Re-measured on 2026-11-08 with AC connected: the same 360 × 240 → 1440 × 960
  ×4 job took **12.7 s in the worker** (15.1 s end to end including queueing)
  with the GPU boosting to 1935 MHz, versus 33.1 s at 300 MHz on battery. The
  ~2.6× speedup is the power profile, not a code change — always state which
  one a timing came from.
- Upscale DPI warnings now use the source dimensions, so AI-created pixels do
  not erase a low-resolution warning; the 2× signature remains flagged at
  121.9 DPI. Visual review of the photo fixture saw detail recovery but also
  synthetic texture/sharpening artifacts. Every result remains a proposal for
  human comparison and approval.
- One user-provided 316 × 198 line-art sample was processed only in temporary
  local storage: Real-ESRGAN x4 completed on the GTX in 5.337 s but remained
  40.1 DPI at target size; Potrace produced a clean transparent preview and
  SVG in 100 ms. The original was untouched and no image was added to the repo.
- Detailed fixture and sample measurements are recorded in
  `docs/image-engine-validation.md`. Representative shop photos and color art
  still need review.
- Design review now puts Real-ESRGAN enhancement first, explains likely AI
  artifacts and the limits of upscaling, surfaces the source DPI before
  processing, and uses explicit model/scale labels. A focused route test
  verifies the selected model, scale and GPU request reach the API.
- Design review now groups cropping, enhancement and print sizing into a
  three-step expandable pipeline. Active jobs show an indeterminate progress
  bar, elapsed time, sample GPU timing, and explicit queued-worker guidance;
  transient job-poll errors retry automatically. At a 562px viewport the page
  has no horizontal overflow.
- Historical vector/background-removal runs (VTracer transparency, Potrace dark
  garment output, AI removal) remain recorded in
  `docs/image-engine-validation.md`; those engines and proposal endpoints are
  retired in v2.0.0.
- Crop, trim, upscale and API-stored job errors were revalidated on generated
  artwork. The API serializes stored errors as the contract's `code`,
  `message`, `retryable`, and object-valued `details`, so failure reasons
  display in the UI.
- The design screen reloads persisted batch jobs and reattaches to the latest
  relevant job after navigation. Existing failed jobs remain in history and
  must be resubmitted after fixes; they are not silently retried.
- API health, Compose smoke and the live failed-job response shape were checked
  against the rebuilt v2.0.0 stack.
- **Batch grid no longer downloads full-resolution PNGs (2026-11-09).** A batch
  of 25 ready-to-pack PNGs totalling ~200 MB made the design grid unusable
  because every card loaded a full PNG. `GET .../versions/{id}/file` now accepts
  an optional `maxPx` (32–2048) and renders a derived, alpha-preserving PNG with
  `SkiaSharp` whose longest side is at most `maxPx`; smaller sources are never
  enlarged. Decoding is gated to two concurrent renders, encoded bytes are
  cached in memory (256 MB, keyed by the immutable version id), and responses
  carry an `ETag` plus `Cache-Control: public, max-age=31536000, immutable` with
  `304 Not Modified` revalidation. The design grid requests `maxPx=640` with
  `loading="lazy" decoding="async" fetchpriority="low"`; the design review page
  keeps the full-resolution file `eager`/`high` because that screen exists to
  judge pixels.
- **Measured on the user's 10-PNG batch (2026-11-09).** The same batch that was
  slow to load transfers 42.35 MB of full PNGs but only 2.62 MB of 640 px
  thumbnails — 93.8% less, 16.2× smaller — with all ten cards rendering. Cold
  thumbnail render ~250 ms, cached ~15–22 ms, and a conditional request returns
  `304` with zero bytes. All ten thumbnails stay RGBA with the longest side at
  exactly 640 px and the source aspect ratio preserved (max deviation 0.0012).
  Skia ignores the PNG "quality" argument (identical bytes for every value), so
  these are lossless PNGs; WebP would be ~48% smaller but is not worth losing
  fidelity in artwork review.
- **Global jobs screen (2026-11-09).** `GET /api/v1/jobs` lists jobs across all
  batches so `/jobs` shows running work instead of only per-batch history. The
  screen sorts live jobs first, polls every 2 s, shows a live count, links each
  row to its batch and design, offers cancel with a conflict-safe refresh, and
  keeps a batch-scoped view at `/batches/:id/jobs`. Batch detail links to it.
- **Print size now follows the artwork aspect ratio (2026-11-09).** The design
  review size step links width and height by default (lock/unlock checkbox),
  offers "Use artwork size", and derives the linked side during render so a crop
  or upscale relinks the size immediately with no effect. An already-saved
  non-ratio size is preserved on load and shown as unlinked rather than silently
  rewritten. Resolution is displayed as the batch's read-only snapshotted
  working DPI, and the output pixel size at the chosen dimensions is shown.
- **Not-found responses now match the contract (2026-11-09).** The two-argument
  `ApiResults.Problem(code, message)` overload defaulted to `422`, so a missing
  batch or design returned `422` where OpenAPI documents `404`. It now routes
  through the existing `StatusFor` mapping; request-validation failures remain
  `422`. The web client already treated `404` as not-found, so the UI improves
  rather than changes behavior.
- **Current gates (2026-11-09).** API build 0 warnings/0 errors; 13 domain + 9
  infrastructure tests pass. Web `npm test`: 214 passed across 17 files (three
  consecutive runs). `npm run build` succeeds; `npm run lint` exits 0 with the
  same 17 pre-existing hook/fast-refresh warnings. `scripts/validate_contracts.py`
  green. Compose rebuilt, `make up` + `make smoke` pass, and `make e2e-fixtures`
  passes (batch `6dd8c4a0-ea49-470f-a9d2-c0841df85d24`). Live checks confirmed
  `maxPx` validation (`422` outside 32–2048), thumbnail caching/`304`, global job
  listing and filtering, and `404` for missing batch/design.

**In progress / immediate next:**

1. The native GPU worker is running from `make worker-gpu` on port 8001
   (GPU-only); the Compose CPU worker stays on port 8000. Re-run the launcher
   after a reboot or stop/start cycle.
2. Re-measure GPU speed with the laptop on AC power and the performance power
   profile. The 2026-11-08 battery run was 3–4× slower because the GPU never
   left 300 MHz; this is host power policy, not a worker bug.
3. Compare enhancement quality and time against authorized non-branded shop
   photos and color art. Nine shop designs were measured on AC power (see
   `docs/image-engine-validation.md`); the remaining gap is low-quality photos
   and screenshots rather than flat artwork.
4. Keep enhancement a reviewable proposal and the final Photoshop review/update
   human-led; measure operator time saved, not unattended automation.
5. The Phase 1–3 worktree is committed in logical slices on `main` (contracts,
   API, worker, packer, web, runtime, docs); keep feature work on top of it.
6. The raster search and diagonal-gap fix are committed and the Compose packer
   image was rebuilt; `make e2e-fixtures` passes on the new image. Keep the
   native GPU worker and Compose CPU worker roles separate.
7. Two intake paths now exist: enhancement intake (targets required, classify
   queued) and ready-to-pack intake (`readyToPack=true`, approved resize
   version, no job). The operator downloads current/proposed PNGs for
   Photoshop from the design review page and re-imports the finished PNGs.
8. The thumbnail pipeline, global jobs screen, aspect-linked print size and
   `404` status fix is committed and validated against the live stack. The
   editor profile selector plus the cutout mask controls (grow/contract,
   independent mask and image levels) are implemented, styled, and green in
   `npm run build`, `npm run lint` and `npm test`. The five design-review UI
   defects found in manual testing (Photopea startup, slider fit, unbounded
   preview, accept/reject modal, live-job indicator) are fixed in the working
   tree and green on the same gates. Leave the unrelated in-flight work
   (batch/design deletion endpoints, the 50 MB upload limit, `win-scripts/`)
   untouched.
9. The user's 25-PNG / ~200 MB batch was not on disk; the measurement above used
   the ten PNGs (51 MB on disk, 42.35 MB served) in `~/Downloads/test`. If the
   25-PNG set becomes available, re-run the grid transfer comparison to confirm
   the saving holds at that scale.
10. `GET /api/v1/jobs` returns every job newest-first with `limit` up to 200 and
    no offset. If job history grows large, add pagination before the global
    screen needs to page through it.

**Open assumptions to confirm with user later:**

- The missing `YOUR ASSIGNMENT` section was inferred to mean Phase 0.
- The MVP has no staff authentication; internal worker endpoints are protected
  by a shared `X-Worker-Key`.
- Intake uses multipart upload (stored immutably) as the one exception to the
  “no files in request bodies” rule.
- A layered export is guaranteed via flat file + manifest + `.jsx` bundle; true
  layered PSB is optional until Photoshop validation.
- Batch edits after export are allowed and the old export remains history; add
  an explicit lock command if the shop needs “sent to printer” immutability.
- The MVP allows one current sheet per batch; very tall batches must be split
  by excluding designs or accepted as one tall sheet/one export.
- Background removal is live but deliberately limited to a colour key. The
  `ai` (BiRefNet) cutout is archived in `archive/birefnet/`: it is not merely
  hidden, it is refused. Busy artwork is cut in Photoshop/Photopea and imported
  through ready-to-pack intake. Vectorization is retired the same way; all
  historical artifacts remain downloadable.

---

## 15. Handoff log

Append newest entries at the top. Keep them short and factual.

### 2026-11-11 — Five manual-testing UI defects on the design review page

- **Photopea startup failure had no exit.** The boot effect depended only on
  `[fileUrl, documentName, update]`, so a timed-out embed showed a dead overlay
  forever. Added a `retry` counter to the dependency list and, when the error
  mentions "never finished starting up", a `Try again` button plus an
  `Open Photopea in new tab` escape hatch (`.photopea-retry` in `photopea.css`).
- **Before/after slider letterboxed instead of filling.** `.comparison-layer
  .alpha-preview` used `object-fit: cover` on a non-replaced element (a no-op),
  so the image overflowed and was clipped. Now `contain`, and the slider passes
  `height: 'auto'` alongside `aspectRatio` so the box derives its height from the
  ratio rather than collapsing.
- **Design preview grew without bound.** A tall design stretched its preview to
  the column width times its ratio, pushing the approve buttons off-screen. The
  review page root is now `className="stack design-view"` and `design-review.css`
  caps `.alpha-preview-image` at `min(58vh, 620px)` (slider `min(62vh, 680px)`),
  letting `object-fit: contain` letterbox. An earlier `100vh`/`overflow: auto`
  wrapper was dropped: it nested a scroll box inside the page and produced two
  scrollbars instead of shrinking the content.
- **Accept/reject confirmation appeared nowhere useful.** Approve ran the API
  call directly and reject ran its own; neither showed the summary the operator
  needs before committing. Both buttons now open one modal (`modalOpen`,
  `modalIntent`, `data-testid="proposal-modal"`), which closes on Cancel, Escape
  or a backdrop click and confirms via `proposal-modal-approve`. The old
  `.review-modal` rule centred itself with `place-items: center` *and*
  `left: 50%; transform: translateX(-50%)`, shifting it half a width off-centre
  and below the viewport; it is now a flex-end sheet with `max-height: min(86vh,
  760px)` and a real `overflow: auto` body.
- **Running jobs were invisible outside a design page.** `LiveJobsBadge` in
  `App.tsx` polls `api.jobs.list({ limit: 200 })` every 3 s and links to `/jobs`
  when anything is queued or running; errors are swallowed so a transient read
  failure just retries.
- Gates: `npm run build` clean, `npm run lint` exit 0 (15 pre-existing warnings,
  0 errors), `npm test` 251 passed. Added
  `confirms approval in a modal that cancels without touching the proposal`,
  which asserts Approve alone does not approve, Cancel and Escape both close,
  and the proposal stays pending throughout.
- Note: `DesignReviewPage.tsx` arrived in the tree corrupted from this work (a
  `useEffect(()` missing its arrow, seven `</section>` replaced by `</div>`,
  missing `modalOpen`/`modalIntent`). Rebuilt from `bc40916` with the modal and
  wrapper applied as seven explicit replacements rather than patched in place.

### 2026-11-10 — BiRefNet archived; colour key gains grow/contract and levels

- Archived the AI cutout: `worker/app/engines/birefnet.py`, its test and every
  `worker/experiments/*.py` script moved (not deleted) to `archive/birefnet/`,
  with a README recording why it lost (GBs of RAM, ~7.5 min per 3600 px image,
  unreliable thin-type edges, hundreds of MB of weights). `onnxruntime` left
  `worker/pyproject.toml`; the `gpu` extra stays as an empty list so existing
  `pip install -e '.[gpu]'` keeps working.
- `ai` remains a legal schema/API enum value so historical jobs render, but the
  API returns `invalid-request` and the worker `unsupported-parameters` with an
  actionable message pointing at `color-to-alpha` or a Photoshop import.
- New `worker/app/mask_ops.py`: `grow_mask` (true circular offset via
  `cv2.distanceTransformWithLabels`, not a square kernel — a square kernel moves
  diagonals ~1.41x too far and took 4.8 s vs 0.3 s at 6850 px), `feather_mask`,
  `levels_lut`/`apply_levels`, `EDGE_THRESHOLD = 128`. Growing inherits the
  nearest selected alpha so a soft rim stays soft; contracting mirrors it from
  the nearest unselected pixel.
- `background.py` now applies one documented order: mode mask -> `min` with the
  reused mask -> brush ops -> grow/contract -> feather -> mask levels, with
  `imageLevels` applied independently before the mask is multiplied into alpha.
  Emits `mask-selection-offset`, `mask-edge-softened`, `mask-levels-applied`,
  `image-levels-applied`.
- Contracts (additive, still v2.0.0): `maskGrowPx` (-100..100), `maskLevels`,
  `imageLevels`, a shared `levelsAdjustment` def, `aiModel` marked deprecated.
  API `StepService` validates the range and both levels objects; web regenerated
  `schema.d.ts` and added `MaskControls` (`MaskGrowControl`, `LevelsControl`,
  live curve) plus `lib/levels.ts` mirroring the worker's LUT exactly.
- Removed the now-dead `cutout` settings, the `./models/cutout` Compose mount and
  the `PRINTSHEET_CUTOUT_MODEL_DIR` export; profiles no longer pick an AI model.
- Gates: worker 225 passed, web `npx vitest run` 250 passed, `npm run build`
  clean, API build 0 warnings, `scripts/validate_contracts.py` green (5 schemas,
  15 examples, OpenAPI v2.0.0). No packer change.
- Note: while finishing this, `DesignReviewPage.tsx` was found mid-edit from the
  unrelated modal work (a `useEffect(()` missing its arrow, `</section>` replaced
  by `</div>` in seven places, missing `modalOpen`/`modalIntent` state). Repaired
  so the file compiles; that repair is not part of this change.

### 2026-11-10 — Editor profile and advanced cutout controls (frontend UI-UX)

- Implemented editor profile presets (logo-text, illustration, soft-artwork,
  manual; order chosen so presets do not fight real images) with an overwrite
  notice when a profile changes a control from what the operator typed.
- Added the advanced cutout panel (alpha floor, alpha curve, despeckle limit,
  matting underbase) as a collapsed, progressive-disclosure `<details>` row
  inside the "Remove background" step.
- Verified tracks A and D: `npm run build` (tsc), `npm run lint` (oxlint) and
  `npm test` (vitest) all green — 249 tests across 20 files, single ~400 KB
  production bundle.
- No contract changes, no new npm dependencies; CSS follows the existing
  tokens (`--accent`, `--ink`, `--panel`, `--line`, `--muted`, `--dim`,
  `--radius`, `.row`, `.field`, `.compact-details`).
- Worker/ untouched; the advanced controls are review-side refinements of the
  worker-produced mask artifact.

### 2026-11-10 — Restored background removal: BiRefNet tiled ONNX & color-to-alpha

- Restored background removal narrowly targeted at logos, text, simple line-art and B&W artwork (MIT-licensed BiRefNet, rejecting CC BY-NC 4.0 BRIA RMBG 2.0).
- BiRefNet ONNX runs directly through `onnxruntime` without rembg dependency tree (~200 MB avoided).
- Fixed resolution loss: eliminated useless input upscaling; implemented native-scale tiling with 1200px window, 96px overlap, raised-cosine blending and budget fallback (benchmarked IoU 0.957 vs 0.659 single-pass). Single-pass matches reference bit-parity.
- Supported modes: `ai` (`birefnet-massive`, `birefnet-general`, `birefnet-general-lite`), `color-to-alpha` (unmultiplied GIMP ramp), `none` (brush-only mask edits).
- Non-destructive review workflow: outputs 8-bit mask artifact (`outputArtifacts.mask` / `VersionArtifacts.maskUrl`), source never overwritten. "View mask artifact" links in UI for both current and proposed versions.
- Added pipeline stage 3: "Remove background" with "Cutout model" disambiguation in `DesignReviewPage.tsx`. Ancestry tracked via `pipelineStatus.ts`.
- Gates: `make test` green across all services (contracts valid, 22 API tests, 214 worker tests, 161 packer tests, web build/lint and 215 web tests). Compose and native run scripts wired to `./models/cutout` at the time; that wiring was removed on 2026-11-10 when BiRefNet was archived.

- Batch grid was loading every full-resolution PNG. Added `IImageThumbnailer`
  (`SkiaImageThumbnailer`) and an optional `maxPx` (32–2048) on the version-file
  endpoint. Two concurrent decodes, 256 MB in-memory cache keyed by immutable
  version id, `ETag` + immutable `Cache-Control`, `304` on revalidation. Grid
  cards use 640 px lazy thumbnails; the review page keeps full resolution.
- Measured on the user's ten PNGs in `~/Downloads/test`: 42.35 MB → 2.62 MB for
  the grid (93.8% saved, 16.2×). Cold render ~250 ms, cached ~15–22 ms. All ten
  remain RGBA at 640 px longest side with aspect preserved. Skia ignores PNG
  `quality` (identical bytes for every value), so output is lossless; WebP was
  ~48% smaller but rejected to keep review fidelity.
- Added global `GET /api/v1/jobs` (status/type/limit) plus `/jobs` and
  `/batches/:id/jobs` screens: live jobs first, 2 s polling, live count, batch
  and design links, cancel with 409-safe refresh.
- Design review now links print width/height to the artwork aspect ratio by
  default with an explicit unlock, "Use artwork size", read-only batch DPI, and
  derived output pixels. The linked side is computed during render, so a crop or
  upscale relinks immediately without an effect; a saved non-ratio size is
  preserved and shown unlinked.
- Fixed a real contract mismatch: `ApiResults.Problem(code, message)` defaulted
  to `422`, so missing batch/design returned `422` where OpenAPI documents
  `404`. Now routed through `StatusFor`; validation errors stay `422`.
- Also fixed an intermittent web test race: two assertions on the 1 s job poller
  used `waitFor`'s default 1 s timeout, so a loaded worker could lose by a tick.
  Raised those two waits to 4 s; three consecutive full runs are green.
- Gates: API build 0 warnings/errors, 22 API tests pass; web 214 tests across 17
  files, build green, lint at the same 17 pre-existing warnings; contracts
  valid; Compose rebuilt with `make up`, `make smoke` and `make e2e-fixtures`
  passing (batch `6dd8c4a0-ea49-470f-a9d2-c0841df85d24`).
- Contract changes are additive, so the version stays 2.0.0; recorded in
  `contracts/CHANGELOG.md`.

### 2026-11-09 — Packer raster search and diagonal gap fix

- Root cause of "packing runs forever": exact Shapely silhouette union and
  mitre-buffer collision search on full-resolution artwork. On the user's ten
  ready PNGs (3000–3500 px per side), `load_masks` alone took 17 s and
  `Packer.__init__` exceeded 5 minutes before being killed.
- Replaced the polygon placement search with a conservative max-pooled
  occupancy bitmap and FFT cross-correlation free-space search. `DesignMask`
  geometry is now lazy; the search never builds it. The search cell keeps the
  roll at roughly 128 cells wide (64 px at 58 cm/300 DPI) and is capped at
  5 mm, so the configured occupancy cell cannot make packing pathological.
- Clearance is certified by single-sided Chebyshev dilation
  (`d * cell_px + 1 >= margin_px`). Fixed `build_footprint`'s collision buffer
  to `margin_px / sqrt(2)` via `collision_radius_px()`, replacing the
  `margin_px / 2 + 1` radius that was ~29% short on diagonals; the previous
  strict-xfail regression test now passes.
- Live validation on the user batch: 31 orderings, 20 s budget, search ~5 s,
  whole `run_pack` ~16 s (integrity ~11 s), 6850 × 11190 px sheet, all ten
  designs placed, all five checks pass; CLI `pack` and `verify` exit 0.
  Benchmark on synthetic blobs: 1 design 0.7 s, 10 designs 10.3 s, 40 designs
  67 s / 1.26 GB peak RSS, all five checks passing.
- Packer suite: 161 passed; ruff clean. No contract changes. Committed as
  `fe7e23a`. Rebuilt the Compose packer image and `make e2e-fixtures` passed
  (batch `d7144197-1277-40ae-8545-1edcc97c5f16`, integrity passed, export
  written).

### 2026-11-08 — Photoshop handoff and ready-to-pack intake

- Added `readyToPack` intake: an operator's Photoshop-exported PNG becomes an
  approved `resize` version with a separate immutable file, derives target
  centimetres from pixels at the batch DPI when omitted, and queues no job.
  Mismatched centimetres fail with `invalid-target-size`.
- Added batch UI multi-file ready import with local pixel previews, plus
  "Download for Photoshop" links for the current and proposed versions on the
  design review page. No editor launch: the operator saves the file and opens
  it locally.
- Live verified: 1417 × 1417 PNG → 11.9973 × 11.9973 cm, `ready`, zero jobs,
  pack + five-check integrity pass + PNG export. Negative cases rejected.
- AC-powered GPU re-measured at 1935 MHz: 12.7 s for 360 × 240 ×4 versus 33.1 s
  on battery. Nine shop designs x4 took 6–61 s each.
- Gates green: contracts (5 schemas / 15 examples, OpenAPI v2.0.0), API 13 + 5,
  worker 195, packer 159, web build/lint and 111 tests.

### 2026-11-08 — Phase 1–3 worktree committed

- Re-ran the full gates before committing: contracts, API (11 + 5), worker
  (195), packer (159), web build/lint and 109 Vitest tests all pass.
- Committed the uncommitted Phase 1–3 work in seven slices on `main`:
  contracts v2.0.0, API workflow implementation, worker processors, packer
  nesting/runner, web workbench, runtime/Compose/E2E wiring, and docs.
- Host is still discharging on battery, so the AC-powered GPU re-measurement
  and representative shop-sample quality review remain open.

### 2026-11-08 — Contract v2.0.0 alignment and green gates

- Finished the in-progress v2.0.0 refactor: repaired `JobCompletionService`
  (local functions had been nested inside `ReadDesignSnapshot`), regenerated
  the web OpenAPI types, and taught the sheet UI/mock/tests about the fifth
  `all-designs-placed` check and report `schemaVersion` 2.0.
- Every gate is green: contracts (5 schemas / 15 examples, OpenAPI 36 paths /
  66 schemas), API 11 + 5 tests, worker 195, packer 159, web build/lint and 109
  tests.
- Rebuilt Compose; API/worker report contract `2.0.0`, smoke passes, and
  `make e2e-fixtures` completes with a five-check passing report.
- Live GPU check: native worker on :8001 upscaled the 360 × 240 fixture to
  1440 × 960 in 33.1 s and kept the 91.0 DPI warning. Host was on battery, so
  the GPU was pinned at 300 MHz; re-measure on AC before judging speed.
- Added ADR 0007 and aligned README/ARCHITECTURE/domain-model/AGENTS with the
  retired background-removal/vectorize scope and polygon placement.

### 2026-11-08 — Image-processing job troubleshooting

- Fixed crop serialization (`CropRect.Area` no longer leaks into the worker
  contract), storage ownership for native/Compose workers, and missing worker
  dependencies for VTracer and AI background removal.
- Configured the native GPU worker as GPU-only on port 8001, alongside the
  Compose CPU worker on port 8000. Compose has a writable shared storage bind
  mount and persistent model/cache directories.
- Reattached the design review UI to persisted jobs after navigation. Job
  failures remain in history; the UI now receives errors in the expected
  contract shape, including object-valued details.
- Validated crop, trim, Potrace, VTracer, key-color removal, and AI removal on
  generated artwork. Full `make test` passes (API 11+5, worker 238, packer
  157, contracts and web build/lint); `npm test` passes 114 tests. Compose API
  and CPU-worker health pass.
- The native GPU worker is configured but not running. Representative shop
  photo/color-art quality review remains open; no customer artwork was used for
  the generated-art engine checks.

### 2026-11-07 — Native GPU worker handoff

- `make worker-gpu` initially failed because the Compose worker already bound
  port 8000. Stopped the Compose worker so the native worker can bind that port.
- Found that Compose used a Docker-only named storage volume, while the native
  worker defaults to repository `storage/`. Copied the existing 28 files
  without deleting the original volume, changed API/worker/packer mounts to
  `./storage:/data/storage`, and updated deployment guidance.
- Recreated API, worker and packer against the bind mount; API and packer are
  running, API health is green, and Compose worker is stopped. User can now run
  `make worker-gpu` from the repository root; the native worker will use the
  same artwork storage as the Compose API.

### 2026-11-07 — Phase 3 fixture-backed engine validation

- The user set the next phase: validate real-world image quality and GPU
  processing, using Real-ESRGAN/Upscayl-compatible models for photo
  enhancement. The final Photoshop sheet remains human-reviewed and updated;
  the goal is less time cropping, enhancing, and packing, not full automation.
- Verified the official Real-ESRGAN bundle installer by checksum and pinned
  the GPU launcher to Vulkan device 1 (GTX 1650 Ti) on this Intel-first host.
  A 360 × 240 photo fixture scaled 4× in 7.835 s, with NVIDIA utilization
  peaking at 97% and memory at 686 MiB. A 960 × 320 signature scaled 2× in
  15.560 s on NVIDIA versus 98.159 s on Intel device 0.
- Fixed upscale DPI metadata/warnings to use source pixels; the enlarged
  signature correctly remains flagged at 121.9 DPI. Photo output showed detail
  recovery and synthetic texture/sharpening, so human review remains required.
- Tested one user-provided 316 × 198 line-art sample locally without modifying
  the original: Real-ESRGAN x4 completed in 5.337 s but remained 40.1 DPI at
  target size; Potrace produced a clean transparent preview and SVG in 100 ms.
  No image was stored in the repository.
- Ran real VTracer color and Potrace dark-garment binary jobs in the worker
  container. VTracer retained transparency (467,289 fully transparent pixels
  in the 1,000 × 1,000 preview); Potrace kept the background transparent and
  the traced ink light on a dark garment.
- Root causes for "doesn't work": no Real-ESRGAN binary/models installed;
  Compose worker excludes the `gpu` capability; worker image omitted Potrace,
  VTracer and SVG rasterization dependencies. These dependencies and native
  GPU setup are now wired. VTracer 0.6.15 segfaults on Python 3.14 and works
  on Python 3.12; a guard prevents native Python 3.14 use.
- Source-level test gates pass: `make test`, 112 web tests, and 238 worker
  tests. Representative real-world quality is still unverified because no
  representative photo or color samples have been processed.

### 2026-11-07 — Enhancement priority

- The user prioritized image enhancement and upscaling over secondary
  vectorization/packing work.
- Moved the Real-ESRGAN controls into the primary Image enhancement card,
  clarified photo/general versus anime-style model selection, added review and
  source-detail caveats, and surfaced effective source DPI before processing.
- Added a route test verifying chosen model, scale, and GPU request. Focused
  route tests (7), TypeScript production build, and lint passed; lint still
  reports existing React hook/fast-refresh warnings.
- Next: use authorized non-branded shop photo/color samples for quality
  comparison; none were available during the prior review.

### 2026-11-07 — Job progress and multistep pipeline UX

- The user reported long enhancement waits with no progress indicator and asked
  for a simpler multistep pipeline.
- Job polling now checks each second and retries after transient read failures.
  The design screen shows queued versus running state, elapsed time, an
  indeterminate activity bar (the engine exposes no reliable percent), recent
  measured GTX timings for small upscales, and guidance when a GPU job waits
  for a native worker.
- Grouped preparation/crop, Real-ESRGAN enhancement, background/vector cleanup,
  and print sizing into expandable numbered pipeline stages; enhancement opens
  by default. Image analysis and history are collapsed until requested.
- Added route coverage for queued/running progress, elapsed time, and stage
  actions. All 114 web tests pass; production build and lint pass with existing
  warnings. Browser check at 562px found no horizontal overflow.

### 2026-11-07 — Phase 2 Compose runtime verification

- Docker access was granted. `make up`, `make smoke`, Compose service health,
  and `API_URL=http://127.0.0.1:8080 make e2e-fixtures` all pass.
- Fixed Release API publishing after the EF Core analyzer cache issue, replaced
  licensed ImageSharp with SkiaSharp, and added image-inspector tests.
- Compose runtime checks exposed the web healthcheck host mismatch, missing
  PostgreSQL schema initialization, and upload-stream ownership issue; fixes
  are covered by the image-inspector tests and successful fixture flow.
- The packer image omitted `contracts/jsonschema`; it now builds from the
  repository root and includes the frozen schemas. The first Compose pack job
  then completed with passed integrity and PNG export.
- No commits were created. Worktree includes the ongoing Phase 1/2 changes.

### 2026-11-07 — Phase 2 native verification

- Fixed service/contract mismatches found by the live flow: nullable classify
  output paths, resize pixel dimensions, and the API's persisted sheet/report
  response shapes.
- Fixed packing so the complete rotated source raster fits on the sheet, and
  made integrity fail if any source pixels are clipped, including transparent
  padding.
- Native fixture E2E passed through PNG and preview downloads. `make test`
  passed (API 10, worker 234, packer 157, contracts and web build/lint);
  `npm test` passed 111 web tests. `docker compose config --quiet` passed.
- Docker daemon/socket access remains unavailable; no commits were created.

### 2026-11-07 — Phase 2 integration work

- Added the API-backed packer runner, dedicated console entry point, Docker
  image and Compose service. Fixed flat PNG/TIFF output paths and preview
  artifact reporting; runner rejects unsafe paths and honors lease loss.
- Enabled the worker job loop in Compose and the native launch script.
- Added `scripts/e2e_fixture_flow.py` and `make e2e-fixtures` for a live
  intake-to-export flow; updated service info to report Phase 2.
- Reconciled the top-level README and architecture status. Docker Compose
  configuration validates, but daemon/socket access is still unavailable.
- Runner's nine targeted tests and lint pass. The full packer suite exposed a
  pre-existing deterministic-test assertion on `durationMs`; the assertion was
  corrected to compare stable metrics. Re-run the suite and live E2E next.

### 2026-11-07 — Resuming Phase 1 core workflows

- Implemented the web workflow routes and added the non-destructive erase/restore
  brush editor. Brush strokes are emitted in source-pixel coordinates and
  submitted with the background-removal proposal; re-editing an existing mask
  reuses its artifact and the pre-mask source so restore strokes can work.
- Added brush interaction and route tests; the full web suite passes (111 tests).
- `make test` passes: contracts, API (10 domain tests), worker (232), packer
  (144), and web build/lint. Web lint has warnings but exits successfully.
- The worker-job schema/example now explicitly permit brush-only mask
  reapplication (`mode: "none"` plus `maskFromVersionId` and `brushOps`); this
  additive contract clarification is recorded in section 16.
- API, web workflow, and brush changes remain uncommitted in the worktree.
- Next: add focused API-level tests and continue Phase 1 integration. Docker
  runtime verification remains blocked until daemon/socket access is available.

### 2026-11-05 — Phase 0 completion (Docker gate open)

- Finished all Phase 0 docs, contracts, spike report, fixtures, Compose,
  Makefile, native scripts and README. Committed as `9f52d0b`.
- `make test` and a native API/worker/web smoke test pass.
- Fixed native health: SQLite dev database is created at startup.
- Docker daemon cannot be started by the agent; `docker compose config` is
  valid, but `make up` still needs a human. Next action is section 14 item 1.

---

## 16. Contract change notifications

Contract version 1.0.0 was frozen on 2026-11-05. It was superseded by the
breaking 2.0.0 change on 2026-11-08 after two additive clarifications on
2026-11-07.

When a contract changes, add a dated entry here naming the schema/operation,
the version bump, and which tracks must adapt (API A, worker B, packer C,
web D). Also update `contracts/CHANGELOG.md` and the examples.

### 2026-11-09 — Additive: `maxPx` thumbnails, global jobs list, honest 404s

No version bump: the contract stays `2.0.0`. Both additions are new optional
surface and the status fix makes the implementation match what was already
documented, so no existing client breaks.

- **API (track A):** `GET /api/v1/designs/{designId}/versions/{versionId}/file`
  accepts optional `maxPx` (32–2048) and returns a derived alpha-preserving PNG
  with `ETag`/immutable `Cache-Control`; without `maxPx` the response is byte-
  identical to before. New `GET /api/v1/jobs` lists jobs across all batches
  (`status`, `type`, `limit` ≤ 200). Not-found conditions for batch, design,
  version, job, sheet and export now return `404` instead of `422`; validation
  failures remain `422`.
- **Web (track D):** design grid uses `versionThumbnailUrl(..., 640)` with lazy
  loading; the review page keeps the full-resolution file. New `/jobs` and
  `/batches/:batchId/jobs` screens consume `api.jobs.list`. `DesignSummary`
  gained no fields.
- **Worker (track B) / packer (track C):** no changes. Thumbnails are an
  API-only read-side derivative and never touch stored version files.
- **Generated types:** `web/src/api/schema.d.ts` regenerated from the OpenAPI
  document; `scripts/validate_contracts.py` remains green.

### 2026-11-08 — Contract 2.0.0: retire removal/vectorize, add placement guarantee

- **API:** removed `POST /steps/vectorize` and
  `POST /steps/background-removal`; retained version/artifact read endpoints
  for history. `PackSheetRequest` gains optional `designIds` for a preview
  subset. Classifier results may omit the retired suggestion fields.
- **Integrity:** `IntegrityReport` `schemaVersion` is `2.0` and
  `all-designs-placed` is the fifth blocking check; `passed` is false if any
  design is unplaced or omitted from a subset pack. Packer responses are
  `schemaVersion` `2.0` with `unplacedDesigns`.
- **Packer:** exact alpha-polygon placement; full raster containment; Lanczos
  target-box fitting only when an explicit physical target differs from the
  approved pixels, reported as `target-resampled`.
- **Worker:** `background-removal` and `vectorize` stay in the job schema for
  historical readability but are rejected as `retired`.
- **Web:** removes brush/removal/vectorize controls; adds subset pack previews
  and the fifth check to the integrity gate.
- Contract version is **2.0.0**. API A, worker B, packer C and web D are all
  aligned; historical records remain readable.

### 2026-11-07 — Brush-only mask reapplication

- Additively relaxed the worker-job background-removal schema so
  `mode: "none"` may include `brushOps` when `maskFromVersionId` is a string.
  The same change is mirrored in `worker/app/_contracts/worker-job.schema.json`;
  the example now covers reusing a mask with brush operations. Contract version
  remains 1.0.0 because the change only accepts an additional valid request.
- Tracks: API A and web D submit this request shape; worker B validates and
  processes it. Packer C is unaffected.

### 2026-11-07 — Nullable classify output path

- The worker-job schema allows `outputPath: null` for classify jobs, which do
  not produce a raster; raster-producing jobs still require a safe relative
  path. Updated the canonical and vendored schemas, classify example, changelog
  and contract documentation. Contract version remains 1.0.0 because this
  accepts an additional valid request shape.
- Tracks: API A serializes the null value and worker B validates it. Packer C
  and web D are unaffected.
