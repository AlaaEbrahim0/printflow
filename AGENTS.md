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
low-quality PNG screenshots). The tool proposes trim, upscale, background
removal, vectorization and final print sizing. A human approves every step. The
packer nests approved designs onto a master sheet that is exactly 58 cm wide
(6850 px at 300 DPI); sheet height is minimized because print cost is
proportional to height. Every processing step creates a new immutable
`DesignVersion`; originals are never overwritten; exports are blocked unless a
machine-readable integrity check passes.

**Core rule:** the machine proposes, the human approves, nothing is lost.

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
5. The packer never resamples, recolors or crops pixels. It only translates and
   rotates by multiples of 90°. Rendering uses the original full-resolution
   approved pixels.
6. A blocking integrity check runs before every export.
7. Sizes are stored in physical units (cm) **and** pixels. Working resolution is
   300 DPI (configurable).
8. Never silently alter a design: anything that can change visible pixels is a
   proposal requiring approval.
9. Only approved versions may become current.
10. A batch can be packed only when every non-excluded design is `ready`.
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

**Current phase: Phase 0 (deliverables complete; Docker verification blocked by
host permissions).**
Do **not** start Phase 1 tracks A–D or Phase 2 work without explicit user
confirmation.

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
- [ ] `docker-compose.yml` + Dockerfiles verified with one command — Compose
      config validates, but the local Docker daemon is inactive and starting it
      needs a password (`sudo` unavailable to the agent). Native stack smoke
      test passes. Run `make up` once Docker is available.
- [x] Native run scripts / Makefile
- [x] Root `README.md`
- [x] Final Phase 0 verification and handoff summary (all gates green except the
      Docker run noted above)

Phase 1 tracks (do not start without confirmation):

- **A — API:** aggregates, state machine, versioning, jobs against fake worker.
- **B — Worker:** trim, Real-ESRGAN, size/resample, background-removal modes,
  vectorize, classifier; CLI-testable.
- **C — Packer:** library, integrity check, exporters, property-based tests,
  benchmark.
- **D — Web:** wizard, crop tool, batch grid, packing preview, brush editor,
  against a mock server built from OpenAPI.

Phase 2 (do not start without confirmation): integration, E2E on fixtures,
settings page, cleanup of old files.

---

## 4. Repository map

```text
.
├── AGENTS.md                    ← this file (keep status current)
├── README.md                    ← quick start, contracts, gates, guardrails
├── ARCHITECTURE.md              ← system design and deployment
├── docker-compose.yml           ← postgres + api + worker + web
├── Makefile                     ← setup/up/test/fixtures/clean entry points
├── api/                         ← ASP.NET Core 10 LTS, Clean Architecture
│   ├── PrintSheet.slnx          ← note: .NET 10 uses .slnx, not .sln
│   ├── src/PrintSheet.Domain/   ← aggregates/value objects; no infrastructure
│   ├── src/PrintSheet.Application/
│   ├── src/PrintSheet.Infrastructure/
│   ├── src/PrintSheet.Api/
│   └── tests/PrintSheet.Domain.Tests/
├── worker/                      ← Python 3.11+ FastAPI, Phase 0 health only
├── packer/                      ← standalone Python, no API/worker dependency
│   ├── printsheet_packer/
│   └── spikes/psd-spike/        ← executable PSD/PSB reproducer
├── web/                         ← React 19 + TypeScript + Vite shell
├── contracts/
│   ├── openapi/                 ← printsheet-api.yaml (3.0.3, v1.0.0)
│   ├── jsonschema/              ← 5 worker/packer/integrity contracts
│   └── examples/                ← 14 validated examples
├── docs/
│   ├── domain-model.md          ← aggregates, state machines, invariants
│   ├── adr/                     ← 0001–0006 + index
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

Host limitation observed on 2026-11-05: the Docker daemon is installed but
inactive, `systematic-mess` is not in the `docker` group, and `sudo` requires a
password the agent does not have. `docker compose config` validates the compose
file, but `make up` cannot run until a human starts Docker or grants socket
access. The native API/worker/web stack was smoke-tested instead.

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

## 6. Current service skeletons

### API (`api/`)

- .NET 10 minimal API with Clean Architecture project references.
- `/healthz` checks PostgreSQL (Compose) or SQLite (Development) through EF Core.
- In Development the empty SQLite database is created with `EnsureCreated()` at
  startup; EF's connectivity check treats a missing file as disconnected.
  Migrations/mappings are Phase 1 A.
- `/api/v1/info` returns contract version `1.0.0`.
- `PrintSheetDbContext` is intentionally empty; mappings/migrations are Phase 1 A.
- `PrintUnits` already implements cm↔px and effective DPI; tested.
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

- FastAPI app with `/` and `/health`.
- `PRINTSHEET_*` settings via `pydantic-settings`.
- `PRINTSHEET_MAX_GPU_JOBS` is constrained to 1 (GTX 1650 Ti, 4 GB VRAM).
- No job loop yet. Phase 1 B adds processing and polling/claiming.
- Tests:

```bash
cd worker
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

