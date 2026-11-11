# BiRefNet cutout — archived

This directory is the **retired** AI background-removal path. Nothing in `worker/`
imports it, no contract mentions it as usable, and no model file is required to run
the app. It is kept so the reasoning, the measurements and the old job records stay
readable — not because it is expected to come back.

## Why it was retired

BiRefNet produced genuinely good mattes in the benchmarks (IoU 0.957 on the 3600 px
stress case with native tiling) but it was not usable in this shop:

| Problem | What it looked like |
| --- | --- |
| Memory | A single tiled 3500 px job held several GB of ONNX activations. On the dev box it competed with the API, the packer and Photoshop; a 4× upscale queued behind it could not start. |
| Time | ~7.5 minutes for one 3600 px image on CPU. Even the "fast" 1200 px tile sweep was ~30 s per image, which is far too slow when a batch has 20 designs. |
| Reliability | Edges were unreliable in exactly the class we care about. Thin type and hairlines came back soft or half-erased because the graph is fixed at 1024×1024 and the matte is stretched back over the source. |
| Weight | The ONNX weights are hundreds of MB and have to be shipped/mounted separately, which made "clone and run" impossible. |

Alpha matting was tried as a refinement and scored *worse* than the raw matte
(0.985 → 0.892), so there was no cheap post-process that rescued the edges.

Meanwhile the colour key already handled the actual work: flat logo/text/line-art
artwork on a solid background. It is ~50 ms, needs no model, and its failures are
visible and fixable with the mask controls. Anything with a busy background is now
cut by hand in Photoshop or Photopea and imported — a human decision instead of a
minute of GPU time that still needed review.

## What is here

| Path | What it is |
| --- | --- |
| `engine.py` | The shipped engine: tiled ONNX inference, explicit device policy, `engine-unavailable` when weights are missing. Was `worker/app/engines/birefnet.py`. |
| `test_engine.py` | Its unit tests (device fallback, tiling, matte assembly). Was `worker/tests/test_engine_birefnet.py`. |
| `experiments/` | Every research script from `worker/experiments/`. Each file's module docstring explains the question it answered. |

The experiments are the useful part. Read them in this order if the AI path is ever
revisited:

1. `model_probe.py` — is a segmentation model even better than a key on this class?
2. `scale_probe.py` — upscaling the input does nothing (the graph resizes anyway).
3. `tile_probe.py`, `tile_sweep.py` — tiling is what buys the detail, and what it costs.
4. `matte_*.py` — caching, scoring, matting refinement, visual sheets.
5. `verify_engine.py` — checks the shipped code reproduces the benchmark numbers.

`bench_gen.py` / `bench_run.py` build and score the ground-truth benchmark set.

## If it is ever revived

- The engine reads its model directory from `PRINTSHEET_CUTOUT_MODEL_DIR` and fails
  with the non-retryable `engine-unavailable` code when the file is absent — it never
  silently substitutes a different model. The Compose mount and the shell export for
  that variable were removed with the archive, and so were the `cutout_*` fields on
  `worker/app/config.py` (`cutout_model_dir`, `cutout_tile_source_px`,
  `cutout_tile_overlap_px`, `cutout_max_tiles`, `cutout_cpu_threads`). Restore those
  before importing this code — as written it will not even construct.
- `onnxruntime` is no longer a worker dependency. Re-add it (or `onnxruntime-gpu`)
  to `worker/pyproject.toml` before importing this code.
- The API still accepts `ai` in the schema so historical jobs render, but
  `StepService` rejects it with `invalid-request` and the worker raises
  `unsupported-parameters`. Both must be relaxed before the mode works again.
- The mask pipeline in `worker/app/processors/background.py` (grow/contract, feather,
  mask levels, image levels) is mode-agnostic and would apply to a model matte
  unchanged.
