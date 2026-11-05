# PSD / PSB layered export spike

**Date:** 2026-11-05
**Status:** complete
**Decision:** [ADR 0003](../../adr/0003-layered-export-format.md) — the
guaranteed layered deliverable is a flat PNG/TIFF + JSON placements manifest +
a Photoshop `.jsx` rebuild bundle. A true layered PSD/PSB is optional and must
only be offered within validated limits.

## Why

The sheet is exactly 58 cm wide (6850 px at 300 DPI) and its height is
minimized, not fixed. A dense batch can reach roughly 500 cm, i.e. about
59,000 px tall. The classic Photoshop PSD format has a hard limit of 30,000 px
per side (about 254 cm at 300 DPI). Photoshop's large-document format, PSB,
raises that limit, but the export pipeline is Python and we do not have
Photoshop on the build machine.

The question was: can `psd-tools` produce a layered PSD/PSB at realistic sheet
sizes, with correct layer offsets, alpha and DPI metadata, reliably enough to
be the primary layered export?

## Environment

| Component | Version |
| --- | --- |
| psd-tools | 1.26.0 |
| Pillow | 13.0.0 |
| Python | 3.14.8 |
| ImageMagick | 7.1.2-34 |
| Photoshop | not available |
| Host GPU | GTX 1650 Ti, 4 GB VRAM (irrelevant here) |

Reproducer:

- [`packer/spikes/psd-spike/spike.py`](../../../packer/spikes/psd-spike/spike.py)
- [`packer/spikes/psd-spike/tall_and_dpi.py`](../../../packer/spikes/psd-spike/tall_and_dpi.py)
- [`packer/spikes/psd-spike/requirements.txt`](../../../packer/spikes/psd-spike/requirements.txt)

Raw measurements are committed as:
[`results/spike-results.json`](results/spike-results.json) and
[`results/tall-and-dpi-results.json`](results/tall-and-dpi-results.json).
Binary artifacts are **not** committed; they are hundreds of megabytes.

## Method

Two scripts, both writing to `PSD_SPIKE_OUT` (default: a git-ignored `out/`
next to the script):

1. **`spike.py`** builds five documents and reopens each one:
   - ordinary 1200 × 800 PSD with two offset layers and alpha;
   - 30,000 × 64 stripe at the exact classic-PSD boundary;
   - 30,001 × 64 stripe, one pixel over the limit;
   - 64 × 30,001 PSB with a layer at offset 30,000;
   - 6850 × 5900 (58 × 50 cm at 300 DPI) with four offset layers.

   For documents at or below 30,000 px it compares the reopened layer raster
   bytes with the source bitmap. Above 30,000 px it records that psd-tools
   cannot read the raster and checks the file with ImageMagick instead.

2. **`tall_and_dpi.py`** builds a 6850 × 31,000 PSB (~58 × 262 cm), embeds
   300 DPI through raw ResolutionInfo bytes, reopens it, and probes it with
   ImageMagick.

### Workaround used in both scripts

`psd-tools` 1.26.0 refuses to composite a preview when either side exceeds
30,000 px, **even for a PSB**. Because `PixelLayer.frompil()` marks the
document dirty, `save()` attempts the preview rebuild and raises. The spike
sets the private flag `doc._updated = False` before `save()`. The resulting
PSB has valid layer records but a stale/initial composite preview.

This is a measurement workaround. It depends on private state and must not be
the production path.

### DPI metadata workaround

`psd_tools.psd.image_resources.ResoulutionInfo` (sic) has a writer signature
bug in 1.26.0 when `ImageResources.write()` calls it. Writing a raw
`ImageResource` with the standard 16.16 fixed-point payload works:

```python
dpi = 300 << 16
raw = struct.pack(">I2HI2H", dpi, 1, 1, dpi, 1, 1)
doc.image_resources[Resource.RESOLUTION_INFO] = ImageResource(
    key=Resource.RESOLUTION_INFO, data=raw
)
```

ImageMagick then reports `300 x 300 PixelsPerInch`.

## Results

