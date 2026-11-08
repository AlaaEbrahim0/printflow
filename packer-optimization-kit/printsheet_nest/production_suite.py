"""Measure the shipped packer on every kit case, for a like-for-like baseline.

Writes ``results/production.json`` so the optimizing agent can compare its own
numbers against what the product does today, case by case.

    python -m printsheet_nest.production_suite
    python -m printsheet_nest.production_suite --orderings 30 --out results/production.json
    python -m printsheet_nest.production_suite --only shop-ten synthetic-04

The production packer has no wall-clock cap *inside* a single ordering — it only
checks its budget between orderings — so one case can run for minutes. This
driver therefore checkpoints after every case and skips cases already recorded,
so an interrupted run never throws away finished work:

    python -m printsheet_nest.production_suite            # resumes
    python -m printsheet_nest.production_suite --fresh     # starts over
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from printsheet_nest.cli import CASES, _load_case
from printsheet_nest.referee import judge

ROOT = Path(__file__).resolve().parent.parent


def _summarise(rows: list[dict], params: dict | None = None) -> dict:
    feasible = [row for row in rows if row["feasible"]]
    return {
        "solver": "production-packer",
        "params": params or {},
        "cases": len(rows),
        "feasible": len(feasible),
        "totalSheetHeightPx": sum(row["sheetHeightPx"] for row in feasible),
        "meanElapsedMs": round(sum(row["elapsedMs"] for row in rows) / len(rows), 1)
        if rows
        else 0.0,
    }


def _write(out: Path, rows: list[dict], params: dict) -> None:
    """Checkpoint atomically so a kill mid-write cannot corrupt the file."""
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {"summary": _summarise(rows, params), "results": rows}
    temporary = out.with_suffix(out.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(out)


def _load_existing(out: Path) -> dict[str, dict]:
    if not out.exists():
        return {}
    try:
        payload = json.loads(out.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        print(f"ignoring unreadable checkpoint at {out}", flush=True)
        return {}
    return {row["case"]: row for row in payload.get("results", []) if "case" in row}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default=str(CASES))
    parser.add_argument(
        "--orderings",
        type=int,
        default=40,
        help="randomized orderings; production default is 40",
    )
    parser.add_argument(
        "--cell-mm",
        type=float,
        default=2.0,
        help="occupancy cell in mm; production default is 2.0",
    )
    parser.add_argument(
        "--time-budget-ms",
        type=int,
        default=5000,
        help="per-run budget in ms; production default is 5000",
    )
    parser.add_argument("--out", default=str(ROOT / "results" / "production.json"))
    parser.add_argument(
        "--only",
        nargs="+",
        default=None,
        metavar="CASE",
        help="measure only these case names",
    )
    parser.add_argument(
        "--fresh",
        action="store_true",
        help="ignore an existing checkpoint and measure every case again",
    )
    args = parser.parse_args(argv)

    if str(ROOT.parent / "packer") not in sys.path:
        sys.path.insert(0, str(ROOT.parent / "packer"))
    from printsheet_nest.production import production_layout

    root = Path(args.cases)
    directories = sorted(path for path in root.iterdir() if (path / "case.json").exists())
    if args.only:
        wanted = set(args.only)
        directories = [path for path in directories if path.name in wanted]
        missing = wanted - {path.name for path in directories}
        if missing:
            parser.error(f"no such case(s): {', '.join(sorted(missing))}")
    if not directories:
        parser.error(f"no cases with case.json under {root}")

    out = Path(args.out)
    params = {
        "cellMm": args.cell_mm,
        "randomizedOrderings": args.orderings,
        "timeBudgetMs": args.time_budget_ms,
    }
    recorded = {} if args.fresh else _load_existing(out)
    rows: list[dict] = []

    for directory in directories:
        name = directory.name
        if name in recorded:
            rows.append(recorded[name])
            print(f"{name:<16} cached{recorded[name]['sheetHeightPx']:>11}", flush=True)
            continue

        case = _load_case(directory)
        print(f"{name:<16} measuring ({len(case.designs)} designs)…", flush=True)
        started = time.perf_counter()
        layout = production_layout(
            case,
            cell_mm=args.cell_mm,
            randomized_orderings=args.orderings,
            time_budget_ms=args.time_budget_ms,
        )
        elapsed = (time.perf_counter() - started) * 1000
        verdict = judge(case, layout)
        row = {
            "case": case.name,
            "feasible": verdict.feasible,
            "sheetHeightPx": verdict.sheet_height_px,
            "density": round(verdict.density, 6),
            "elapsedMs": round(elapsed, 1),
            "reasons": verdict.reasons[:5],
        }
        rows.append(row)
        print(
            f"{case.name:<16}{'yes' if verdict.feasible else 'NO':>4}"
            f"{verdict.sheet_height_px:>11}{elapsed:>10.0f} ms",
            flush=True,
        )
        _write(out, rows, params)
        print(f"{'':<16} checkpointed to {out}", flush=True)

    # Recompute from the accumulated rows so a resumed run reports the full set.
    _write(out, rows, params)
    summary = _summarise(rows, params)
    print(
        f"\n{summary['feasible']}/{summary['cases']} feasible · "
        f"total sheet height {summary['totalSheetHeightPx']} px",
        flush=True,
    )
    print(f"wrote {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
