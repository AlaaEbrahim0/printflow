# Image Engine Validation

**Status:** fixture, one user-provided line-art sample and nine authorized shop
designs measured on AC power; representative photo-quality validation remains
open.

**Current priority:** enhancement/upscaling quality, GPU execution, and clear
human-review guidance. Vectorization and packing are secondary.

## Scope

The goal is to reduce operator time spent cropping, enhancing and packing.
Processing remains a proposal: staff review the original and preview, approve
or reject each version, and make the final Photoshop sheet edits themselves.
No unattended print-ready claim is made.

## Environment and engine checks

- GPU: NVIDIA GeForce GTX 1650 Ti, 4 GB VRAM; Linux x86_64.
- Upscaler: checksum-verified Real-ESRGAN ncnn Vulkan v0.2.5.0,
  `realesrgan-x4plus` for general/photo content.
- Vulkan enumerates Intel UHD as device 0 and the GTX as device 1 on this host.
  The native GPU launcher defaults to device 1 and allows an override.
- Vector engines and SVG preview rendering run in the Python 3.12 worker
  container. VTracer 0.6.15 is guarded on host Python 3.14 because its native
  extension segfaults there.

## Results

### AC-powered GPU timings (2026-11-08 re-measurement)

The earlier battery run held the GTX at 300 MHz. On AC power with a performance
profile the same 360 × 240 → 1440 × 960 x4 job took **12.7 s** of worker time
(15.1 s end to end) and the GPU boosted to **1935 MHz**, versus 33.1 s on
battery. Treat GPU timings recorded on battery as 2.5–4× pessimistic.

| Input and path | Result | Quality assessment |
|---|---|---|
| User-provided 316 × 198 line-art print sample; Real-ESRGAN x4 | Succeeded on the GTX in 5.337 s; output 1264 × 792. The source remains **40.1 DPI** at the 20 × 12.5 cm target and receives `very-low-effective-dpi`. | Visually enlarged and cleaned, but the model cannot restore reliable source detail. Do not treat its pixel dimensions as real resolution or print-ready quality. Prefer obtaining a better source or proposing a vector trace; keep human approval. |
| Same line-art sample; Potrace binary vectorization | Succeeded in 100 ms; transparent PNG preview and SVG artifact produced. | The traced line work looked clean in the preview. The SVG is scalable, but the operator should still compare its contours and fine strokes against the source before approval. |
| Generated 360 × 240 photo fixture; Real-ESRGAN x4 | Output 1440 × 960 in 7.835 s. Concurrent NVIDIA monitoring reached 97% utilization and 686 MiB. | Detail recovery was visible, but so were synthetic texture and sharpening artifacts. This is a reviewable proposal, not a faithful reconstruction guarantee. |
| Generated 960 × 320 thin-signature fixture; Real-ESRGAN x2 | GTX device 1: 15.560 s; Intel Vulkan device 0: 98.159 s. The result remains flagged at 121.9 source DPI. | GPU processing is substantially faster on this host. Upscaling does not remove the low-source-resolution warning. |
| Generated transparent color artwork; VTracer color mode | Worker-container job succeeded; 1000 × 1000 preview retained alpha (467,289 fully transparent pixels), with an SVG artifact. | Transparency survives the end-to-end worker pipeline. VTracer's color-count setting maps to a precision value, not an exact palette size. |
| Generated binary artwork for a dark garment; Potrace | Worker-container job succeeded with a transparent preview and light ink. | Contrast behavior is correct for the garment preview; inspect the actual artwork before approval. |

The user-provided image was copied to temporary storage for these local runs;
the original was not modified, no sample image was added to the repository, and
no external image service was used.

### Shop sample sweep (2026-11-08, AC power)

Nine authorized non-branded shop designs (cartoon with text, dark figure,
color collage, monochrome owl, signature, flat crest, color portrait, logo
text, flat ball) were run directly through `realesrgan-ncnn-vulkan -s 4` with
`realesrgan-x4plus`, 256 px tiles, on the GTX at ~1920 MHz:

| Source | Output | Time |
|---|---|---|
| 316 × 198 signature | 1264 × 792 | 6.2 s |
| 709 × 1181 flat ball | 2836 × 4724 | 20.7 s |
| 1024 × 1536 mono owl | 4096 × 6144 | 35.3 s |
| 1200 × 1200 cartoon with text | 4800 × 4800 | 30.8 s |
| 1239 × 1269 color collage | 4956 × 5076 | 39.4 s |
| 1280 × 1376 flat crest | 5120 × 5504 | 36.2 s |
| 1432 × 1600 color portrait | 5728 × 6400 | 60.9 s |
| 1600 × 654 logo text | 6400 × 2616 | 24.9 s |
| 1600 × 1600 dark figure | 6400 × 6400 | 52.2 s |

