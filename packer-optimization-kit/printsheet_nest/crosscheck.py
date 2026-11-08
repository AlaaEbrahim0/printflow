"""Cross-validate the kit's referee against the production integrity checks.

The kit is only useful if its referee agrees with the shipped one. This script
runs the real packer through :func:`printsheet_packer.pipeline.run_pack`, then
judges the *same* layout with the kit referee, and reports any disagreement in
the pass/fail verdict or in the measured minimum gap.

    python -m printsheet_nest.crosscheck cases/shop-ten

A disagreement is a bug in the kit, not an optimisation opportunity: a solver
tuned against a lenient referee would be rejected in production.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from printsheet_nest.cli import _load_case
from printsheet_nest.referee import judge
from printsheet_nest.types import Layout, Placement, UnplacedDesign


def _uuid(seed: str) -> str:
    """Deterministic UUID-shaped id, so the production schema accepts it."""
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"printsheet-kit:{seed}"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", help="case directory, e.g. cases/shop-ten")
    parser.add_argument("--orderings", type=int, default=30)
    args = parser.parse_args(argv)

    root = Path(__file__).resolve().parent.parent.parent
    if str(root / "packer") not in sys.path:
        sys.path.insert(0, str(root / "packer"))

    from printsheet_packer.contracts import parse_pack_request
    from printsheet_packer.pipeline import run_pack

    case = _load_case(Path(args.case))
    document = {
        "schemaVersion": "1.0",
        "requestId": f"crosscheck-{case.name}",
        "rollWidthCm": case.params.roll_width_cm,
        "marginMm": case.params.margin_mm,
        "edgeMarginMm": case.params.edge_margin_mm,
        "dpi": case.params.dpi,
        "alphaThreshold": case.params.alpha_threshold,
        "cellMm": 5.0,
        "randomizedOrderings": args.orderings,
        "timeBudgetMs": case.params.time_budget_ms,
        "seed": case.params.seed,
        "noInterlocking": False,
        "designs": [
            {
                "designId": _uuid(design.design_id),
                "versionId": _uuid(design.design_id + "-v"),
                "displayName": design.design_id,
                "filePath": f"designs/{design.design_id}.png",
                "widthPx": design.width_px,
                "heightPx": design.height_px,
                "allowRotation": design.allow_rotation,
            }
            for design in case.designs
        ],
        "output": {"directory": "sheets", "manifestPath": "sheets/placements.json"},
    }

    with tempfile.TemporaryDirectory(prefix="printsheet-crosscheck-") as temporary:
        storage = Path(temporary)
        for design in case.designs:
            target = storage / "designs" / f"{design.design_id}.png"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(Path(case.files[design.design_id]).read_bytes())

        request = parse_pack_request(document)
        outcome = run_pack(request, storage, write_outputs=False, preview=False)
        report = outcome.report
        production_layout = outcome.layout

    by_uuid = {_uuid(design.design_id): design.design_id for design in case.designs}
    layout = Layout(
        placements=tuple(
            Placement(
                design_id=by_uuid[item.design_id],
                x_px=item.x_px,
                y_px=item.y_px,
                width_px=item.width_px,
                height_px=item.height_px,
                rotation_deg=item.rotation_deg,
            )
            for item in production_layout.placements
        ),
        unplaced=tuple(
            UnplacedDesign(by_uuid[item.design_id], item.reason)
            for item in production_layout.unplaced
        ),
        sheet_width_px=production_layout.sheet_width_px,
        sheet_height_px=production_layout.sheet_height_px,
    )

    kit = judge(case, layout)
    gap_check = next(check for check in report["checks"] if check["id"] == "minimum-gap")
    # Production publishes the gap in millimetres (``minimumGapMm``) and the
    # edge clearance only as ``minimumEdgeClearanceMm``; the raw pixel values
    # stay internal, so compare the millimetre figures.
    production_gap_mm = gap_check["details"].get("minimumGapMm")
    production_edge_mm = gap_check["details"].get("minimumEdgeClearanceMm")
    kit_gap_mm = (
        round(kit.minimum_gap_px * 25.4 / case.params.dpi, 4)
        if kit.minimum_gap_px is not None
        else None
    )
    kit_edge_mm = (
        round(kit.minimum_edge_clearance_px * 25.4 / case.params.dpi, 4)
        if kit.minimum_edge_clearance_px is not None
        else None
    )

    print(f"case                  {case.name}")
    print(f"sheet                 {kit.sheet_width_px} x {kit.sheet_height_px} px")
    print(f"production passed     {report['passed']}")
    print(f"kit feasible          {kit.feasible}")
    print(f"production min gap    {production_gap_mm} mm")
    print(f"kit min gap           {kit_gap_mm} mm ({kit.minimum_gap_px} px)")
    print(f"production edge       {production_edge_mm} mm")
    print(f"kit edge              {kit_edge_mm} mm ({kit.minimum_edge_clearance_px} px)")
    if kit.reasons:
        print("kit reasons:")
        for reason in kit.reasons[:5]:
            print(f"  - {reason}")

    agree = kit.feasible == report["passed"]
    gaps_agree = kit_gap_mm == production_gap_mm
    print(f"\nverdicts agree        {agree}")
    print(f"gaps agree            {gaps_agree}")
    return 0 if agree and gaps_agree else 1


if __name__ == "__main__":
    raise SystemExit(main())
