"""Benchmark ONNX segmentation models (via rembg) on the target cutout class.

The classical probes showed the ceiling of key-colour methods: letter counters and
thin type are ambiguous when the artwork itself is near the background colour.
This harness measures whether a general segmentation model does better on logos,
text, black-and-white art and flat illustration -- and, critically, whether it
degrades when the input is a *photo* of artwork rather than a clean render.

Scoring is the same as bench_run: IoU, plus `under` (artwork erased, fatal) and
`over` (background kept, shows as halo).
"""

from __future__ import annotations

import glob
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from bench_run import score  # noqa: E402

BENCH = os.path.join(os.path.dirname(__file__), "bench")


def load(p: str) -> tuple[np.ndarray, np.ndarray]:
    rgb = np.array(Image.open(p).convert("RGB"))
    truth = np.array(Image.open(p.replace(".png", ".truth.png")).convert("RGBA"))[:, :, 3]
    return rgb, truth


def main() -> None:
    from rembg import new_session, remove

    models = sys.argv[1:] or ["isnet-anime", "u2net", "birefnet-general-lite", "silueta"]
    paths = [p for p in sorted(glob.glob(os.path.join(BENCH, "*.png"))) if ".truth." not in p]

    results: dict[str, dict[str, float]] = {}
    for name in models:
        t0 = time.time()
        session = new_session(name)
        print(f"\n=== {name} (session {time.time()-t0:.1f}s) ===")
        agg = {"iou": 0.0, "under": 0.0, "over": 0.0, "n": 0, "t": 0.0}
        for p in paths:
            rgb, truth = load(p)
            pil = Image.fromarray(rgb)
            t1 = time.time()
            out = remove(pil, session=session, post_process_mask=False)
            agg["t"] += time.time() - t1
            pred = np.array(out.convert("RGBA"))[:, :, 3]
            s = score(pred, truth)
            agg["iou"] += s["iou"]
            agg["under"] += s["under"]
            agg["over"] += s["over"]
            agg["n"] += 1
            print(
                f"  {os.path.basename(p)[:-4]:32} IoU {s['iou']:6.3f} "
                f"under {s['under']:6.3f} over {s['over']:6.3f}"
            )
        n = agg["n"]
        results[name] = {
            "iou": agg["iou"] / n,
            "under": agg["under"] / n,
            "over": agg["over"] / n,
            "ms": agg["t"] / n * 1000,
        }

    print("\n=== summary ===")
    print(f"{'model':26}{'meanIoU':>9}{'under':>8}{'over':>8}{'ms/img':>9}")
    for name, r in sorted(results.items(), key=lambda kv: -kv[1]["iou"]):
        print(f"{name:26}{r['iou']:9.3f}{r['under']:8.3f}{r['over']:8.3f}{r['ms']:9.0f}")


if __name__ == "__main__":
    main()
