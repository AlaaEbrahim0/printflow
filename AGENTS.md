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
print sizing, plus a background-removal (cutout) step. Vectorization was retired
in contract v2.0.0 and remains readable as history only. A human approves every
step. The packer nests approved designs onto a master sheet that is exactly
58 cm wide (6850 px at 300 DPI); sheet height is minimized because print cost is
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

**Current phase: Phase 1b IndexedDB drafts.** Scope corrected 2026-11-12:
designs process one at a time; bulk upload exists only for packing intake;
3–6 occasional users; no speculative scaling, pagination, queue throughput,
or multi-worker work. Phase 1a remains complete and serves careful single-design
sessions. Finish IndexedDB drafts, then pull Phase 4 ahead for Quick Levels,
one-click Clean for background removal, background color/uniformity readout,
and color-key flow. Then Phase 2 selection tools, Phase 3 complex editor shell,
Phase 5 packing integrity, Phase 6 export. withoutbg is no longer deferred - it
shipped as the self-hosted cutout provider in v3.1.0 (see §15); color key and
Quick Levels still serve logos/text/simple illustrations. Subagents run
sequentially, at most one, mechanical tasks only; core work stays owner-written.
Worker processing stays sequential, concurrency 1 for all job types.

Contract v3.1.0 added background removal back as an additive step: a cutout is
queued like any other step but executed **in-process by the API** behind a
`cutout` job capability, because a 30-90 s synchronous request does not fit the
worker claim protocol. Contract v2.0.0 had retired background removal and
vectorization, added optional packing of a selected subset, made
`all-designs-placed` the fifth blocking integrity check, and versioned
IntegrityReport as `2.0`. The API, worker, packer, web and Compose images are
aligned on v3.1.0; the fixture E2E and a live GPU upscale both pass.

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
│   ├── openapi/                 ← printsheet-api.yaml (3.0.3, v3.2.0)
│   ├── jsonschema/              ← 5 worker/packer/integrity contracts
│   └── examples/                ← 14 validated examples
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
  version `3.2.0`.
- Supported new steps are classify, trim/manual crop, upscale, resize and
  background removal. `vectorize` and `manual-edit` are retired step types that
  remain readable in historical records but cannot be proposed anew.
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
- Image processing covers trim/crop, upscale, resize, classify. `background-removal`
  is deliberately **not** a worker job type: the API runs cutouts in-process
  (`cutout` capability), so `background-removal` stays out of `JOB_TYPES` and the
  worker-job schema. `vectorize` and `manual-edit` are retired job types; their
  schemas remain for historical readability but new work is rejected with
  `retired` or `unsupported-parameters`.
- Job polling starts only when `PRINTSHEET_RUN_JOBS=true`; Compose and
  `scripts/run-worker.sh` enable it. Health-only app/test runs keep the default
  false.
- Current test suite: 200 tests.
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

Contract version: **3.2.0** (additive on top of the 3.0.0 breaking change; the
frozen 1.0.0 was 2026-11-05).

Canonical files:

- `contracts/openapi/printsheet-api.yaml` — HTTP API, OpenAPI 3.0.3, 41 paths,
  75 schemas.
- `contracts/jsonschema/worker-job.schema.json` — worker request envelope with
  per-type parameters.
- `contracts/jsonschema/worker-result.schema.json` — worker completion result,
  success/failure and classifier suggestions.
- `contracts/jsonschema/packer-request.schema.json` — file-based packer input.
- `contracts/jsonschema/packer-response.schema.json` — placements + outputs,
  referencing the integrity report.
- `contracts/jsonschema/integrity-report.schema.json` — five blocking checks
  (`schemaVersion` 2.0).
- `contracts/examples/` — 14 validated examples covering every supported worker
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
- Step types: `original`, `trim`, `crop`, `upscale`, `resize`,
  `background-removal`. Historical `vectorize` and `manual-edit` values remain
  readable but are retired for new proposals.
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
- `vectorize` and `manual-edit` are retired step types that remain in the
  `StepType` enum for historical record readability but cannot be proposed anew.
  `background-removal` is a live step type, executed in-process by the API. All
  historical mask and vector artifacts remain readable and downloadable; they are
  never edited.
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
- Native storage: `Storage:Root` is relative, so `scripts/run-api.sh` pins
  `Storage__Root=$ROOT/storage`. Launch the API through that script; running
  `dotnet run` by hand puts the working directory at `api/src/PrintSheet.Api`
  and the worker then cannot find uploaded files
  (`input file is missing`). `make test-storage-roots` catches a split.
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
- Never hand the AI matte an RGBA image through `convert("RGB")`: that drops the
  alpha without compositing, and the RGB under a transparent pixel is undefined
  (a real shop PNG held flat grey there), so the model reads garbage as artwork.
  `WithoutBgCutout` composites on white first.
- Never re-mate an upload that already carries a cut-out alpha. Measured on
  `Meter.png` 3500 × 4834: 356 s and IoU 0.987 while shaving 1.3% of the subject,
  versus reading the stored alpha. The processor now reports
  `source-alpha-used` and skips the engine.
- A white interior that only exists because the source alpha hid it cannot be
  recovered from a flattened image by any matte. Measured +110…185% extra opaque
  area on `Meter` and `Untitled-1`. Those designs go through ready-to-pack or a
  manual cut-out; do not "fix" it by loosening a threshold.
- The AI matte is CPU ONNX and the timer is real: tens of seconds for a 1 MP
  design, ~6 minutes for 3500 × 4834 when the BiRefNet branch runs. Keep worker
  concurrency 1 and do not add a timeout that turns a slow-but-correct matte into
  a failure.
- WithoutBG weights are ~1.5 GB. They belong in `HF_HOME` (git-ignored
  `models/hf`), never in the repo or in the shared storage root.

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

## 14. Tooling verification note

The agent file viewer may strip characters such as `=`, `*`, and `=>` from displayed output. Never infer source corruption from displayed text. Verify with a clean compiler, tests, and byte-level `grep`/`od` checks before editing.

## 15. Live status

**Last updated:** 2026-11-24 (DTF preflight shipped, contracts 3.2.0)

**Done and verified:**

- **DTF preflight (2026-11-24).** Phase 2 preflight is implemented and green:
  domain (`PrintSpec`, `PreflightProfile`, `PreflightReport`), application
  (`PreflightService`/`PreflightRunner`/`PreflightAnalysis`, options +
  startup validator), infrastructure (Skia codec + `PngMetadata`, 15 checks, 5
  opt-in fixes, assembly-scanned DI) and `POST /api/v1/preflight`. The cut-out
  always runs it report-only, writes `<output>.preflight.json` and records
  `preflightReportPath`/`preflightVerdict`/`preflightFindingCount`; any preflight
  failure is logged and swallowed. Contracts 3.2.0 (additive, 41 paths / 75
  schemas), `schema.d.ts` regenerated, smoke test follows `ContractVersion.cs`.
  Verified live on a native API and through the rebuilt Compose container: a real
  cut-out produced verdict `warn` with contrast/dpi-metadata/icc-profile
  findings, the ad-hoc endpoint on the same file produced a byte-identical
  report, and `fix=true` on a screenshot-like PNG embedded `sRGB` and wrote
  `pHYs` 11811 (300 DPI).
  Two defects found by the new API test project: `fixedImageBase64` was sent as
  `null` instead of omitted, and a malformed multipart body produced an unhandled
  500 instead of a 422. API tests 26 domain / 52 application / 11 api / 111
  infrastructure (2 live skipped); web 261 tests / 20 files, build and lint green
  (same 8 pre-existing warnings).

- Git repo initialized (`main`); skeleton commit `d0d44b9`; Phase 0 deliverable
  commit `9f52d0b`.