Every run returned the exact expected x4 dimensions. Time scales with source
area at roughly 30–35 MPix/min on this GPU, so a 1600 × 1600 design is about a
minute. Two quality caveats remain visible and are the reason approval stays
manual:

- Small text in the cartoon and logo samples gains crispness but can pick up
  invented edge detail; the operator must compare glyph shapes against the
  original.
- Flat vector-like crests and the ball logo are better served by asking for a
  vector source than by upscaling; the model adds texture to regions that
  should stay perfectly flat.

Samples were processed from a temporary folder; nothing was added to the
repository.

## Ready-to-pack intake

Because background removal and final sizing happen in Photoshop, the workbench
also accepts finished artwork. `POST /api/v1/batches/{id}/designs` with
`readyToPack=true` copies the uploaded PNG into a separate approved `resize`
version, makes it current, derives the target centimetres from the pixels at the
batch working DPI, and queues no job. A live check with a 1417 × 1417 PNG at
300 DPI produced an 11.9973 × 11.9973 cm target, a `ready` design, no jobs, and
a clean pack plus five-check integrity pass and PNG export. Supplying centimetres
that do not match the pixels is rejected with `invalid-target-size` so the
packer never resamples finished artwork.

## Follow-up

This validates engine behavior and the shop-design sweep above, not the full
range of shop artwork. Remaining useful samples are low-quality photos and
screenshots where operators currently spend time cleaning halos, thin strokes or
backgrounds, plus color-heavy artwork at print size. Ready-to-pack intake is the
supported path once background removal and final sizing are done in Photoshop.

## withoutbg spike — blocked (2026-11-12)

Spike stopped before model download or image processing.

- Python 3.12 is unavailable on this host. `python3` is 3.14.8; no
  `worker/.venv/bin/python` exists.
- PyPI check at install time: `python3 -m pip index versions withoutbg-python`
  returned `ERROR: No matching distribution found for withoutbg-python`.
- Therefore package install, bundle download, offline verification, five-image
  test, CPU/GPU timings, RAM/VRAM measurements, routing, matte edge review,
  removal/upscale order comparison and failure-mode validation could not run.
- No model bundle was downloaded. Existing `models/cutout/*.onnx` files belong
  to archived BiRefNet work and were not reused.
- No production API, worker, web or editor code changed. No spike script was
  added because required package and runtime were unavailable.

Decision: do not adopt `withoutbg-python` yet. Re-run only when Python 3.12
venv and an installable package/model bundle are available; then test five
authorized images, preserve soft mattes without thresholding, compare
removal-first versus upscale-first, and record measured CPU/GPU and memory
numbers before any production proposal.

## withoutbg spike — measured small CPU run, adoption deferred (2026-11-12)

Package and bundle setup completed in Compose worker:

- Package: `withoutbg` 1.5.0 (installed in `/tmp/withoutbg`, ephemeral).
- Runtime: Python 3.12, Compose worker, CPU-only.
- HF repository: `withoutbg/withoutbg-openweights-onnx`.
- Pinned revision embedded by installed package: `d0bfe3f4d0cefe0a2ad427f350c6373a7e889ea0`.
- Spike bundle: `/data/storage/models/withoutbg`.
- Bundle size: ~1.4 GB; five ONNX assets present.
- `WithoutBG` exposes `open_weights`, `opensource`, `remove_background`, and `remove_background_batch`.
- `open_weights(model_path)` and `opensource(model_path)` both exist. Smoke preload completed successfully with explicit local model path.

Measured unbuffered, local-weight runs used `nproc=8`, `cpu.max=max 100000` (no cgroup cap), and `OMP_NUM_THREADS` unset. Default ONNX Runtime behavior saturated about one core. Explicit `SessionOptions.intra_op_num_threads=8` did not improve the same 1000 × 1000 case: default measured 16.07–27.738 s; explicit 8-thread measured 26.0 s. Preload was 8.696 s default and 6.294–6.392 s on later runs. Router category printed before branch inference.

