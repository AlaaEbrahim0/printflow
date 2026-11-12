# Decision log

Append-only autonomous decisions.

## 2026-11-12

- Adopted reversible withoutbg spike setup only: use local open weights in Compose worker, mounted under `/data/storage/models/withoutbg`; no cloud API. Revert: remove spike files/memo and delete only spike model directory after explicit data confirmation.
- Kept Phase 1 editor work as main line while spike runs. Revert: none needed; separate files and commits.
- Deferred withoutbg adoption. Blockers bind the BiRefNet branch (`flat_scene`/`hard_opaque`): 5–5.8 GiB RSS, concurrency 1, no CUDA on 4 GB VRAM, flat-scene edge quality unapproved. The matting branch (photo-like route) measured production-viable on infrastructure: 2.292 s inference, 2.75 GiB RSS, output dimensions preserved, no large-image degradation observed.
- Recorded facts: 8-thread `intra_op` gave no gain (memory-bound fp32, lever dead); preload 6.3–8.7 s; large-file output preserved original dimensions; partial alpha was ~1–1.3% with hard edges on flat-scene routes.
- Reopen when Phase 3 image-quality review visually assesses withoutbg matting-branch mattes on 3–5 real photo-style designs. No new infrastructure work needed — bundle, script, and measurements are committed (`c258787`, `8b595da`). Reverting deferral is a config decision, not a build.
- Revert path: remove `worker/experiments/withoutbg_spike.py`, spike-only model bundle, and memo additions after confirming no production references.
