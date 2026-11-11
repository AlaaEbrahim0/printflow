"""Verify a hand-rolled ONNX cutout matches rembg bit-for-bit.

rembg is convenient but drags in scipy, scikit-image, pymatting, numba and pooch
(~200 MB) for a single model call. If the preprocessing can be reproduced exactly,
the worker can depend on ``onnxruntime`` alone and keep its existing slim image.

Ground truth here is the matte cache that rembg itself produced, so this compares
against the reference implementation's real output rather than a re-derivation.
"""

from __future__ import annotations

import glob
import os

import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = os.path.dirname(__file__)
CACHE = os.path.join(HERE, "cache", "birefnet-massive")
REAL = os.path.expanduser("~/Downloads/test")
MODEL = os.path.expanduser(
    "~/.local/share/rembg/models/birefnet-massive/birefnet-massive.onnx"
)
SIZE = (1024, 1024)
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


def preprocess(img: Image.Image) -> np.ndarray:
    """Exactly rembg's BaseSession.normalize for the BiRefNet sessions."""

    im = img.convert("RGB").resize(SIZE, Image.Resampling.LANCZOS)
    ary = np.array(im).astype(np.float32)
    ary = ary / max(float(ary.max()), 1e-6)

    out = np.zeros((SIZE[1], SIZE[0], 3), np.float32)
    for c in range(3):
        out[:, :, c] = (ary[:, :, c] - MEAN[c]) / STD[c]
    return out.transpose(2, 0, 1)[None, ...]


def matte(session: ort.InferenceSession, img: Image.Image) -> np.ndarray:
    pred = session.run(None, {"input_image": preprocess(img)})[0][:, 0, :, :]
    pred = 1.0 / (1.0 + np.exp(-pred))
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / max(hi - lo, 1e-6)
    mask = Image.fromarray((np.squeeze(pred) * 255).astype(np.uint8), mode="L")
    return np.array(mask.resize(img.size, Image.Resampling.LANCZOS))


def main() -> None:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    session = ort.InferenceSession(MODEL, sess_options=opts, providers=["CPUExecutionProvider"])

    print(f"{'case':18}{'maxAbsDiff':>12}{'meanAbsDiff':>13}{'identical':>11}")
    print("-" * 54)
    checked = 0
    for p in sorted(glob.glob(os.path.join(CACHE, "real__*.alpha.npy")))[:4]:
        name = os.path.basename(p)[len("real__") : -len(".alpha.npy")]
        ref = np.load(p)

        art = Image.open(os.path.join(REAL, f"{name}.png")).convert("RGBA")
        base = Image.new("RGB", art.size, (255, 255, 255))
        base.paste(art, mask=art.split()[3])

        mine = matte(session, base)
        if mine.shape != ref.shape:
            print(f"{name:18} shape mismatch {mine.shape} vs {ref.shape}")
            continue
        diff = np.abs(mine.astype(np.int16) - ref.astype(np.int16))
        checked += 1
        print(
            f"{name:18}{diff.max():12}{diff.mean():13.4f}"
            f"{str(np.array_equal(mine, ref)):>11}"
        )

    print(f"\nchecked {checked} cases")


if __name__ == "__main__":
    main()