### Packer (`packer/`)

- Standalone package + CLI; no imports from API/worker.
- `python -m printsheet_packer version` works.
- `validate` command validates JSON documents against contracts, loading all
  schemas into a `referencing` registry so the packer response can resolve the
  integrity-report `$ref`.
- Phase 0 tests only cover the shell; Phase 1 C owns nesting/integrity/export.
- Tests:

```bash
cd packer
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

### Web (`web/`)

- React 19 + TypeScript + Vite 8 shell, dark workbench landing page.
- Live `/healthz` check through Vite proxy to the API.
- Proxy target: `VITE_API_PROXY_TARGET` (default `http://localhost:8080`).
- Build/lint:

```bash
cd web
npm ci
npm run build
npm run lint
```

---

## 7. Frozen contracts

Contract version: **1.0.0** (frozen 2026-11-05).

Canonical files:

- `contracts/openapi/printsheet-api.yaml` — HTTP API, OpenAPI 3.0.3, 38 paths,
  69 schemas.
- `contracts/jsonschema/worker-job.schema.json` — worker request envelope with
  per-type parameters.
- `contracts/jsonschema/worker-result.schema.json` — worker completion result,
  success/failure and classifier suggestions.
- `contracts/jsonschema/packer-request.schema.json` — file-based packer input.
- `contracts/jsonschema/packer-response.schema.json` — placements + outputs,
  referencing the integrity report.
- `contracts/jsonschema/integrity-report.schema.json` — four blocking checks.
- `contracts/examples/` — 14 validated examples covering every worker job type
  and both integrity outcomes.
- `contracts/CHANGELOG.md`, `contracts/README.md` — change policy.

Contract rules:

1. All service-to-service file exchange is by **relative storage path**, never
   base64 or file bytes in JSON.
2. Paths are relative to the shared storage root and must not contain `..`.
3. Worker job types: `classify`, `trim`, `background-removal`, `upscale`,
   `vectorize`, `resize`. Manual crop is a trim job with a manual crop rect but
   is recorded as a `crop` DesignVersion.
4. Packer request/response uses top-left origin, cm for placements, pixels for
   geometry, 90° rotation steps only.
5. `IntegrityReport.passed` is true only when all four blocking checks pass:
   `visible-pixels-inside-sheet`, `dilated-masks-no-overlap`, `minimum-gap`,
   `pixel-equality`.
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
- Step types: `original`, `trim`, `crop`, `upscale`, `vectorize`,
  `background-removal`, `resize`.
- Only one `proposed` version per design. A stale proposal (parent no longer
  current) must be rejected, not quietly rebased.
- A design becomes `ready` only when the current approved version is a `resize`
  and target dimensions are set.
- Reverting sets the current pointer to an earlier approved version; it does
  **not** create or delete a version. If the target is not a current-matching
  resize, the design returns to `in-progress`.
- The final `resize` step resamples exactly once with Lanczos to
  `round(cm * dpi / 2.54)` pixels.
- `PrintUnits.PixelsForCentimeters` uses round-half-away-from-zero:
  58 cm × 300 DPI → 6850 px.
- Low-DPI warnings: warn below 150 DPI, strongly warn below 100 DPI. These are
  configurable settings, not scattered magic numbers.
