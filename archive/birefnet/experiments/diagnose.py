"""Diagnose why some cutouts fail: border colour, content colour, holes, gradients."""

import glob
import os

import numpy as np
from PIL import Image

SRC = os.path.expanduser("~/Downloads/test")


def flatten_to(img, bg=(255, 255, 255)):
    base = Image.new("RGB", img.size, bg)
    base.paste(img, mask=img.split()[3])
    return base


for path in sorted(glob.glob(os.path.join(SRC, "*.png"))):
    img = Image.open(path).convert("RGBA")
    truth = np.array(img)[:, :, 3]
    flat = np.array(flatten_to(img))

    visible = truth > 127
    bg_px = flat[~visible].reshape(-1, 3)
    fg_px = flat[visible].reshape(-1, 3)

    # What colour is the background after flattening, and the artwork?
    bg_med = np.median(bg_px, axis=0) if len(bg_px) else np.array([0, 0, 0])
    fg_med = np.median(fg_px, axis=0) if len(fg_px) else np.array([0, 0, 0])

    # How separated are they? min max-channel distance between medians.
    sep = np.max(np.abs(bg_med - fg_med))

    # Does the visible artwork touch the border?
    border_visible = (
        visible[0, :].any() or visible[-1, :].any() or visible[:, 0].any() or visible[:, -1].any()
    )

    # Interior background holes: background pixels not connected to the border.
    import cv2

    bgmask = (~visible).astype(np.uint8)
    n, labels = cv2.connectedComponents(bgmask, connectivity=4)
    edge_labels = (
        set(labels[0, :].tolist()) | set(labels[-1, :].tolist())
        | set(labels[:, 0].tolist()) | set(labels[:, -1].tolist())
    )
    enclosed = np.isin(labels, [lab for lab in edge_labels if lab != 0], invert=True) & (~visible)
    hole_share = enclosed.sum() / max((~visible).sum(), 1)

    print(
        f"{os.path.basename(path):16} bg={tuple(bg_med.astype(int))!s:18} "
        f"fg={tuple(fg_med.astype(int))!s:18} sep={sep:3.0f} "
        f"touchesBorder={str(border_visible):5} interiorHoles={hole_share:.2f}"
    )
