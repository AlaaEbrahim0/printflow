"""Tall PSB memory measurement plus 300 DPI metadata embedding.

Writes a 6850 x 31,000 PSB (58 cm wide, ~262 cm tall at 300 DPI) with one
offset layer and validates:

- psd-tools can open the file and read layer names/bboxes;
- psd-tools cannot composite the merged image above 30,000 px;
- ImageMagick can read the PSB and reports 300 DPI.

The 300 DPI resource is written as raw ResolutionInfo bytes because
psd-tools 1.26.0's ResoulutionInfo.write() has a broken signature when called
through ImageResources.

    PSD_SPIKE_OUT=/tmp/psd-spike-out .venv/bin/python tall_and_dpi.py
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import time
import tracemalloc
from pathlib import Path

from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
from psd_tools.constants import Resource
from psd_tools.psd.image_resources import ImageResource

OUT = Path(os.environ.get("PSD_SPIKE_OUT", Path(__file__).resolve().parent / "out"))
OUT.mkdir(parents=True, exist_ok=True)

W, H = 6850, 31_000
path = OUT / "tall-6850x31000.psb"

tracemalloc.start()
t0 = time.perf_counter()
doc = PSDImage.new("RGB", (W, H), color=(255, 255, 255))
# 300 DPI, inches; fixed 16.16 fields. Raw bytes avoid the psd-tools writer
# signature bug in ResoulutionInfo.
dpi = 300 << 16
raw = struct.pack(">I2HI2H", dpi, 1, 1, dpi, 1, 1)
doc.image_resources[Resource.RESOLUTION_INFO] = ImageResource(
    key=Resource.RESOLUTION_INFO, data=raw
)
im = Image.new("RGBA", (1200, 900), (0, 0, 0, 0))
dr = ImageDraw.Draw(im)
dr.rectangle([0, 0, 1199, 899], fill=(200, 30, 40, 255))
dr.text((20, 20), "tall sheet test", fill=(255, 255, 255, 255))
PixelLayer.frompil(im, doc, name="design-a", left=300, top=29_000)
doc._updated = False  # avoid psd-tools' PSD-only 30k preview guard
doc.save(path, compression=1)
elapsed = time.perf_counter() - t0
_current, peak = tracemalloc.get_traced_memory()
tracemalloc.stop()

reopened = PSDImage.open(path)
res = reopened.image_resources.get_data(Resource.RESOLUTION_INFO)
layers = [
    {"name": layer.name, "bbox": list(layer.bbox), "size": list(layer.size)}
    for layer in reopened
]
out = {
    "path": path.name,
    "bytes": path.stat().st_size,
    "version": reopened.version,
    "size": list(reopened.size),
    "layers": layers,
    "resolution": repr(res),
    "save_seconds": round(elapsed, 2),
    "peak_tracemalloc_mb": round(peak / 1024 / 1024, 1),
    "composite_readable_by_psd_tools": True,
}
try:
    reopened.topil()
except Exception as exc:  # noqa: BLE001 - the failure is the measurement
    out["composite_readable_by_psd_tools"] = False
    out["composite_read_error"] = f"{type(exc).__name__}: {exc}"

magick = shutil.which("magick") or shutil.which("identify")
if magick:
    try:
        probe = subprocess.run(
            [magick, "identify", "-format", "%wx%h %x x %y %U", str(path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        out["imagemagick_identify"] = probe.stdout.strip()
    except Exception as exc:  # noqa: BLE001
        out["imagemagick_error"] = f"{type(exc).__name__}: {exc}"
else:
    out["imagemagick_identify"] = "unavailable"

(OUT / "tall-and-dpi-results.json").write_text(json.dumps(out, indent=2) + "\n")
print(json.dumps(out, indent=2))
