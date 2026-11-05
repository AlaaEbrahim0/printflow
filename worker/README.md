# PrintSheet Worker

FastAPI image-processing worker (Python 3.11+).

Phase 0 contains configuration, a health endpoint and the contract boundary.
Trim, Real-ESRGAN upscaling, background removal, vectorization and the
classifier are implemented in Phase 1 track B.

## Configure

All settings use the `PRINTSHEET_` prefix, for example:

```bash
export PRINTSHEET_STORAGE_ROOT=../storage
export PRINTSHEET_API_BASE_URL=http://localhost:8080
export PRINTSHEET_WORKER_KEY=dev-worker-key
export PRINTSHEET_GPU_ENABLED=false
```

`PRINTSHEET_MAX_GPU_JOBS` is constrained to exactly `1` for the 4 GB GTX 1650 Ti.

## Run natively

```bash
python3.12 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## Test

```bash
.venv/bin/pytest
```

## GPU fallback

The target machine has a GTX 1650 Ti (4 GB VRAM). Real-ESRGAN is invoked through
the `realesrgan-ncnn-vulkan` CLI rather than a PyTorch model to keep VRAM use
predictable. Docker GPU passthrough is painful on Windows; `scripts/run-worker-gpu.sh`
is the supported native path. The CLI integration lands in Phase 1 B; the worker
serializes all GPU jobs by configuration now.

The worker job/result contracts are frozen in `../contracts/jsonschema/`.
