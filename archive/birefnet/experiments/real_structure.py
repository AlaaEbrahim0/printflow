"""Why do the shop's own files score badly? Check whether their alpha is even a cutout.

If a file's ground-truth alpha is "nearly everything opaque with transparent
margins", it is a full-bleed illustration that was trimmed, not a subject cut out
of a background. Scoring a segmentation model against that measures the wrong
thing, so this prints the alpha structure before any conclusion is drawn.
"""

from __future__ import annotations

import glob
import os

import numpy as np
from PIL import Image

REAL = os.path.expanduser("~/Downloads/test")

print(f"{'file':16}{'size':>12}{'opaque%':>9}{'clear%':>8}{'largestBlob%':>13}{'verdict'}")
print("-" * 78)
for p in sorted(glob.glob(os.path.join(REAL, "*.png"))):
    art = Image.open(p).convert("RGBA")
    a = np.array(art)[:, :, 3]
    opaque = (a > 127).mean()
    clear = (a <= 8).mean()
    # Is the opaque region one connected mass (full-bleed) or scattered subjects?
    import cv2

    n, lab, stats, _ = cv2.connectedComponentsWithStats((a > 127).astype(np.uint8), connectivity=8)
    largest = max((stats[i, cv2.CC_STAT_AREA] for i in range(1, n)), default=0) / a.size
    if opaque > 0.7 and largest > 0.55:
        verdict = "full-bleed / trimmed, NOT a cutout"
    elif opaque > 0.7:
        verdict = "mostly opaque"
    else:
        verdict = "subject cutout"
    print(
        f"{os.path.basename(p):16}{art.size[0]:5}x{art.size[1]:<6}{opaque*100:8.1f}%"
        f"{clear*100:7.1f}%{largest*100:12.1f}%  {verdict}"
    )
