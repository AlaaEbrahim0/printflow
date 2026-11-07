# PrintSheet Packer

Standalone Python library and CLI for nesting approved designs onto a print
sheet, verifying the result and exporting it. No imports from `/api` or
`/worker`, no database, no network: the contract is a request file in, a
response file and artifacts out, all paths relative to one storage root.

```bash
cd packer
python3.11 -m venv .venv            # or: make packer-setup   (from the repo root)
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest                    # 144 tests
.venv/bin/ruff check .              # lint + format gate
```

## Commands

```bash
printsheet-packer pack --request REQUEST.json --storage-root DIR \
    [--response RESPONSE.json] [--no-preview] [--preview-width N] [--force]
printsheet-packer export --manifest MANIFEST.json --storage-root DIR \
    --format flat-png|flat-tiff|psd-bundle --out PATH [--strip-rows N] [--force]
printsheet-packer verify --manifest MANIFEST.json --storage-root DIR
printsheet-packer validate --contract packer-request --document FILE.json
printsheet-packer version
```

`pack` validates the request against the frozen schema, nests, runs the four
blocking integrity checks, writes `output.previewPath` and
`output.manifestPath`, embeds the integrity report in the response, validates
the response against the frozen schema, prints it on stdout and exits non-zero
if any check did not pass. `verify` re-runs the checks against a manifest and
exits 0 only when the fresh report passes **and** every approved source file
still matches the sha256 recorded in the manifest.

`export` renders exactly what the manifest describes; it re-validates the
manifest (schema plus the embedded integrity report) but does not itself
re-measure the sheet. The **caller** owns the export gate — run `verify` first,
or refuse when `integrityReport.passed` is false. `verify` is the command that
answers "may this sheet be exported right now".

Every command exits non-zero with one concise stderr line, e.g.
`design-exceeds-roll: …`, and the structured `{"code", "message", "details"}`
payload so a caller can surface it.

Library use is the same three functions:

```python
from printsheet_packer.contracts import load_pack_request
from printsheet_packer.pipeline import run_pack, require_passed, verify_manifest

outcome = run_pack(load_pack_request("request.json"), "storage")
require_passed(outcome)          # raises IntegrityFailedError otherwise
print(outcome.written["manifest"])
fresh = verify_manifest("storage/b1/sheets/placements.json", "storage")
```

## Geometry conventions

| Thing | Rule |
| --- | --- |
| Sheet width | exactly `round_half_away_from_zero(rollWidthCm × dpi / 2.54)` → 58 cm @ 300 DPI = **6850 px** |
| Sheet height | bottom-most visible pixel + `ceil(edgeMarginMm → px)`, never less than 1 px |
| Origin | top-left, y down. `rotationDeg` is **clockwise** |
| Placement coordinates | cm in the response (`xCm`, `yCm`, `widthCm`, `heightCm`) and whole px in the manifest (`xPx`, `yPx`); cm values are the px values at `dpi`, not rounded |
| Placement `widthPx`/`heightPx` | the **rotated image** footprint (90/270 swap width and height) |
| Positions | quantized to whole occupancy-grid cells: `cellPx = max(1, round(cellMm / 25.4 × dpi))`, so `xPx % cellPx == 0` |
| Clearances | `marginMm`/`edgeMarginMm` convert with **ceil** to px, so a physical gap is never smaller than asked |
| Occupancy grid | dimensions round **up**; a cell is occupied if **any** pixel in it is; the grid may overestimate, never underestimate |
| Occupied pixel | `alpha > alphaThreshold` (default 5) — faint smoke and mist count |
| Transforms | translate by whole pixels, rotate by 0/90/180/270 with transposes only. Never resample, recolour or crop artwork |

### Dilation

The structuring element is the **Chebyshev square** `{|dx| ≤ r, |dy| ≤ r}`,
applied as two exact 1-D sliding-OR passes (O(n) via a prefix sum, no scipy).
It strictly contains the disk of radius `r`, so it is the conservative choice:
a clearance proved with it also holds as a Euclidean clearance.

Two nested grids:

* **Between designs.** `marginPx = ceil(marginMm / 25.4 × dpi)`. The search pads
  each design's grid by `blockRadiusCells = ceil((marginPx − 1) / (2 × cellPx))`
  cells; blocks that share no cell keep their nearest visible pixels at least
  `2 × blockRadiusCells × cellPx + 1 ≥ marginPx` apart. Full-resolution
  re-verification then dilates by `ceil((marginPx − 1) / 2)` and proves the same
  property on real pixels.
