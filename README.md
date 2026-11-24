# PrintSheet Workbench

Internal, review-driven DTF print preparation. Staff upload a batch of customer
designs, the system proposes trim, crop, Real-ESRGAN enhancement, final print
sizing and background removal — in the shop's order, crop → enhance → set print
size → remove background — and a human approves every step. Background
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

Order of operations, in `BackgroundRemovalPipeline`. There are two modes,
because the shop's step order is crop → enhance → set print size → remove
background, so the cut-out usually runs on a version that is already at its
final print pixels:

*Default (no print size yet)* — the cut-out also prepares the artwork:

1. auto-crop the upload (worker `/v1/crop`, the same rules as the trim job);
2. remove the background on the **cropped, low-resolution** image — the open
   model computes a matte at its own internal resolution, so feeding it the full
   print-size image only costs time and adds edge fringing;
3. upscale the **cropped original colours** with Real-ESRGAN (worker
   `/v1/upscale`), never the provider's cutout;
4. upscale the provider's matte to the colour size and refine it
   (bicubic/Mitchell, optional contraction, optional feather, optional threshold);
5. recombine: the upscaled RGB with the refined alpha.

*`preserveSize` (parent is already the approved print size)* — steps 1 and 3 are
skipped. The packer requires the final version to be exactly the target pixels,
so a cut-out that re-cropped or re-upscaled would stop matching and the design
could never be packed. The provider still gets the same bytes and the matte is
refined to the input's own size. The decision is made once when the job is
queued and recorded in the job's `parameters.preserveSize`, so the runner never
re-derives it from state that may have changed.

A design is `ready` when the current version is a resize **or a cut-out** whose
pixels equal the target at the working DPI (`Design.RecomputeStatus`). A mono
refinement at those pixels counts too. Any other step is not terminal, because
nothing would then guarantee the printed size.

Providers are chosen by the server configuration; the design review's "Remove
background" step offers `Server default` / `Solid · local` / `Local · withoutBG` /
`Poof · cloud` / `Auto · solid → local → Poof`, and sends `provider` only for an
explicit override. `Server default` follows `BackgroundRemoval:DefaultProvider`.

`solid` is the deterministic local remover for flat artwork on a solid
background: it samples the border, refuses when the border is not uniform enough
to be a background, and keys the sampled colour with a hard contract, so a logo on
a flat canvas is cut in milliseconds with no model and no network. `auto` probes
`solid` first and falls through to withoutBG and then Poof when the border
analysis says the image is not flat; an explicit `solid` that cannot apply fails
loudly instead of silently doing nothing.

