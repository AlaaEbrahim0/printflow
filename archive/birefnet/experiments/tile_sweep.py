"""Find the tiling trade-off: how many source pixels may one 1024 window cover?

Native tiling (16 windows for a 3600 px design) recovers the detail but costs 7.5
minutes on CPU. That is far too slow for one image at a time if the operator is
waiting. This sweeps the window size to find where quality saturates, so the
implementation can pick the cheapest setting that still passes.
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
from tile_probe import big_case  # noqa: E402


def tiled(session, img: Image.Image, window: int, tile: int = 1024, overlap: int = 96) -> np.ndarray:
    """Run the model on tiles that each cover `window` source pixels, then stitch."""

    from rembg import remove

    w, h = img.size
    acc = np.zeros((h, w), np.float32)
    weight = np.zeros((h, w), np.float32)
    # Blend window sized to the *source* footprint of one tile, not the model input.
    ramp = np.outer(np.hanning(window) ** 0.5 + 1e-3, np.hanning(window) ** 0.5 + 1e-3).astype(
        np.float32
    )

    step = max(window - overlap, 1)
    xs = list(range(0, max(w - window, 0) + 1, step)) or [0]
    ys = list(range(0, max(h - window, 0) + 1, step)) or [0]
    if xs[-1] + window < w:
        xs.append(w - window)
    if ys[-1] + window < h:
        ys.append(h - window)

    for y0 in ys:
        for x0 in xs:
            patch = img.crop((x0, y0, x0 + window, y0 + window))
            if patch.size != (window, window):
                canvas = Image.new("RGB", (window, window), (255, 255, 255))
                canvas.paste(patch, (0, 0))
                patch = canvas
            if window != tile:
                patch = patch.resize((tile, tile), Image.LANCZOS)
            out = remove(patch, session=session, post_process_mask=False)
            a = np.array(out.convert("RGBA"))[:, :, 3].astype(np.float32)
            if window != tile:
                a = np.array(
                    Image.fromarray(a.astype(np.uint8)).resize((window, window), Image.BILINEAR),
                    dtype=np.float32,
                )
            acc[y0 : y0 + window, x0 : x0 + window] += a * ramp
            weight[y0 : y0 + window, x0 : x0 + window] += ramp

    return np.clip(acc / np.maximum(weight, 1e-6), 0, 255).astype(np.uint8)


def main() -> None:
    from rembg import new_session

    session = new_session("birefnet-general-lite")
    flat, truth = big_case(4)
    w = flat.size[0]
    print(f"case {flat.size[0]}x{flat.size[1]}  model=birefnet-general-lite")
    print(f"{'window':>8}{'tiles':>7}{'IoU':>8}{'under':>8}{'over':>8}{'sec':>8}")
    print("-" * 47)

    for window in (w, 1800, 1200, 1024):
        n = max(1, round(w / window)) ** 2
        t0 = time.time()
        a = tiled(session, flat, window)
        sec = time.time() - t0
        s = score(a, truth)
        print(f"{window:8}{n:7}{s['iou']:8.3f}{s['under']:8.3f}{s['over']:8.3f}{sec:8.1f}")


if __name__ == "__main__":
    main()
