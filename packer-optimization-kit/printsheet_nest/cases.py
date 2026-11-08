"""Benchmark cases: deterministic, self-contained, and reproducible.

A *case* is a fixed set of PNG files plus the sheet geometry they must satisfy.
Cases are generated once into a directory and then reused, so every solver is
judged on byte-identical inputs.

Two families are provided:

``synthetic-*``
    Elliptical blobs with soft edges and occasional holes. They reward
    interlocking and give a smooth difficulty ramp by count.

``shop-*``
    Real approved artwork copied from the repository fixtures. These are the
    shapes the packer actually sees: a flat vector logo (large dead area), a
    thin signature (long and skinny), a collage (rectangular, no alpha), a pale
    smoke plume (faint alpha above the threshold), and a tall banner.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from printsheet_nest.types import Case, DesignSpec, PackParams

# ----------------------------------------------------------------------
# fixture geometry
# ----------------------------------------------------------------------

DEFAULT_PARAMS = PackParams(
    roll_width_cm=58.0,
    dpi=300,
    margin_mm=30.0,
    edge_margin_mm=10.0,
    alpha_threshold=5,
    seed=20261105,
    time_budget_ms=60_000,
)

# name -> (source fixture, print width cm, print height cm)
SHOP_DESIGNS: dict[str, tuple[str, float, float]] = {
    "flat-vector-logo": ("flat-vector-logo.png", 22.0, 22.0),
    "thin-signature": ("thin-signature-gray.png", 20.0, 6.0),
    "full-bleed-collage": ("full-bleed-collage.png", 30.0, 20.0),
    "pale-mist": ("pale-mist-white.png", 18.0, 14.0),
    "tall-banner": ("tall-banner.png", 10.0, 26.0),
    "overwide-banner": ("overwide-banner.png", 54.0, 12.0),
    "sticker-fringe": ("sticker-fringe.png", 16.0, 16.0),
    "flat-logo-margin": ("flat-logo-black-margin.png", 20.0, 20.0),
    "white-smoke": ("white-smoke-on-black.png", 18.0, 18.0),
    "lowres-screenshot": ("lowres-screenshot.jpg", 12.0, 8.0),
}


def _fit(image: Image.Image, width_cm: float, height_cm: float, dpi: int) -> Image.Image:
    """Resample once at case-build time so the solver sees final-size pixels.

    The solver itself never resamples; this only prepares the input file, which
    is exactly what the production intake does when the operator supplies a
    target size.
    """
    target_w = int(round(width_cm / 2.54 * dpi))
    target_h = int(round(height_cm / 2.54 * dpi))
    if image.size == (target_w, target_h):
        return image
    scale = min(target_w / image.width, target_h / image.height)
    size = (max(1, int(round(image.width * scale))), max(1, int(round(image.height * scale))))
    return image.resize(size, Image.Resampling.LANCZOS)


def _synthetic(
    rng: np.random.Generator, index: int, max_side_cm: float, dpi: int
) -> Image.Image:
    width_cm = float(rng.uniform(6.0, max_side_cm))
    height_cm = float(rng.uniform(6.0, max_side_cm))
    width = int(round(width_cm / 2.54 * dpi))
    height = int(round(height_cm / 2.54 * dpi))
    ys, xs = np.mgrid[0:height, 0:width]
    radius = ((xs - width / 2) / (width * 0.46)) ** 2 + ((ys - height / 2) / (height * 0.46)) ** 2
    alpha = np.clip((1.0 - radius) * 320, 0, 255).astype(np.uint8)
    if rng.random() < 0.35:
        alpha[radius < 0.18] = 0
    palette = [(190, 40, 40), (30, 160, 60), (40, 80, 200), (200, 160, 30), (120, 60, 180)]
    red, green, blue = palette[index % len(palette)]
    array = np.dstack(
        [
            np.full((height, width), red, np.uint8),
            np.full((height, width), green, np.uint8),
            np.full((height, width), blue, np.uint8),
            alpha,
        ]
    )
    return Image.fromarray(array, "RGBA")


def build_case(
    name: str,
    designs: list[tuple[str, Image.Image]],
    params: PackParams,
    directory: Path,
) -> Case:
    """Write the design files under ``directory`` and return the case."""
    directory.mkdir(parents=True, exist_ok=True)
    specs: list[DesignSpec] = []
    files: dict[str, str] = {}
    for design_id, image in designs:
        path = directory / f"{design_id}.png"
        image.save(path, "PNG", compress_level=1)
        specs.append(
            DesignSpec(
                design_id=design_id,
                file_path=str(path),
                width_px=image.width,
                height_px=image.height,
                allow_rotation=True,
                display_name=design_id,
            )
        )
        files[design_id] = str(path)
    return Case(name=name, params=params, designs=tuple(specs), files=files)


def synthetic_case(
    count: int,
    directory: Path,
    params: PackParams | None = None,
    max_side_cm: float = 28.0,
) -> Case:
    params = params or DEFAULT_PARAMS
    rng = np.random.default_rng(params.seed + count)
    designs = [
        (f"blob-{index:02d}", _synthetic(rng, index, max_side_cm, params.dpi))
        for index in range(count)
    ]
    return build_case(f"synthetic-{count:02d}", designs, params, directory)


def shop_case(fixtures: Path, directory: Path, params: PackParams | None = None) -> Case:
    """All ten real fixtures, sized to plausible print dimensions."""
    params = params or DEFAULT_PARAMS
    designs: list[tuple[str, Image.Image]] = []
    for design_id, (filename, width_cm, height_cm) in SHOP_DESIGNS.items():
        source = fixtures / filename
        if not source.exists():
            raise SystemExit(f"missing fixture {source}; run scripts/generate_fixtures.py")
        with Image.open(source) as opened:
            opened.load()
            image = opened.convert("RGBA")
        designs.append((design_id, _fit(image, width_cm, height_cm, params.dpi)))
    return build_case("shop-ten", designs, params, directory)


def case_manifest(case: Case) -> dict:
    return {
        "name": case.name,
        "params": {
            "rollWidthCm": case.params.roll_width_cm,
            "dpi": case.params.dpi,
            "marginMm": case.params.margin_mm,
            "edgeMarginMm": case.params.edge_margin_mm,
            "alphaThreshold": case.params.alpha_threshold,
            "seed": case.params.seed,
            "timeBudgetMs": case.params.time_budget_ms,
        },
        "designs": [
            {
                "designId": design.design_id,
                "widthPx": design.width_px,
                "heightPx": design.height_px,
                "allowRotation": design.allow_rotation,
            }
            for design in case.designs
        ],
    }


def write_manifest(case: Case, path: Path) -> None:
    path.write_text(json.dumps(case_manifest(case), indent=2), encoding="utf-8")


def copy_case(source: Path, destination: Path) -> None:
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(source, destination)


__all__ = [
    "DEFAULT_PARAMS",
    "SHOP_DESIGNS",
    "build_case",
    "case_manifest",
    "copy_case",
    "shop_case",
    "synthetic_case",
    "write_manifest",
]
