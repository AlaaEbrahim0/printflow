#!/usr/bin/env python3
"""Generate realistic Phase 0 fixtures for PrintSheet Workbench.

The fixtures are deliberately awkward: screenshots, full-bleed art, faint
smoke, thin signatures, pale mist, alpha fringes, tall banners and one design
wider than the roll. They are generated rather than committed so the repo stays
small and the inputs stay reproducible.

    python3 scripts/generate_fixtures.py
    python3 scripts/generate_fixtures.py --out /tmp/printsheet-fixtures

Requires Pillow. The generated directory contains images, a manifest.json and
a contact-sheet.png for eyeballing. Everything under fixtures/generated/ is
git-ignored.

The manifest is deterministic: same Pillow version + same seed => same bytes
and hashes. `generatedAt` is fixed on purpose so regenerating does not create a
spurious diff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "fixtures" / "generated"
GENERATED_AT = "2026-11-05T00:00:00Z"
BASE_SEED = 20261105
DPI = 300
ROLL_WIDTH_CM = 58.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def jitter(color: tuple[int, ...], amount: int, rng: random.Random) -> tuple[int, ...]:
    return tuple(max(0, min(255, c + rng.randint(-amount, amount))) for c in color)


def checkerboard(width: int, height: int, cell: int = 16) -> Image.Image:
    image = Image.new("RGB", (width, height), "#d8d8d8")
    draw = ImageDraw.Draw(image)
    for y in range(0, height, cell):
        for x in range(0, width, cell):
            if (x // cell + y // cell) % 2 == 0:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill="#b8b8b8")
    return image


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def px_for_cm(cm: float, dpi: int = DPI) -> int:
    # Matches PrintUnits.PixelsForCentimeters: round half away from zero.
    value = cm * dpi / 2.54
    return int(math.floor(value + 0.5))


def effective_dpi(width_px: int, height_px: int, width_cm: float, height_cm: float) -> float:
    return round(min(width_px / (width_cm / 2.54), height_px / (height_cm / 2.54)), 2)


def fit_thumbnail(image: Image.Image, box: tuple[int, int]) -> Image.Image:
    copy = image.copy()
    copy.thumbnail(box, Image.Resampling.LANCZOS)
    return copy


# ---------------------------------------------------------------------------
# Fixture art
# ---------------------------------------------------------------------------


def make_full_bleed(rng: random.Random) -> Image.Image:
    """All four edges are non-uniform: an auto-trim must not be proposed."""
    w, h = 1800, 1200
    image = Image.new("RGB", (w, h), "#f4e7d3")
    draw = ImageDraw.Draw(image)
    quadrants = [
        ((0, 0, w // 2, h // 2), "#e4572e"),
        ((w // 2, 0, w, h // 2), "#29335c"),
        ((0, h // 2, w // 2, h), "#f3a712"),
        ((w // 2, h // 2, w, h), "#2e8b57"),
    ]
    for box, color in quadrants:
        draw.rectangle(box, fill=color)
    for i in range(60):
        x0 = rng.randint(-100, w + 100)
        y0 = rng.randint(-100, h + 100)
        x1 = x0 + rng.randint(80, 500)
        y1 = y0 + rng.randint(80, 500)
        color = rng.choice(["#ffffff", "#111111", "#ffd166", "#06d6a0", "#ef476f"])
        draw.ellipse([x0, y0, x1, y1], outline=color, width=rng.randint(2, 12))
    for i in range(24):
        x = rng.randint(0, w)
        draw.line([x, 0, x + rng.randint(-300, 300), h], fill="#ffffff", width=rng.randint(1, 5))
    draw.text((40, h - 120), "FULL BLEED COLLAGE", font=font(72), fill="#ffffff")
    draw.text((40, h - 40), "edges are intentionally non-uniform", font=font(28), fill="#111111")
    return image


def make_smoke(rng: random.Random) -> Image.Image:
    """White smoke and faint mist on a near-black background."""
    w, h = 1600, 2000
    image = Image.new("RGB", (w, h), "#050505")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for strand in range(90):
        x = rng.gauss(w / 2, 170)
        y = h - rng.randint(0, 250)
        points = [(x, y)]
        for step in range(rng.randint(20, 55)):
            x += rng.gauss(0, 18)
            y -= rng.randint(12, 34)
            if y < 80:
                break
            points.append((x, y))
        brightness = rng.randint(180, 255)
        alpha = rng.randint(10, 55)
        draw.line(points, fill=(brightness, brightness, brightness, alpha), width=rng.randint(1, 6), joint="curve")
    # A few brighter core wisps so the design has visible structure.
    for strand in range(12):
        x = rng.gauss(w / 2, 120)
        y = h - 150
        points = [(x, y)]
        for _ in range(rng.randint(25, 45)):
            x += rng.gauss(0, 12)
            y -= rng.randint(18, 40)
            points.append((x, y))
        draw.line(points, fill=(240, 240, 240, rng.randint(60, 110)), width=rng.randint(2, 9), joint="curve")
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.text((70, 80), "SMOKE ON BLACK", font=font(64), fill="#d8d8d8")
    draw.text((70, 160), "faint strands must survive background removal", font=font(26), fill="#8a8a8a")
    return image


def make_flat_logo(rng: random.Random) -> Image.Image:
    """Flat multi-color logo with wide, uniform black margins."""
    w, h = 1200, 800
    image = Image.new("RGB", (w, h), "#0a0a0a")
    draw = ImageDraw.Draw(image)
    cx, cy = w // 2, h // 2
    draw.ellipse([cx - 300, cy - 240, cx - 40, cy + 20], fill="#ff7a18")
    draw.polygon([(cx - 20, cy - 260), (cx + 260, cy - 40), (cx + 20, cy + 20)], fill="#16c1b7")
    draw.rounded_rectangle([cx - 250, cy + 70, cx + 300, cy + 210], radius=28, fill="#f4f1de")
    draw.text((cx - 225, cy + 105), "PRINTSHEET", font=font(88), fill="#0a0a0a")
    draw.text((cx - 240, cy + 240), "FLAT LOGO / 3 COLORS", font=font(28), fill="#777777")
    return image


def make_thin_signature(rng: random.Random) -> Image.Image:
    """Thin dark signature on gray; low effective DPI at a large target."""
    w, h = 960, 320
    image = Image.new("RGB", (w, h), "#b8b8b8")
    draw = ImageDraw.Draw(image)
    points = []
    for i in range(220):
        t = i / 219
        x = 70 + t * (w - 140)
        y = h / 2 + 70 * math.sin(t * math.pi * 4.2) * math.exp(-1.2 * t) + 18 * math.sin(t * math.pi * 17)
        points.append((x, y))
    draw.line(points, fill="#202020", width=3, joint="curve")
    draw.line([(80, h - 70), (w - 80, h - 70)], fill="#202020", width=2)
    draw.text((70, 30), "A. Customer", font=font(30), fill="#333333")
    # Slight sensor-like noise so trim tolerance cannot assume a perfect flat fill.
    for _ in range(4000):
        x, y = rng.randrange(w), rng.randrange(h)
        draw.point((x, y), fill=jitter((184, 184, 184), 6, rng))
    return image


def make_pale_mist(rng: random.Random) -> Image.Image:
    """Low-contrast pastel mist on white; aggressive AI cutout would eat it."""
    w, h = 1400, 1000
    image = Image.new("RGB", (w, h), "#ffffff")
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    palette = [(255, 214, 224), (214, 236, 255), (226, 255, 214), (255, 243, 214), (230, 214, 255)]
    for _ in range(38):
        x = rng.randint(160, w - 160)
        y = rng.randint(140, h - 140)
        rx = rng.randint(90, 320)
        ry = rng.randint(70, 260)
        color = rng.choice(palette)
        draw.ellipse([x - rx, y - ry, x + rx, y + ry], fill=(*color, rng.randint(18, 48)))
    overlay = overlay.filter(ImageFilter.GaussianBlur(14))
    image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    draw = ImageDraw.Draw(image)
    draw.text((80, h - 110), "pale mist / handle with care", font=font(34), fill="#9a8f96")
    return image


def make_sticker_fringe(rng: random.Random) -> Image.Image:
    """Transparent sticker with a white halo/fringe around a dark shape."""
    w, h = 1000, 1000
    image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    cx, cy = w // 2, h // 2
    # Soft shadow-like halo, then an opaque white fringe ring, then artwork.
    draw.ellipse([cx - 410, cy - 410, cx + 410, cy + 410], fill=(255, 255, 255, 26))
    draw.ellipse([cx - 380, cy - 380, cx + 380, cy + 380], fill=(255, 255, 255, 255))
    draw.ellipse([cx - 350, cy - 350, cx + 350, cy + 350], fill="#18206f")
    draw.ellipse([cx - 320, cy - 320, cx + 320, cy + 320], outline="#f4d35e", width=18)
    draw.polygon([(cx, cy - 230), (cx + 210, cy + 150), (cx - 210, cy + 150)], fill="#ee964b")
    draw.text((cx - 150, cy + 190), "STICKER", font=font(56), fill="#ffffff")
    # A few semi-transparent speckles just outside the white ring: classic fringe.
    for _ in range(180):
        angle = rng.uniform(0, math.tau)
        radius = rng.randint(382, 420)
        x = cx + radius * math.cos(angle)
        y = cy + radius * math.sin(angle)
        draw.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(255, 255, 255, rng.randint(20, 120)))
    return image


def make_tall_banner(rng: random.Random) -> Image.Image:
    """Tall transparent banner; must be rotated or packed vertically."""
    w, h = 600, 2400
    image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([50, 50, w - 50, h - 50], radius=40, fill="#0f4c5c")
    for i in range(12):
        y = 200 + i * 170
        draw.line([(90, y), (w - 90, y - 90)], fill="#e36414", width=10)
    draw.text((95, 120), "TALL", font=font(110), fill="#f4f1de")
    draw.text((95, 240), "BANNER", font=font(110), fill="#f4f1de")
    draw.text((95, h - 220), "2400 px", font=font(58), fill="#9ab8c2")
    draw.text((95, h - 140), "rotate me", font=font(58), fill="#9ab8c2")
    return image


def make_overwide(rng: random.Random) -> Image.Image:
    """Native width is 8000 px = 67.7 cm at 300 DPI, wider than the 58 cm roll."""
    w, h = 8000, 400
    image = Image.new("RGB", (w, h), "#101820")
    draw = ImageDraw.Draw(image)
    for i in range(14):
        x = 60 + i * 560
        draw.rounded_rectangle([x, 70, x + 480, h - 70], radius=24, fill="#f2aa4c")
        draw.text((x + 40, 130), f"OVERWIDE {i + 1}", font=font(58), fill="#101820")
    for x in range(0, w, 80):
        draw.line([(x, 0), (x, h)], fill="#1c2b36", width=2)
    draw.text((60, 10), "8000 px = 67.7 cm at 300 DPI", font=font(42), fill="#ffffff")
    return image


def make_lowres_screenshot(rng: random.Random) -> Image.Image:
    """A tiny, noisy JPEG resembling a customer phone screenshot."""
    w, h = 360, 240
    image = Image.new("RGB", (w, h), "#f2f2f2")
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, w, 34], fill="#3a506b")
    draw.text((10, 8), "Shop App", font=font(16), fill="#ffffff")
    for i in range(4):
        x = 8 + i * 88
        draw.rectangle([x, 48, x + 78, 170], fill="#ffffff", outline="#c9c9c9")
        draw.rectangle([x + 6, 56, x + 72, 112], fill=rng.choice(["#d1495b", "#00798c", "#edae49", "#66a182"]))
        draw.rectangle([x + 10, 124, x + 66, 134], fill="#666666")
        draw.rectangle([x + 10, 140, x + 52, 148], fill="#999999")
    # Sensor/JPEG-friendly noise before the labels, so the text stays legible.
    for _ in range(5000):
        x, y = rng.randrange(w), rng.randrange(h)
        draw.point((x, y), fill=jitter((120, 120, 120), 26, rng))
    draw.text((10, 190), "SALE -30% TODAY", font=font(26), fill="#222222")
    draw.text((10, 218), "blurry screenshot / quality 28", font=font(13), fill="#555555")
    return image


def make_vector_logo(rng: random.Random) -> Image.Image:
    """Flat two/three-color shape on transparency, a strong vectorize candidate."""
    w, h = 2000, 2000
    image = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    cx, cy = w // 2, h // 2
    draw.polygon(
        [
            (cx, cy - 760),
            (cx + 620, cy - 300),
            (cx + 420, cy + 640),
            (cx - 420, cy + 640),
            (cx - 620, cy - 300),
        ],
        fill="#0b3d91",
    )
    draw.polygon(
        [
            (cx, cy - 620),
            (cx + 470, cy - 270),
            (cx + 310, cy + 480),
            (cx - 310, cy + 480),
            (cx - 470, cy - 270),
        ],
        fill="#ffffff",
    )
    draw.polygon([(cx - 60, cy - 300), (cx + 210, cy + 120), (cx + 30, cy + 120), (cx + 120, cy + 430), (cx - 180, cy - 40), (cx - 10, cy - 40)], fill="#e63946")
    draw.rectangle([cx - 300, cy + 520, cx + 300, cy + 570], fill="#0b3d91")
    return image


# ---------------------------------------------------------------------------
# Fixture specs
# ---------------------------------------------------------------------------


@dataclass
class Fixture:
    name: str
    file_name: str
    factory: object
    target_width_cm: float | None
    target_height_cm: float | None
    expect: dict = field(default_factory=dict)
    notes: str = ""
    jpeg_quality: int | None = None


FIXTURES: list[Fixture] = [
    Fixture(
        name="Full-bleed collage",
        file_name="full-bleed-collage.png",
        factory=make_full_bleed,
        target_width_cm=30.0,
        target_height_cm=20.0,
        expect={
            "autoTrim": False,
            "fullBleed": True,
            "backgroundMode": "none",
            "vectorize": "not-recommended",
            "upscale": "none",
            "exceedsRoll": False,
        },
        notes="All four edges are non-uniform. No auto-trim proposal is allowed.",
    ),
    Fixture(
        name="White smoke on black",
        file_name="white-smoke-on-black.png",
        factory=make_smoke,
        target_width_cm=20.0,
        target_height_cm=25.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "color-to-alpha",
            "backgroundKey": "#050505",
            "vectorize": "not-recommended",
            "upscale": "2x",
            "exceedsRoll": False,
        },
        notes="Faint strands and mist. AI cutout may erase them; check alpha fringe.",
    ),
    Fixture(
        name="Flat logo on black",
        file_name="flat-logo-black-margin.png",
        factory=make_flat_logo,
        target_width_cm=24.0,
        target_height_cm=16.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "color-to-alpha",
            "backgroundKey": "#0A0A0A",
            "vectorize": "recommended",
            "upscale": "none",
            "exceedsRoll": False,
        },
        notes="Wide uniform margins; three flat colors; good vectorize candidate.",
    ),
    Fixture(
        name="Thin signature on gray",
        file_name="thin-signature-gray.png",
        factory=make_thin_signature,
        target_width_cm=26.0,
        target_height_cm=8.7,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "color-to-alpha",
            "backgroundKey": "#B8B8B8",
            "vectorize": "optional",
            "upscale": "4x",
            "lowDpi": True,
            "exceedsRoll": False,
        },
        notes="~94 DPI at target width; thin 3 px strokes must survive upscale.",
    ),
    Fixture(
        name="Pale mist on white",
        file_name="pale-mist-white.png",
        factory=make_pale_mist,
        target_width_cm=18.0,
        target_height_cm=13.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "color-to-alpha",
            "backgroundKey": "#FFFFFF",
            "vectorize": "not-recommended",
            "upscale": "none",
            "lowContrast": True,
            "exceedsRoll": False,
        },
        notes="Very low contrast. Aggressive removal would destroy the art; inspect previews.",
    ),
    Fixture(
        name="Sticker with fringe",
        file_name="sticker-fringe.png",
        factory=make_sticker_fringe,
        target_width_cm=12.0,
        target_height_cm=12.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "none",
            "vectorize": "optional",
            "upscale": "none",
            "hasAlpha": True,
            "exceedsRoll": False,
        },
        notes="White halo and semi-transparent speckles; checkerboard/black/white previews matter.",
    ),
    Fixture(
        name="Tall banner",
        file_name="tall-banner.png",
        factory=make_tall_banner,
        target_width_cm=10.0,
        target_height_cm=40.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "none",
            "vectorize": "not-recommended",
            "upscale": "none",
            "hasAlpha": True,
            "exceedsRoll": False,
        },
        notes="Tall transparent banner; tests 90-degree rotation and tall sheet rendering.",
    ),
    Fixture(
        name="Overwide banner",
        file_name="overwide-banner.png",
        factory=make_overwide,
        target_width_cm=67.73,
        target_height_cm=3.39,
        expect={
            "autoTrim": False,
            "fullBleed": True,
            "backgroundMode": "none",
            "vectorize": "not-recommended",
            "upscale": "none",
            "exceedsRoll": True,
        },
        notes="Native 8000 px = 67.7 cm at 300 DPI. Must be explicitly scaled or excluded.",
    ),
    Fixture(
        name="Low-res phone screenshot",
        file_name="lowres-screenshot.jpg",
        factory=make_lowres_screenshot,
        target_width_cm=10.0,
        target_height_cm=6.7,
        jpeg_quality=28,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "color-to-alpha",
            "backgroundKey": "#F2F2F2",
            "vectorize": "not-recommended",
            "upscale": "4x",
            "lowDpi": True,
            "jpegArtifacts": True,
            "exceedsRoll": False,
        },
        notes="360 x 240 JPEG at quality 28: blur, block artifacts, ~91 DPI at target.",
    ),
    Fixture(
        name="Flat vector logo",
        file_name="flat-vector-logo.png",
        factory=make_vector_logo,
        target_width_cm=25.0,
        target_height_cm=25.0,
        expect={
            "autoTrim": True,
            "fullBleed": False,
            "backgroundMode": "none",
            "vectorize": "recommended",
            "upscale": "none",
            "hasAlpha": True,
            "exceedsRoll": False,
        },
        notes="Flat 2000 px shield on transparency; vectorize should be a one-click win.",
    ),
]


# ---------------------------------------------------------------------------
# Manifest / contact sheet
# ---------------------------------------------------------------------------


def build_contact_sheet(entries: list[dict], out_path: Path) -> None:
    columns = 5
    cell_w, cell_h = 330, 280
    rows = math.ceil(len(entries) / columns)
    sheet = Image.new("RGB", (columns * cell_w, rows * cell_h + 60), "#20242b")
    draw = ImageDraw.Draw(sheet)
    draw.text((16, 16), "PrintSheet Phase 0 fixtures", font=font(30), fill="#f4f1de")
    for index, entry in enumerate(entries):
        image = Image.open(out_path.parent / entry["file"]).convert("RGBA")
        thumb = fit_thumbnail(image, (cell_w - 30, cell_h - 70))
        x = (index % columns) * cell_w + (cell_w - thumb.width) // 2
        y = (index // columns) * cell_h + 50 + (cell_h - 70 - thumb.height) // 2
        board = checkerboard(thumb.width, thumb.height, 12)
        board.paste(thumb, (0, 0), thumb)
        sheet.paste(board, (x, y))
        label = entry["file"].rsplit("/", 1)[-1]
        draw.text(
            ((index % columns) * cell_w + 14, (index // columns) * cell_h + cell_h - 18),
            label[:46],
            font=font(13),
            fill="#c9d1d9",
        )
    sheet.save(out_path, format="PNG")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--clean", action="store_true", help="delete the output directory first")
    args = parser.parse_args()

    out = args.out.resolve()
    if args.clean and out.exists():
        shutil.rmtree(out)
    images_dir = out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    for index, fixture in enumerate(FIXTURES):
        rng = random.Random(BASE_SEED + index * 7919)
        image = fixture.factory(rng)  # type: ignore[operator]
        path = images_dir / fixture.file_name
        if fixture.jpeg_quality is not None:
            image.convert("RGB").save(path, format="JPEG", quality=fixture.jpeg_quality, subsampling=2)
        else:
            image.save(path, format="PNG", optimize=True)

        opened = Image.open(path)
        width_px, height_px = opened.size
        has_alpha = opened.mode in ("RGBA", "LA") or "transparency" in opened.info
        width_cm = fixture.target_width_cm
        height_cm = fixture.target_height_cm
        dpi_at_target = (
            effective_dpi(width_px, height_px, width_cm, height_cm)
            if width_cm and height_cm
            else None
        )
        exceeds_roll = bool(width_cm and width_cm > ROLL_WIDTH_CM)
        expect = dict(fixture.expect)
        if dpi_at_target is not None:
            expect["effectiveDpiAtTarget"] = dpi_at_target
            expect.setdefault("lowDpi", dpi_at_target < 150)
            expect.setdefault("strongLowDpi", dpi_at_target < 100)
        expect["exceedsRoll"] = exceeds_roll

        entries.append(
            {
                "name": fixture.name,
                "file": f"images/{fixture.file_name}",
                "format": opened.format,
                "widthPx": width_px,
                "heightPx": height_px,
                "hasAlpha": has_alpha,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "targetWidthCm": width_cm,
                "targetHeightCm": height_cm,
                "expect": expect,
                "notes": fixture.notes,
            }
        )

    manifest = {
        "schemaVersion": "1.0",
        "generatedAt": GENERATED_AT,
        "generator": "scripts/generate_fixtures.py",
        "seed": BASE_SEED,
        "batch": {
            "name": "Phase 0 demo batch",
            "rollWidthCm": ROLL_WIDTH_CM,
            "marginMm": 30,
            "edgeMarginMm": 0,
            "workingDpi": DPI,
            "designCount": len(entries),
        },
        "contactSheet": "contact-sheet.png",
        "designs": entries,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    build_contact_sheet(entries, out / "contact-sheet.png")

    total_bytes = sum(entry["bytes"] for entry in entries)
    print(f"Wrote {len(entries)} fixtures to {out}")
    print(f"Images: {total_bytes / 1024 / 1024:.1f} MiB; manifest: {manifest_path}")
    print(f"Contact sheet: {out / 'contact-sheet.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
