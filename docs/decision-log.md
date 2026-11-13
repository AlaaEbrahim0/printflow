# Decision log

Append-only autonomous decisions.

## 2026-11-13

- **Adopted withoutbg as the AI cutout** (the 2026-11-12 deferral is closed).
  The product owner prioritized matte quality over runtime, which is exactly what
  the earlier blockers priced in: the BiRefNet branch's 5–5.8 GiB RSS and one
  inference at a time are acceptable on a single-operator workbench with worker
  concurrency 1. No new infrastructure: the bundle and spike script were already
  committed, so adoption is the `WithoutBgCutout` adapter plus `mode: ai`.
- **Not** adopted: BRIA RMBG 1.4/2.0. Its weights are CC BY-NC 4.0 and a
  for-profit print shop is commercial use; revisit only with a paid Bria licence.
- Quality measured against the shop's own hand-cut alpha (a real design flattened
  onto white and re-mated, scored at alpha > 127):
  - already-cut uploads: own alpha kept, IoU 0.9912 / MAE 0.53 of 255;
  - opaque-background uploads, `6+5+` 1173 × 1235: IoU 0.9988;
  - `3` 3148 × 2394: IoU 0.9846; `+6` 855 × 1181: IoU 0.9992; `weewc` 1181 × 862:
    IoU 0.9974; `2` 560 × 1181 lost 13.3% of the subject (worst case, review it).
- Two failure modes are now guarded rather than tuned away:
  1. `convert("RGB")` on an RGBA upload drops alpha without compositing, and the
     RGB under a transparent pixel is undefined (a real file held flat grey),
     which the model read as artwork. The adapter composites on white first.
  2. Re-mating an upload that is already cut out can only shave visible pixels and
     never recover hidden ones; on `Meter` 3500 × 4834 it took 356 s and reached
     IoU 0.987. Such uploads keep their own alpha (`source-alpha-used`) and pay no
     inference.
- Designs whose negative space *is* the garment (white interior that only exists
  because the source alpha hides it) cannot be re-mated from a flattened image:
  measured +110…185% extra opaque area on `Meter` and `Untitled-1`. That is a
  property of the input, not a tunable; those go through ready-to-pack or manual
  cut-out. Never "fix" it by loosening a threshold — the model already agrees
  with the truth on 4 of 5 opaque-background samples.
- DTF pass: `maskMinAreaPx` (UI default 24 px²) drops opaque specks and fills
  background pinholes before grow/feather, because DTF prints every opaque pixel.

## 2026-11-12

- Adopted reversible withoutbg spike setup only: use local open weights in Compose worker, mounted under `/data/storage/models/withoutbg`; no cloud API. Revert: remove spike files/memo and delete only spike model directory after explicit data confirmation.
- Kept Phase 1 editor work as main line while spike runs. Revert: none needed; separate files and commits.
- Deferred withoutbg adoption. Blockers bind the BiRefNet branch (`flat_scene`/`hard_opaque`): 5–5.8 GiB RSS, concurrency 1, no CUDA on 4 GB VRAM, flat-scene edge quality unapproved. The matting branch (photo-like route) measured production-viable on infrastructure: 2.292 s inference, 2.75 GiB RSS, output dimensions preserved, no large-image degradation observed.
- Recorded facts: 8-thread `intra_op` gave no gain (memory-bound fp32, lever dead); preload 6.3–8.7 s; large-file output preserved original dimensions; partial alpha was ~1–1.3% with hard edges on flat-scene routes.
- Reopen when Phase 3 image-quality review visually assesses withoutbg matting-branch mattes on 3–5 real photo-style designs. No new infrastructure work needed — bundle, script, and measurements are committed (`c258787`, `8b595da`). Reverting deferral is a config decision, not a build.
- Revert path: remove `worker/experiments/withoutbg_spike.py`, spike-only model bundle, and memo additions after confirming no production references.
