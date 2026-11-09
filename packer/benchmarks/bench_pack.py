"""Packer benchmark — not part of CI.

Runs the real pipeline (decode → nest → integrity → preview → manifest) on
synthetic designs of realistic size and reports the phase timings.

    cd packer
    .venv/bin/python benchmarks/bench_pack.py
    .venv/bin/python benchmarks/bench_pack.py --counts 40 --orderings 60 --keep

``--keep DIR`` leaves the storage tree behind so the same batch can be reused
with the CLI:

    .venv/bin/printsheet-packer pack --request DIR/request.json --storage-root DIR/storage

pytest-benchmark is installed with the dev extra, but the search is not
microsecond-accurate enough for it to add anything here; the wall-clock
breakdown is what matters.
"""

from __future__ import annotations

import argparse
import json
import resource
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from printsheet_packer.contracts import parse_pack_request
from printsheet_packer.export import build_manifest, hash_sources, write_manifest
from printsheet_packer.integrity import ReportContext, build_report
from printsheet_packer.nesting import Packer
from printsheet_packer.pipeline import load_masks, measure_layout
from printsheet_packer.render import preview_from_renderer
from printsheet_packer.storage import StorageRoot
from printsheet_packer.units import pixels_for_centimeters

COLORS = [(190, 40, 40), (30, 160, 60), (40, 80, 200), (200, 160, 30), (120, 60, 180)]


def timed(start: float) -> tuple[float, float]:
    now = time.perf_counter()
    return (now - start) * 1000, now


def synthetic_design(
    rng: np.random.Generator, index: int, max_side_cm: float, dpi: int
) -> dict[str, Any]:
    """A soft-edged blob with a hole, roughly the size of a printed design."""
    width_cm = float(rng.uniform(6, max_side_cm))
    height_cm = float(rng.uniform(6, max_side_cm))
    width = pixels_for_centimeters(width_cm, dpi)
    height = pixels_for_centimeters(height_cm, dpi)
    ys, xs = np.mgrid[0:height, 0:width]
    radius = ((xs - width / 2) / (width * 0.46)) ** 2 + ((ys - height / 2) / (height * 0.46)) ** 2
    alpha = np.clip((1.0 - radius) * 320, 0, 255).astype(np.uint8)
    hole = radius < 0.18 if rng.random() < 0.35 else np.zeros((height, width), dtype=bool)
    alpha[hole] = 0
    color = COLORS[index % len(COLORS)]
    array = np.dstack(
        [
            np.full((height, width), color[0], np.uint8),
            np.full((height, width), color[1], np.uint8),
            np.full((height, width), color[2], np.uint8),
            alpha,
        ]
    )
    design_id, version_id = str(uuid.uuid4()), str(uuid.uuid4())
    relative = f"bench/{design_id}/versions/{version_id}.png"
    return {
        "array": array,
        "relative": relative,
        "record": {
            "designId": design_id,
            "versionId": version_id,
            "displayName": f"bench-{index:02d}",
            "filePath": relative,
            "widthPx": width,
            "heightPx": height,
            "allowRotation": True,
            "targetWidthCm": round(width_cm, 2),
            "targetHeightCm": round(height_cm, 2),
        },
    }


def build_batch(count: int, args: argparse.Namespace, storage: Path) -> dict[str, Any]:
    rng = np.random.default_rng(args.seed + count)
    designs = [synthetic_design(rng, index, args.max_side_cm, args.dpi) for index in range(count)]
    for design in designs:
        target = storage / design["relative"]
        target.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(design["array"], "RGBA").save(target, compress_level=1)
    return {
        "schemaVersion": "1.0",
        "requestId": f"bench-{count}",
        "rollWidthCm": args.roll_cm,
        "marginMm": args.margin_mm,
        "edgeMarginMm": args.edge_mm,
        "dpi": args.dpi,
        "alphaThreshold": 5,
        "cellMm": args.cell_mm,
        "randomizedOrderings": args.orderings,
        "timeBudgetMs": args.time_budget_ms,
        "seed": args.seed,
        "noInterlocking": args.no_interlocking,
        "designs": [design["record"] for design in designs],
        "output": {
            "directory": "bench/sheets",
            "previewPath": "bench/sheets/preview.png",
            "manifestPath": "bench/sheets/placements.json",
        },
    }


