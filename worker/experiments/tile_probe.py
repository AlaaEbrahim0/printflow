"""Does tiled inference at native resolution beat one 1024x1024 pass?

The ONNX graph is fixed at 1024x1024. A 3500 px design is therefore downsampled
3.4x before the model ever sees it, and the 1024 matte is stretched back -- which
is exactly why thin type and hairlines lose their edges on real artwork.

Tiling runs the same model on overlapping 1024 windows at native scale and stitches
the results. If the resolution ceiling is real, tiling should visibly win on a
high-resolution case; if it does not, the model is simply limited and tiling is not
worth the cost.
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)
from bench_run import score  # noqa: E402
from bench_gen import CANVAS, _font, flatten  # noqa: E402

from PIL import ImageDraw  # noqa: E402


def big_case(scale: int = 4) -> tuple[Image.Image, np.ndarray]:
    """Thin type and hairlines at high resolution: the detail-loss stress case."""

    size = CANVAS * scale
    art = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    y = 200 * scale
    for line in ("PRECISION CUT", "SINCE 1998", "300 DPI READY", "NO HALO"):
        d.text((80 * scale, y), line, font=_font(64 * scale), fill=(15, 15, 15, 255))
        y += 110 * scale
    for i in range(24):
        ly = (120 + i * 28) * scale
        d.line([(100 * scale, ly), (800 * scale, ly)], fill=(30, 30, 30, 255), width=2 * scale)
    flat = flatten(art, (255, 255, 255))
    return flat, np.array(art)[:, :, 3]


def tiled(session, img: Image.Image, tile: int = 1024, overlap: int = 128) -> np.ndarray:
    """Run the model on overlapping native-scale tiles and blend the mattes."""

    from rembg import remove

    w, h = img.size
    acc = np.zeros((h, w), np.float32)
    weight = np.zeros((h, w), np.float32)

    # A raised-cosine window avoids a visible seam where tiles meet.
    ramp = np.outer(
        np.hanning(tile) ** 0.5 + 1e-3,
        np.hanning(tile) ** 0.5 + 1e-3,
    ).astype(np.float32)

    step = tile - overlap
    xs = list(range(0, max(w - tile, 0) + 1, step)) or [0]
    ys = list(range(0, max(h - tile, 0) + 1, step)) or [0]
    if xs[-1] + tile < w:
        xs.append(w - tile)
    if ys[-1] + tile < h:
        ys.append(h - tile)

    for y0 in ys:
        for x0 in xs:
            patch = img.crop((x0, y0, x0 + tile, y0 + tile))
            if patch.size != (tile, tile):
                canvas = Image.new("RGB", (tile, tile), (255, 255, 255))
                canvas.paste(patch, (0, 0))
                patch = canvas
            out = remove(patch, session=session, post_process_mask=False)
            a = np.array(out.convert("RGBA"))[:, :, 3].astype(np.float32)
            acc[y0 : y0 + tile, x0 : x0 + tile] += a * ramp
            weight[y0 : y0 + tile, x0 : x0 + tile] += ramp

    return np.clip(acc / np.maximum(weight, 1e-6), 0, 255).astype(np.uint8)


def main() -> None:
    from rembg import new_session, remove

    session = new_session("birefnet-massive")
    flat, truth = big_case(4)
    print(f"case {flat.size[0]}x{flat.size[1]}")

    t0 = time.time()
    whole = remove(flat, session=session, post_process_mask=False)
    ms_whole = (time.time() - t0) * 1000
    a_whole = np.array(whole.convert("RGBA"))[:, :, 3]

    t0 = time.time()
    a_tile = tiled(session, flat)
    ms_tile = (time.time() - t0) * 1000

    for label, a, ms in (("single 1024 pass", a_whole, ms_whole), ("tiled native", a_tile, ms_tile)):
        s = score(a, truth)
        print(f"{label:20} IoU {s['iou']:.3f}  under {s['under']:.3f}  over {s['over']:.3f}  {ms:7.0f} ms")

    out = os.path.join(HERE, "tile_compare.png")
    panels = []
    for a in (a_whole, a_tile, truth):
        rgb = np.array(flat).astype(np.float32)
        al = (a.astype(np.float32) / 255.0)[..., None]
        panels.append((rgb * al + np.array([120, 120, 124], np.float32) * (1 - al)).astype(np.uint8))
    sheet = Image.new("RGB", (flat.size[0] * 3, flat.size[1]))
    for i, p in enumerate(panels):
        sheet.paste(Image.fromarray(p), (i * flat.size[0], 0))
    sheet.resize((sheet.size[0] // 4, sheet.size[1] // 4), Image.LANCZOS).save(out)
    print(f"wrote {out} (single | tiled | truth)")


if __name__ == "__main__":
    main()