- 1000 × 1000 `flat_scene`: 16.07–27.738 s default; 26.0 s with explicit 8 intra-op threads; output 1000 × 1000 `RGBA`; alpha 0–255; 10,696 partial-alpha pixels; peak RSS ~5.0 GiB. Flat-scene matte had hard-looking edges in review; no soft halo-quality approval.
- Authorized photo-like 2550 × 3543 `soft_detail` matting route: 2.292 s inference after 6.294 s preload; output preserved 2550 × 3543 `RGBA`; 679,209 partial-alpha pixels; peak RSS ~2.75 GiB. This is expected path, not BiRefNet worst case.
- Stored 4349 × 5669 file: `flat_scene`, 23.219 s inference after 6.392 s preload; output preserved 4349 × 5669 `RGBA`; 320,552 partial-alpha pixels; peak RSS ~5.82 GiB. Inference stayed near-constant because model input is capped; decode/resize/output memory scales.

5.0+ GiB peak RSS makes worker concurrency=1 mandatory for this path. CUDA/GPU is ruled out for this bundle and host because deployment target has 4 GB VRAM. Adoption recommendation: **defer**. Quality and memory are not safe for production until controlled soft-detail/flat-scene review and a memory-isolated serialized proposal job are approved.

The spike script is `worker/experiments/withoutbg_spike.py`. It uses one `remove_background()` call per image, records input/output dimensions and mode, checks alpha statistics, and uses no cloud API. Bundle path is spike-only; adoption would require a dedicated models mount outside shared artwork storage.

Smart-brush inspection was not reached because adoption is deferred; do not wire AI removal or `model.edit` into production.

## withoutbg adopted as the AI cutout — quality gate (2026-11-13)

Adoption reverses the 2026-11-12 deferral: the product owner accepted the runtime
and memory cost in exchange for matte quality, and the worker already runs one
job at a time. Engine: `withoutbg` 1.5.0, `OpenWeightsModel` with the routed
bundle (router → matting graph or BiRefNet, alpha upsampled to source size), CPU
ONNX, capped by the bundle's `max_inference_size`.

Scoring: the shop's own hand-cut alpha is the truth (alpha > 127), the proposal's
alpha is the result. `kept` is the fraction of truth-opaque pixels retained,
`extra` is how much opaque area the matte added.

Already-cut uploads (own alpha is the truth, so the matte is not run at all):

| Input | Size | IoU | kept | extra | alpha MAE |
| --- | --- | --- | --- | --- | --- |
| `Meter.png` | 3500 × 4834 | 0.9912 | 0.9912 | −0.9% | 0.53/255 |

Opaque-background uploads (design flattened onto white, then re-mated — the
screenshot case the AI path exists for):

| Input | Size | IoU | kept | extra |
| --- | --- | --- | --- | --- |
| `6+5+.png` | 1173 × 1235 | 0.9988 | 0.9999 | +0.1% |
| `+6.png` | 855 × 1181 | 0.9992 | 0.9998 | +0.0% |
| `weewc.png` | 1181 × 862 | 0.9974 | 0.9995 | +0.2% |
| `3.png` | 3148 × 2394 | 0.9846 | 0.9993 | +1.4% |
| `2.png` | 560 × 1181 | 0.8673 | 0.8673 | −13.3% |

Negative-space designs, flattened first (unsolvable by any matte, because the
white interior is pixel-identical to the background):

| Input | Size | IoU | kept | extra |
| --- | --- | --- | --- | --- |
| `Meter.png` | 3500 × 4834 | 0.4340 | 0.9953 | +128.9% |
| `Untitled-1.png` | 2550 × 3543 | 0.4448 | 0.9556 | +110.4% |

Defects found and fixed while measuring:

1. `image.convert("RGB")` on an RGBA upload drops alpha without compositing; the
   RGB under a transparent pixel is undefined and a real shop file held flat grey
   there, which the matte read as artwork. The adapter now composites on white,
   and only for inputs without an existing cut-out.
2. Running the matte on an upload that is already cut out costs 356 s on a
   3500 × 4834 design and reproduces the stored alpha at IoU 0.987 while shaving
   1.3% of the subject. Those uploads now keep their own alpha and report
   `source-alpha-used`; a design in that state finishes in ~25 s (decode, mask
   refinement, encode).

Timing on this host (CPU, concurrency 1, weights cached): `6+5+` 1173 × 1235 in
~36 s end to end; `pale-mist-white` 1400 × 1000 in 20.3 s; first ever AI job
331 s including the ~1.5 GB one-time weight download.

Not covered: the 5.0+ GiB peak RSS measured in the spike still applies to the
BiRefNet branch, so worker concurrency stays 1 and `PRINTSHEET_MAX_GPU_JOBS`
stays 1. No GPU path exists for this bundle on a 4 GB card.
