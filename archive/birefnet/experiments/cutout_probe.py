"""Experiment: can a classical cutout recover alpha for logo/illustration artwork?

We have ten PNGs that already carry real alpha. That is free ground truth: flatten
each onto a solid background, then try to recover the cutout and score it against
the known alpha. This tells us whether a targeted classical pipeline is enough for
logos, simple illustrations, text and black-and-white designs.
"""

import glob
import os

import cv2
import numpy as np
from PIL import Image

SRC = os.path.expanduser("~/Downloads/test")


def flatten_to(img: Image.Image, bg=(255, 255, 255)) -> Image.Image:
    base = Image.new("RGB", img.size, bg)
    base.paste(img, mask=img.split()[3])
    return base


def border_uniformity(rgb: np.ndarray, tol: int = 12) -> float:
    b = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    med = np.median(b, axis=0)
    return float(np.mean(np.max(np.abs(b.astype(int) - med.astype(int)), axis=1) <= tol))


def classical_cutout(rgb: np.ndarray, tol: int = 18) -> np.ndarray:
    """Flood-fill the border colour, then colour-to-alpha the anti-aliased rim."""
    h, w = rgb.shape[:2]
    border = np.concatenate([rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]])
    key = np.median(border, axis=0).astype(np.int16)

    dist = np.max(np.abs(rgb.astype(np.int16) - key), axis=2)
    # Candidate background pixels, then keep only those connected to the border.
    near = (dist <= tol).astype(np.uint8)
    n, labels = cv2.connectedComponents(near, connectivity=4)
    keep = np.zeros(n, dtype=bool)
    edge_labels = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    for lab in edge_labels:
        if lab != 0:
            keep[lab] = True
    background = keep[labels]
    alpha = np.where(background, 0, 255).astype(np.uint8)
    return alpha


def score(pred: np.ndarray, truth: np.ndarray) -> dict:
    p = pred > 127
    t = truth > 127
    inter = np.logical_and(p, t).sum()
    union = np.logical_or(p, t).sum()
    iou = inter / union if union else 1.0
    # "halo" = pixels we kept that should have been removed
    over = np.logical_and(p, ~t).sum() / max(t.sum(), 1)
    under = np.logical_and(~p, t).sum() / max(t.sum(), 1)
    return {"iou": iou, "over": over, "under": under}


def main() -> None:
    print(f"{'file':16} {'size':>12} {'borderUnif':>10} {'IoU':>7} {'over':>7} {'under':>7}")
    print("-" * 68)
    for path in sorted(glob.glob(os.path.join(SRC, "*.png"))):
        img = Image.open(path).convert("RGBA")
        truth = np.array(img)[:, :, 3]

        flat = flatten_to(img)
        rgb = np.array(flat)

        unif = border_uniformity(rgb)
        pred = classical_cutout(rgb)
        s = score(pred, truth)
        name = os.path.basename(path)
        print(
            f"{name:16} {img.size[0]:5}x{img.size[1]:<6} {unif:10.2f} "
            f"{s['iou']:7.3f} {s['over']:7.3f} {s['under']:7.3f}"
        )


if __name__ == "__main__":
    main()
