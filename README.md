# PrintSheet Workbench

Internal, review-driven DTF print preparation. Staff upload a batch of customer
designs, the system proposes trim, crop, background removal, Real-ESRGAN
enhancement and final print sizing, and a human approves every step. Background
removal keys out a flat colour and exposes mask shaping — grow/contract the
selection, feather the edge, and apply separate levels to the mask and the image
— so logos, text and line art cut cleanly; busy artwork is still cut in Photoshop
and imported as ready-to-pack. Vectorization was retired in contract v2.0.0.
Approved designs are
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
| Worker | <http://localhost:8000> | `/health`, `/v1/crop`, `/v1/upscale` |
| withoutBG | <http://localhost:8002> | `/health`, `/ready`; background removal |
| PostgreSQL | internal only | `postgres:5432` on the Compose network |

`make up` builds the images, waits for health, and smoke-tests the API,
database connectivity, worker storage and web page. `make logs` follows logs;
`make down` stops; `make reset` also deletes the database and storage volumes.

Optional overrides go in `.env` (copy `.env.example`): ports, database
credentials, the internal worker key and the background-removal provider
selection. The defaults are development-only.

### What Compose runs

- **api** — ASP.NET Core 10, PostgreSQL, storage at `/data/storage`.
- **worker** — FastAPI image processor, CPU-only, claims image jobs and shares
  the storage volume.
- **withoutbg** — self-hosted withoutBG v4 background-removal service (CPU,
  pinned by digest, ~1.5 GB model loaded before `/ready` succeeds).
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

`scripts/run-api.sh` pins `Storage__Root` to the repo-root `storage/`, the same
directory `scripts/run-worker.sh` and the packer read. This is not optional:
`Storage:Root` in the settings file is a *relative* path, and `dotnet run` puts
the process working directory at `api/src/PrintSheet.Api`, so without the pin the
API writes uploads into `api/src/PrintSheet.Api/storage` while the worker looks
in `storage/`. Every job then fails with `input file is missing` even though the
file was written successfully.

GPU note: the Compose worker cannot use the host GPU. Run
`make worker-gpu-setup` once to install the pinned Real-ESRGAN binary/models,
then use `make worker-gpu` for GPU work. On the target workstation this selects
the GTX 1650 Ti as Vulkan device 1; override
`PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX` if device ordering differs. GPU jobs
are serialized (`max_gpu_jobs = 1`) because the card has 4 GB VRAM.

---

## Background removal

Background removal is a first-class step: `POST
/api/v1/designs/{designId}/steps/background-removal` queues a `background-removal`
job and returns `202` immediately. The API then runs the job itself and writes the
cut-out as a `proposed` version, exactly like a worker step, so approval and
rejection work unchanged.

The API executes this job rather than a worker. The provider adapters, the
crop/upscale clients and the alpha refiner all live in the API, and a pipeline run
takes tens of seconds — far too long for a request. A hosted service
(`BackgroundRemovalWorker`) polls for queued cutout jobs one at a time and runs
them through `BackgroundRemovalJobRunner`.

Workers cannot claim these jobs. A cutout carries the `cutout` capability, which
the claim endpoint refuses to parse for a caller, and `background-removal` is
absent from the worker job schema. This keeps the promise that a worker is never
leased a job it has no processor for.

The pipeline lives in the Application layer
(`api/src/PrintSheet.Application/BackgroundRemoval`) and depends only on ports:
a background remover, a cropper, an upscaler, an alpha refiner and an alpha
compositor. Infrastructure supplies the adapters, so the business logic contains
no provider names, URLs or HTTP status codes.

Order of operations, in `BackgroundRemovalPipeline`:

1. auto-crop the upload (worker `/v1/crop`, the same rules as the trim job);
2. remove the background on the **cropped, low-resolution** image — the open
   model computes a matte at its own internal resolution, so feeding it the full
   print-size image only costs time and adds edge fringing;
3. upscale the **cropped original colours** with Real-ESRGAN (worker
   `/v1/upscale`), never the provider's cutout;