| Setting | Meaning |
| --- | --- |
| `BackgroundRemoval:DefaultProvider` | `withoutbg` (default), `poof`, `solid` or `auto` |
| `BackgroundRemoval:FallbackProvider` | optional second provider; empty disables fallback |
| `BackgroundRemoval:RunJobs` | set `false` to stop the API executing cutout jobs |
| `BackgroundRemoval:Solid:BackgroundTolerance` | per-channel RGB distance a pixel may be from the sampled background and still be keyed, default 22 |
| `BackgroundRemoval:Solid:MinBorderUniformity` | share of border pixels that must match the sampled colour before the remover will run, default 0.90 |
| `BackgroundRemoval:Solid:MaxBorderForegroundRatio` | share of border pixels that may be artwork before the remover refuses, default 0.02 |
| `BackgroundRemoval:Solid:BorderWidthPx` | thickness of the sampled border, default 2 px |
| `BackgroundRemoval:Solid:EdgeBandPixels` | how far the fractional-alpha band reaches into the foreground, default 3 px |
| `BackgroundRemoval:Solid:MinSpeckArea` | opaque specks under this pixel area are dropped, default 12 |
| `BackgroundRemoval:Poof:ApiKey` | Poof key; never logged |
| `BackgroundRemoval:Poof:BaseUrl` | defaults to `https://api.poof.bg/v1/` |
| `BackgroundRemoval:WithoutBg:BaseUrl` | defaults to `http://localhost:8002` |
| `BackgroundRemoval:WithoutBg:MaxInputPixels` | largest image sent to the CPU provider, default 1,000,000; larger crops are downscaled first and the matte is scaled back up |
| `BackgroundRemoval:Poof:MaxInputPixels` | largest image sent to Poof, default 24,000,000; Poof returns a full-resolution matte, so this only bounds the upload |
| `BackgroundRemoval:PrepareWorker:BaseUrl` | worker base URL |
| `BackgroundRemoval:PrepareWorker:WorkerKey` | falls back to `Worker:Key` |
| `BackgroundRemoval:PrepareWorker:UpscaleScale` | 2 or 4 (Real-ESRGAN's only ratios) |
| `BackgroundRemoval:PrepareWorker:UseGpu` | false for the CPU worker |
| `BackgroundRemoval:PrepareWorker:MaxAiOutputPixels` | largest output sent to Real-ESRGAN; unset derives it from `UseGpu` (4M on GPU, 150k on CPU — the CPU engine manages ~970 px/s against a 300 s attempt timeout). Above it the crop is resampled in-process |
| `BackgroundRemoval:PrepareWorker:MaxOutputPixels` | ceiling for the upscaled colour layer, default 24,000,000; the requested scale is halved until it fits |
| `BackgroundRemoval:AlphaFeatherPx` | matte feather radius, default 0.5; 0 disables |
| `BackgroundRemoval:AlphaContractPx` | matte contraction in pixels, default 2; 0 disables |
| `BackgroundRemoval:AlphaThreshold` | optional hard cutoff (0–255); off by default |
| `BackgroundRemoval:MaxInputBytes` | 20 MB, Poof's hard cap (applied to the bytes actually uploaded) |

`RunJobs: false` leaves queued cutouts untouched, which is what a read-only or
migration instance wants. The single-job-at-a-time limit is deliberate: the
pipeline holds several full-size PNGs in memory and the upscaler owns the GPU.

The Compose API talks to the CPU worker (`http://worker:8000`, `UseGpu=false`).
Handing the upscale to the native GPU worker on the host needs the container to
reach a host port. The API service maps `host.docker.internal` to the host
gateway for that, so:

```bash
BACKGROUND_REMOVAL_PREPARE_WORKER_BASE_URL=http://host.docker.internal:8001 \
WORKER_GPU_ENABLED=true docker compose up -d api
```

That only works if the host firewall accepts traffic from the Docker bridge.
On the reference workstation it does not: every host port, on both the
`docker0` and the Compose bridge gateway, times out from inside the container
while container-to-container traffic is fine. Verify before relying on it:

```bash
docker compose exec api curl -sf http://host.docker.internal:8001/health
```

If that fails, run the API natively (`make api`) so it can use `localhost:8001`,
or leave Compose on the CPU worker — the pixel budget keeps that path bounded
and it finishes, just without the AI detail.

The request body is optional and only overrides the provider for one job:

```bash
curl -X POST http://localhost:8080/api/v1/designs/$DESIGN_ID/steps/background-removal \
  -H 'Content-Type: application/json' -d '{}'
# 202 {"jobId": "...", "status": "queued", ...}
```

The 20 MB cap is the provider's upload limit, so it is enforced on the bytes that
are actually sent — the downscaled image when a pixel budget applied, not the
untouched original, which cropping usually brings well under the cap.

The pixel budget is per provider because the two engines are not alike. The
self-hosted model runs on the workstation CPU at roughly 1 MP per 30 s and
mattes at its own low internal resolution anyway, so `WithoutBg:MaxInputPixels`
defaults to 1,000,000: a print-size crop would only time out. Poof answered
6.2 MP in 5.5 s and 24 MP in 6.7 s and returns a matte at the input resolution,
so `Poof:MaxInputPixels` defaults to 24,000,000 — downscaling it would soften
the anti-aliased edge (measured mean 17/255 alpha error against the native
matte). When a fallback provider is configured, the tighter of the two budgets
applies, because the selector may switch after the image has been resized.

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
by default, so a missing key never produces a surprise billed call). The
simplest local setup is a gitignored `.env` (copy `.env.example`) holding
`POOF_API_KEY=...`; Compose picks it up automatically.

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
settings point the prepare routes at the plain worker on `:8000`, which runs
Real-ESRGAN on the CPU. To exercise the upscale step on the GPU run
`make worker-gpu` and set `BackgroundRemoval:PrepareWorker:BaseUrl` to
`http://localhost:8001` with `UseGpu: true`.

