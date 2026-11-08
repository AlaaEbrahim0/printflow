# PrintSheet Worker

Phase 3 image-processing worker. Active job types are `classify`, `trim`,
`upscale`, and `resize`. Legacy background-removal/vectorization records remain
readable, but those job types are rejected as retired.

It reads and writes only files inside the shared storage root; image bytes never
travel in JSON. The FastAPI service still only exposes `/` and `/health`; the job
loop is opt-in (`PRINTSHEET_RUN_JOBS=true`) so liveness never depends on the API.

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
.venv/bin/ruff check app tests
```

## CLI (how this track is verified without an API)

```bash
# run one job document against a storage root; exit 0 ok, 2 job failed, 1 usage
.venv/bin/python -m app.cli process --job ../contracts/examples/worker-job-trim.json \
    --storage-root ../storage --result /tmp/result.json

# validate a job document only (no processing)
.venv/bin/python -m app.cli process --job job.json --storage-root ../storage --validate-only

# claim work from the API
.venv/bin/python -m app.cli run --once      # at most one job
.venv/bin/python -m app.cli run --loop      # poll until SIGTERM/SIGINT

# ad-hoc classification of one file inside the storage root
.venv/bin/python -m app.cli classify ../storage/batch/design/version.png --dpi 300
```

`process` validates the job against `worker-job.schema.json`, runs the matching
processor, stamps `metadata.durationMs`, validates the emitted result against
`worker-result.schema.json`, and exits non-zero when the job failed. Failures are
returned as structured envelopes (`{"code", "message", "retryable"}`), never as
tracebacks. The `contractVersion`-aware examples in `../contracts/examples/` are
executed by the test suite (`tests/test_job_examples.py`).

## Service

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000        # health only
PRINTSHEET_RUN_JOBS=true .venv/bin/uvicorn app.main:app --port 8000   # + loop
```

`/health` reports `storageWritable`, `capabilities`, `gpuEnabled`, `maxGpuJobs`,
`runJobs`, `leaseSeconds`, `heartbeatSeconds`, `contractVersion`.

## Settings (`PRINTSHEET_*` env or `worker/.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_ROOT` | `/data/storage` | shared root every path is resolved against |
| `API_BASE_URL` | `http://localhost:8080` | internal API base |
| `WORKER_KEY` | `dev-worker-key` | sent as `X-Worker-Key` |
| `WORKER_ID` | `worker-local` | identity recorded on claims |
| `CAPABILITIES` | `image` | capability list sent in `ClaimJobsRequest` |
| `RUN_JOBS` | `false` | start the claim loop in the app lifespan |
| `LEASE_SECONDS` | `120` | requested lease, clamped to 15..900 |
| `HEARTBEAT_SECONDS` | `30` | heartbeat cadence (never later than lease/3) |
| `POLL_SECONDS` / `CLAIM_BACKOFF_SECONDS` | `2` / `5` | idle and error waits |
| `MAX_CONSECUTIVE_CLAIM_ERRORS` | `5` | loop gives up after this many |
| `SHUTDOWN_GRACE_SECONDS` | `30` | time for the in-flight job after SIGTERM |
| `GPU_ENABLED` | `false` | allow Real-ESRGAN on the Vulkan GPU |
| `MAX_GPU_JOBS` | `1` | pinned to 1 for the 4 GB GTX 1650 Ti |
| `CONTRACTS_DIR` | auto | schema dir, see “Contract location” |
| `WORKING_DPI` | `300` | only for ad-hoc `classify` jobs |
| `DPI_WARN_BELOW` / `DPI_STRONG_WARN_BELOW` | `150` / `100` | low-resolution warnings |
| `MAX_INPUT_PIXELS` | `80000000` | decompression-bomb guard for worker reads |
| `BORDER_BAND_RATIO`/`_MIN_PX`/`_MAX_PX` | `0.04`/`2`/`48` | border strip width |
| `BACKGROUND_MATCH_TOLERANCE` | `12` | per-channel “is this the background?” |
| `ALPHA_THRESHOLD` | `5` | alpha below this counts as empty (packer uses 5 too) |
| `EDGE_UNIFORM_RATIO` | `0.9` | share that makes a strip a clean margin |
| `CLASSIFY_ANALYSIS_MAX_PX` | `600` | colour/edge features work on a copy |
| `CLASSIFY_COLOR_LEVELS` | `32` | quantisation levels per channel |
| `CLASSIFY_FLAT_COLOR_TOLERANCE` | `12` | flat-colour match |
| `CLASSIFY_EDGE_THRESHOLD` | `48` | gradient magnitude that counts as an edge |
| `CLASSIFY_UNIQUE_COLOR_LOGO_MAX` | `48` | illustration heuristic for upscale suggestions |
| `TRIM_PADDING_PX` / `TRIM_TOLERANCE` | `8` / `12` | auto-trim defaults |
| `REALESRGAN_BINARY` | `realesrgan-ncnn-vulkan` | engine path |
| `REALESRGAN_MODEL_DIR` | unset | passed as `-m` when set |
| `REALESRGAN_TILE_SIZE` | `256` | default `-t` when the job omits it |
| `REALESRGAN_GPU_DEVICE_INDEX` | `0` | `-g` when GPU is enabled |
| `REALESRGAN_CPU_THREADS` | `0` | `-j 1:N:N` on the CPU path, 0 = engine default |
| `REALESRGAN_TIMEOUT_SECONDS` | `900` | hard subprocess timeout |
| `LOG_LEVEL` / `LOG_JSON` | `INFO` / `false` | stderr logging; JSON for containers |

