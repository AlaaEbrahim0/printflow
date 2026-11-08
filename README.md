# PrintSheet Workbench

Internal, review-driven DTF print preparation. Staff upload a batch of customer
designs, the system proposes trim, crop, Real-ESRGAN enhancement and final print
sizing, and a human approves every step. Background removal and vectorization
were retired in contract v2.0.0; staff finish those in Photoshop and can import
the exported PNGs directly as ready-to-pack artwork. Approved designs are
nested onto a master sheet that is exactly **58 cm wide** (6850 px at 300 DPI);
sheet height — and therefore print cost — is minimized. Every step creates an
immutable version, originals are never overwritten, and export is blocked
unless a machine-readable integrity check passes.

**Core rule: the machine proposes, the human approves, nothing is lost.**

> Phase 3 image-quality validation is in progress. The API, worker, packer,
> workbench screens, settings, lease-based packer runner and Compose stack are
> implemented, and the fixture-backed intake-to-export flow passes with the
> five-check v2.0 integrity report. GPU enhancement runs natively. See
> [`AGENTS.md`](AGENTS.md) for current verification status.

---

## Quick start (Docker Compose)

Requirements: Docker with Compose v2.

```bash
make up
# or: docker compose up --build -d --wait
./scripts/smoke_test.py
```

| Service | URL | Notes |
| --- | --- | --- |
| Web workbench | <http://localhost:5173> | Vite dev server, proxies `/api` and `/healthz` |
| API | <http://localhost:8080> | `/healthz`, `/api/v1/info` |
| Worker | <http://localhost:8000> | `/health` |
| PostgreSQL | internal only | `postgres:5432` on the Compose network |

`make up` builds the images, waits for health, and smoke-tests the API,
database connectivity, worker storage and web page. `make logs` follows logs;
`make down` stops; `make reset` also deletes the database and storage volumes.

Optional overrides go in `.env` (copy `.env.example`): ports, database
credentials and the internal worker key. The defaults are development-only.

### What Compose runs

- **api** — ASP.NET Core 10, PostgreSQL, storage at `/data/storage`.
- **worker** — FastAPI image processor, CPU-only, claims image jobs and shares
  the storage volume.
- **packer** — lease-based runner for sheet packing, integrity checks and
  exports; invokes the standalone packer CLI and shares storage.
- **web** — Vite dev server.
- **postgres** — persisted in the `postgres_data` volume.

The packer library/CLI remains independent of the API and worker; only its
small job runner communicates with the API.

---

## Native development

Requirements: .NET SDK 10, Python 3.11+, Node 24+, npm.

```bash
make setup          # restore NuGet, create worker/packer venvs, npm ci, contract venv
make test           # every gate
```

Run the services in separate terminals:

```bash
make api            # http://localhost:8080, SQLite, storage/ in repo root
make worker         # http://localhost:8000, claims image jobs
cd packer && .venv/bin/printsheet-packer-runner
make web            # http://localhost:5173, proxies to :8080
```

The native API uses `api/src/PrintSheet.Api/appsettings.Development.json`
(SQLite at `printsheet.dev.db`, storage root `storage`). The Compose API uses
PostgreSQL and `/data/storage`. They are intentionally different; do not point
native development at the Compose database unless you mean to.

GPU note: the Compose worker cannot use the host GPU. Run
`make worker-gpu-setup` once to install the pinned Real-ESRGAN binary/models,
then use `make worker-gpu` for GPU work. On the target workstation this selects
the GTX 1650 Ti as Vulkan device 1; override
`PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX` if device ordering differs. GPU jobs
are serialized (`max_gpu_jobs = 1`) because the card has 4 GB VRAM.

---

## Repository map

```text
api/         ASP.NET Core 10, Clean Architecture (Domain/Application/Infrastructure/Api)
worker/      Python FastAPI image-processing worker
packer/      Standalone Python nesting/integrity/export package + CLI
web/         React 19 + TypeScript + Vite workbench UI
contracts/   Frozen OpenAPI 3.0.3 + JSON Schemas + validated examples
docs/        Domain model, ADRs, PSD spike report
fixtures/    Generator script and docs; generated images are git-ignored
scripts/     Run, smoke-test, fixture-generation and contract-validation scripts
```

Key documents:

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, deployment, ports,
  data flow, testing strategy.
- [`docs/domain-model.md`](docs/domain-model.md) — aggregates, state machines,
  invariants, commands, error codes.
- [`docs/adr/`](docs/adr/README.md) — stack split, job queue, layered export,
  packer algorithm, storage, immutable versioning.
- [`docs/spikes/psd-spike/`](docs/spikes/psd-spike/README.md) — measured
  PSD/PSB limits behind the layered-export decision.
- [`contracts/README.md`](contracts/README.md) — frozen interfaces and change
  policy.
- [`AGENTS.md`](AGENTS.md) — operating manual and live handoff status.

---

## Contracts

Contract version: **1.0.0**. Canonical files:

```text
contracts/openapi/printsheet-api.yaml
contracts/jsonschema/worker-job.schema.json
contracts/jsonschema/worker-result.schema.json
contracts/jsonschema/packer-request.schema.json
contracts/jsonschema/packer-response.schema.json
contracts/jsonschema/integrity-report.schema.json
contracts/examples/*.json
```

