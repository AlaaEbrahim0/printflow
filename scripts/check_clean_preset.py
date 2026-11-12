#!/usr/bin/env python3
"""Check that the one-click Clean preset only offers itself where it works.

Clean is a promise: "this design's background is a flat colour I can key out".
The web app offers it from the classifier's `sampledBackground` confidence. This
script asks whether that promise holds on the fixture artwork, by running the
worker's own `sample_background` and `background_matches` — the same code the
real job runs — and scoring the result against a ground truth that does not
depend on the sampled colour:

* border pixels are background by construction (the generator draws them from
  the background layer), so any border pixel the key leaves behind is a miss;
* pixels whose per-channel distance from the border median exceeds 60 are
  artwork, so any of those the key removes is damage.

Usage:

    python3 scripts/check_clean_preset.py
    python3 scripts/check_clean_preset.py --out /tmp/printsheet-fixtures

Exit code is 1 if any design is offered Clean and then fails, so this can gate a
change to the confidence threshold. Regenerate fixtures first
(`python3 scripts/generate_fixtures.py`) if the directory is missing.

Requires the worker virtualenv (numpy + Pillow):
    worker/.venv/bin/python scripts/check_clean_preset.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "worker"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from app.analysis import background_matches, sample_background, to_arrays  # noqa: E402
from app.config import Settings  # noqa: E402

# Mirrors CLEAN_MIN_CONFIDENCE / CLEAN_TOLERANCE in
# web/src/routes/DesignReviewPage.tsx. Keep the three in step: this script is the
# evidence for those numbers.
MIN_CONFIDENCE = 0.7
TOLERANCE = 24
ARTWORK_DISTANCE = 60
BORDER_BAND_DIVISOR = 50


def tolerance_for(confidence: float) -> int:
    """Tolerance is fixed; confidence only decides whether Clean is offered."""
    del confidence
    return TOLERANCE


def evaluate(path: Path, settings: Settings) -> dict[str, object]:
    arrays = to_arrays(Image.open(path).convert("RGBA"))
    sample = sample_background(arrays, settings)
    confidence = float(sample.confidence or 0.0)

    if sample.kind == "transparent" or not sample.hex:
        return {"offered": False, "reason": "transparent background", "sample": sample}
    if confidence < MIN_CONFIDENCE:
        return {"offered": False, "reason": f"border uniform only {confidence:.0%}", "sample": sample}

    tolerance = tolerance_for(confidence)
    matched = background_matches(
        arrays, sample, tolerance=tolerance, alpha_threshold=settings.alpha_threshold
    )

    height, width = arrays.height, arrays.width
    band = max(1, min(width, height) // BORDER_BAND_DIVISOR)
    border = np.zeros((height, width), bool)
    border[:band, :] = border[-band:, :] = True
    border[:, :band] = border[:, -band:] = True
    opaque = arrays.alpha > 0
    border_px = border & opaque

    if border_px.any():
        median = np.median(arrays.rgb[border_px], axis=0)
        distance = np.max(np.abs(arrays.rgb.astype(np.int16) - median.astype(np.int16)), axis=2)
    else:
        distance = np.zeros((height, width), dtype=np.int16)
    artwork = opaque & (distance > ARTWORK_DISTANCE)

    background_left = float((~matched[border_px]).mean()) if border_px.any() else 0.0
    artwork_lost = float(matched[artwork].mean()) if artwork.any() else 0.0
    return {
        "offered": True,
        "sample": sample,
        "tolerance": tolerance,
        "backgroundLeft": background_left,
        "artworkLost": artwork_lost,
        "pass": background_left <= 0.02 and artwork_lost <= 0.02,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=REPO / "fixtures" / "generated",
        help="Generated fixture directory (default: fixtures/generated)",
    )
    args = parser.parse_args()

    manifest_path = args.out / "manifest.json"
    if not manifest_path.exists():
        print(f"No manifest at {manifest_path}. Run scripts/generate_fixtures.py first.")
        return 2

    manifest = json.loads(manifest_path.read_text())
    settings = Settings()
    failures: list[str] = []

    print(f"{'design':26} {'confidence':>10} {'tol':>4} {'bg left':>8} {'art lost':>9}  verdict")
    print("-" * 78)
    for design in manifest["designs"]:
        result = evaluate(args.out / design["file"], settings)
        sample = result["sample"]
        if not result["offered"]:
            print(
                f"{design['name'][:26]:26} {float(sample.confidence or 0):>9.0%} "
                f"{'-':>4} {'-':>8} {'-':>9}  not offered ({result['reason']})"
            )
            continue
        verdict = "PASS" if result["pass"] else "FAIL"
        if not result["pass"]:
            failures.append(design["name"])
        print(
            f"{design['name'][:26]:26} {float(sample.confidence or 0):>9.0%} "
            f"{result['tolerance']:>4} {result['backgroundLeft']:>7.1%} "
            f"{result['artworkLost']:>8.1%}  {verdict}"
        )

    print()
    if failures:
        print(f"{len(failures)} design(s) offered Clean but failed: {', '.join(failures)}")
        return 1
    print("Every design offered Clean keyed its background out without eating artwork.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
