
## withoutbg spike — runtime blocked after bundle download (2026-11-12)

Package and bundle setup completed in Compose worker:

- Package: `withoutbg` 1.5.0 (installed in `/tmp/withoutbg`, ephemeral).
- Runtime: Python 3.12, Compose worker, CPU-only.
- HF repository: `withoutbg/withoutbg-openweights-onnx`.
- Pinned revision embedded by installed package: `d0bfe3f4d0cefe0a2ad427f350c6373a7e889ea0`.
- Spike bundle: `/data/storage/models/withoutbg`.
- Bundle size: ~1.4 GB; five ONNX assets present.
- `WithoutBG` exposes `open_weights`, `opensource`, `remove_background`, and `remove_background_batch`.
- `open_weights(model_path)` and `opensource(model_path)` both exist. Smoke preload completed successfully with explicit local model path.

Full image inference did not produce a result within the available execution window. The worker remained healthy and was not OOM-killed, but the test command returned no result for stored images, including small inputs, after several minutes. Therefore no valid `r.size`, `r.mode`, per-image timings, route categories, RAM measurements, matte comparisons, or failure-mode conclusions exist. The required 4349×5669 original-size smoke check did not run. Adoption recommendation: **defer** until a bounded, observable inference run completes.

The spike script is `worker/experiments/withoutbg_spike.py`. It uses one `remove_background()` call per image, records input/output dimensions and mode, checks alpha statistics, and uses no cloud API. Bundle path is spike-only; adoption would require a dedicated models mount outside shared artwork storage.

Smart-brush inspection was not reached because adoption is deferred; do not wire AI removal or `model.edit` into production.