Validate everything:

```bash
make test-contracts
# or
python3 -m venv .venv-contracts
.venv-contracts/bin/pip install -r scripts/requirements-dev.txt
.venv-contracts/bin/python scripts/validate_contracts.py
```

Rules that are easy to break:

- Service-to-service file exchange uses **relative storage paths**, never
  base64 or file bytes in JSON. Intake multipart is the only exception.
- Paths must not contain `..`.
- Packer placements use a top-left origin, cm for positions, px for geometry,
  and rotations of exactly 0/90/180/270°.
- The four blocking integrity checks have fixed IDs and any `skipped` check
  means the report is **not** passed.
- Export is blocked when the report is missing, stale or failed for the sheet
  revision.

Contract changes require updating the schema, its examples, the changelog, and
notifying the other tracks. See `contracts/README.md`.

---

## Fixtures

The fixtures are generated, not committed, so the repo stays small and the
inputs stay reproducible:

```bash
make fixtures
# -> fixtures/generated/images/, manifest.json, contact-sheet.png
```

They cover full-bleed art, white smoke on black, a flat logo, a thin signature
at ~94 DPI, pale mist, an alpha sticker with fringe, a tall banner, an
over-wide banner, a low-quality JPEG screenshot and a flat vector logo. The
manifest records expected trim/enhancement behavior, dimensions, effective DPI
and SHA-256. See [`fixtures/README.md`](fixtures/README.md).

---

## Tests and gates

```bash
make test             # contracts + API + worker + packer + web
make test-api         # dotnet test PrintSheet.slnx
make test-worker      # pytest
make test-packer      # pytest
make test-web         # tsc + vite build + oxlint
make test-contracts   # schemas, examples, OpenAPI
make verify           # alias for make test
```

Run the fixture-backed API/worker/packer flow after the services are running:

```bash
make up
make e2e-fixtures
```

The E2E command creates a new batch, uploads the generated fringe fixture,
resizes and approves a version, packs a sheet, runs the blocking integrity
check, and downloads the exported PNG and preview. It leaves the batch in the
database for inspection. For a native stack, start `make api`, `make worker`,
and `cd packer && .venv/bin/printsheet-packer-runner` in separate terminals
before running it.

Every logical change should pass its relevant gate before commit. Packer
property/adversarial tests cover nesting and integrity; a passing fixture flow
complements rather than replaces those tests.

---

## Product guardrails

1. The original upload is never modified or overwritten.
2. Every processing step creates a new immutable version. Current is a pointer.
3. Only approved versions may become current; reject/undo/revert always work.
4. Previews show checkerboard and selectable garment colors; halos and fringes
   must be visible there.
5. The packer never resamples, recolors or crops; it translates and rotates by
   90° only, using full-resolution approved pixels.
6. A blocking integrity check runs before every export.
7. Sizes are stored in cm **and** px at configurable DPI (default 300).
8. Designs wider than the roll are rejected or scaled only by explicit user
   choice.
9. A batch packs only when every non-excluded design is ready.
10. Any design, target-size or batch-geometry change invalidates the sheet.
11. Ready-to-pack imports keep the operator's exact pixels: the upload is
    preserved as the original, a separate approved resize version is current,
    and supplied centimetres must match the pixels or the import is rejected.

---

## Two intake paths

| Path | When | What happens |
| --- | --- | --- |
| Enhancement intake | The source needs help. Target cm required. | Original stored immutably, `classify` queued, trim/crop/enhance/resize proposed for approval. |
| Ready-to-pack intake | Background removal and final sizing were done in Photoshop. | Original stored immutably, a copy becomes an approved `resize` version and is current, target cm derived from pixels at the batch DPI, no job queued. |

In the workbench, the design review page offers **Download for Photoshop** for
the current and proposed versions; the batch page imports the finished PNGs in
one multi-file step. Nothing is launched automatically — the operator opens the
file in Photoshop and saves the export back into the batch.

---

## Layered export decision (short version)

Classic PSD is limited to 30,000 px per side (~254 cm at 300 DPI); a dense
sheet can reach ~59,000 px. The PSD spike measured that `psd-tools` can write a
PSB above the limit but cannot composite or read back its rasters, needs a
private-state workaround, and extrapolates to ~2.3 GB peak for a 500 cm sheet.

Therefore the guaranteed layered deliverable is:

1. flat transparent PNG/TIFF at 300 DPI (strip-rendered),
2. a JSON placements manifest with source version IDs and hashes,
3. a Photoshop `.jsx` rebuild bundle.

True layered PSD is optional within validated limits; layered PSB is gated
until a strip-based writer and real-Photoshop smoke tests exist. See
[ADR 0003](docs/adr/0003-layered-export-format.md) and the
[spike report](docs/spikes/psd-spike/README.md).

---

## Security and scope

- Internal, single-operator tool. There is no staff authentication in the MVP;
  deploy on a trusted LAN.
- Internal worker endpoints use a shared `X-Worker-Key`; it is never sent to the
  browser.
- Customer artwork stays local. AI processing runs on the workstation.
- sRGB only; ICC/CMYK workflows are out of scope for the MVP.
- The MVP targets one workstation. Multi-machine deployment would require
  object storage and a shared queue; those are explicit non-goals for now.