def run_one(count: int, args: argparse.Namespace, storage: Path) -> dict[str, Any]:
    document = build_batch(count, args, storage)
    request = parse_pack_request(document)
    root = StorageRoot(storage)
    phases: dict[str, float] = {}
    started = time.perf_counter()
    start = started
    masks, images = load_masks(request, root)
    phases["decode"], start = timed(start)
    packer = Packer(request, masks)
    layout = packer.run()
    phases["search"], start = timed(start)
    measured, renderer = measure_layout(layout, images)
    phases["integrity"], start = timed(start)
    report = build_report(
        measured,
        ReportContext(
            dpi=request.dpi,
            sheet_width_px=layout.sheet_width_px,
            sheet_height_px=layout.sheet_height_px,
            design_count=len(layout.placed),
            duration_ms=layout.duration_ms,
            occupancy_ratio=layout.occupancy_ratio,
            orderings_tried=layout.orderings_tried,
        ),
    )
    if not args.skip_preview:
        preview_from_renderer(renderer, target_width_px=args.preview_width)
        phases["preview"], start = timed(start)
    if not args.skip_manifest:
        manifest = build_manifest(request, layout, report, hash_sources(root, request.designs))
        write_manifest(root, request.output.manifest_path, manifest, overwrite=True)
        phases["manifest"], start = timed(start)
    phases["total"] = (time.perf_counter() - started) * 1000

    return {
        "designs": count,
        "sheetPx": f"{layout.sheet_width_px}x{layout.sheet_height_px}",
        "sheetCm": round(layout.sheet_height_px * 2.54 / request.dpi, 1),
        "orderings": layout.orderings_tried,
        "occupancy": round(layout.occupancy_ratio, 4),
        "passed": report["passed"],
        "cellPx": layout.cell_px,
        "phasesMs": {key: round(value, 1) for key, value in phases.items()},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts", default="1,10,40", help="Comma separated design counts")
    parser.add_argument("--roll-cm", type=float, default=58.0)
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument("--margin-mm", type=float, default=30.0)
    parser.add_argument("--edge-mm", type=float, default=10.0)
    parser.add_argument("--cell-mm", type=float, default=5.0)
    parser.add_argument("--max-side-cm", type=float, default=28.0)
    parser.add_argument("--orderings", type=int, default=30)
    parser.add_argument("--time-budget-ms", type=int, default=60_000)
    parser.add_argument("--seed", type=int, default=20261105)
    parser.add_argument("--no-interlocking", action="store_true")
    parser.add_argument("--skip-preview", action="store_true")
    parser.add_argument("--skip-manifest", action="store_true")
    parser.add_argument("--preview-width", type=int, default=900)
    parser.add_argument("--keep", type=Path, help="Leave the generated batch here")
    parser.add_argument("--json", action="store_true", help="Print raw JSON")
    args = parser.parse_args(argv)

    directory = args.keep or Path(tempfile.mkdtemp(prefix="printsheet-bench-"))
    storage = directory / "storage"
    storage.mkdir(parents=True, exist_ok=True)
    rows = []
    for count in [int(value) for value in args.counts.split(",") if value.strip()]:
        rows.append(run_one(count, args, storage))
    if not args.keep:
        shutil.rmtree(directory, ignore_errors=True)

    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        widths = (7, 14, 9, 7, 10, 8, 9, 10, 8, 9, 9)
        labels = (
            "designs", "sheet px", "sheet cm", "orders", "occupancy",
            "decode", "search", "integrity", "preview", "manifest", "total ms",
        )
        print(" ".join(f"{label:>{width}}" for label, width in zip(labels, widths, strict=True)))
        for row in rows:
            phases = row["phasesMs"]
            values = (
                row["designs"], row["sheetPx"], row["sheetCm"], row["orderings"],
                row["occupancy"], phases.get("decode", 0), phases["search"],
                phases["integrity"], phases.get("preview", 0),
                phases.get("manifest", 0), phases["total"],
            )
            cells = [f"{value:>{width}}" for value, width in zip(values, widths, strict=True)]
            print(" ".join(cells))
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        print(f"\npeak RSS {peak:.0f} MB; passed={[row['passed'] for row in rows]}")
        print(f"cellPx={rows[-1]['cellPx']}  (search cell for cellMm={args.cell_mm})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