- **GPU upscale verified (2026-11-23).** Real-ESRGAN on the GTX 1650 Ti via
  `make worker-gpu` (`:8001`) drives the GPU to 97% and the live pipeline test
  passes in 45 s. Measured throughput: CPU worker ~970 output px/s, GPU ~25k px/s.
  The AI upscale budget is therefore derived from `UseGpu` (4M / 150k) instead of
  a flat 1M, which on CPU would have needed ~17 min against a 300 s timeout.
- **Cutouts no longer time out (2026-11-22).** The "runs forever" symptom was two
  unbounded steps, not a broken worker. The self-hosted model mattes at its own
  low internal resolution and takes ~30 s per MP, so a 16.9 MP crop ran far past
  the provider timeout; `WithoutBg:MaxInputPixels` (default 1,000,000) makes
  `BoundedMatteProvider` downscale before upload and the refiner scales the matte
  back up, so the pipeline's size guard is "never larger than the crop, same
  aspect ratio". Poof is verified live and keeps its full 24 MP budget because it
  returns a native-resolution matte in seconds. The Real-ESRGAN call is bounded
  too: above `PrepareWorker:MaxAiOutputPixels` (unset derives 4M on GPU / 150k on
  CPU from the measured ~25k / ~970 output px/s) and on any
  retryable worker fault the upscaler resamples in-process with Mitchell, and
  `MaxOutputPixels` (default 24,000,000) halves the scale until the layer fits.
  Live through Compose on the three designs that used to fail: 2856×3820 in
  37.0 s, 3998×1562 in 47.3 s, 2428×3968 in 41.3 s, `succeeded` on 1 attempt
  each; Poof on the 3998×1562 design in 15.4 s.
- **Alpha contract (2026-11-22).** The approved cutout carried a 1–2 px pure-white
  rim because Real-ESRGAN blends the original background into the outermost RGB
  pixels and the provider matte, computed at cropped source size, upscales into a
  low-alpha haze. `BackgroundRemoval:AlphaContractPx` (default 2, range 0–8)
  applies Photoshop's Select > Modify > Contract: threshold the upscaled matte at
  the selection edge (128, or `AlphaThreshold` when set), erode with a Euclidean
  disk, then feather, which rebuilds the anti-aliased border. The erosion clamps
  at the frame, so a subject bleeding to the crop edge is not eaten inward.
  Measured on one live 468×468 cutout: contract 0 → 1266 white edge pixels,
  1 → 427, 2 → 46, 3 → 0; the live API run with the shipped default reproduced
  46 (alpha-weighted 5.1 vs 13.7) with no continuous band. Erosion cost
  3500×4834 r=2 ≈ 1.4 s, 6850×6850 r=2 ≈ 3.3 s. Compose seam
  `BACKGROUND_REMOVAL_ALPHA_CONTRACT_PX` defaults to 2.
- **Background-removal adapters (2026-11-21).** A pluggable pipeline in the
  Application layer (`crop → remove background on the cropped low-res image →
  upscale cropped RGB → refine matte → recombine`) depends only on ports; Poof
  (verified contract, no retry because the POST is billed) and self-hosted
  withoutBG v4 are Infrastructure adapters, and the crop/upscale steps reuse the
  worker through new `POST /v1/crop` and `POST /v1/upscale` routes rather than
  duplicating auto-trim or Real-ESRGAN. Fallback fires only for availability
  faults, never for input faults. Verified live end to end against the pinned
  withoutBG container plus the native GPU worker.
- **Background removal is now a shipped step (contracts 3.1.0).** It is queued
  through `POST /api/v1/designs/{designId}/steps/background-removal` and executed
  in-process by the API (`BackgroundRemovalJobRunner` behind
  `BackgroundRemovalWorker`), not by the worker: a run takes 30-90 s, so the
  request returns a job and the UI polls. Isolation is by capability, not job
  type - the runner is the only caller that claims `cutout`, and the claim
  endpoint refuses to parse that name so no worker can ever take one. The
  `provider` override is validated at the endpoint, stored on the job and
  forwarded to the selector; it is not silently discarded. Measured live: a
  cutout produced a 1268x1068 RGBA proposal in 64.9 s with transparent corners
  and the subject at its source colour.
- API Clean Architecture implementation builds; 17 domain, 38 application and
  73 infrastructure tests pass (3 live-only tests skip without the worker and
  withoutBG URLs; with both URLs set the live pipeline test passes in 45 s). The
  live fixture-flow script covers the API job lifecycle.
- Worker processing covers classify, trim/crop, upscale, resize; 200 tests pass.
  `background-removal` is not a worker job type at all (the API runs it), so it
  is absent from `JOB_TYPES` and the worker-job schema. `vectorize` and
  `manual-edit` are retired job types; their schemas remain for historical
  readability but new work is rejected with `retired` or
  `unsupported-parameters`.
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
  implemented. `npm test`: 246 passed across 20 files. `npm run build` succeeds;
  `npm run lint` exits 0 with pre-existing React-hook/fast-refresh warnings and
  no errors.
- PSD/PSB spike rerun from the committed reproducer; report and JSON results in
  `docs/spikes/psd-spike/`.
- Frozen contracts complete at v3.1.0: 5 JSON Schemas, 14 examples, OpenAPI
  3.0.3 with 39 paths / 67 schemas. `scripts/validate_contracts.py` derives the
  newest version from `contracts/CHANGELOG.md` and fails if
  `ContractVersion.Current` disagrees with the OpenAPI doc.
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

**In progress / immediate next:**

1. **AI cutout phase shipped, awaiting manual acceptance (2026-11-13).** The
   manual editor is frozen; the product priority is design quality — a clean mask
   and DTF-ready printing. Shipped: withoutBG `ai` mode, `maskMinAreaPx` speck and
   pinhole pass, live levels preview, AI-by-default cutout step, and the
   already-cut fast path. Measured quality tables and the two failure modes live
   in `docs/image-engine-validation.md`; BRIA RMBG stays out because its weights
   are CC BY-NC 4.0. Next in this track: judge the matte visually on real shop
   photos and colour art, then decide whether `2.png`-style 13% subject loss
   needs a second pass or just review guidance.
2. Phase 1b complete and committed (`f5441f8`): draft store + editor lifecycle
   (restore prompt, debounced autosave, visibility flush, clear after confirmed
   API save).
3. Phase 4 complete and committed (`f869dc1`): `web/src/lib/quickLevels.ts`
   (histogram + percentile auto levels, pure functions, BT.601 luminance),
   `QuickLevels` + `BackgroundReadout` components in the design-review cutout
   step, and a one-click Clean button that keys the classifier's
   `sampledBackground` hex and resets levels/grow to identity before submitting
   color-to-alpha. No contract change (`sampledBackground`, `imageLevels`
   already in schema).
4. Phase 4 fixture validation done (`scripts/check_clean_preset.py`,
   `make clean-preset`). It runs the worker's own `sample_background` +
   `background_matches` over the ten generated fixtures and scores against a
   ground truth independent of the sampled colour (border pixels are background
   by construction; pixels >60 from the border median are artwork). Findings:
   - Clean is offered only at `sampledBackground.confidence ≥ 0.7`. Below it the
     border is not a single colour and keying is hopeless: the full-bleed
     collage (0.00) and low-res phone screenshot (0.13) left 66–99% of their
     border behind. The gate is the fix; a wider tolerance only made it worse.
   - Tolerance is fixed at 24, the manual control's default. It was the tightest
     value clearing the residual second tone in the pale-mist and overwide
     banner fixtures (3% of border left at 10–20, 0% at 24) with no artwork
     removed on any design. The earlier confidence-scaled 10/16/24 rule was
     backwards: confidence measures uniformity, not how tight the key should be.
   - Transparent-background fixtures correctly never offer Clean.
   Quick Levels proposes auto levels on all ten fixtures (measured spans
   23–230); the narrow-range refusal is unit-tested, not fixture-triggered.
   Web suite 428 tests / 41 files green; full `make phase-gates` green.
   Next: Phase 2 selection tools.
