"""Score cached mattes, and test whether post-processing closes the gap.

The raw model matte is a 1024x1024 prediction resized up to the source. That
resize is where thin type and hairlines lose their edges, so the interesting
question is whether a guided refinement step (recovering the matte against the
actual pixels) beats the raw output -- without re-running inference.

Scoring is per corpus, because the two mean different things:

* ``bench`` -- synthetic target class, exact ground truth.
* ``real``  -- the shop's own artwork, alpha ground truth, *hard* class (anime,
  photo composites). Included to catch regressions, not to tune on.
"""

from __future__ import annotations

import glob
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "cache")


def score(pred: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    p = pred > 127
    t = truth > 127
    inter = np.logical_and(p, t).sum()
    union = np.logical_or(p, t).sum()
    tsum = max(t.sum(), 1)
    return {
        "iou": float(inter / union) if union else 1.0,
        "under": float(np.logical_and(~p, t).sum() / tsum),
        "over": float(np.logical_and(p, ~t).sum() / tsum),
    }


def load(model: str) -> dict[str, dict[str, np.ndarray]]:
    out: dict[str, dict[str, np.ndarray]] = {}
    for p in sorted(glob.glob(os.path.join(CACHE, model, "*.alpha.npy"))):
        tag = os.path.basename(p)[: -len(".alpha.npy")]
        out[tag] = {
            "alpha": np.load(p),
            "truth": np.load(p.replace(".alpha.npy", ".truth.npy")),
        }
    return out


def guided_refine(alpha: np.ndarray, rgb: np.ndarray, radius: int = 4) -> np.ndarray:
    """Snap the resized matte to image edges, then keep only the moved rim.

    The model predicts at 1024x1024; upsampling to a 3500 px source blurs the
    boundary by several pixels. Guided filtering pulls that boundary back onto
    the real edge using the image itself as the guide.
    """

    a = alpha.astype(np.float32) / 255.0
    guide = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    refined = cv2.ximgproc.guidedFilter(guide, a, radius, 1e-3) if hasattr(cv2, "ximgproc") else a
    return np.clip(refined * 255.0, 0, 255).astype(np.uint8)


def crisp(alpha: np.ndarray, lo: int = 60, hi: int = 195) -> np.ndarray:
    """Widen contrast on the matte: kills the grey halo a resized matte leaves."""
    a = alpha.astype(np.float32)
    out = np.clip((a - lo) / max(hi - lo, 1) * 255.0, 0, 255)
    return out.astype(np.uint8)


def report(model: str, transform=None, label: str = "raw") -> None:
    data = load(model)
    if not data:
        print(f"no cache for {model}")
        return

    agg: dict[str, dict[str, float]] = {}
    worst: list[tuple[float, str]] = []

    for tag, d in data.items():
        corpus = tag.split("__")[0]
        alpha = d["alpha"]
        if transform is not None:
            alpha = transform(alpha, tag)
        s = score(alpha, d["truth"])
        bucket = agg.setdefault(corpus, {"iou": 0.0, "under": 0.0, "over": 0.0, "n": 0})
        for k in ("iou", "under", "over"):
            bucket[k] += s[k]
        bucket["n"] += 1
        if corpus == "bench":
            worst.append((s["iou"], tag))

    parts = []
    for corpus, b in sorted(agg.items()):
        n = b["n"]
        parts.append(
            f"{corpus}: IoU {b['iou']/n:.3f} under {b['under']/n:.3f} over {b['over']/n:.3f} (n={n})"
        )
    print(f"{model:26} {label:8} " + " | ".join(parts))

    if label == "raw":
        for iou, tag in sorted(worst)[:4]:
            print(f"    worst: {tag:36} {iou:.3f}")


def main() -> None:
    print("=== raw model mattes ===")
    for model in ("birefnet-massive", "birefnet-general", "bria-rmbg"):
        if os.path.isdir(os.path.join(CACHE, model)):
            report(model)

    print("\n=== with matte contrast (lo=60 hi=195) ===")
    for model in ("birefnet-massive", "birefnet-general", "bria-rmbg"):
        if os.path.isdir(os.path.join(CACHE, model)):
            report(model, lambda a, _t: crisp(a), "crisp")

    print("\n=== with contrast + mild dilation/erosion check ===")
    for delta in (-2, -1, 0, 1, 2):
        if not os.path.isdir(os.path.join(CACHE, "birefnet-massive")):
            break
        k = np.ones((3, 3), np.uint8)

        def shift(a, _t, delta=delta, k=k):
            return cv2.erode(a, k, iterations=-delta) if delta < 0 else cv2.dilate(a, k, iterations=delta)

        report("birefnet-massive", shift, f"shift{delta:+d}")


if __name__ == "__main__":
    main()
