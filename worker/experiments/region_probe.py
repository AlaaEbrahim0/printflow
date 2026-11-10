"""Region-aware cutout: decide *per region* whether it is background.

The failure of a plain border flood fill is letter counters and enclosed holes:
the background is one continuous region conceptually, but a naive fill only
reaches the part touching the border. The failure of a global key removal is the
opposite: it punches holes in artwork that happens to match the key colour.

This probes the middle ground that actually suits logos, simple illustrations,
text and black-and-white art:

1. estimate the background key from the border;
2. build a *soft* key-distance map;
3. treat background as every region whose key-distance is low AND that is either
   border-connected or fully enclosed by low-distance pixels (a counter);
4. keep artwork regions that are large / dark / saturated regardless of shape;
5. recover a soft rim by un-premultiplying against the key.

The point of this experiment is to find where the remaining errors are and
whether they are a tuning problem or an information problem.
"""

from __future__ import annotations

import glob
import os
import sys

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
from bench_run import _border_key, score  # noqa: E402


def soft_key_distance(rgb: np.ndarray, key: np.ndarray) -> np.ndarray:
    """Euclidean distance in RGB from the key, as uint8."""
    diff = rgb.astype(np.float32) - key.reshape(1, 1, 3).astype(np.float32)
    return np.sqrt((diff * diff).sum(axis=2))


def region_aware(
    rgb: np.ndarray,
    *,
    tol: int = 26,
    min_art_share: float = 0.0008,
    invert_ok: bool = True,
) -> tuple[np.ndarray, dict]:
    """Return (alpha, diagnostics). Alpha is uint8, 255 = keep."""
    key = _border_key(rgb)
    dist = soft_key_distance(rgb, key)

    h, w = dist.shape
    total = h * w

    # Candidate background: close to the key. Slight blur keeps anti-aliased
    # pixels out of the seed so they can carry a ramp later.
    near = (dist <= tol).astype(np.uint8)

    # Label the *artwork* instead: anything not near the key.
    art = (1 - near).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(art, connectivity=8)

    alpha = np.zeros((h, w), np.float32)
    kept_regions = 0
    dropped = 0
    for lab in range(1, n):
        x, y, bw, bh, area = stats[lab]
        if area < 6:
            dropped += 1
            continue
        comp = labels == lab
        # A region that is basically the key colour inside the artwork is a
        # counter (hole in an O) or a genuine white detail. Decide by whether it
        # is enclosed by dark artwork and small relative to the artwork.
        mean_dist = float(dist[comp].mean())
        if mean_dist <= tol * 1.2:
            # close to key: only keep if it is a real enclosed counter of a
            # larger dark shape, which we cannot tell here - keep by default and
            # let the caller invert.
            if area / total < min_art_share:
                dropped += 1
                continue
        alpha[comp] = 255.0
        kept_regions += 1

    # Fill enclosed background (counters) back to transparent when the artwork
    # surrounds them: flood fill the transparent area from the border and mark
    # anything unreached as enclosed.
    holes = (alpha < 127).astype(np.uint8)
    nh, hlab = cv2.connectedComponents(holes, connectivity=4)
    edge = set(hlab[0, :].tolist()) | set(hlab[-1, :].tolist())
    edge |= set(hlab[:, 0].tolist()) | set(hlab[:, -1].tolist())
    for lab in range(1, nh):
        if lab in edge:
            continue
        comp = hlab == lab
        # Enclosed transparent island: this is a counter only if it is small.
        if comp.sum() / total > 0.02:
            alpha[comp] = 0.0

    # Soft rim: ramp alpha by key distance in a narrow band around the edge.
    edge_band = cv2.morphologyEx(
        (alpha > 127).astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)
    )
    band = cv2.dilate(edge_band, np.ones((5, 5), np.uint8)) > 0
    ramp = np.clip((dist - tol * 0.6) / max(tol * 1.6, 1) * 255.0, 0, 255)
    alpha[band] = ramp[band]

    return alpha.astype(np.uint8), {
        "key": key.astype(int).tolist(),
        "kept": kept_regions,
        "dropped": dropped,
    }


def main() -> None:
    paths = [p for p in sorted(glob.glob("worker/experiments/bench/*.png")) if ".truth." not in p]
    print(f"{'case':32}{'IoU':>8}{'under':>8}{'over':>8}")
    print("-" * 56)
    agg = {"iou": 0.0, "under": 0.0, "over": 0.0, "n": 0}
    for p in paths:
        rgb = np.array(Image.open(p).convert("RGB"))
        truth = np.array(Image.open(p.replace(".png", ".truth.png")).convert("RGBA"))[:, :, 3]
        pred, diag = region_aware(rgb)
        s = score(pred, truth)
        agg["iou"] += s["iou"]
        agg["under"] += s["under"]
        agg["over"] += s["over"]
        agg["n"] += 1
        print(f"{os.path.basename(p)[:-4]:32}{s['iou']:8.3f}{s['under']:8.3f}{s['over']:8.3f}")
    n = agg["n"]
    print("-" * 56)
    print(f"{'mean':32}{agg['iou']/n:8.3f}{agg['under']/n:8.3f}{agg['over']/n:8.3f}")


if __name__ == "__main__":
    main()