- Background removal is a non-destructive mask. Modes: AI cutout, key-color to
  alpha (unmultiplied color), none. Brush operations are stored in version
  parameters; the mask is an artifact, never destructive.
- Full-bleed inputs (all four edges non-uniform) must not get an auto-trim
  proposal.
- Vectorize output has a preview raster version and an SVG artifact; the final
  resize can rasterize from the SVG at target size/DPI.
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
make api / worker / web / worker-gpu
```

Raw commands, if you need them:

```bash
cd api && dotnet test PrintSheet.slnx
cd worker && .venv/bin/python -m pytest
cd packer && .venv/bin/python -m pytest
cd web && npm run build && npm run lint
.venv-contracts/bin/python scripts/validate_contracts.py
```

Every logical step should pass its relevant gate before commit. The packer and
integrity check will later get property-based/adversarial tests; do not treat a
green smoke test as sufficient for Phase 1 C.

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
- JSON casing: lowercase kebab statuses/enums (`in-progress`, `background-removal`),
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
  in Compose use PostgreSQL. `AddDbContextCheck` only checks connectivity — no
  migrations/tables exist yet.
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

**Last updated:** 2026-11-05 (Phase 0 deliverables complete)

**Done and verified:**

- Git repo initialized (`main`); skeleton commit `d0d44b9`.
- API Clean Architecture skeleton builds; 10 domain unit tests pass.
- API `/healthz` wired to EF Core. Native SQLite dev DB is created at startup
  (`EnsureCreated`) so the connectivity probe passes; Compose uses PostgreSQL.
- Worker FastAPI skeleton; 2 tests pass.
- Packer package/CLI shell; 2 tests pass; external `$ref` registry works.
- Web shell builds and lints clean.
- PSD/PSB spike rerun from the committed reproducer; report and JSON results in
  `docs/spikes/psd-spike/`.
- Frozen contracts complete: 5 JSON Schemas, 14 examples, OpenAPI 3.0.3 with 38
  paths / 69 schemas. `scripts/validate_contracts.py` green.
- `ARCHITECTURE.md`, `docs/domain-model.md`, ADRs 0001–0006 with index.
- `scripts/generate_fixtures.py` produces 10 realistic inputs + manifest +
  contact sheet under `fixtures/generated/` (git-ignored).
- `docker-compose.yml`, `Makefile`, native run scripts, smoke test, root
  `README.md`.
- `make test` green: contracts, 10 API tests, 2 worker tests, 2 packer tests,
  web build + oxlint.
- Native end-to-end smoke passed: API `/healthz` + database, `/api/v1/info`,
  worker `/health` with writable storage, web page.
- `docker compose config` validates.

**In progress / immediate next:**

1. Docker verification is the only open Phase 0 gate. Start Docker and grant
   socket access, then run:
   ```bash
   sudo systemctl start docker
   sudo usermod -aG docker "$USER"   # then log out/in
   make up
   ```
   If the build surfaces a Dockerfile/compose issue, fix it and rerun
   `make test` + `make smoke`.
2. Mark the Docker deliverable complete in section 3, commit Phase 0, and stop.
3. Do not start Phase 1 A–D without explicit user confirmation.

**Blockers:** local Docker daemon is inactive and the agent cannot start it
(no passwordless sudo, user not in the `docker` group). Everything else is
green.

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

---

## 15. Handoff log

Append newest entries at the top. Keep them short and factual.

### 2026-11-05 — Phase 0 completion (Docker gate open)

- Finished all Phase 0 docs, contracts, spike report, fixtures, Compose,
  Makefile, native scripts and README.
- `make test` and a native API/worker/web smoke test pass.
- Fixed native health: SQLite dev database is created at startup.
- Docker daemon cannot be started by the agent; `docker compose config` is
  valid, but `make up` still needs a human. Next action is section 14 item 1.

---

## 16. Contract change notifications

Contract version 1.0.0 was frozen on 2026-11-05. No post-freeze changes.

When a contract changes, add a dated entry here naming the schema/operation,
the version bump, and which tracks must adapt (API A, worker B, packer C,
web D). Also update `contracts/CHANGELOG.md` and the examples.