Step 3 needs a worker with Real-ESRGAN installed. The Compose worker ships the
engine at `/tools` and will run it on llvmpipe (software Vulkan) because the
container has no GPU device; that works but is slow — measured ~970 px/s of
output, so a 300 s attempt covers roughly 150k px. The pipeline's default CPU
budget is sized to that, and anything larger is resampled in-process instead of
timing out. For print-size upscaling run the native GPU worker (`make worker-gpu`)
and point `BackgroundRemoval:PrepareWorker:BaseUrl` at it with `UseGpu: true`:
the same engine on the GTX 1650 Ti managed ~25k px/s (480k px in 19.5 s), about
25x faster.

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

## Mono refinement (clean 1-bit ink)

For text, line art and single-ink logos, DTF output is only clean if the artwork
is hard ink — every pixel either fully printed or not printed at all. A JPEG of a
logo is none of those things: it carries blocking, ringing around every stroke,
mosquito noise in the paper and colour fringing on the edges, and a DTF printer
turns all of that into visible speckle. The `refine-mono` step removes it and
cuts the artwork to exactly two states.

```bash
curl -X POST http://localhost:8080/api/v1/designs/$DESIGN_ID/steps/refine-mono \
  -H 'Content-Type: application/json' -d '{"preset":"text"}'
# 202 {"jobId": "...", "status": "queued", ...}
```

It runs in the **worker, at the full print resolution**, never on a preview: a
cut made on a downscaled preview bakes the preview's own noise into the plate.
The API only validates what an operator can choose and queues the job; the
classifier inside the worker decides what is actually done.

### The gate comes first

The worker measures the artwork before touching it. Otsu separability η
(between-class variance ÷ total variance) says whether the tones split into two
populations at all; a second feature — the share of ink pixels whose chroma is
≤ 24 — says whether the ink is neutral or whether colour is load-bearing.

| Kind | Meaning | What happens |
| --- | --- | --- |
| `mono-ink` | Two well-separated tones, neutral ink | Cleaned and binarized |
| `flat-colour` | Flat artwork, but the colour matters | **Only** binarized with `binarizeFlatColour` |
| `photo` | Continuous tones | Left untouched, job succeeds with `skipped: true` |

Measured on the ten fixtures with luminance composited over white, mono-type art
scores η ≥ 0.922 and photographs ≤ 0.788, so the 0.85 threshold sits in an empty
band (10/10 correct). Neutral-ink share separates absolutely: `mono-ink` ≥ 0.946,
`flat-colour` 0.000.

Two consequences are deliberate. **A photograph is not a failure** — the job
succeeds and writes the input through unchanged with the measured reason, because
failing would make every ordinary design look broken in the queue. And **a preset
can only narrow the gate, never widen it**: choosing `logo` on a photo still
reports "these tones are not separable" rather than flattening it.

### The chain

`denoise → upscale → binarize → despeckle → fillHoles → morphology → validate`.
Each stage is an independent unit behind a `Stage` protocol with its own trace, so
it can be tested alone and the order is data, not control flow.

* **Denoise** — median 3×3 by default. On a low-resolution JPEG upscaled to
  1440×960 it cut isolated noise pixels 56 → 8 and blobs ≤ 4 px 262 → 208 in
  ~1 ms, while leaving a 3 px stroke intact.