`MAX_GPU_JOBS` is constrained to exactly `1`: the loop is sequential, so a GPU
job can never overlap another on the 4 GB card.

## Contract location

1. `PRINTSHEET_CONTRACTS_DIR` if set;
2. the nearest `contracts/jsonschema` found by walking up from `app/`;
3. `app/_contracts/` — a byte-identical vendored copy for container images whose
   build context is `worker/` only.

`tests/test_contracts.py` fails if the vendored copy ever differs from the frozen
contract, so the fallback cannot drift. Never edit `app/_contracts/` to make a
test pass. The worker never edits `contracts/`.

`format` keywords (`uuid`) are treated as annotations, matching the repository's
own contract validator; the API is authoritative for those, while path safety is
re-checked here independently (`app/storage.py`).

## Engines and how to enable them

The worker image supports crop/trim, classification and resizing without
optional image-engine dependencies. Background removal and vectorization are
retired; legacy jobs fail explicitly with `unsupported-parameters`.

* **Real-ESRGAN** is the `realesrgan-ncnn-vulkan` binary; it is not a pip
  dependency. From the repository root, run `make worker-gpu-setup` to install
  the checksum-verified Linux release and its models under the ignored
  `.tools/` directory. Then run `make worker-gpu`; this starts a native worker
  that advertises only the GPU capability on port 8001. The Compose worker
  remains active on port 8000 for CPU jobs. Both workers share the repository
  `storage/` directory. On this workstation
  the launcher defaults to Vulkan device 1 (the GTX 1650 Ti; Intel UHD is
  device 0); override
  `PRINTSHEET_REALESRGAN_GPU_DEVICE_INDEX` when the device ordering differs.
  Other platforms can install a release into `PATH` or set
  `PRINTSHEET_REALESRGAN_BINARY` and `PRINTSHEET_REALESRGAN_MODEL_DIR`.
Missing Real-ESRGAN binaries produce a stable non-retryable
`engine-unavailable` result. The worker never substitutes another algorithm
behind the operator's back.

## Processing rules implemented here

* The input file is never modified. Job inputs are registered as *protected*
  paths and any attempt to write one is refused (`output-overwrites-input`).
* All writes are atomic: temp file in the destination directory, fsync,
  `os.replace`, and the file is world-readable (`0644`) for the API and web.
* Paths are validated before any read: absolute paths, `..`, empty segments,
  backslashes, `~`, NUL and symlink escapes out of the root are rejected.
