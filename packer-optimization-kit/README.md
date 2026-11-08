# PrintSheet nesting kit

A self-contained harness for improving **where each approved design goes on a
printed roll**. Everything you need is in this directory; nothing here imports
the product.

Read [`BRIEF.md`](./BRIEF.md) first — it is the actual task. This file only
covers how to run the thing.

## Setup

The kit needs `numpy`, `Pillow` and `shapely`. Any Python 3.11+ environment with
those three works; the reference environment is the repo's own
`packer/.venv`:

```bash
python -m pip install -r requirements.txt
```

## The loop

```bash
# 1. Materialise the cases (once). Writes cases/<name>/{case.json,*.png}.
python -m printsheet_nest.cli build

# 2. Measure your solver on every case.
python -m printsheet_nest.cli run --solver my_package.mine:solve --out results/mine.json

# 3. Compare against the reference solvers already recorded.
cat results/baseline.json      # fast raster greedy bottom-left (the floor to beat)
cat results/production.json    # the shipped packer at its shipped 5 s budget
cat results/production-60s.json # the same packer given the baseline's 60 s budget
```

Read `BRIEF.md` §6 before drawing conclusions from those two production files:
production's height depends on its time budget, it fails three of the six cases
outright, and the two files answer different questions.

`run` prints a table and, with `--out`, writes machine-readable JSON so you can
track iterations. Use `--only shop-ten,synthetic-04` while iterating.

To judge a single layout by hand:

```bash
python -m printsheet_nest.cli score path/to/layout.json --case cases/shop-ten
```

## What to implement

One function:

```python
def solve(case: Case) -> Layout: ...
```

`Layout` is in `printsheet_nest/types.py`. The referee
(`printsheet_nest/referee.py`) judges it at full resolution and never trusts
your numbers, so you can return anything you like and it will be checked.

The baseline you must beat is `printsheet_nest.baseline:solve`. Its docstring
lists the eight weaknesses the brief asks you to attack.

## Honesty rules that matter more than the score

* A layout that breaks a hard constraint scores **nothing**, no matter how short
  the sheet. The referee is the only judge.
* Every requested design must appear exactly once. Reporting a design as
  unplaced is legal but fails the case.
* The gap is a **Chebyshev** distance between nearest visible pixels. The
  shipped packer gets this wrong on diagonals — see `BRIEF.md` §3 and §6.1.
  Do not inherit that bug.
* Pixels are never resampled: only translation and 90° rotations are allowed.

## Layout of this directory

```
BRIEF.md              the task, constraints, scoring and the bar to beat
printsheet_nest/
  types.py            Case, Layout, Placement, UnplacedDesign, PackParams
  referee.py          independent full-resolution judge (do not modify)
  baseline.py         reference solver; the score to beat
  cases.py            case generation from fixtures + synthetic blobs
  harness.py          runs a solver over cases and records results
  cli.py              build / run / score entry point
  production.py       runs the *shipped* packer on a case (calibration only)
  production_suite.py records results/production.json
  crosscheck.py       proves the referee agrees with production's own verifier
tests/test_kit.py     referee and baseline regression tests
cases/                generated inputs (not source)
results/              recorded scores (baseline, production, yours)
```

## Checking your work

```bash
python -m pytest tests/ -q
```

Also worth running once, to confirm the referee still agrees with the product on
a real case:

```bash
python -m printsheet_nest.crosscheck cases/shop-ten
```
