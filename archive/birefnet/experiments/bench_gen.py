"""Benchmark generator for the *target* cutout class.

The user's scope is deliberately narrow: logos, simple illustrations, text and
black-and-white designs. Those have a uniform background, flat or few-colour
artwork, and sharp-to-anti-aliased edges. This module synthesises that class with
exact ground-truth alpha so a cutout algorithm can be measured honestly instead
of tuned against anime artwork (which is the hard class and already cut out).

Each case is drawn as RGBA on a transparent canvas, then flattened onto a solid
background. The alpha before flattening is the ground truth.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFont

CANVAS = 900


@dataclass(frozen=True)
class Case:
    name: str
    artwork: Image.Image  # RGBA, transparent background
    background: tuple[int, int, int]
    note: str = ""


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _badge_logo() -> Image.Image:
    """Flat vector-style badge: ring, inner disc, chevrons. Sharp curves."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = CANVAS // 2
    d.ellipse((cx - 300, cy - 300, cx + 300, cy + 300), fill=(28, 32, 58, 255))
    d.ellipse((cx - 250, cy - 250, cx + 250, cy + 250), fill=(240, 166, 32, 255))
    d.ellipse((cx - 190, cy - 190, cx + 190, cy + 190), fill=(28, 32, 58, 255))
    # Sharp chevrons with thin strokes.
    for offset in (-70, 0, 70):
        d.line(
            [(cx - 120, cy + offset - 40), (cx, cy + offset + 20), (cx + 120, cy + offset - 40)],
            fill=(240, 240, 240, 255),
            width=22,
            joint="curve",
        )
    return img


def _wordmark() -> Image.Image:
    """Thick lettering with counters (o, e, R, a, D) - the interior-hole test."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((70, 300), "BOLDR", font=_font(190), fill=(20, 20, 20, 255))
    d.text((70, 470), "GEAR co.", font=_font(110), fill=(200, 30, 40, 255))
    return img


def _thin_text() -> Image.Image:
    """Small thin type - the anti-aliasing stress case."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    y = 200
    for line in ("PRECISION CUT", "SINCE 1998", "300 DPI READY", "NO HALO"):
        d.text((80, y), line, font=_font(64), fill=(15, 15, 15, 255))
        y += 110
    return img


def _black_on_white_ink() -> Image.Image:
    """Black ink illustration: silhouette with fine detail and sharp points."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Mountain/tree silhouette - many sharp vertices and concave notches.
    pts = [(60, 820)]
    x = 60
    rng = np.random.default_rng(7)
    while x < 840:
        step = int(rng.integers(40, 90))
        peak = int(rng.integers(300, 760))
        pts.append((x + step // 2, peak))
        pts.append((min(x + step, 840), 820))
        x += step
    d.polygon(pts, fill=(10, 10, 10, 255))
    return img


def _flat_illustration() -> Image.Image:
    """Simple flat illustration: a few solid shapes, one over another."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((150, 250, 750, 700), radius=60, fill=(38, 120, 190, 255))
    d.ellipse((260, 330, 470, 540), fill=(250, 220, 60, 255))
    d.polygon([(520, 620), (700, 340), (700, 620)], fill=(230, 80, 70, 255))
    d.rectangle((300, 590, 640, 630), fill=(255, 255, 255, 255))
    return img


def _white_artwork() -> Image.Image:
    """White artwork on white background - the degenerate worst case."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((200, 200, 700, 700), fill=(255, 255, 255, 255))
    d.text((330, 400), "WHITE", font=_font(90), fill=(255, 255, 255, 255))
    return img


def _border_touching() -> Image.Image:
    """Artwork bleeding to the edge - must not be flood-filled away."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 300, CANVAS, 600), fill=(120, 40, 160, 255))
    d.text((60, 390), "EDGE BLEED", font=_font(110), fill=(255, 255, 255, 255))
    return img


def _thin_strokes() -> Image.Image:
    """Hairline strokes: 2-3 px features that must survive downscaling."""
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(24):
        y = 120 + i * 28
        d.line([(100, y), (800, y)], fill=(30, 30, 30, 255), width=2)
    d.ellipse((380, 380, 520, 520), outline=(30, 30, 30, 255), width=3)
    return img


def build_cases() -> list[Case]:
    """Every case, flattened onto the backgrounds that actually occur in intake."""

    specs: list[tuple[str, Image.Image, tuple[int, int, int], str]] = [
        ("badge-logo-on-white", _badge_logo(), (255, 255, 255), "flat vector badge"),
        ("wordmark-on-white", _wordmark(), (255, 255, 255), "thick type, counters"),
        ("thin-text-on-white", _thin_text(), (255, 255, 255), "anti-aliasing stress"),
        ("ink-on-white", _black_on_white_ink(), (255, 255, 255), "sharp concave points"),
        ("flat-illustration-on-white", _flat_illustration(), (255, 255, 255), "few flat colours"),
        ("badge-logo-on-black", _badge_logo(), (0, 0, 0), "dark background"),
        ("wordmark-on-grey", _wordmark(), (128, 128, 128), "mid grey background"),
        ("white-art-on-white", _white_artwork(), (255, 255, 255), "degenerate: no contrast"),
        ("edge-bleed-on-white", _border_touching(), (255, 255, 255), "touches border"),
        ("hairlines-on-white", _thin_strokes(), (255, 255, 255), "2-3 px strokes"),
        ("wordmark-on-cream", _wordmark(), (247, 240, 226), "off-white paper"),
    ]

    cases: list[Case] = []
    for name, art, bg, note in specs:
        cases.append(Case(name=name, artwork=art, background=bg, note=note))
    return cases


def flatten(art: Image.Image, background: tuple[int, int, int]) -> Image.Image:
    """Composite RGBA artwork onto a solid colour, exactly as a JPEG/PNG would arrive."""

    base = Image.new("RGB", art.size, background)
    base.paste(art, mask=art.split()[3])
    return base


if __name__ == "__main__":
    out = "worker/experiments/bench"
    import os

    os.makedirs(out, exist_ok=True)
    for case in build_cases():
        flat = flatten(case.artwork, case.background)
        flat.save(f"{out}/{case.name}.png")
        case.artwork.save(f"{out}/{case.name}.truth.png")
        print(f"{case.name:32} bg={case.background} {case.note}")
    print(f"\nwrote {len(build_cases()) * 2} files to {out}/")