5. Phase 2 selection tools done. The six tools (marquee, ellipse, lasso,
   polygon, wand, color-range) and four combine modes were already implemented
   and wired; this pass found and closed the gaps around them:
   - `colorRange.ts` was the only selection module with no test file. Writing
     the tests found a divide by zero: RGB mode at fuzziness 0 built a zero
     budget, so every pixel normalised to NaN and an exact match selected
     nothing. Latent, because the editor only calls it with `metric: 'hsl'`,
     but the budget is now floored at 1 and 18 tests cover both metrics.
   - `memoryBudget.assertSupportedSize` documented a 40 MP refusal that nothing
     imported. A 6850 px square (a real 58 cm target at 300 DPI) is 46.9 MP and
     would have asked for ~750 MB across the three canvases. The guard now runs
     on load, before allocation, and saving is blocked for a refused document.
   - `workPath.ts` implemented the whole pen tool and had no importer; the
     editor inlined only corner placement. Wiring it exposed a defect in the
     module: the 8 px vertex hit radius shadowed `addPathPoint`'s one-pixel
     duplicate test, so pressing the start corner could only grab it and a
     polygon could never be closed by clicking. Fixed, then wired with
     Enter/Escape/Delete handling that leaves other keys to history.
   Every module under `web/src/components/manual-editor/` is now imported and
   tested. Web suite 473 tests / 45 files green; full `make phase-gates` green.
   Next: Phase 3 complex editor shell.
6. Phase 3 complex editor shell, first slice done. `document.ts` and
   `compositeDocument` already described a full stack (base raster, adjustment
   layers, colour-key layers, each with visibility/opacity/blend/mask) but the
   editor only ever built one base layer and never showed a list. Scoping that
   exposed three defects that had to be fixed first, because a layer panel would
   have sat on all three:
   - The Levels / Hue / Saturation panel never reached a pixel. Every slider set
     `dirty` and nothing else; the document handed to `compositeDocument` carried
     only the base layer. Adjustments now append an adjustment layer through
     `documentBuild.ts`, which is also the single builder the draft uses, so the
     preview and the saved draft can never describe different documents.
   - Adjustment and colour-key layers were composited with source-over, which is
     wrong twice: a 50%-alpha pixel came out at 75% (`sa + da(1 - sa)`), so soft
     mask edges crept back towards opaque through every adjustment pass, and a
     colour-key layer re-emitted the composite it had just keyed, so keying did
     nothing at all. Both are transforms of the pixels below, so they now
     interpolate between the composite and the transformed copy.
   - `packMask` wrote one byte per pixel while `PackedMask` is `bitpack-v1` and
     `validateDocument` requires `ceil(w*h/8)` bytes. Every draft save with a
     non-empty mask was rejected as "mask dimensions mismatch", which the editor
     surfaced as "Draft save failed" — Phase 1b persistence silently did not work
     for exactly the edits worth persisting. The earlier draft tests only used a
     null mask, which is why they passed.
   The shell itself is `layerStack.ts` (pure add/remove/reorder/visibility/
   opacity/blend/active-layer operations, every one routed through
   `applyCommand` so `validateDocument` checks it on every keystroke),
   `LayerPanel.tsx` (top-first list, eye toggle, select, add Levels, add colour
   key, delete, move up/down, opacity, blend) and a `stack` state in
   `ManualEditor` that includes the base layer so the artwork's own visibility,
   opacity and blend mode are reachable — the one thing the single-layer editor
   could not express. Layer changes are part of the history snapshot, so Ctrl+Z
   walks them back like a mask stroke; layer *selection* deliberately is not,
   because spending an undo step on the highlight moving is worse than nothing.
   Drafts now persist the stack and the active layer id (optional fields, so a
   draft written before layers existed still restores).
   Two ordering defects found by the new tests: `applyCommand` validates the
   document it produces, so deleting the active layer had to re-point
   `activeLayerId` *before* the removal; and the global Levels layer is derived
   from the sliders and must not be written back into the stack, or the next
   render adds a second copy and the panel grows a phantom row.
   Web suite 551 tests / 50 files green; full `make phase-gates` green.
   Next: still Phase 3 — the stack renders but per-layer mask painting, layer
   rename and a pixel-op layer the operator can configure are not wired.
6b. Phase 3, per-layer masks. A mask used to belong to "the document", so the
   only thing it could limit was the artwork itself. That is the wrong shape for
   complex designs: the reason to add a Levels layer is usually to fix one
   region, and without a per-layer mask the adjustment applies everywhere or not
   at all. `maskLayerId` now names the layer the live bytes belong to;
   `buildRenderDocument` overrides only that layer's packed mask and leaves the
   rest of the stack alone; `layerMaskBytes` decodes a layer's mask back to bytes
   when the operator selects it; `applyLiveMaskToStack` folds the live bytes back
   onto their owner before any stack read.
   The defect this exposed is worth recording because the symptom was misleading.
   Switching layers silently discarded the mask just painted: the stack still
   held the stale packed copy from before the stroke, and selecting another layer
   replaced the live buffer with that layer's (usually null) mask. The first
   version of the test caught it as "back to the base layer shows no mask", which
   looked like a status-line bug and was actually data loss.
   The second misleading symptom was a test failure reading `[0,0,0,0]` where the
   compositor independently produced `[145,145,145,200]`. The compositor was
   correct all along. The editor draws the composite to the artwork canvas and
   the selection/mask tint to the overlay canvas, and both receive
   `putImageData`; the test helper recorded "the last call" and sometimes read the
   overlay's cleared buffer as if it were the render. The helper now identifies
   the artwork canvas by what it is (not `hidden`, no `manual-overlay` class)
   instead of by call order.
   That in turn exposed a real test race: `manual-save` becomes enabled when the
   image loads, while the first composite is drawn in a later effect, so reading
   a pixel in between passes on an idle machine and fails under a full parallel
   run. It failed roughly half the full-suite runs before the helper waited for
   the first draw. This is why the suite was intermittently red on
   `darkens the render when the Levels black point is raised` — the same test
   that failed once earlier and could not be reproduced in isolation.
   Masks are per-layer, but only one is painted at a time, so the editor keeps a
   single live buffer plus its owner id rather than a byte map per layer: a
   stroke costs one array, and switching layers is a decode of that layer's
   packed mask. Deleting the layer that owns the live mask drops the paint target
   back to the active layer; every other layer edit leaves it alone.
   Web suite 565 tests / 51 files green, four consecutive full runs; full
   `make phase-gates` green; `npm run build` green.
   Next: still Phase 3 — layer rename, a pixel-op layer the operator can
   configure (colour key is added at a fixed white seed), and per-layer mask
   feather are not wired.
7. Keep worker loop sequential with concurrency 1 for every job type. The AI
   matte is CPU-bound and serialized; that is deliberate, not a backlog item.
8. Do not start scaling, pagination, multi-worker, or bulk-throughput work unless
   measured need appears. Manual editor feature work stays frozen even though its
   route and modules remain green.

Historical runtime notes follow; native GPU and prior Phase 3 measurements remain
reference data, not immediate work.

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
- `vectorize` and `manual-edit` are retired step/job types. Historical artifacts
  remain downloadable; no new work can be proposed. `background-removal` was
  retired in v3.0.0 and restored in v3.1.0 as an in-process API job.

---

## 16. Handoff log

### 2026-11-24 — DTF preflight: 15 checks, 5 opt-in fixes, contracts 3.2.0

- **Preflight is deterministic and in-process.** No network, no model, no
  randomness, iterative algorithms only, flat buffers and no per-pixel
  allocation. A report that changes between runs is not evidence of anything, so
  the JSON is byte-stable: findings and fixes are sorted by code (then region
  Y/X, then message), metrics keep their measurement order, and nothing time- or
  machine-dependent is serialised. `ReportJsonIsByteStable` pins it.