* **Binarize** — Otsu by default. `adaptive` (Gaussian, block 41, C 8) is for a
  page lit unevenly across the scan, and is always followed by despeckle because a
  local cut fabricates specks in flat areas: on an uneven-lit synthetic scan it
  invented 3 tiny blobs that despeckle removed, while Otsu scored 1.0000 on the
  same image.
* **Despeckle / fillHoles** — remove ink blobs and fill enclosed paper holes up
  to a pixel budget. Only ink is removed and only *enclosed* paper is filled, so a
  real dot survives and negative space touching the border is never eaten.
* **Validate** — asserts the plate really is two-state before it is written.

### Presets

| Preset | Use | Binarizes |
| --- | --- | --- |
| `text` | Scans and line art | mono-ink only |
| `logo` | Single-ink logos | mono-ink only |
| `illustration` | Flat-colour logos, **with consent** | mono-ink, and flat-colour when `binarizeFlatColour` is set |
| `clean-only` | Keep the palette, just remove JPEG damage | never |

Any parameter sent alongside a preset overrides it for that job only; the worker
owns the numbers, so a preset tuned server-side needs no API change. Every field
is optional and unknown parameters are refused rather than ignored.

### Output format, and why it is not a mode-1 PNG

The plate is RGBA with exactly two pixel states: opaque black ink `(0,0,0,255)`
on fully transparent paper `(255,255,255,0)`, at the batch working DPI, with the
ink and paper counts recorded in the job's `metadata.mono`.

A mode-1 PNG would be the obvious choice and is wrong. Measured, it converts to
RGBA with alpha 255 on every pixel, and the packer decides occupancy from alpha
(`occupancy_from_alpha`, threshold 5) — so a mode-1 design would be packed as a
**solid white box**. Two-state RGBA keeps the ink opaque and the paper invisible,
which is what both the packer and the printer read.

### When it is offered

The step is a conditional finishing pass, not a fifth numbered tool: the review
page offers it only once the artwork has a print size, and never opens it by
itself. The API refuses it before the print size exists
(`invalid-target-size`), because a resize afterwards would resample the hard plate
back into greys and undo the whole job. A refined version at the target pixels is
terminal, exactly like the resize and the cut-out.

Verified live on a quality-10 JPEG of a two-line logo: 2362×1181 plate, η 0.9848,
neutral ink 100%, Otsu threshold 134, denoise changing 96,312 px, ending at
186,167 ink px — **exactly 2 distinct RGBA values on disk** at 300 DPI, packed
with a second design (0 unplaced) and passing integrity 5/5. On the rendered
sheet the refined design carries 1 ink colour; the unrefined one beside it, 67.

---

## DTF preflight

Every cut-out now produces a report next to its output, and the same report can
be requested for any PNG before it becomes a version:

```bash
curl -X POST http://localhost:8080/api/v1/preflight \
  -F file=@design.png \
  -F targetWidthCm=10 -F targetHeightCm=10 \
  -F garmentColorKind=dark
# 200 {"report": {...}}
```

It is deterministic and in-process: no network, no model, no randomness, and no
per-pixel allocation beyond the flat buffers the analysis needs. The same input
always produces the same report bytes, which is what makes the file worth
keeping beside the artwork.

### The report

`verdict` is `fail` when any finding is an error, `warn` when any is a warning,
otherwise `pass`. Findings and fixes are sorted by code (then region, then
message), metrics keep their measurement order, and nothing time- or
machine-dependent is serialised — a diff between two runs is a real difference.

