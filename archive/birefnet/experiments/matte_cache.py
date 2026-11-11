"""Cache raw model mattes so refinement can be iterated without re-running inference.

BiRefNet-massive takes ~30 s per image on CPU. Scoring ten refinement ideas would
mean ten full re-runs, so inference happens once here and every alpha is written to
``cache/<model>/<case>.npy``. Refinement experiments then load the cache.

Two corpora:

* ``bench/`` -- synthetic logos, wordmarks, thin type, ink art, flat illustration,
  each with exact ground-truth alpha.
* ``~/Downloads/test`` -- the shop's real artwork, which already carries alpha.
  Flattening it onto white and re-deriving the cutout gives a real-world score.
"""

from __future__ import annotations

import glob
import os
import sys
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(__file__)
BENCH = os.path.join(HERE, "bench")
REAL = os.path.expanduser("~/Downloads/test")
CACHE = os.path.join(HERE, "cache")


def flatten(art: Image.Image, background=(255, 255, 255)) -> Image.Image:
    base = Image.new("RGB", art.size, background)
    base.paste(art, mask=art.split()[3])
    return base


def cases() -> list[tuple[str, str, tuple[int, int, int]]]:
    """(corpus, name, background) for everything we can score."""
    out: list[tuple[str, str, tuple[int, int, int]]] = []
    for p in sorted(glob.glob(os.path.join(BENCH, "*.png"))):
        if ".truth." in p:
            continue
        out.append(("bench", os.path.basename(p)[:-4], (255, 255, 255)))
    # The bench generator flattens onto its declared background; recover it.
    sys.path.insert(0, HERE)
    from bench_gen import build_cases  # noqa: E402

    bg = {c.name: c.background for c in build_cases()}
    out = [(c, n, bg.get(n, b)) for c, n, b in out]

    for p in sorted(glob.glob(os.path.join(REAL, "*.png"))):
        out.append(("real", os.path.basename(p)[:-4], (255, 255, 255)))
    return out


def load_case(corpus: str, name: str, background) -> tuple[Image.Image, np.ndarray]:
    if corpus == "bench":
        flat = Image.open(os.path.join(BENCH, f"{name}.png")).convert("RGB")
        truth = np.array(Image.open(os.path.join(BENCH, f"{name}.truth.png")).convert("RGBA"))[:, :, 3]
        return flat, truth
    art = Image.open(os.path.join(REAL, f"{name}.png")).convert("RGBA")
    return flatten(art, background), np.array(art)[:, :, 3]


def main() -> None:
    model = sys.argv[1] if len(sys.argv) > 1 else "birefnet-massive"
    only = sys.argv[2] if len(sys.argv) > 2 else None

    from rembg import new_session, remove

    out_dir = os.path.join(CACHE, model)
    os.makedirs(out_dir, exist_ok=True)

    print(f"loading {model} ...", flush=True)
    t0 = time.time()
    session = new_session(model)
    print(f"session ready in {time.time()-t0:.1f}s\n", flush=True)

    for corpus, name, background in cases():
        if only and only not in name:
            continue
        tag = f"{corpus}__{name}"
        alpha_path = os.path.join(out_dir, f"{tag}.alpha.npy")
        truth_path = os.path.join(out_dir, f"{tag}.truth.npy")
        if os.path.exists(alpha_path) and os.path.exists(truth_path):
            print(f"  skip {tag}")
            continue

        flat, truth = load_case(corpus, name, background)
        t1 = time.time()
        out = remove(flat, session=session, post_process_mask=False)
        ms = (time.time() - t1) * 1000

        alpha = np.array(out.convert("RGBA"))[:, :, 3]
        np.save(alpha_path, alpha)
        np.save(truth_path, truth)
        print(f"  {tag:40} {flat.size[0]:5}x{flat.size[1]:<5} {ms:7.0f} ms", flush=True)


if __name__ == "__main__":
    main()
