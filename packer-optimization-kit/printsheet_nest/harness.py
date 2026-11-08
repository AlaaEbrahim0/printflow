"""The harness: run a solver on a case, judge it, and score it.

Scoring is deliberately simple and single-objective, because the production
objective is: **place everything, on the shortest possible sheet, without ever
breaking a hard constraint.**

    score = 0                       if the referee rejects the layout
    score = sheet_height_px         otherwise

Lower is better. Ties are broken by wall-clock time, then by name. The referee
verdict is always recorded, so a solver that "wins" by cheating is visible
immediately: it scores 0.

Timing is measured around the solver's ``solve`` call only. Reading PNGs and
judging are outside the measurement, so a solver cannot win by doing less
verification — the referee always runs at full resolution.
"""

from __future__ import annotations

import importlib
import json
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from printsheet_nest.referee import judge
from printsheet_nest.types import Case, Layout


@dataclass
class Result:
    case_name: str
    solver: str
    feasible: bool
    sheet_height_px: int
    score: int
    elapsed_ms: float
    reasons: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "case": self.case_name,
            "solver": self.solver,
            "feasible": self.feasible,
            "sheetHeightPx": self.sheet_height_px,
            "score": self.score,
            "elapsedMs": round(self.elapsed_ms, 1),
            "reasons": self.reasons,
            "details": self.details,
        }


def load_solver(spec: str):
    """``module:attribute`` -> callable(Case) -> Layout."""
    if ":" not in spec:
        raise SystemExit(f"solver spec must look like 'module:function', got {spec!r}")
    module_name, attribute = spec.split(":", 1)
    module = importlib.import_module(module_name)
    try:
        return getattr(module, attribute)
    except AttributeError as exc:
        raise SystemExit(f"{module_name} has no attribute {attribute!r}") from exc


def run_case(case: Case, solver, solver_name: str) -> Result:
    started = time.perf_counter()
    try:
        layout = solver(case)
    except Exception:  # a crashing solver is a failed solver, not a harness bug
        return Result(
            case_name=case.name,
            solver=solver_name,
            feasible=False,
            sheet_height_px=0,
            score=0,
            elapsed_ms=(time.perf_counter() - started) * 1000,
            reasons=[f"solver raised: {traceback.format_exc(limit=3).strip()}"],
        )
    elapsed_ms = (time.perf_counter() - started) * 1000

    if not isinstance(layout, Layout):
        return Result(
            case_name=case.name,
            solver=solver_name,
            feasible=False,
            sheet_height_px=0,
            score=0,
            elapsed_ms=elapsed_ms,
            reasons=[f"solver returned {type(layout).__name__}, expected Layout"],
        )

    verdict = judge(case, layout)
    return Result(
        case_name=case.name,
        solver=solver_name,
        feasible=verdict.feasible,
        sheet_height_px=verdict.sheet_height_px,
        score=verdict.sheet_height_px if verdict.feasible else 0,
        elapsed_ms=elapsed_ms,
        reasons=verdict.reasons,
        details=verdict.details,
    )


def run_suite(cases: list[Case], solver, solver_name: str) -> list[Result]:
    return [run_case(case, solver, solver_name) for case in cases]


def summarise(results: list[Result]) -> dict[str, Any]:
    feasible = [result for result in results if result.feasible]
    return {
        "solver": results[0].solver if results else None,
        "cases": len(results),
        "feasible": len(feasible),
        "totalSheetHeightPx": sum(result.sheet_height_px for result in feasible),
        "meanElapsedMs": round(
            sum(result.elapsed_ms for result in results) / len(results), 1
        )
        if results
        else 0.0,
        "worstCase": max(
            (result.sheet_height_px for result in feasible), default=0
        ),
    }


def write_results(results: list[Result], path: Path) -> None:
    payload = {
        "summary": summarise(results),
        "results": [result.to_json() for result in results],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


__all__ = [
    "Result",
    "load_solver",
    "run_case",
    "run_suite",
    "summarise",
    "write_results",
]
