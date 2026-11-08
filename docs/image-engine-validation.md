# Image Engine Validation

**Status:** fixture and one user-provided line-art sample tested; representative
photo-quality validation remains open.

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

## Follow-up

This validates one real line-art sample and engine behavior, not the range of
shop artwork. Photo enhancement on representative, authorized shop photos and
color artwork still needs review. The most useful next samples are low-quality
photos/screenshots and edge cases where operators currently spend time cleaning
halos, thin strokes, or backgrounds.
