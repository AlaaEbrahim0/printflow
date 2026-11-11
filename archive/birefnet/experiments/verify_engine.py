"""Verify the shipped engine reproduces the benchmark numbers.

The experiments established what the engine *should* do. This checks the code that
actually ships does it: same matte as the cached reference, and the tiling win on
the high-resolution stress case.
"""

from __future__ import annotations

import os
import sys
import time

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "worker"))
sys.path.insert(0, os.path.join(ROOT, "worker", "experiments"))

from app.config import Settings  # noqa: E402
from app.engines.birefnet import BirefnetEngine  # noqa: E402
from bench_run import score  # noqa: E402
from tile_probe import big_case  # noqa: E402

CACHE = os.path.join(ROOT, "worker", "experiments", "cache", "birefnet-massive")
REAL = os.path.expanduser("~/Downloads/test")


def settings(**overrides) -> Settings:
    return Settings(
        cutout_model_dir="/tmp/cutout_models",
        cutout_tile_source_px=overrides.pop("window", 1200),
        **overrides,
    )


def check_parity() -> None:
    """Single-tile engine output must match the reference matte."""

    print("=== parity with reference implementation (single pass) ===")
    engine = BirefnetEngine(settings(window=8192))
    print(f"  {engine.describe('birefnet-massive')}")

    name = "+6"
    art = Image.open(os.path.join(REAL, f"{name}.png")).convert("RGBA")
    base = Image.new("RGB", art.size, (255, 255, 255))
    base.paste(art, mask=art.split()[3])

    reference = np.load(os.path.join(CACHE, f"real__{name}.alpha.npy"))
    t0 = time.time()
    result = engine.cutout(base, "birefnet-massive")
    ms = (time.time() - t0) * 1000

    mine = np.array(result.image)[:, :, 3]
    diff = np.abs(mine.astype(np.int16) - reference.astype(np.int16))
    print(f"  tiles={result.tiles} device={result.device} {ms:.0f} ms")
    print(f"  maxAbsDiff={diff.max()} meanAbsDiff={diff.mean():.4f}")
    assert diff.max() <= 2, f"engine diverged from reference by {diff.max()}/255"
    print("  OK\n")


def check_tiling() -> None:
    """Tiling must beat a single pass on high-resolution fine detail."""

    print("=== tiling on a 3600px stress case ===")
    flat, truth = big_case(4)

    single = BirefnetEngine(settings(window=8192))
    t0 = time.time()
    a1 = np.array(single.cutout(flat, "birefnet-massive").image)[:, :, 3]
    s1 = score(a1, truth)
    print(
        f"  single pass  IoU {s1['iou']:.3f} under {s1['under']:.3f} "
        f"over {s1['over']:.3f}  {(time.time()-t0):.0f}s"
    )

    tiled = BirefnetEngine(settings(window=1200))
    t0 = time.time()
    result = tiled.cutout(flat, "birefnet-massive")
    a2 = np.array(result.image)[:, :, 3]
    s2 = score(a2, truth)
    print(
        f"  tiled x{result.tiles:<2}   IoU {s2['iou']:.3f} under {s2['under']:.3f} "
        f"over {s2['over']:.3f}  {(time.time()-t0):.0f}s"
    )
    print(f"  warnings: {[w['code'] for w in result.warnings]}")

    assert s2["iou"] > s1["iou"], "tiling did not improve IoU"
    print("  OK\n")


if __name__ == "__main__":
    check_parity()
    check_tiling()
    print("engine verified")
