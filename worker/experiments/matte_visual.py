"""Render a visual comparison sheet: source, model matte, ground truth, error map.

Numbers cannot settle whether a cutout is usable for print. This composites each
result over a mid-grey background so halos are visible, marks the errors (red =
artwork erased, blue = background kept), and writes a contact sheet.
"""

from __future__ import annotations

import glob
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "cache")
sys.path.insert(0, HERE)
from matte_hybrid import hybrid, source_rgb  # noqa: E402

CELL = 260
MODEL = sys.argv[1] if len(sys.argv) > 1 else "birefnet-massive"


def over_grey(rgb: np.ndarray, alpha: np.ndarray, grey=(120, 120, 124)) -> np.ndarray:
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    return (rgb.astype(np.float32) * a + np.array(grey, np.float32) * (1 - a)).astype(np.uint8)


def main() -> None:
    tags = [os.path.basename(p)[: -len(".alpha.npy")] for p in sorted(glob.glob(os.path.join(CACHE, MODEL, "*.alpha.npy")))]
    tags.sort(key=lambda t: (t.split("__")[0], t))

    cols = 4
    rows = len(tags)
    sheet = Image.new("RGB", (cols * CELL, rows * CELL), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)

    for r, tag in enumerate(tags):
        alpha = np.load(os.path.join(CACHE, MODEL, f"{tag}.alpha.npy"))
        truth = np.load(os.path.join(CACHE, MODEL, f"{tag}.truth.npy"))
        rgb = source_rgb(tag)

        ref = hybrid(alpha, rgb)

        pv, tv = ref > 127, truth > 127
        err = rgb.copy()
        err[(~pv) & tv] = (255, 50, 50)   # artwork erased
        err[pv & (~tv)] = (50, 120, 255)  # background kept

        panels = [
            Image.fromarray(rgb),
            Image.fromarray(over_grey(rgb, ref)),
            Image.fromarray(over_grey(rgb, truth)),
            Image.fromarray(err),
        ]
        for c, panel in enumerate(panels):
            cell = panel.resize((CELL, CELL), Image.LANCZOS)
            sheet.paste(cell, (c * CELL, r * CELL))
        draw.text((4, r * CELL + 4), tag[:34], fill=(0, 255, 90))

    out = os.path.join(HERE, "compare.png")
    sheet.save(out)
    print(f"wrote {out}  ({len(tags)} rows)")
    for i, t in enumerate(tags):
        print(f"  row {i+1}: {t}")
    print("\ncolumns: source | model+hybrid over grey | ground truth | red=erased blue=kept")


if __name__ == "__main__":
    main()