* `cm → px` is `round_half_away_from_zero(cm * dpi / 2.54)` — 58 cm at 300 DPI is
  6850 px, the same rule as `PrintUnits` in the API.
* `resize` resamples exactly once with Lanczos; `contain` never stretches or
  crops and centres the artwork on transparent padding.
* Full bleed is never auto-trimmed: the input is passed through with the warning
  `full-bleed-no-auto-trim`, and `classify` sets `trim.recommended = false`
  whenever `fullBleed` is true.
* Palette and 16-bit sources are widened to 8-bit RGBA with a `warning`-severity
  note; bitonal sources expand to `L` with an `info` note.
* Low effective DPI is reported against the *source*: `low-effective-dpi` below
  `DPI_WARN_BELOW`, `very-low-effective-dpi` below `DPI_STRONG_WARN_BELOW`.

## Stable failure codes

| Code | Retryable | Raised when |
| --- | --- | --- |
| `invalid-job` | no | the document fails `worker-job.schema.json` |
| `storage-path-invalid` | no | absolute/traversal/unreadable path |
| `output-overwrites-input` | no | assigned output equals a protected input |
| `input-missing` | yes | the assigned input file is not there yet |
| `image-decode-failed` | no | the input exists but cannot be decoded |
| `input-too-large` | no | above `MAX_INPUT_PIXELS` |
| `unsupported-parameters` | no | schema-legal value the worker cannot honour, including retired jobs |
| `crop-out-of-bounds` | no | manual `cropRect` leaves the source |
| `engine-unavailable` | no | `realesrgan-ncnn-vulkan` is absent |
| `engine-failed` | yes | the engine exited non-zero or misbehaved |
| `engine-timeout` | yes | the engine exceeded its timeout |
| `engine-output-invalid` | no | no output, or wrong dimensions/undecodable |
| `unsupported-output-format` | no | assigned suffix cannot hold the pixels |
| `invalid-result` | no | our own result failed the result schema |
| `worker-shutdown` | yes | grace period expired mid-job |
| `lease-lost` / `worker-key-invalid` / `api-unreachable` | varies | API/lease problems |
| `internal-error` | yes | unexpected crash, reported structurally |

Warning codes you will see in previews include
`content-touches-crop-edge`, `full-bleed-no-auto-trim`, `no-content-detected`,
`lossy-reencode`, `palette-converted`, `bit-depth-converted`,
`low-effective-dpi`, `very-low-effective-dpi`, `target-px-cm-mismatch`,
`gpu-requested-cpu-fallback`, `tile-size-below-minimum`,
`alpha-dropped-by-engine`, `engine-input-converted`,
`classifier-analysis-downscaled`.

## Limitations, stated honestly

1. **Real-ESRGAN alpha** depends on the binary version: the worker verifies the
   output dimensions and warns (`alpha-dropped-by-engine`) if transparency the
   source had is gone. It cannot judge visually — that is the preview's job.
2. **CPU fallback for upscaling** is allowed (same model, slower device) with a
   warning; nothing silently switches to a plain Lanczos enlargement.
3. **Classifier features are measured on a downscaled copy** for colour/edge
   stats (`CLASSIFY_ANALYSIS_MAX_PX`); margins and full-bleed use full
   resolution. `uniqueColorCount` counts *quantised* colours.
4. **`resize` honours an explicit `targetWidthPx`/`targetHeightPx`** even when it
   disagrees with `round(cm × dpi / 2.54)`, and reports
   `target-px-cm-mismatch`; the API decides readiness.
5. **No EXIF orientation handling.** Uploaded screenshots are used as stored.

## Tests

```bash
.venv/bin/pytest -q
.venv/bin/ruff check app tests
```

Fakes cover the Real-ESRGAN command seam (`FakeCommandRunner`) and API
(`httpx.MockTransport`, `FakeClient` in `tests/test_runner.py`). Legacy job
examples are validated and rejected explicitly; active examples are executed
end to end in `tests/test_job_examples.py`.