4. upscale the provider's matte to the colour size and refine it
   (bicubic/Mitchell, optional contraction, optional feather, optional threshold);
5. recombine: the upscaled RGB with the refined alpha.

Providers are chosen by the server configuration; the design review's "Remove
background" step offers `Server default` / `Local · withoutBG` / `Poof · cloud`
and sends `provider` only for an explicit override. `Server default` follows
`BackgroundRemoval:DefaultProvider`.

| Setting | Meaning |
| --- | --- |
| `BackgroundRemoval:DefaultProvider` | `withoutbg` (default) or `poof` |
| `BackgroundRemoval:FallbackProvider` | optional second provider; empty disables fallback |
| `BackgroundRemoval:RunJobs` | set `false` to stop the API executing cutout jobs |
| `BackgroundRemoval:Poof:ApiKey` | Poof key; never logged |
| `BackgroundRemoval:Poof:BaseUrl` | defaults to `https://api.poof.bg/v1/` |
| `BackgroundRemoval:WithoutBg:BaseUrl` | defaults to `http://localhost:8002` |
| `BackgroundRemoval:PrepareWorker:BaseUrl` | worker base URL |
| `BackgroundRemoval:PrepareWorker:WorkerKey` | falls back to `Worker:Key` |
| `BackgroundRemoval:PrepareWorker:UpscaleScale` | 2 or 4 (Real-ESRGAN's only ratios) |
| `BackgroundRemoval:PrepareWorker:UseGpu` | false for the CPU worker |
| `BackgroundRemoval:AlphaFeatherPx` | matte feather radius, default 0.5; 0 disables |
| `BackgroundRemoval:AlphaContractPx` | matte contraction in pixels, default 2; 0 disables |
| `BackgroundRemoval:AlphaThreshold` | optional hard cutoff (0–255); off by default |
| `BackgroundRemoval:MaxInputBytes` | 20 MB, Poof's hard cap (applied to the cropped upload) |

`RunJobs: false` leaves queued cutouts untouched, which is what a read-only or
migration instance wants. The single-job-at-a-time limit is deliberate: the
pipeline holds several full-size PNGs in memory and the upscaler owns the GPU.

The request body is optional and only overrides the provider for one job:

```bash
curl -X POST http://localhost:8080/api/v1/designs/$DESIGN_ID/steps/background-removal \
  -H 'Content-Type: application/json' -d '{}'
# 202 {"jobId": "...", "status": "queued", ...}
```

The 20 MB cap is the provider's upload limit, so it is enforced on the cropped
image that is actually sent — not on the untouched original, which cropping
usually brings well under the cap.

Fallback is deliberately narrow. It fires for availability faults (401, 402,
403, 429, 5xx, timeouts, circuit open) and never for input faults (400, 413,
422): the same bytes would be rejected by the second provider too. Every
outbound call here is a POST that spends real work — a billed Poof credit, an
exclusive GPU minute, a full CPU inference — so the HTTP clients disable retries
for unsafe methods outright. A retry after an attempt timeout could charge twice
or hold the GPU twice; fallback and re-running the use case cover transients
instead. Timeouts and circuit breakers still apply. A cutout that fails for an
availability reason is reported as retryable, so it is requeued; an input fault
is terminal.

### Poof key (secret)

Never commit the key. Locally:

```bash
cd api/src/PrintSheet.Api
dotnet user-secrets set "BackgroundRemoval:Poof:ApiKey" "sk_..."
```

The API project has a `UserSecretsId`; `appsettings*.json` keeps the key empty
so the service still starts when Poof is not in use (the adapter then reports an
availability failure and the selector may fall back). In Compose the key comes
from the environment:

```bash
POOF_API_KEY=sk_... BACKGROUND_REMOVAL_PROVIDER=poof docker compose up -d
```

`BackgroundRemoval__Poof__ApiKey` is read from `POOF_API_KEY`;
`BackgroundRemoval__DefaultProvider` from `BACKGROUND_REMOVAL_PROVIDER`; and
`BackgroundRemoval__FallbackProvider` from `BACKGROUND_REMOVAL_FALLBACK` (empty
by default, so a missing key never produces a surprise billed call).

### Running withoutBG

Compose starts it automatically:

```bash
docker compose up -d withoutbg     # http://localhost:8002, /health and /ready
```

The image is pinned by digest in `docker-compose.yml`. Bump it deliberately
after reviewing the release notes; a re-tagged `latest` must not silently change
the model behind an approved cutout.

Native development can point at the same container: `WithoutBg:BaseUrl` in
`appsettings.Development.json` is `http://localhost:8002`. The development
settings point the prepare routes at the plain worker on `:8000`; Real-ESRGAN is
only installed for the GPU worker, so to exercise the upscale step natively run
`make worker-gpu` and set `BackgroundRemoval:PrepareWorker:BaseUrl` to
`http://localhost:8001` with `UseGpu: true`.

Step 3 needs a worker with Real-ESRGAN installed. The Compose worker ships
without the engine binary, so a Compose-only deployment can remove backgrounds
but cannot finish the pipeline; run the native GPU worker (`make worker-gpu`)
and point `BackgroundRemoval:PrepareWorker:BaseUrl` at it. That is deliberate:
print-size upscaling on CPU takes minutes per layer even with the engine present,
and the pipeline's timeouts are sized for a GPU.

The API health check for withoutBG is tagged `dependency`, and `/healthz` skips
dependency checks, so the workbench stays up when the cutout service is down.

### Tests

Adapter, runner and pipeline tests use fake HTTP handlers and fake ports; nothing
calls Poof. The claim boundary is covered against a real SQLite database, so the
"workers never see a cutout" rule is tested where it is enforced. The Docker
integration test is skipped unless a container URL is exported:

```bash
docker compose up -d withoutbg
make test-api-docker          # adapter against the real container

# The whole pipeline needs a worker with Real-ESRGAN installed; the Compose
# worker has no engine binary. This target starts one on :8001 without the job
# loop, so it does not compete with a running worker.
make worker-live-test &
make test-api-live
```

The live run is the only one that proves the matte actually lands at print size;
it crops, removes, upscales, refines and recombines a synthetic artwork and
asserts the subject stays opaque while the paper becomes transparent.

### Known limitation: input that already has transparency

The pipeline assumes an opaque source (a scan, photo or flattened export). The
worker's upscaler refuses an image with real transparency, because upscaling a
matte here would invent edges that the provider matte owns, so a transparent
upload fails the pipeline with `InvalidImage` instead of being flattened behind
your back. Flatten such a source onto its intended background before running
background removal; the opaque-alpha PNG the cropper normally produces is
accepted (see `worker/README.md`).

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

### Open in Photopea (browser editing)

Every design card and the review page also expose **Open in Photopea**, which
opens `/batches/:batchId/designs/:designId/photopea?versionId=…` — a full-screen
route outside the workbench shell. It embeds the official editor at
`https://www.photopea.com/` and talks to it through the documented
[Live Messaging API](https://www.photopea.com/api/live):

- The exact version file is fetched same-origin (`credentials: 'same-origin'`)
  and handed to the frame as an `ArrayBuffer` via `postMessage`, so no image URL
  or token is ever exposed to Photopea.
- **Save as ready-to-pack** exports with `app.activeDocument.saveToOE("png")`,
  receives the bytes as an `ArrayBuffer`, wraps them in a PNG `File`, and posts
  it through the existing ready-to-pack intake as a **new design** in the same
  batch. The version that was opened is never modified. **Download PNG** is
  offered for operators who want to bring the file back manually.

The messaging layer lives in `web/src/lib/photopea.ts` (handshake, command
acknowledgements, export buffers, timeouts, listener cleanup, and rejection of
messages from foreign windows or origins); the frame is owned by
`web/src/components/photopea/PhotopeaEditor.tsx`. This is a manual editing
handoff — there is no AI step, MCP server, or browser automation involved.

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