| Case | Size (px) | Format version | File size | Save time | Peak traced Python memory |
| --- | --- | --- | ---: | ---: | ---: |
| ordinary multi-layer | 1200 × 800 | PSD (1) | 2.9 MB | 0.02 s | 5.5 MB |
| exact PSD limit | 30,000 × 64 | PSD (1) | 5.9 MB | 0.05 s | 12.9 MB |
| one pixel over | 30,001 × 64 | PSB (2) | 5.9 MB | 0.04 s | 12.9 MB |
| tall offset layer | 64 × 30,001 | PSB (2) | 5.8 MB | 0.01 s | 11.0 MB |
| realistic 4-layer sheet | 6850 × 5900 | PSD (1) | 122.7 MB | 0.56 s | 231.3 MB |
| tall sheet, one layer | 6850 × 31,000 | PSB (2) | 637.2 MB | 0.63 s | 1215.1 MB |

Notes:

- Peak traced memory is `tracemalloc`, i.e. Python allocations only. Native
  Pillow buffers and the OS page cache are not included; real RSS is higher.
- `PSDImage.new()` defaults to **RAW** canvas compression. Passing
  `compression=1` still produced 637 MB for a mostly white 6850 × 31,000
  canvas. This dominates the file-size problem, not just layer data.
- The 6850 × 5900 file stayed under the 30,000 px limit, so it is a classic
  PSD, not a PSB. All four layer round-trips were byte-identical.

## Findings

1. **Classic PSD works up to exactly 30,000 px per side.** A 30,000 × 64
   document is written as version 1 and round-trips correctly.
2. **psd-tools automatically promotes to PSB at 30,001 px.** The header is
   version 2 and the layer records/offsets are correct, including a layer at
   y = 30,000.
3. **psd-tools applies the PSD limit to reads too.** Reading back a layer
   raster or compositing a PSB above 30,000 px fails with
   `ValueError: Image ... exceeds the PSD maximum of 30000 px per axis.`
   It can still open the structure and read layer names/bboxes.
4. **The private `_updated = False` workaround produces a PSB with layers but
   a stale composite.** It is not an acceptable foundation for a production
   exporter.
5. **ImageMagick reads the tall PSB and its layer raster correctly**, and
   reports 300 DPI when the raw ResolutionInfo resource is present.
6. **Memory is not strip-based.** Extrapolating the measured 1.2 GB at
   6850 × 31,000 linearly to 6850 × 59,000 gives roughly 2.3 GB of traced
   Python allocations for a single save, before native buffers. A 500 cm sheet
   is therefore a real OOM risk on a modest workstation, and the writer would
   need horizontal strips to be safe.
7. **File size is a delivery problem.** A 637 MB PSB for one tall sheet is
   impractical for a print shop to move around, especially when the visible
   artwork is a small fraction of the canvas.

## Decision

See [ADR 0003](../../adr/0003-layered-export-format.md). In short:

- **Guaranteed:** flat transparent PNG/TIFF at 300 DPI, written in horizontal
  strips, plus a JSON placements manifest (version IDs, cm and px geometry,
  rotation) and a Photoshop `.jsx` that rebuilds the layered document from the
  manifest and the immutable version files.
- **Optional:** `layered-psd` for sheets within the 30,000 px limit, and
  `layered-psb` only after a strip-based writer exists and has been smoke-tested
  in real Photoshop. The API exposes `psd-bundle` as the safe layered format.
- The export dialog must state the effective sheet size and which layered
  formats are available before the operator clicks export.

## Not tested

- Opening the generated PSB in real Photoshop (not installed; ImageMagick is
  only a structural/format check).
- Photoshop's handling of layer names, blend modes, smart objects or layer
  comps. The spike only writes plain pixel layers.
- Very large layer counts (40 designs × several versions). Only four layers
  were measured.
- TIFF/PNG strip rendering, which is Phase 1 C work and not part of this spike.

## Reproduce

```bash
cd packer/spikes/psd-spike
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python spike.py
PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python tall_and_dpi.py
# Writes ~780 MB of artifacts plus the two JSON result files.
```
