"""Does upscaling the input before segmentation actually improve the cutout?

The working hypothesis is that a 4x-upscaled design gives the model "more pixels,
more data, more accuracy". Most salient-object models normalise their input to a
fixed square (u2net: 320x320) before inference, so the pixels you feed in are
thrown away by a bilinear resize -- the upscale should be a no-op apart from the
cost. This measures it rather than assuming.
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
CASES = ["thin-text-on-white", "hairlines-on-white", "wordmark-on-white", "ink-on-white"]


def main() -> None:
    from rembg import new_session, remove

    session = new_session("u2net")
    print(f"{'case':26}{'scale':>7}{'IoU':>8}{'under':>8}{'over':>8}{'ms':>7}")
    for name in CASES:
        p = os.path.join(BENCH, f"{name}.png")
        rgb = np.array(Image.open(p).convert("RGB"))
        truth = np.array(Image.open(os.path.join(BENCH, f"{name}.truth.png")).convert("RGBA"))[:, :, 3]
        for scale in (1, 2, 4):
            img = Image.fromarray(rgb)
            if scale > 1:
                img = img.resize((rgb.shape[1] * scale, rgb.shape[0] * scale), Image.LANCZOS)
            t0 = time.time()
            out = remove(img, session=session, post_process_mask=False)
            ms = (time.time() - t0) * 1000
            pred = np.array(out.convert("RGBA").resize((rgb.shape[1], rgb.shape[0]), Image.NEAREST))[:, :, 3]
            s = score(pred, truth)
            print(f"{name:26}{scale:>7}{s['iou']:8.3f}{s['under']:8.3f}{s['over']:8.3f}{ms:7.0f}")


if __name__ == "__main__":
    main()