| Code | Severity | Rule |
| --- | --- | --- |
| `resolution` | error / warning | Effective DPI across the printed width: error below 200, warning below 300 |
| `alpha` | error | No alpha channel, or every pixel opaque: the background will print |
| `bit-depth` | warning | Above 8 bits per channel: the RIP silently reduces it |
| `icc-profile` | warning | No sRGB/ICC profile: the RIP guesses the colour space |
| `dpi-metadata` | warning | Missing or mismatched pHYs: the print size is assumed, not declared |
| `soft-edge` | warning | More than 12% of the edge band is semi-transparent: the outline will look feathered |
| `soft-interior` | error | More than 0.5% of the foreground is semi-transparent away from the edge: the matte is incomplete |
| `coverage` | warning | Ink over 60% of the print area: stiff, heavy, slow to cure |
| `safe-margin` | warning | Opaque ink within 1 mm of the trim edge |
| `region-count` | warning | More than 10 islands above the minimum area: usually a fragmented cut-out |
| `stroke-width` | error / warning | Thinnest stroke on the medial axis: error below 0.25 mm, warning below 0.5 mm |
| `gap-width` | warning | Two shapes closer than 0.5 mm: they bleed together on the shirt |
| `island-area` | warning | Opaque islands below 1.0 mm²: they flake off or clog the film |
| `hole-area` | warning | Enclosed holes below 0.5 mm²: trapped air under the film |
| `contrast` | warning | WCAG contrast against the garment below 1.5:1 at 25% and 60% ink opacity |
| `check-failed` | warning | A check threw; the other fourteen still ran |

Thresholds live in `Preflight:Profile` and are validated at startup: a profile
whose numbers contradict each other (`RecommendedDpi` below `MinimumDpi`, a
`CriticalStrokeMm` above `MinimumStrokeMm`, an opacity outside `(0, 1]`) refuses
to start rather than reporting nonsense. `appsettings.Example.json` lists every
key. A check is one class implementing `IPreflightCheck`; it is discovered from
the assembly, so a new rule needs no registration and no edit to the runner.

### Fixes are opt-in, and report-only is the default

`fix=true` applies the enabled safe fixes and returns the repaired PNG as
`fixedImageBase64`. The report is then rebuilt from the fixed pixels, so a fix
that did not help still shows its finding — the report never claims a repair it
cannot see.

| Fix | Resolves | What it does |
| --- | --- | --- |
| `remove-islands` | `island-area`, `region-count` | Clears opaque islands below the area floor |
| `fill-holes` | `hole-area` | Fills enclosed holes below the area floor |
| `set-dpi-metadata` | `dpi-metadata` | Writes the print spec DPI into `pHYs` |
| `embed-srgb` | `icc-profile` | Writes the `sRGB` chunk |
| `harden-soft-interior` | `soft-interior` | Snaps interior semi-transparency to 0 or 255, leaving the edge band alone |

`Preflight:EnabledFixes` bounds what a caller may request. Fixes never touch
resolution, coverage, stroke or gap: those need the operator to change the
artwork, not the metadata.

### The cut-out always preflights

`POST /api/v1/designs/{designId}/steps/background-removal` runs preflight
report-only after the pipeline writes the cut-out. The report goes to
`<output>.preflight.json` and the job metadata carries `preflightReportPath`,
`preflightVerdict` and `preflightFindingCount`. A preflight failure is logged and
swallowed: the version is already on disk, and a report problem must never turn
finished work into a failed job.

The report judges the cut-out against the print job it is destined for: the
design's target centimetres at its working DPI. A design without a print size yet
is measured on its own canvas, and the report echoes that derived size.

```bash
curl -X POST http://localhost:8080/api/v1/preflight -F file=@artwork.png -F fix=true
```

Omitting `targetWidthCm`/`targetHeightCm` is the same as the cut-out path with no
target: the file is judged at the `dpi` you name (default 300).

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

Contract version: **3.2.0**. Canonical files:

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
  base64 or file bytes in JSON. Intake multipart is the only inbound exception,
  and `POST /api/v1/preflight` is the only outbound one: it returns one repaired
  PNG to the browser that just uploaded it, not a file between services.
- Paths must not contain `..`.
- Packer placements use a top-left origin, cm for positions, px for geometry,
  and rotations of exactly 0/90/180/270°.
- The five blocking integrity checks have fixed IDs and any `skipped` check
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