* **To the sheet edge.** Never dilated — the visible bbox is checked in exact
  pixels against `edgeMarginPx`, so an `edgeMarginMm` of 0 really does allow a
  design to sit flush against the roll edge.

## Algorithm (ADR 0004)

1. Decode each approved file, threshold alpha, crop to the visible bbox.
2. Build the image-aligned grid and its dilated collision **block** for each
   allowed rotation (0/90/180/270 when `allowRotation`).
3. Order designs by descending visible area, then descending bbox area, height,
   width, design id. Then try `randomizedOrderings` seeded permutations.
4. For each design: lowest feasible y, then lowest x, scanning rotations and
   pruning any rotation that cannot beat the best rank found so far. Collision
   tests are vectorised NumPy ANDs on the grid; positions are whole cells.
5. Stop starting a new ordering once `timeBudgetMs` has passed (the budget is
   only consulted *between* orderings, so a run that completes all orderings is
   bit-reproducible from `seed`). Keep the layout with the smallest sheet
   height; ties break on total occupied cells, then on earlier positions.
6. Verify at full resolution (`integrity.py`), render the preview, write the
   manifest, validate the response against the frozen contract.

`noInterlocking = true` replaces each raster mask with its axis-aligned bounding
box, or with its convex hull when the optional `geo` extra (`shapely`) is
installed — a predictable, slightly wasteful mode for troubleshooting.

A design whose visible bbox does not fit the usable width in **any** allowed
rotation is refused with `design-exceeds-roll`; it is never scaled or cropped.

## Integrity report

`integrity-report.schema.json` is frozen; the report always carries exactly the
four blocking checks, in this order, and `passed` is true only when all four are
`passed` — a `skipped` check means not passed:

1. `visible-pixels-inside-sheet` — counts visible pixels outside the sheet by
   side and by design.
2. `dilated-masks-no-overlap` — pairwise on full-resolution dilated masks,
   restricted to pairs whose dilated bboxes actually intersect.
3. `minimum-gap` — the exact minimum Chebyshev pixel distance, measured by
   binary searching the dilation radius, plus edge clearance per design.
4. `pixel-equality` — each rendered placement layer compared byte-for-byte to
   the approved file rotated the way the record says. A source pixel with
   `alpha == 0` carries no ink, so its unused RGB bytes are not reproduced and
   nothing may be painted outside the source's painted set.

`metrics.minimumGapMm` is present only when at least one pair was close enough
to measure (the probe is `marginPx + 4`); otherwise the report says so in
`pairsBeyondGapProbe` and the value is omitted rather than invented. The same
applies to `metrics` in general: every number is measured, none is estimated.

## Manifest (packer-owned, internal)

The frozen contracts define no export request, so the packer owns
`packer/printsheet_packer/schemas/placement-manifest.schema.json`
(`kind: "printsheet.packer.manifest"`, `schemaVersion: "1.0"`). It is validated
on read by `export` and `verify`, and carries everything a re-render needs:
sheet geometry, the full parameter set (including `cellPx`, `seed` and
`orderingsTried`), the embedded integrity report, and per placement the design
and version ids, display name, relative source path, **sha256 of the source
file**, source width/height, rotation, px and cm geometry plus the visible bbox.
`xPx`/`yPx` are whole pixels; the cm fields are derived from them at `dpi`.

A sha256 mismatch is not one of the four checks — `verify` reports it as
`source-changed` / `source-missing` on stderr and exits non-zero, so a stale
sheet cannot be mistaken for a valid one.

## Exports

| Format | What it is | Status |
| --- | --- | --- |
| `flat-png` | 8-bit RGBA, horizontal strips, own container writer (`zlib` + CRC), `pHYs` for DPI | guaranteed |
| `flat-tiff` | baseline little-endian TIFF, 256-row deflate strips, `ResolutionUnit=inch` + X/YResolution | guaranteed |
| `psd-bundle` | `sheet.png` + `placements.json` + `rebuild.jsx` | guaranteed layered-equivalent |
| `layered-psd` | — | **refused** (`export-format-unavailable`) |
| `layered-psb` | — | **refused** (`export-format-unavailable`) |

Both flat writers stream: the sheet canvas is never allocated, so a 6850 × 59 000
px sheet costs one strip of memory (~14 MB at 512 rows) rather than 1.6 GB.
Everything is written to a temp file and renamed only after the whole container
is complete, so a failure leaves nothing behind; `--force` is required to
replace an existing artifact and replacing a file this run read as an **input**
is refused outright.

