"""Run the production packer's search on a kit case, for calibration.

The kit's referee judges both solvers identically, so this script answers one
question: what sheet height does the *shipped* algorithm currently reach on
these exact designs? That number is the bar an optimizing solver must beat.

    python -m printsheet_nest.production cases/shop-ten

It imports ``printsheet_packer`` from ``../packer``; nothing here is used by the
harness, and the kit runs fine without it.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from printsheet_nest.cases import DEFAULT_PARAMS
from printsheet_nest.cli import _load_case
from printsheet_nest.referee import judge
from printsheet_nest.types import Case, Layout, Placement, UnplacedDesign


def production_layout(
    case: Case,
    *,
    cell_mm: float = 2.0,
    randomized_orderings: int = 40,
    time_budget_ms: int = 5000,
) -> Layout:
    """Ask the shipped packer for a layout, then translate it into kit types.

    The defaults are production's own, from ``PackerSettings.Default`` in
    ``api/src/PrintSheet.Application/Settings/AppSettings.cs``: ``cellMm=2``,
    ``randomizedOrderings=40``, ``timeBudgetMs=5000``. Earlier versions of this
    script hard-coded ``cellMm=5.0``, which is a different (coarser) search than
    the product actually runs — every published production number must come from
    these defaults so the bar is honest.
    """
    root = Path(__file__).resolve().parent.parent.parent
    packer_root = root / "packer"
    if str(packer_root) not in sys.path:
        sys.path.insert(0, str(packer_root))

    from printsheet_packer.contracts import parse_pack_request
    from printsheet_packer.masks import build_design_mask, load_rgba
    from printsheet_packer.nesting import Packer

    document = {
        "schemaVersion": "1.0",
        "requestId": f"calibrate-{case.name}",
        "rollWidthCm": case.params.roll_width_cm,
        "marginMm": case.params.margin_mm,
        "edgeMarginMm": case.params.edge_margin_mm,
        "dpi": case.params.dpi,
        "alphaThreshold": case.params.alpha_threshold,
        "cellMm": cell_mm,
        "randomizedOrderings": randomized_orderings,
        "timeBudgetMs": time_budget_ms,
        "seed": case.params.seed,
        "noInterlocking": False,
        "designs": [
            {
                "designId": _uuid(design.design_id),
                "versionId": _uuid(design.design_id + "-v"),
                "displayName": design.design_id,
                "filePath": f"{design.design_id}.png",
                "widthPx": design.width_px,
                "heightPx": design.height_px,
                "allowRotation": design.allow_rotation,
            }
            for design in case.designs
        ],
        "output": {
            "directory": "calibrate/sheets",
            "manifestPath": "calibrate/sheets/placements.json",
        },
    }
    request = parse_pack_request(document)

    masks = {}
    for design in request.designs:
        original = next(item for item in case.designs if _uuid(item.design_id) == design.design_id)
        rgba = load_rgba(case.files[original.design_id])
        masks[design.design_id] = build_design_mask(design, rgba, request.alpha_threshold)

    layout = Packer(request, masks).run()
    by_uuid = {_uuid(design.design_id): design.design_id for design in case.designs}
    return Layout(
        placements=tuple(
            Placement(
                design_id=by_uuid[placement.design_id],
                x_px=placement.x_px,
                y_px=placement.y_px,
                width_px=placement.width_px,
                height_px=placement.height_px,
                rotation_deg=placement.rotation_deg,
            )
            for placement in layout.placements
        ),
        unplaced=tuple(
            UnplacedDesign(by_uuid[item.design_id], item.reason) for item in layout.unplaced
        ),
        sheet_width_px=layout.sheet_width_px,
        sheet_height_px=layout.sheet_height_px,
    )


def _uuid(seed: str) -> str:
    """Deterministic UUID-shaped id, so the production schema accepts it."""
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"printsheet-kit:{seed}"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", help="case directory, e.g. cases/shop-ten")
    args = parser.parse_args(argv)
    case = _load_case(Path(args.case))
    layout = production_layout(case)
    verdict = judge(case, layout)
    print(f"case        {case.name}")
    print(f"sheet       {verdict.sheet_width_px} x {verdict.sheet_height_px} px")
    print(f"feasible    {verdict.feasible}")
    print(f"density     {verdict.density:.4f}")
    print(f"min gap     {verdict.minimum_gap_px} px")
    for reason in verdict.reasons:
        print(f"  ! {reason}")
    return 0 if verdict.feasible else 1


if __name__ == "__main__":
    raise SystemExit(main())
