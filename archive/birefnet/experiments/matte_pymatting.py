"""Alpha matting: turn the model's coarse matte into a pixel-accurate cutout.

The model predicts at 1024x1024. Resized up to a 3500 px source, its boundary is
blurred over several pixels -- that is what leaves thin type half-erased and puts a
grey fringe around everything. Alpha matting solves the opposite problem: given a
rough trimap (sure-foreground / unknown / sure-background) it solves for the exact
alpha of every unknown pixel from the image itself, at full resolution.

This tests whether that recovers the detail the model loses, using the cached
matte as the trimap and comparing against ground truth.
"""

from __future__ import annotations

import glob
import os
import sys
import time

import numpy as np
from pymatting import estimate_alpha_cf, estimate_foreground_ml

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "cache")
sys.path.insert(0, HERE)
from matte_hybrid import source_rgb  # noqa: E402


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


def trimap(alpha: np.ndarray, shrink: int = 8, grow: int = 8) -> np.ndarray:
    """1 = sure foreground, 0 = sure background, 0.5 = unknown band."""

    import cv2

    hard = (alpha > 127).astype(np.uint8)
    k = np.ones((3, 3), np.uint8)
    fg = cv2.erode(hard, k, iterations=max(shrink, 1))
    bg = 1 - cv2.dilate(hard, k, iterations=max(grow, 1))
    out = np.full(alpha.shape, 0.5, np.float64)
    out[bg > 0] = 0.0
    out[fg > 0] = 1.0
    return out


def main() -> None:
    model = "birefnet-massive"
    tags = [os.path.basename(p)[: -len(".alpha.npy")] for p in sorted(glob.glob(os.path.join(CACHE, model, "*.alpha.npy")))]
    tags = [t for t in tags if t.startswith("bench__")]

    print(f"{'case':36}{'raw IoU':>9}{'matte IoU':>11}{'under':>8}{'over':>8}{'ms':>9}")
    print("-" * 82)
    agg = {"raw": [0.0, 0.0, 0.0], "mat": [0.0, 0.0, 0.0], "n": 0}

    for tag in tags:
        alpha = np.load(os.path.join(CACHE, model, f"{tag}.alpha.npy"))
        truth = np.load(os.path.join(CACHE, model, f"{tag}.truth.npy"))
        rgb = source_rgb(tag)

        tri = trimap(alpha)
        t0 = time.time()
        # Work at a sane resolution: matting is O(n) but the solver is heavy.
        h, w = rgb.shape[:2]
        scale = min(1.0, 1200.0 / max(h, w))
        if scale < 1.0:
            import cv2

            size = (int(w * scale), int(h * scale))
            small = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA)
            tri_s = cv2.resize(tri, size, interpolation=cv2.INTER_NEAREST)
        else:
            small, tri_s = rgb, tri
        try:
            a = estimate_alpha_cf(small.astype(np.float64) / 255.0, tri_s)
            a = np.clip(a * 255, 0, 255).astype(np.uint8)
            if scale < 1.0:
                import cv2

                a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)
        except Exception as exc:  # noqa: BLE001
            print(f"{tag:36} matting failed: {exc}")
            continue
        ms = (time.time() - t0) * 1000

        s_raw = score(alpha, truth)
        s_mat = score(a, truth)
        for k in ("iou", "under", "over"):
            agg["raw"][("iou", "under", "over").index(k)] += s_raw[k]
            agg["mat"][("iou", "under", "over").index(k)] += s_mat[k]
        agg["n"] += 1

        print(
            f"{tag:36}{s_raw['iou']:9.3f}{s_mat['iou']:11.3f}"
            f"{s_mat['under']:8.3f}{s_mat['over']:8.3f}{ms:9.0f}"
        )

    n = max(agg["n"], 1)
    print("-" * 82)
    print(f"{'mean raw':36}{agg['raw'][0]/n:9.3f}")
    print(
        f"{'mean matted':36}{agg['mat'][0]/n:9.3f}"
        f"{agg['mat'][1]/n:8.3f}{agg['mat'][2]/n:8.3f}"
    )


if __name__ == "__main__":
    main()
