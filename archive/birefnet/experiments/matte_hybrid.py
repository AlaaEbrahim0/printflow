"""Per-case detail, and a hybrid: model semantics + classical pixel-accurate edges.

Two failure modes showed up and they are complementary:

* The classical key-colour method is pixel-exact at full resolution but cannot tell
  a letter counter ("O") from artwork that happens to match the key colour.
* The model understands *what* is foreground but predicts at 1024x1024, so thin
  type and hairlines come back blurred and partly erased when upsampled to a
  3000 px source.

So: let the model decide the region, and let the image decide the edge. The hybrid
takes the model matte as a region prior, then re-derives alpha at full resolution
from the local background colour inside that region's neighbourhood.
"""

from __future__ import annotations

import glob
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "cache")
BENCH = os.path.join(HERE, "bench")
REAL = os.path.expanduser("~/Downloads/test")


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


def source_rgb(tag: str) -> np.ndarray:
    corpus, name = tag.split("__", 1)
    if corpus == "bench":
        sys.path.insert(0, HERE)
        from bench_gen import build_cases

        bg = {c.name: c.background for c in build_cases()}.get(name, (255, 255, 255))
        art = Image.open(os.path.join(BENCH, f"{name}.truth.png")).convert("RGBA")
        base = Image.new("RGB", art.size, bg)
        base.paste(art, mask=art.split()[3])
        return np.array(base)
    art = Image.open(os.path.join(REAL, f"{name}.png")).convert("RGBA")
    base = Image.new("RGB", art.size, (255, 255, 255))
    base.paste(art, mask=art.split()[3])
    return np.array(base)


def border_key(rgb: np.ndarray) -> np.ndarray:
    b = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    return np.median(b, axis=0)


def hybrid(alpha: np.ndarray, rgb: np.ndarray, band: int = 24, tol: float = 12.0) -> np.ndarray:
    """Refine the model matte's rim against the actual pixels.

    Inside the rim band the model is unreliable, so alpha is recomputed from the
    distance to the sampled background colour: pixels at the key are transparent,
    pixels far from it are opaque, and the anti-aliased blend in between gets a
    proportional value. Everywhere else the model's decision stands.
    """

    key = border_key(rgb).astype(np.float32)
    dist = np.sqrt(((rgb.astype(np.float32) - key) ** 2).sum(axis=2))

    hard = (alpha > 127).astype(np.uint8)
    rim = cv2.dilate(hard, np.ones((band, band), np.uint8)) - cv2.erode(
        hard, np.ones((band, band), np.uint8)
    )

    out = alpha.astype(np.float32).copy()
    # Ramp: 0 at the key, 255 once the pixel is clearly not the background.
    ramp = np.clip((dist - tol) / max(tol, 1.0) * 255.0, 0, 255)
    sel = rim > 0
    out[sel] = ramp[sel]
    return out.astype(np.uint8)


def main() -> None:
    model = "birefnet-massive"
    print(f"{'case':38}{'raw':>22}{'hybrid':>22}")
    print(f"{'':38}{'IoU / under / over':>22}{'IoU / under / over':>22}")
    print("-" * 82)

    agg = {c: {"raw": [0.0, 0.0, 0.0, 0], "hyb": [0.0, 0.0, 0.0, 0]} for c in ("bench", "real")}

    for p in sorted(glob.glob(os.path.join(CACHE, model, "*.alpha.npy"))):
        tag = os.path.basename(p)[: -len(".alpha.npy")]
        corpus = tag.split("__")[0]
        alpha = np.load(p)
        truth = np.load(p.replace(".alpha.npy", ".truth.npy"))
        rgb = source_rgb(tag)

        a = score(alpha, truth)
        b = score(hybrid(alpha, rgb), truth)
        for k, v in (("raw", a), ("hyb", b)):
            slot = agg[corpus][k]
            slot[0] += v["iou"]
            slot[1] += v["under"]
            slot[2] += v["over"]
            slot[3] += 1
        print(
            f"{tag:38}{a['iou']:7.3f}/{a['under']:6.3f}/{a['over']:6.3f}"
            f"{b['iou']:8.3f}/{b['under']:6.3f}/{b['over']:6.3f}"
        )

    print("-" * 82)
    for corpus, d in agg.items():
        for k, label in (("raw", "raw"), ("hyb", "hybrid")):
            iou, under, over, n = d[k]
            print(f"{corpus + ' ' + label:38} mean IoU {iou/n:.3f}  under {under/n:.3f}  over {over/n:.3f}")


if __name__ == "__main__":
    main()