- **One shared analysis, fifteen rules.** `PreflightContext` owns a single
  `Lazy<PreflightAnalysis>`: opaque mask (alpha ≥ 128), 8-connected opaque
  components, 4-connected holes that do not touch the border, an exact Euclidean
  distance map via two Felzenszwalb passes capped at 255 px (a byte keeps it
  affordable on a 6850 px roll), and a lazy hole-label map only the fill-holes
  fix needs. Three buffers per image instead of one per rule.
- **Checks are discovered, not listed.** `AddPreflight` scans the assembly for
  `IPreflightCheck`/`IPreflightFix`, so a new rule is one class and no
  registration. The runner sorts by `Code`, so assembly order never reaches the
  JSON, and a throwing check becomes a `check-failed` warning instead of losing
  the other fourteen results (cancellation still propagates).
- **Thresholds are physical, and validated at startup.** `PreflightProfile`
  expresses everything in mm, fractions and ratios, so the same numbers mean the
  same thing at 200 and 600 DPI. `Profile.Validate()` catches cross-field
  contradictions (`RecommendedDpi` < `MinimumDpi`, `CriticalStrokeMm` ≥
  `MinimumStrokeMm`, opacity outside `(0, 1]`, non-positive limits) and
  `PreflightOptionsValidator` refuses to boot on them rather than reporting
  confident nonsense.
- **Report-only by default; fixes are opt-in.** `PreflightService` decodes once,
  runs the checks, applies only the enabled fixes whose findings are present,
  then re-runs and serialises the *final* state — so a fix that did not help still
  shows its finding. `fix=true` on the endpoint returns the repaired PNG as
  `fixedImageBase64`. Fixes cover metadata (`set-dpi-metadata`, `embed-srgb`),
  specks (`remove-islands`, `fill-holes`) and interior matte damage
  (`harden-soft-interior`); none touch resolution, coverage, stroke or gap, which
  need the operator to change the artwork.
- **The cut-out always preflights, and never fails because of it.** The runner
  runs it report-only after the pipeline writes its output, stores the JSON as
  `<output>.preflight.json`, and adds `preflightReportPath`, `preflightVerdict`
  and `preflightFindingCount` to the job metadata. Any preflight failure is logged
  and swallowed: the version is already on disk, and a report problem must never
  turn finished work into a failed job. It judges the cut-out against the design's
  target centimetres at its working DPI, and against its own canvas when no print
  size exists yet.
- **Two defects the new API test project caught.** `fixedImageBase64` was
  serialised as `null` rather than omitted (contract says nullable *and absent*
  when nothing was fixed), and a malformed multipart body threw
  `InvalidDataException` out of `ReadFormAsync`, which the exception handler does
  not map — a 500 for a caller error. Both fixed and covered.
- **Two threshold defects found by driving the live API.** A correctly sized
  2362×1575 version at 20 cm measures 299.974 DPI and warned "below target" on
  every such version, so both resolution comparisons now carry a 0.5 DPI
  rounding allowance. And `PreflightProfile.ContrastOpacities` was a non-empty
  array default, which the .NET binder *appends* to, so configuration produced
  `[0.25, 0.6, 0.5]` instead of `[0.5]`; it is now nullable with an
  `EffectiveContrastOpacities` fallback.
- Contracts 3.2.0 (additive): new `POST /api/v1/preflight` plus
  `PreflightResponse`, `PreflightReport`, `PreflightSpecSummary`,
  `PreflightFinding`, `PreflightRegion`, `PreflightMetric` and
  `PreflightFixRecord`. No existing request or response changed shape.
  `web/src/api/schema.d.ts` regenerated; the smoke test reads
  `ContractVersion.cs`.
- Gates: `dotnet build` 0 warnings / 0 errors; API 26 domain / 52 application /
  11 api / 111 infrastructure (2 live skipped); contracts valid (5 schemas, 15
  examples, OpenAPI 3.0.3 v3.2.0, 41 paths / 75 schemas); web 261 tests / 20
  files, `npm run build` and `npm run lint` green (same 8 pre-existing warnings).
- Not verified: no real shop artwork has been judged against the profile yet —
  the thresholds are the production checklist defaults, not measured on the
  shop's own files. The Compose API image *was* rebuilt and smoke-tested
  (`make smoke` green, `/api/v1/info` reports 3.2.0, `POST /api/v1/preflight`
  answers 200 through the container).

### 2026-11-23 — Mono refinement: clean 1-bit DTF plates, server-side

- **New worker job type `refine-mono`.** It reduces a text/logo scan to hard ink
  at the **full print resolution** — never a preview. A cut made on a preview
  bakes the preview's noise into the plate, which is the whole failure this
  stage exists to prevent. Library lives in `worker/app/mono/`
  (`types`/`classify`/`stages`/`presets`/`chain`), the job seam in
  `worker/app/processors/refine_mono.py`.
- **The chain is a strategy list, not a monolith**: `denoise → upscale →
  binarize → despeckle → fillHoles → morphology`, then `validate`. Each stage is
  an independent unit behind a `Stage` protocol with its own `StageTrace`, so
  every one is testable alone and the order is data (`DEFAULT_CHAIN`), not
  control flow.
- **A classifier gate decides first, and it cannot be overridden.** Otsu
  separability η (between-class variance / total variance) separates mono-type
  art from photographs; a second feature (share of ink pixels with chroma ≤ 24)
  splits `mono-ink` from `flat-colour`. Re-measured on the 10 fixtures with
  luminance composited over white: mono-type art scores η ≥ 0.922, photos
  ≤ 0.788, so the 0.85 gate sits in an empty band — 10/10 correct. Neutral-ink
  share splits absolutely (mono-ink ≥ 0.946, flat-colour 0.000).
- **A photograph is not a failure.** The job succeeds, writes the input through
  unchanged and reports `skipped: true` with the measured reason. Failing would
  make every non-mono design look broken in the queue. A preset can only *narrow*
  the gate, never widen it: choosing `logo` on a photo still reports "these tones
  are not separable".
- **Binarizing a flat-colour illustration needs explicit consent**
  (`binarizeFlatColour`), because it is irreversible. `clean-only` is the
  deblock-and-denoise-without-binarize preset, expressed as a `MonoPreset` mode
  rather than a parameter so the two intents cannot be combined nonsensically.
- **Output is two-state RGBA, not a mode-1 PNG.** Measured: a mode-1 file
  converts to RGBA with alpha 255 everywhere, and the packer decides occupancy
  from alpha (`occupancy_from_alpha`, threshold 5), so a mode-1 design would be
  packed as a **solid white box**. The plate is instead opaque black ink
  `(0,0,0,255)` on fully transparent paper `(255,255,255,0)`, asserted before
  write *and* re-checked on the array that reaches disk.
- **`clean_colour` must use a vector-valued median** (take the whole colour of the
  median-luminance neighbour). Per-channel medians invented 108 new shades on
  `tall-banner`; 0 invented colours after the fix.
- **The refinement is refused before the print size is established.** It is a
  finishing pass; a resize afterwards would resample the hard plate back into
  greys and waste the job. `StepService` returns `invalid-target-size` unless the
  parent is already at the target pixels. `StepType.RefineMono` is terminal
  (gated by `MatchesTarget` like the others).
- Live proof, fresh batch, real quality-10 JPEG of a two-line logo:
  resize → 2362×1181 → refine → `mono-ink`, η 0.9848, neutral share 1.0, Otsu
  threshold 134, denoise changed 96,312 px, despeckle 0 → 186,167 ink px. On
  disk: **exactly 2 distinct RGBA values**, 300 DPI preserved. Approved →
  design `ready` at 299.97 DPI → packed with the second design, 0 unplaced →
  integrity **5/5 passed**, sheet `valid`. On the rendered sheet the refined
  design carries **1 ink colour**, the unrefined one beside it 67.