True layered PSD/PSB is deliberately not implemented (ADR 0003): `psd-tools`
1.26.0 cannot read or composite layer rasters above the PSD 30 000 px limit, the
only workaround touches private state and leaves a stale composite, the writer is
not strip-based (~2.3 GB extrapolated for a tall sheet) and there is no
Photoshop on this machine to validate any of it. `rebuild.jsx` is the honest
answer: it recreates one layer per design at the recorded pixel position and
90° rotation inside Photoshop, which can save a real PSB. **The script has never
been executed** — there is no Photoshop here — so treat it as a reviewed
template, not a tested deliverable, and smoke-test it before the shop relies on
it.

## Tests

```bash
.venv/bin/python -m pytest                      # everything
.venv/bin/python -m pytest tests/test_properties.py -q   # hypothesis invariants
.venv/bin/python -m pytest tests/test_integrity.py -q    # adversarial checks
```

No network, GPU, Photoshop or ImageMagick: every image is a synthetic NumPy
array written into a `tmp_path` storage root, and no binary is committed.
Covered: thresholding and faint pixels, holes, exact dilation against a brute
force kernel, round-up grids, 90° rotations against Pillow's transposes, storage
traversal and symlink escapes, ordering and determinism, over-width refusal,
four-check adversarial failures, strip boundaries through placements, tall
sheets, PNG/TIFF read back with Pillow (size, mode, DPI, identical pixels),
atomic failure, manifest validation, and the full `pack → verify → export` CLI
path. Property-based invariants: grids never underestimate, rotations preserve
the pixel multiset, sheet width is the canonical rounding, cell padding
guarantees the requested gap, and every pack result is inside, apart and
reproducible.

## Benchmark (not in CI)

```bash
cd packer
.venv/bin/python benchmarks/bench_pack.py                       # 1, 10, 40 designs
.venv/bin/python benchmarks/bench_pack.py --counts 40 --orderings 8 --keep /tmp/batch
.venv/bin/printsheet-packer pack --request /tmp/batch/request.json --storage-root /tmp/batch/storage
```

Measured on this machine (AMD Zen, Python 3.11, NumPy 2.4.6, 58 cm roll, 300 DPI,
30 mm margin, 10 mm edge margin, 5 mm cells, ellipse-like blobs up to 28 cm):

| designs | orderings | sheet | search | integrity | whole pack | peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 31 | 6850 × 2399 | 19 ms | 69 ms | 0.3 s | — |
| 10 | 31 | 6850 × 8364 | 2.6 s | 1.5 s | 5.6 s | — |
| 20 | 9 | 6850 × 15425 | 2.7 s | 2.6 s | 8.1 s | — |
| 40 | 31 | 6850 × 34976 (296 cm) | 45 s | 6.3 s | 58 s | 1.26 GB |
| 40 | 9 | same height | 12.5 s | 5.9 s | 24.5 s | 1.26 GB |

All four checks passed in every run. The 40-design batch is a hard one (43.7 %
ink occupancy); the last two rows show that beyond a handful of orderings the
search cost buys no height improvement on this input, so `randomizedOrderings:
10` is the sane interactive default and `timeBudgetMs` is the safety net the ADR
asks for. `preview` (a resampled display file) and `manifest` are separate
columns in the tool's own output.

## Deliberately not implemented

* Layered PSD/PSB writing — see the export table above and ADR 0003.
* Any resampling, recolouring or cropping of artwork. The preview file is the
  only resampled artifact, and it is display-only.
* FFT/convolution or true polygon nesting. The grid search is heuristic and
  does not prove optimality.
* Cost calculation, batch state, jobs, retries: the API owns those. The packer
  is a pure function over files.

## Module map

```text
printsheet_packer/
  units.py       cm/mm <-> px, round-half-away-from-zero (mirrors PrintUnits)
  errors.py      structured codes the API can surface
  contracts.py   schema discovery, referencing registry, typed request/placements
  storage.py     storage-root resolution, input immutability, atomic writes
  masks.py       alpha masks, Chebyshev dilation, grids, 90° rotation
  nesting.py     ordering, grid search, sheet sizing
  integrity.py   the four blocking checks and the report
  render.py      strip renderer and preview
  export.py      manifest, flat PNG/TIFF, psd-bundle, format gate
  pipeline.py    pack / verify orchestration
  cli.py         pack, export, verify, validate, version
  schemas/placement-manifest.schema.json   packer-owned manifest
```
