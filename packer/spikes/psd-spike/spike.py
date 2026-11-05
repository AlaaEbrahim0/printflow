"""PSD/PSB boundary spike for the PrintSheet sheet exporter.

Measures what psd-tools 1.26.0 can write and read back:

1. ordinary multi-layer PSD with alpha;
2. the exact classic-PSD 30,000 px boundary;
3. automatic promotion to PSB one pixel over the limit;
4. a PSB layer whose offset is beyond 30,000 px;
5. a realistic 6850 x 5900 sheet with four layers.

Run with the packer extra or an isolated environment:

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python spike.py

The output directory holds large binary artifacts (hundreds of MB) and is
git-ignored. Only the JSON results are meant to be committed. See
docs/spikes/psd-spike/README.md for the findings.
"""

from __future__ import annotations

import json
import os
import time
import tracemalloc
from pathlib import Path

from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

OUT = Path(os.environ.get("PSD_SPIKE_OUT", Path(__file__).resolve().parent / "out"))
OUT.mkdir(parents=True, exist_ok=True)

PSD_LIMIT = 30_000


def make_layer(
    w: int,
    h: int,
    color: tuple[int, int, int, int],
    label: str,
) -> Image.Image:
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, max(w - 1, 0), max(h - 1, 0)], fill=color)
    if w > 12 and h > 12:
        d.rectangle([4, 4, w - 5, h - 5], outline=(255, 255, 255, 255), width=2)
    if w > 24 and h > 24:
        d.text((10, 10), label, fill=(0, 0, 0, 255))
    return im


def build(path: Path, size: tuple[int, int], layers, compression: int = 1) -> dict:
    w, h = size
    tracemalloc.start()
    t0 = time.perf_counter()
    doc = PSDImage.new("RGB", (w, h), color=(255, 255, 255))
    for name, image, left, top in layers:
        PixelLayer.frompil(image, doc, name=name, left=left, top=top)
    # psd-tools 1.26.0 refuses to composite previews above 30,000 px even for
    # PSB documents. Clearing the dirty flag writes the layers without
    # rebuilding the merged preview. This relies on a private attribute and
    # leaves a stale composite; it is a spike measurement, not a production
    # path.
    doc._updated = False
    doc.save(path, compression=compression)
    elapsed = time.perf_counter() - t0
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    reopened = PSDImage.open(path)
    layer_info = []
    for layer in reopened:
        info = {
            "name": layer.name,
            "bbox": list(layer.bbox),
            "size": list(layer.size),
            "kind": layer.kind,
        }
        if layer.kind == "pixel":
            if max(w, h) <= PSD_LIMIT:
                source = next(
                    img.tobytes() for n, img, _l, _t in layers if n == layer.name
                )
                info["roundtrip_ok"] = layer.topil().tobytes() == source
            else:
                # psd-tools applies the PSD 30,000 px limit to layer raster
                # reads as well, so it cannot read back its own PSB layer
                # above that size. ImageMagick checks the raster instead.
                info["roundtrip_ok"] = None
                info["roundtrip_note"] = "psd-tools raster read blocked at >30,000 px"
        layer_info.append(info)
    return {
        "path": path.name,
        "bytes": path.stat().st_size,
        "version": reopened.version,
        "size": list(reopened.size),
        "layers": layer_info,
        "save_seconds": round(elapsed, 2),
        "peak_tracemalloc_mb": round(peak / 1024 / 1024, 1),
    }


def main() -> None:
    results = []

    # 1. Ordinary PSD, multiple offset layers, alpha.
    small = build(
        OUT / "small-psd.psd",
        (1200, 800),
        [
            ("red-panel", make_layer(300, 200, (220, 40, 40, 255), "A"), 20, 20),
            ("blue-panel", make_layer(200, 300, (40, 80, 220, 255), "B"), 900, 450),
        ],
    )
    results.append({"case": "ordinary-psd-multilayer", **small})

    # 2. Exact classic-PSD 30,000 px boundary (single row span, small area).
    boundary = build(
        OUT / "boundary-30000.psd",
        (PSD_LIMIT, 64),
        [("stripe", make_layer(PSD_LIMIT, 64, (10, 200, 90, 255), "BOUNDARY"), 0, 0)],
    )
    results.append({"case": "psd-width-30000-boundary", **boundary})

    # 3. One pixel over the PSD limit: must promote to PSB (version 2).
    psb = build(
        OUT / "width-30001.psb",
        (PSD_LIMIT + 1, 64),
        [("stripe", make_layer(PSD_LIMIT + 1, 64, (200, 10, 90, 255), "PSB"), 0, 0)],
    )
    results.append({"case": "psb-width-30001", **psb})

    # 4. Tall PSB, layer offset at the limit.
    tall = build(
        OUT / "tall-64x30001.psb",
        (64, PSD_LIMIT + 1),
        [("bottom-marker", make_layer(64, 2, (0, 0, 0, 255), "X"), 0, PSD_LIMIT)],
    )
    results.append({"case": "psb-height-30001-offset-30000", **tall})

    # 5. Realistic small batch sheet: 58 x 50 cm at 300 DPI, 4 layers.
    sheet = build(
        OUT / "sheet-6850x5900.psd",
        (6850, 5900),
        [
            ("design-a", make_layer(2000, 1500, (220, 40, 40, 255), "A"), 100, 100),
            ("design-b", make_layer(1800, 1800, (40, 80, 220, 255), "B"), 2300, 100),
            ("design-c", make_layer(1600, 2600, (40, 200, 90, 255), "C"), 4300, 100),
            ("design-d", make_layer(2400, 2000, (230, 220, 40, 255), "D"), 100, 3000),
        ],
    )
    results.append({"case": "psd-6850x5900-4-layers", **sheet})

    report = {
        "psd_tools_version": __import__("psd_tools").__version__,
        "pillow_version": Image.__version__,
        "python": __import__("sys").version.split()[0],
        "psd_limit_px": PSD_LIMIT,
        "results": results,
    }
    (OUT / "spike-results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