- Also verified the decline path live on design `66c51a2c` (a 33-colour flat
  logo): `text` preset → `mono-preset-skipped`, pixels byte-identical, design
  stayed `ready`; then `illustration` + `binarizeFlatColour` → binarized to two
  states.
- Tests: worker 246 (+46: `test_mono.py` 31, `test_processors_refine_mono.py`
  15), API 19 domain / 44 application / 75 infrastructure (3 live skipped), web
  258. Frozen `worker-job`/`worker-result` schemas and examples updated (a
  `monoMetadata` def was needed — `metadata` is `additionalProperties: false`).

### 2026-11-23 — Step order is now crop → enhance → print size → remove background

- **The review page's four tools are numbered in the shop's real order.** Remove
  background moved from an unnumbered optional "+" to step 4; the summary now
  says "Final step · cut out at the print size" and explains, when no print size
  is set yet, that the cut-out will crop and enlarge instead.
- **Two blockers had to be fixed first — a UI reorder alone would not have
  worked.** Both were verified by driving the live API, not by inspection:
  1. `Design.RecomputeStatus` only returned `Ready` for `StepType.Resize`, so a
     cut-out as the last version left the design `in-progress` forever and the
     packer refused it. It now accepts `IsTerminalStep` = resize **or**
     background-removal, still gated by `MatchesTarget`, so a cut-out that
     changed the pixel size is still correctly not ready. Upscale/trim/crop stay
     non-terminal, locked by `TerminalStepTests.UpscaleAtTheTargetPixels_IsStillNotTerminal`.
  2. `BackgroundRemovalPipeline` always auto-cropped and upscaled internally,
     which changes the dimensions. It now takes `preserveSize` and skips both.
     The flag is decided **when the job is queued** (`StepService` compares the
     parent's pixels to the target) and recorded in `parameters.preserveSize`,
     so the runner never re-derives it from state that may have changed.
- Live proof on design `66c51a2c`: set 10×10 cm → resize proposal 1181×1181 →
  approve → design `ready`; cut-out job recorded `{"preserveSize":true}` and
  logged `preserveSize=True widthPx=1181 heightPx=1181`; approved cut-out →
  design still `ready`, current version `background-removal` 1181×1181,
  effective 299.97 DPI. Output quality: 0 border-adjacent white px, all four
  corners alpha 0, 11,178 soft-edge px. A pack of that batch refused on *other*
  designs only — this one was absent from the `batch-not-ready` list.
- Mirrored in `web/src/mocks/store.ts` (status derivation + approve guard), so
  the mock cannot drift from the domain. The approve guard only enforces target
  pixels on a cut-out when a target exists, because a cut-out *before* print
  size is still legal and is followed by the resize.
- Tests: 17 domain (+4), 38 application (+3), 73 infrastructure (3 live
  skipped), 250 web (+2). README, ARCHITECTURE §7.2 updated.

### 2026-11-23 — GPU path verified; two of yesterday's claims were wrong

- **GPU upscale verified end to end.** `make worker-gpu` on `:8001`, Real-ESRGAN
  enumerated the GTX 1650 Ti as Vulkan device 1 and drove it to 97% utilisation.
  The live pipeline test (`PRINTSHEET_TEST_WORKER_URL=http://localhost:8001/`)
  passes in 45 s: crop → withoutBG → GPU upscale → refine → recombine.
- **Throughput measured, and it invalidated the AI budget default.** Output px/s:
  CPU worker ~970 (154k px in 159 s, via the Compose worker's own `/v1/upscale`),
  GPU ~25k (480k px in 19.5 s) — 25× apart. The previous flat
  `MaxAiOutputPixels = 1_000_000` would need ~17 min on CPU against a 300 s
  attempt timeout, so every CPU deployment would burn 5 min and fall back. It is
  now `int?`: unset derives from `UseGpu` (4M GPU / 150k CPU) via
  `AiOutputPixelBudget`, and an explicit value still wins. Compose seam removed
  because the default is now correct per engine; `AiOutputBudgetFollowsTheEngineThatWillRun`
  locks it in.
- **Correction: the Compose worker does ship Real-ESRGAN.** README claimed it had
  no engine binary and "cannot finish the pipeline". It has the binary and models
  at `/tools` and serves `/v1/upscale` on llvmpipe (software Vulkan, no
  `/dev/dri` in the container). Measured, not assumed. README fixed.
- **Correction: the `host.docker.internal:8001` recipe does not work here.**
  Containers on this workstation cannot reach *any* host port — `docker0` and the
  Compose bridge gateway both time out, while container-to-container is fine — so
  the API container can never call the native GPU worker. It is a host firewall
  (sudo-gated, not inspected). README and the compose comment now say to verify
  with `docker compose exec api curl -sf http://host.docker.internal:8001/health`
  and to run the API natively or accept the CPU worker if it fails. The
  `extra_hosts` mapping stays; it is necessary but not sufficient.
- Live after the budget change: the 3998×1562 design via Compose CPU worker
  `succeeded` in 1 attempt, 59.6 s (withoutBG removal 40.6 s), and the upscale
  resolved locally as intended rather than timing out.
- Tests: API 13 + 35 + 73 (3 live skipped), plus the live pipeline test green
  against the GPU worker.

### 2026-11-22 — Poof verified live; pixel budget split per provider

- Poof is now verified end to end, not just mocked. The key lives only in the
  gitignored `.env` (`POOF_API_KEY`), never in a tracked file; `git grep` for it
  in tracked content is empty.
- Direct probes: 400×300 in 2.9 s, 6.2 MP in 5.9 s, 24 MP in 6.7 s, all HTTP 200
  with an RGBA matte at the *input* resolution.
- **The 1 MP budget was wrong for Poof.** Comparing Poof's native matte on the
  3998×1562 crop against the same image downscaled to 1 MP and re-expanded gives
  mean 26.8/255 alpha error on the anti-aliased edge band (0.45 overall) — i.e.
  the downscale reintroduced exactly the soft-edge error the alpha contract
  exists to remove. So the budget moved into each provider's options:
  `WithoutBg:MaxInputPixels` (default 1,000,000, CPU-bound) and
  `Poof:MaxInputPixels` (default 24,000,000, upload bound only). The
  `BackgroundRemoval:ProviderMaxInputPixels` key added earlier the same day is
  gone; it was never released.
- `BoundedMatteProvider` now takes the *tightest* budget among providers the call
  could reach, including the configured fallback: the selector can switch after
  the bytes were resized, so a Poof-only budget would hand withoutBG an image it
  cannot finish.
- The 20 MB upload cap moved out of `BackgroundRemovalPipeline` into the
  decorator, because only the decorator knows the bytes that are actually sent.
  Three pipeline tests that asserted the old placement were removed; the
  decorator has its own test for the post-downscale cap.
- Live through the Compose API on the 3998×1562 design, same design both ways:
  Poof `succeeded` 1 attempt, 15.4 s total / 5.8 s removal, **no downscale log**;
  withoutBG `succeeded` 1 attempt, 41.5 s total / 30.9 s removal, downscale log
  present. Both outputs: 0 white-rim px, corners alpha 0, 73,350 soft-edge px.
- Tests: API 13 + 35 + 72 (3 live skipped). New: Poof kept at full resolution,
  tightest-budget-with-fallback, post-downscale byte cap, per-provider binding.
- Still not exercised: the native GPU worker path
  (`host.docker.internal:8001`); Compose runs the CPU worker.

### 2026-11-22 — cutouts stop timing out ("runs forever" fixed)

- Symptom: every background-removal job ended in `failed`/`running` after
  repeated attempts, with `prepare-worker upscale timed out.` or
  `prepare-worker crop could not be reached.` Compose jobs of that type:
  `b8024a45`, `b2b455c1`, `35007e69`, `bee2531a`. Nothing was wrong with the
  worker: the Compose CPU worker and the native GPU worker were both healthy.
  The job was simply too big for the budgets.
- Two unbounded steps, both now capped by configuration:
  - **Provider.** withoutBG/Poof compute the matte at their own internal
    resolution, so a print-size crop buys no edge detail and costs minutes.
    `BackgroundRemoval:ProviderMaxInputPixels` (default 1,000,000) downscales the
    cropped image before it is sent (`BoundedMatteProvider`, a decorator around
    the provider selector) and the refiner scales the matte back up. The
    pipeline's exact-size guard was relaxed to "never larger than the crop, same
    aspect ratio", since a smaller matte is normal.
  - **Upscale.** `PrepareWorkerUpscaler` only calls Real-ESRGAN when the output
    fits `MaxAiOutputPixels` (default 1,000,000); above it, and on any retryable
    worker fault, it resamples in-process with Skia Mitchell. `MaxOutputPixels`
    (default 24,000,000) halves the configured scale until the colour layer
    fits, and returns the input unchanged when even 1x is over.
- Live verification through the Compose API (page 3 designs, all previously
  failing): 2856x3820 in 37.0 s, 3998x1562 in 47.3 s, 2428x3968 in 41.3 s —
  `succeeded`, 1 attempt each. The 3998x1562 run logged
  `Downscaling the cutout input from 3998x1562 to 1599x625 for the provider`;
  its upscale resolved to 1x. Alpha rim still clean (0 border-adjacent pure
  white pixels after the 2 px contract). Test proposals rejected afterwards.
- Compose seams added: `BACKGROUND_REMOVAL_PROVIDER_MAX_INPUT_PIXELS`,
  `BACKGROUND_REMOVAL_PREPARE_WORKER_MAX_AI_OUTPUT_PIXELS`,
  `BACKGROUND_REMOVAL_PREPARE_WORKER_MAX_OUTPUT_PIXELS`, and
  `extra_hosts: host.docker.internal:host-gateway` on the API so an operator can
  point `PrepareWorker:BaseUrl` at the native GPU worker
  (`http://host.docker.internal:8001` + `WORKER_GPU_ENABLED=true`).
- Tests: 4 upscaler/budget tests in `BackgroundRemovalAdapterTests` (worker
  unavailable -> local resample, AI budget skipped, scale capped, input returned
  over ceiling), 1 downscale test for the provider decorator, and
  `AcceptsAProviderMatteSmallerThanTheCrop` in the pipeline tests. API 13 + 36 +
  68 (3 live skipped), `dotnet build` clean.
- Not verified: Poof end to end (still no `POOF_API_KEY`); mocked contract tests
  only. The GPU path through `host.docker.internal:8001` is configured but not
  exercised — Compose runs the CPU worker.

### 2026-11-22 — design review chooses the cutout provider

- The review page always called `api.steps.backgroundRemoval(designId)` with no
  body, so only `BackgroundRemoval:DefaultProvider` ever ran and Poof was
  unreachable from the workbench even when configured.
- The "Remove background" step now offers `Server default` / `Local · withoutBG` /
  `Poof · cloud` (`CUTOUT_PROVIDERS` in `DesignReviewPage.tsx`). Only an explicit
  override is sent: `Server default` sends `{}` so a deployment that sets
  `DefaultProvider=poof` is not overridden by the UI.
- Poof still needs `POOF_API_KEY`; without it the adapter refuses to call and the
  job fails with "not configured", not retryable. The hint says so.
- Tests: two route tests assert the pressed state and that the job carries
  `{ provider: 'poof' }`, or omits `provider` for the default. Web 248 tests /
  20 files, build and lint clean (0 errors).

### 2026-11-22 — alpha contract removes the upscaler's white rim

- Symptom: a background-removed design kept a 1–2 px pure-white fringe that
  prints as a halo on a dark garment. Measured on the approved 468×468 cutout:
  the outermost band was 1266 pixels with mean luminance 254.8.
- Two causes: Real-ESRGAN blends the old background into the outermost RGB
  pixels, and withoutBG's matte (computed at cropped source size, here 117 px)
  upscales 4× into a 2–14 alpha haze outside the true edge.
- `BackgroundRemoval:AlphaContractPx` (default 2, range 0–8) is Photoshop's
  Select > Modify > Contract. Order is fixed: threshold the upscaled matte at
  the selection edge (128, or `AlphaThreshold` when set) → erode with a
  Euclidean disk → feather. The disk matters: a square kernel pulls a diagonal
  edge `r × sqrt(2)`, so a 2 px contract would shave 2.8 px off a curve. The
  feather runs after the erosion so the new border is anti-aliased; running it
  first only spreads alpha back over the pixels the contract removed.
- Rejected alternatives, measured on the same live data: eroding the soft ramp
  instead of the selection leaves the sub-threshold haze (contract 2 → 1171
  white px); a low-cut + 3 px min filter looked smoother (155 px) but needs a
  magic low-cut value and 3 px of contraction.
- Live verification through the real API on a fresh copy of the small sample:
  crop 117 → cutout → 4× upscale 468 → refine, job `succeeded` in ~90 s,
  result 468×468 with 46 residual white pixels (weighted 5.1) and no white
  band at 2 or 3 px depth. Baseline with the same input: 1266 (weighted 13.7).
- Gates: `dotnet build` 0 warnings / 0 errors; API 13 + 35 + 63 tests (3 live
  skipped); `docker compose config --quiet` valid. Compose API recreated with
  the default `BackgroundRemoval__AlphaContractPx=2`.
- Not fixed: the CPU worker needs ~73 s for a 4× upscale of a 117 px crop, so
  realistic designs still time out at 300 s; use the native GPU worker for
  large artwork.

### 2026-11-22 — Compose worker Real-ESRGAN support and -g auto fix

- Fixed 503 Service Unavailable in prepare-worker upscale during background removal:
  `worker/Dockerfile` now installs `libvulkan1` and `mesa-vulkan-drivers` for Vulkan
  software rasterizer (llvmpipe); `docker-compose.yml` mounts `.tools/realesrgan-v0.2.5.0:/tools:ro`
  and sets `PRINTSHEET_REALESRGAN_BINARY` and `PRINTSHEET_REALESRGAN_MODEL_DIR`.
- Fixed `realesrgan.py` passing `-g -1` on CPU fallback, which caused `realesrgan-ncnn-vulkan`
  to exit 255 with `invalid gpu device`; now passes `-g auto`.
- Updated `scripts/run-worker.sh` to auto-detect Real-ESRGAN binary and models.
- Verified in-stack live execution: `POST /v1/crop` and `POST /v1/upscale` return 200 OK,
  and in-process background removal completed end-to-end to `succeeded` status with an
  approved RGBA cutout version.

### 2026-11-22 — background removal restored as an in-process cutout (contracts 3.1.0)

- v3.0.0 removed the in-worker cutout pipeline. v3.1.0 adds it back as an
  **additive** step with a different executor: `JobCapability.Cutout` isolates a
  job that the API runs itself (`BackgroundRemovalJobRunner` + hosted
  `BackgroundRemovalWorker`), because a 30-90 s run does not fit the worker claim
  protocol. `background-removal` stays out of worker `JOB_TYPES` and
  `worker-job.schema.json`; `JobService.ClaimAsync` rejects `"cutout"` as
  unparseable so no worker can take one.
- Pipeline order is fixed and tested: auto-crop -> remove background on the
  cropped low-res image -> upscale the original cropped RGB -> upscale/refine
  alpha separately -> recombine. The 20 MB provider cap is enforced on the
  **cropped** bytes, not the original upload.
- Three defects found and fixed after the feature landed: the endpoint validated
  and stored a `provider` override that the pipeline never read (every cutout
  silently used the configured default); `HasActiveStepJobAsync` omitted
  `BackgroundRemoval`, so a second step could be queued against a design while a
  cutout held it and would fail only after the work was done; and the runner
  hardcoded `hasAlpha: true`, which won over the completion service's file
  inspection. Each has a regression test that fails when the fix is reverted.
- `scripts/validate_contracts.py` now derives the newest version from
  `contracts/CHANGELOG.md` instead of pinning a literal, and fails when
  `ContractVersion.Current` disagrees with the OpenAPI doc.
- Gates: contracts v3.1.0 green, API 13 + 35 + 57 tests (3 skipped), worker 200,
  packer 161, web 246 / 20 files, `dotnet build` 0 warnings / 0 errors.
- Not verified: Compose alone cannot finish the upscale step (no Real-ESRGAN
  binary in the worker image); use the native GPU worker on `:8001`.

### 2026-11-20 — background-removal and manual-edit retired; contracts v3.0.0

- Removed all background-removal and manual-edit code paths: API endpoints,
  worker processor and engine, mask_ops, web cutout UI, manual editor, Quick Levels.
- Contracts bumped to v3.0.0 (breaking). OpenAPI and worker-job schema no longer
  include `background-removal` or `manual-edit`. StepType enum keeps legacy
  values for historical readability. 14 examples validate.
- Deleted model weights and caches: `models/cutout` (2.1 GB BiRefNet),
  `models/hf` (1.4 GB withoutBG), `storage/models/withoutbg`, `archive/birefnet/`,
  `~/.cache/huggingface` (1.9 GB).
- Docker compose: removed `HF_HOME`, `./models:/data/models` worker mount.
- API tests 22 pass, worker tests 192 pass, packer tests 161 pass, web build/lint
  pass. Contract validation green.

Append newest entries at the top. Keep them short and factual.

### 2026-11-13 — AI background removal adopted (withoutBG); DTF speck pass; levels preview

- Product priority changed: manual editor frozen, background-removal quality and
  on-the-fly levels come first, and a long matte is acceptable if the result is
  clean. BRIA RMBG is **not** used (weights are CC BY-NC 4.0; a for-profit shop is
  commercial use). withoutBG open weights (Apache-2.0 + Meta DINOv3 attribution)
  are the engine, `aiModel: withoutbg-open`, CPU ONNX.
- Worker: `worker/app/engines/withoutbg.py` adapts the bundle (lazy import/load,
  composited inference, matte at source size); `background.py` accepts
  `mode: ai`, feeds the matte into the *same* mask pipeline as the colour key and
  emits `ai-cutout-applied`. New `maskMinAreaPx` runs `refine_mask_regions`
  (opaque islands out, background pinholes in) before grow/feather and emits
  `mask-regions-refined`. Settings: `PRINTSHEET_CUTOUT_MODEL_PATH`; weights cache
  in `HF_HOME` (`models/hf` natively, `/data/models/hf` in Compose).
- Two measured defects fixed. (1) `convert("RGB")` on an RGBA upload drops alpha
  without compositing and a real shop PNG held flat grey under its transparency,
  which the model read as artwork; the adapter now composites on white.
  (2) Re-mating an upload that is already cut out took 356 s on a 3500 × 4834
  design to reproduce its own alpha at IoU 0.987 while shaving 1.3% of the
  subject, so those uploads keep their alpha and report `source-alpha-used`.
- Quality against the shop's own hand-cut alpha (alpha > 127): already-cut
  `Meter` IoU 0.9912 / MAE 0.53 of 255; opaque-background re-mates `6+5+` 0.9988,
  `+6` 0.9992, `weewc` 0.9974, `3` 0.9846, `2` 0.8673 (loses 13.3% of the
  subject — known worst case, review guidance not a threshold change). Designs
  whose white interiors only exist as hidden alpha are unsolvable after
  flattening (+110…185% extra area on `Meter`/`Untitled-1`); those go through
  ready-to-pack. Full tables in `docs/image-engine-validation.md`, decision in
  `docs/decision-log.md`.
- API: `BackgroundRemovalStepCommand`/`BackgroundRemovalStepRequest` gained
  `MaskMinAreaPx`; `StepService` validates 0–100000, rejects any AI model other
  than `withoutbg-open`, and only accepts `aiModel` with `mode: ai`.
- Contracts (additive, still 2.0.0): `maskMinAreaPx` in the worker-job schema and
  OpenAPI, `aiModel` re-documented as `[withoutbg-open]`, vendored schema synced,
  `web/src/api/schema.d.ts` regenerated, `contracts/CHANGELOG.md` updated.
- Web: cutout step defaults to AI with an explicit AI/colour-key segmented
  control, "Drop specks under" (24 px²), a live `LevelsPreview` canvas that draws
  the same colour and alpha curves at preview resolution, and levels open by
  default. The "Manual cleanup" link is gone; the manual-editor route, modules and
  tests are untouched.
- Gates: worker 228 passed (`ruff` clean apart from two pre-existing long lines);
  web 566 passed / 51 files, `tsc -b` clean; API `dotnet build` 0 warnings /
  0 errors. Live E2E through the API verified both paths (already-cut and opaque).
- Not verified: Compose runtime for the AI path (only native), and the visual
  judgement of matte quality on real shop photos and colour art. The 5.0+ GiB
  peak RSS from the spike still applies to the BiRefNet branch, so worker
  concurrency stays 1.

### 2026-11-13 — Native storage root split fixed ("input file is missing")

- Symptom: trim/upscale/background-removal all failed with
  `input file is missing: {batch}/{design}/versions/{version}.png` even though
  the upload had succeeded.
- Root cause: `Storage:Root` in `appsettings.Development.json` is the *relative*
  path `"storage"`, and `dotnet run` sets the process working directory to
  `api/src/PrintSheet.Api`. The API therefore wrote uploads into
  `api/src/PrintSheet.Api/storage` while `scripts/run-worker.sh` read
  `$ROOT/storage` (repo root) and the packer is always handed the repo root.
  Nothing was lost; the file existed in the API-only directory.
- Fix: `scripts/run-api.sh` now exports
  `Storage__Root="${Storage__Root:-$ROOT/storage}"` before launching, matching
  the worker's `PRINTSHEET_STORAGE_ROOT` default. The API, worker and packer
  now resolve one shared root in native development.
- Data: the two orphaned batch folders (`0cb36c6f-…`, `4878d046-…`) were copied
  into the repo `storage/`, verified byte-identical with `diff -r`, then the
  `api/src/PrintSheet.Api/storage` duplicate was backed up to
  `/tmp/api-storage-backup-*.tar.gz` and removed.
- Guard: `scripts/check_storage_roots.py` parses both launch scripts and fails
  if their `$ROOT`-anchored storage defaults differ; wired into `make` as
  `test-storage-roots` and into `phase-gates`. Verified it fails on a split.
- Verified live: the previously failing version now serves `http=200
  bytes=129334`; trim, background-removal (color-to-alpha) and a fresh upload
  each completed `succeeded` with output written under the repo `storage/`.
  Upscale staying `queued` is correct, not a defect: `StepService` assigns
  `JobCapability.Gpu` and a `gpu_enabled=false` worker drops `gpu` from
  `capability_list`, so only `make worker-gpu` can claim it.

### 2026-11-11 — Manual cleanup contract and stabilization pass

- OpenAPI/manual-edit contract aligned; `schema.d.ts` regenerated; `manual-edit` step label added.
- Manual editor modules now compile and full web suite passes 309 tests. Web build passes. API build passes with 0 warnings/errors; API tests pass 22.
- Geometry tests now pass in current tree. Contract validation passes through `make test-contracts`.
- `make test-web`, `make test-api`, and `make test-contracts` pass. Full `make test`, worker/packer gates, live E2E, and endpoint integration tests remain unrun in this session.

### 2026-11-11 — Manual cleanup editor completed pass

- Added manual editor selection modes, polygon/lasso, contiguous wand, color-range sampling, mask creation, Levels/HSL controls, PNG download and Printflow manual-edit save call.
- Added API `POST /api/v1/designs/{designId}/steps/manual-edit`, immutable proposed `StepType.ManualEdit`, parent/stale/pending checks, PNG/dimension/size validation, safe version storage and audit event.
- Fixed manual editor selection helper TypeScript errors, identity render check, marching-ant left edge, undo label, and added focused selection tests.
- Web build passes; focused editor tests pass; API build and 22 API tests pass. Full editor test suite retains 3 pre-existing geometry expectation failures; contract OpenAPI update and full backend endpoint tests remain follow-up.

### 2026-11-11 — Manual cleanup editor foundation

- Added `/batches/:batchId/designs/:designId/manual-editor` with browser Canvas editor.
- Added rectangular/elliptical marquee, basic color-tolerance wand, invert/deselect, selection-to-mask, Levels, Hue/Saturation, zoom, PNG download.
- Reused existing immutable file URL and design route. No backend or contract change yet.
- Web build and 253 tests pass.
- Remaining: lasso/polygon, contiguous wand, Color Range, path workflow, real undo/redo, mask controls, save-as-proposed multipart endpoint, focused engine tests.

### 2026-11-11 — Review page rebuilt as a canvas + layer-stack editor; teal accent and a light theme

- **The review page was one long column.** Preview, readiness, a four-step
  accordion and history stacked vertically, so comparing a change with its
  result meant scrolling the artwork off-screen. It is now `.editor`, a
  two-column grid: `.editor-stage` (background picker, canvas, job progress,
  decisions) and `.editor-side` (layers, readiness, tools). The stage is
  `position: sticky` under the top bar, so the artwork stays put while the rail
  scrolls. Deliberately *not* an `overflow: auto` box on either pane: nesting
  scroll containers gives the page two scrollbars and traps the wheel over the
  artwork. Collapses to one column at 1080px.
- **Versions are now a layer stack.** The version chain was only reachable
  through a collapsed "Version history" list. `design.versions` now renders as
  `.layer` rows (thumbnail, step, pixels, current/proposal/rejected flag,
  per-layer Revert), each with an eye toggle that takes it off the canvas. The
  canvas shows the selected layer, or — for a proposal by default — a
  before/after slider against the nearest visible layer below it, toggleable via
  `toggle-compare`. Selecting a layer never changes what the packer uses; only
  approval does.
- **Accent is teal, not orange.** The palette moved into `index.css` as tokens
  (`--accent`, `--accent-fill`, `--accent-soft`, `--accent-line`, `--on-accent`,
  plus `--sheen`/`--hover`/`--stage-bg`/`--field-bg`/`--checker-*`). Buttons use
  `--accent-fill` with white text because `--accent` (`#2dd4bf`) is too light to
  carry white; text and focus rings use `--accent`.
- **Light theme added, dark by default.** `useTheme` (`lib/theme.ts`) writes
  `data-theme` on `<html>` and remembers an explicit choice in
  `localStorage['printsheet.theme']`. It deliberately does *not* follow
  `prefers-color-scheme`: the shop chose dark as the house default, and a
  light-OS workstation was opening the workbench in a theme nobody asked for
  (caught in a real browser render, not by the tests). Toggle lives in the top
  bar as `data-testid="theme-toggle"` and advertises the theme it switches *to*.
- Every theme-dependent colour is a token now. Swept 84 hardcoded `rgba()`
  values out of `ui.css`, `shell.css`, `batch.css`, `design-review.css`,
  `preview.css`, `mask-controls.css`, `crop.css` and `photopea.css`. Inputs use
  `--field-bg`, artwork surfaces `--stage-bg`. Two literals are intentional and
  commented: the Photopea iframe backdrop, and the crop viewport (a fixed dark
  stage in both themes so the artwork is judged against a constant).
- **Fixed while verifying in a browser:** the segmented background picker used
  `--ink` as its track, which is near-white in light mode and made the active
  pill invisible; it is now `--panel-3` with a `--panel` active pill. The Tools
  panel said "finish current job first" while a *proposal* was the blocker; it
  now names the real reason (`toolsBlockedReason`). Two notices still said
  "below", a leftover from the vertical layout.
- Gates: build clean, oxlint 0 errors (same 15 pre-existing warnings), 253 tests
  pass. Added `shows every version as a layer and keeps approval on the proposal
  layer` and `defaults to the dark theme and remembers an explicit switch`.
  Verified in headless Chromium against both the real API and the mock server:
  layer count matches versions, sticky canvas stays on screen at full scroll
  (top 131px vs topbar bottom 59px), modal centred and inside the viewport,
  Escape closes it, compare/single-view toggles, 700px viewport stacks with no
  horizontal overflow.
- Note: the `SettingsContext` "window is not defined" unhandled rejection in
  `Shell.test.tsx` is a pre-existing flake (1 in ~6 runs on the untouched tree,
  same rate after this work), not a regression from it.

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
  additive contract clarification is recorded in section 17.
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

## 17. Contract change notifications

Contract version 1.0.0 was frozen on 2026-11-05. It was superseded by the
breaking 2.0.0 change on 2026-11-08 after two additive clarifications on
2026-11-07.

When a contract changes, add a dated entry here naming the schema/operation,
the version bump, and which tracks must adapt (API A, worker B, packer C,
web D). Also update `contracts/CHANGELOG.md` and the examples.

### 2026-11-24 — Additive: DTF preflight (contracts 3.2.0)

Contract version is now `3.2.0`. Additive on top of 3.1.0: no existing request
or response changed shape.

- **API (track A):** new `POST /api/v1/preflight` (multipart `file`,
  `targetWidthCm`, `targetHeightCm`, `dpi`, `garmentColorKind`,
  `garmentColorHex`, `profile`, `fix`) returning `PreflightResponse`
  (`report`, plus `fixedImageBase64` when a fix applied). A cut-out now always
  runs preflight report-only and writes `<output>.preflight.json`; its job
  metadata gains `preflightReportPath`, `preflightVerdict` and
  `preflightFindingCount`.
- **New schemas:** `PreflightResponse`, `PreflightReport`,
  `PreflightSpecSummary`, `PreflightFinding`, `PreflightRegion`,
  `PreflightMetric`, `PreflightFixRecord`. The report is a stable document:
  findings and fixes sorted by code, nothing time- or machine-dependent.
- **Web (track D):** `web/src/api/schema.d.ts` regenerated. The review page's
  cutout provider list gains `solid` and `auto`; nothing consumes the preflight
  report in the UI yet — it is written beside the cut-out and returned by the
  ad-hoc endpoint.
- **Worker (track B) / packer (track C):** no change. Preflight is an API-side
  read of pixels and PNG metadata; no new job type, no new file exchange.
- Thresholds are configuration (`Preflight:Profile`), not contract surface, so a
  profile change needs no version bump.

### 2026-11-13 — Additive: AI matte (`withoutbg-open`) and `maskMinAreaPx`

No version bump: the contract stays `2.0.0`. Both additions are optional and no
existing client changes shape.

- **Worker job schema (track B):** `background-removal` gains optional
  `maskMinAreaPx` (0..100000). `aiModel` describes `withoutbg-open` as the only
  available matte and keeps the archived BiRefNet ids out. New warning codes
  `ai-cutout-applied`, `source-alpha-used`, `mask-regions-refined`. The vendored
  `worker/app/_contracts/worker-job.schema.json` is byte-identical.
- **API (track A):** `mode: ai` is accepted again; `aiModel` must be
  `withoutbg-open` (or absent) and is only valid with `ai`. `maskMinAreaPx`
  validated 0..100000 and forwarded. `BackgroundRemovalStepRequest` gained
  `maskMinAreaPx`.
- **Web (track D):** cutout step defaults to `ai`, sends `aiModel:
  withoutbg-open` and `maskMinAreaPx: 24`, and offers a colour-key mode for flat
  art. `web/src/api/schema.d.ts` regenerated.
- **Packer (track C):** no change; a background-removal proposal is still just an
  immutable version with a mask artifact.

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
