"""Benchmark candidate cutout algorithms on the target class.

Every case has exact ground-truth alpha. We score IoU plus the two errors that
actually hurt a print shop:

* ``under`` - artwork erased. Unrecoverable, so it dominates.
* ``over``  - background kept. Shows up as a white/grey halo on a dark garment.
* ``halo``  - mean colour error on the recovered rim, which is what the eye sees
  as fringing after compositing onto a dark shirt.
"""

from __future__ import annotations

import glob
import os

import cv2
import numpy as np
from PIL import Image


def load_case(path: str):
    flat = np.array(Image.open(path).convert("RGB"))
    truth_path = path.replace(".png", ".truth.png")
    truth = np.array(Image.open(truth_path).convert("RGBA"))[:, :, 3]
    return flat, truth


def score(pred: np.ndarray, truth: np.ndarray) -> dict[str, float]:
    p = pred > 127
    t = truth > 127
    inter = np.logical_and(p, t).sum()
    union = np.logical_or(p, t).sum()
    iou = inter / union if union else 1.0
    tsum = max(t.sum(), 1)
    return {
        "iou": float(iou),
        "over": float(np.logical_and(p, ~t).sum() / tsum),
        "under": float(np.logical_and(~p, t).sum() / tsum),
    }


def _border_key(rgb: np.ndarray) -> np.ndarray:
    b = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    return np.median(b, axis=0)


# --------------------------------------------------------------------------- A
def flood_only(rgb: np.ndarray, tol: int = 18) -> np.ndarray:
    """Border-connected flood fill of the key colour. No soft edge."""
    key = _border_key(rgb)
    dist = np.max(np.abs(rgb.astype(np.int16) - key.astype(np.int16)), axis=2)
    near = (dist <= tol).astype(np.uint8)
    n, labels = cv2.connectedComponents(near, connectivity=4)
    edge = set(labels[0, :].tolist()) | set(labels[-1, :].tolist())
    edge |= set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    keep = np.zeros(n, bool)
    for lab in edge:
        if lab:
            keep[lab] = True
    bg = keep[labels]
    return np.where(bg, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- B
def flood_plus_ramp(rgb: np.ndarray, tol: int = 18, soft: int = 40) -> np.ndarray:
    """Flood fill, then a distance ramp on the 1-2 px anti-aliased rim."""
    hard = flood_only(rgb, tol)
    key = _border_key(rgb)
    dist = np.max(np.abs(rgb.astype(np.int16) - key.astype(np.int16)), axis=2).astype(np.float32)

    # Rim = pixels near the hard edge, either side.
    edge = cv2.morphologyEx(
        (hard > 127).astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)
    )
    rim = cv2.dilate(edge, np.ones((5, 5), np.uint8)) > 0

    alpha = hard.astype(np.float32)
    ramp = np.clip((dist - tol) / max(soft, 1) * 255.0, 0, 255)
    alpha[rim] = ramp[rim]
    return alpha.astype(np.uint8)


# --------------------------------------------------------------------------- C
def flood_ramp_despill(rgb: np.ndarray, tol: int = 18, soft: int = 40):
    """B: plus colour decontamination of the rim.

    A semi-transparent rim pixel is a mix of artwork colour and background key.
    Recovering the true colour removes the halo that a print shop sees on dark
    garments. Returns (alpha, rgb_decontaminated).
    """
    alpha = flood_plus_ramp(rgb, tol, soft)
    key = _border_key(rgb).astype(np.float32)
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    work = rgb.astype(np.float32)

    # observed = a*true + (1-a)*key  =>  true = (observed - (1-a)*key) / a
    safe = np.maximum(a, 1e-3)
    true = (work - (1.0 - a) * key) / safe
    out = np.where(a > 0.02, true, work)
    return alpha, np.clip(out, 0, 255).astype(np.uint8)


def halo_error(recovered_rgb: np.ndarray, truth_rgba: np.ndarray, alpha: np.ndarray) -> float:
    """Mean |colour difference| on the visible rim vs the true artwork colour."""

    truth_rgb = truth_rgba[:, :, :3].astype(np.float32)
    rim = (alpha > 30) & (alpha < 225)
    if not rim.any():
        return 0.0
    diff = np.abs(recovered_rgb.astype(np.float32) - truth_rgb)[rim]
    return float(diff.mean())


def main() -> None:
    paths = sorted(glob.glob("worker/experiments/bench/*.png"))
    paths = [p for p in paths if not p.endswith(".truth.png")]

    algs = {
        "A flood": lambda rgb: flood_only(rgb),
        "B ramp": lambda rgb: flood_plus_ramp(rgb),
        "C despill": lambda rgb: flood_ramp_despill(rgb)[0],
    }

    header = f"{'case':32}" + "".join(f"{n:>22}" for n in algs)
    print(header)
    print(f"{'':32}" + "".join(f"{'IoU / under / over':>22}" for _ in algs))
    print("-" * len(header))

    totals = {n: {"iou": 0.0, "under": 0.0, "over": 0.0, "halo": 0.0, "n": 0} for n in algs}

    for path in paths:
        flat, truth = load_case(path)
        truth_rgba = np.array(Image.open(path.replace(".png", ".truth.png")).convert("RGBA"))
        name = os.path.basename(path)[:-4]
        row = f"{name:32}"
        for label, fn in algs.items():
            pred = fn(flat)
            s = score(pred, truth)
            if label == "C despill":
                _, fixed = flood_ramp_despill(flat)
                s["halo"] = halo_error(fixed, truth_rgba, pred)
            totals[label]["iou"] += s["iou"]
            totals[label]["under"] += s["under"]
            totals[label]["over"] += s["over"]
            totals[label]["halo"] += s.get("halo", 0.0)
            totals[label]["n"] += 1
            row += f"{s['iou']:7.3f}/{s['under']:6.3f}/{s['over']:6.3f}"
        print(row)

    print("-" * len(header))
    for label, t in totals.items():
        n = t["n"]
        print(
            f"{label:32} mean IoU {t['iou']/n:6.3f}  under {t['under']/n:6.3f}  "
            f"over {t['over']/n:6.3f}"
            + (f"  rim colour err {t['halo']/n:5.1f}" if label == "C despill" else "")
        )


if __name__ == "__main__":
    main()
