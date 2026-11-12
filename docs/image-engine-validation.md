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
