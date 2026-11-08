"""Command line entry point for the nesting kit.

    python -m printsheet_nest.cli build          # write cases/ from fixtures
    python -m printsheet_nest.cli run            # run a solver over all cases
    python -m printsheet_nest.cli score LAYOUT   # judge a single layout.json

Typical loop for an optimizing agent:

    python -m printsheet_nest.cli run --solver printsheet_nest.mine:solve \\
        --out results/mine.json

Every invocation prints a table; ``--out`` also writes machine-readable JSON so
progress can be tracked across iterations.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from printsheet_nest.cases import (
    DEFAULT_PARAMS,
    shop_case,
    synthetic_case,
    write_manifest,
)
from printsheet_nest.harness import load_solver, run_suite, summarise, write_results
from printsheet_nest.referee import judge
from printsheet_nest.types import Case, DesignSpec, Layout, PackParams, Placement, UnplacedDesign

ROOT = Path(__file__).resolve().parent.parent
CASES = ROOT / "cases"
FIXTURES = ROOT.parent / "fixtures" / "generated" / "images"

SYNTHETIC_COUNTS = (4, 8, 12, 20, 30)


def cmd_build(args: argparse.Namespace) -> int:
    target = Path(args.directory) if args.directory else CASES
    target.mkdir(parents=True, exist_ok=True)
    built: list[str] = []
    for count in SYNTHETIC_COUNTS:
        case = synthetic_case(count, target / f"synthetic-{count:02d}")
        write_manifest(case, target / f"synthetic-{count:02d}" / "case.json")
        built.append(f"{case.name} ({len(case.designs)} designs)")
    shop = shop_case(FIXTURES, target / "shop-ten")
    write_manifest(shop, target / "shop-ten" / "case.json")
    built.append(f"{shop.name} ({len(shop.designs)} designs)")
    for line in built:
        print(f"built {line}")
    print(f"\ncases in {target}")
    return 0


def _load_case(directory: Path) -> Case:
    """Rebuild a Case from its manifest and PNG files on disk."""
    manifest = json.loads((directory / "case.json").read_text(encoding="utf-8"))
    params = PackParams(
        roll_width_cm=manifest["params"]["rollWidthCm"],
        dpi=manifest["params"]["dpi"],
        margin_mm=manifest["params"]["marginMm"],
        edge_margin_mm=manifest["params"]["edgeMarginMm"],
        alpha_threshold=manifest["params"]["alphaThreshold"],
        seed=manifest["params"]["seed"],
        time_budget_ms=manifest["params"]["timeBudgetMs"],
    )
    specs = tuple(
        DesignSpec(
            design_id=entry["designId"],
            file_path=str(directory / f"{entry['designId']}.png"),
            width_px=entry["widthPx"],
            height_px=entry["heightPx"],
            allow_rotation=entry["allowRotation"],
            display_name=entry["designId"],
        )
        for entry in manifest["designs"]
    )
    return Case(
        name=manifest["name"],
        params=params,
        designs=specs,
        files={spec.design_id: spec.file_path for spec in specs},
    )


def cmd_run(args: argparse.Namespace) -> int:
    root = Path(args.cases) if args.cases else CASES
    directories = sorted(path for path in root.iterdir() if (path / "case.json").exists())
    if not directories:
        print(f"no cases in {root}; run 'python -m printsheet_nest.cli build' first", file=sys.stderr)
        return 2
    if args.only:
        wanted = {token.strip() for token in args.only.split(",") if token.strip()}
        directories = [path for path in directories if path.name in wanted]
    cases = [_load_case(path) for path in directories]

    solver = load_solver(args.solver)
    results = run_suite(cases, solver, args.solver)
    summary = summarise(results)

    print(f"{'case':<16}{'ok':>4}{'sheet px':>11}{'score':>11}{'ms':>10}")
    for result in results:
        print(
            f"{result.case_name:<16}{'yes' if result.feasible else 'NO':>4}"
            f"{result.sheet_height_px:>11}{result.score:>11}{result.elapsed_ms:>10.0f}"
        )
        for reason in result.reasons[:3]:
            print(f"    ! {reason}")
    print(
        f"\n{summary['feasible']}/{summary['cases']} feasible · "
        f"total sheet height {summary['totalSheetHeightPx']} px · "
        f"mean {summary['meanElapsedMs']} ms"
    )

    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        write_results(results, out)
        print(f"wrote {out}")
    return 0 if summary["feasible"] == summary["cases"] else 1


def cmd_score(args: argparse.Namespace) -> int:
    case = _load_case(Path(args.case))
    document = json.loads(Path(args.layout).read_text(encoding="utf-8"))
    layout = Layout(
        placements=tuple(
            Placement(
                design_id=entry["designId"],
                x_px=entry["xPx"],
                y_px=entry["yPx"],
                width_px=entry["widthPx"],
                height_px=entry["heightPx"],
                rotation_deg=entry["rotationDeg"],
            )
            for entry in document["placements"]
        ),
        unplaced=tuple(
            UnplacedDesign(
                design_id=entry["designId"],
                reason=entry.get("reason", "unknown"),
                details=entry.get("details", {}),
            )
            for entry in document.get("unplacedDesigns", [])
        ),
        sheet_width_px=document["sheet"]["widthPx"],
        sheet_height_px=document["sheet"]["heightPx"],
    )
    verdict = judge(case, layout)
    print(json.dumps(verdict.to_json(), indent=2))
    return 0 if verdict.feasible else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="printsheet_nest.cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="generate cases from fixtures and synthetic blobs")
    build.add_argument("--directory", help="where to write cases (default: ./cases)")
    build.set_defaults(func=cmd_build)

    run = sub.add_parser("run", help="run a solver over every case")
    run.add_argument("--solver", default="printsheet_nest.baseline:solve")
    run.add_argument("--cases", help="case root (default: ./cases)")
    run.add_argument("--only", help="comma separated case directory names")
    run.add_argument("--out", help="write JSON results here")
    run.set_defaults(func=cmd_run)

    score = sub.add_parser("score", help="judge a single layout.json")
    score.add_argument("layout")
    score.add_argument("--case", required=True, help="case directory")
    score.set_defaults(func=cmd_score)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
