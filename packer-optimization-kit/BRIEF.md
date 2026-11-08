# PrintSheet nesting optimisation — brief for an optimising agent

You are improving the search that decides **where each approved design goes on
a printed roll**. Everything else in the product is out of scope.

This document is self-contained. It states the objective, the hard constraints,
the harness you are scored on, the baseline you must beat, and where the current
algorithm leaves value on the table.

---

## 1. The product context (what must never break)

PrintSheet packs customer artwork onto a continuous DTF (direct-to-film) roll.
An operator uploads designs, approves them, and the tool proposes a layout. A
human reviews that layout and exports a sheet; the sheet is then printed.

The consequences that shape the algorithm:

* **Pixels are never resampled or re-encoded.** A design is placed at its exact
  approved size, rotated only by multiples of 90°. Any transform that would
  alter a pixel is a product bug, not an optimisation.
* **Nothing may be silently dropped.** Every design the operator included must
  appear on the sheet. If one genuinely cannot fit, the run reports it as
  unplaced with a reason — it never quietly shrinks or omits it.
* **The gap is a physical print requirement.** Designs are cut out and pressed,
  so a minimum visible-pixel clearance (`margin_mm`) and a clearance from the
  sheet edge (`edge_margin_mm`) are hard, non-negotiable constraints.
* **The sheet height is material cost.** The roll is sold by length. Shorter is
  strictly better: same designs, less film, same print quality.

## 2. Your objective

> Place every design, respecting every hard constraint, and minimise the
> resulting sheet height in pixels.

Lower is better, and that is the only objective. Wall-clock time is a
constraint (a production run must finish in seconds to a couple of minutes),
not something to trade against height beyond that budget.

There is no reward for elegance. A CP-SAT model, simulated annealing, a beam
search, a learned policy, a hand-tuned heuristic — all are equally acceptable.
The referee decides.

## 3. The hard constraints

A layout is rejected if **any** of these fails. The referee enforces each one
at full resolution, independently of your code.

| # | Constraint |
|---|---|
| 1 | Every requested design is placed **exactly once**. |
| 2 | Each placement uses rotation `0`, `90`, `180`, or `270` only. |
| 3 | A placement's declared `widthPx`/`heightPx` equal the rotated source's real dimensions. |
| 4 | No visible pixel (`alpha > alpha_threshold`) lies outside the sheet. |
| 5 | No two designs' visible pixels are closer than `margin_px`, measured in **Chebyshev** distance (`max(|dx|, |dy|)`). |
| 6 | Every visible pixel is at least `edge_margin_px` from all four sheet edges. |
| 7 | The reported sheet height is at least the lowest visible pixel. |
| 8 | The reported sheet width equals the roll width, exactly. |

**Chebyshev, not Euclidean.** The referee and the production *integrity gate*
both measure clearance as Chebyshev distance between nearest visible pixels
(`max(|dx|, |dy|)`), which is what a square cut gap means physically. A layout
legal under Chebyshev is also legal under Euclidean, but **not the reverse**.

Do not weaken this. A solver that "wins" on Euclidean gaps will be rejected.

> **This is the shipped packer's own bug, and you must not inherit it.** The
> production search certifies a gap with `geometry.buffer(margin_px/2 + 1,
> join_style="mitre")` and accepts the placement when the buffered silhouettes
> do not overlap. That is a **radial (Euclidean) offset**, while the gate
> demands a **Chebyshev** gap. On a diagonal the radial certificate is short by
> a factor of `sqrt(2)`:
>
> | `margin_px` | radius used (`m/2+1`) | radius needed (`m/sqrt2`) | worst certified Chebyshev gap |
> |---|---|---|---|
> | 30 | 16.0 | 21.2 | 22.6 px |
> | 60 | 31.0 | 42.4 | 43.8 px |
> | 120 | 61.0 | 84.9 | 86.3 px |
> | 354 | 178.0 | 250.3 | 251.7 px |
>
> So the certificate is ~29% short at every realistic margin, and the search
> can emit a layout its own gate rejects. Measured on `synthetic-12`: a pair
> accepted at 363 px Euclidean is only 273 px Chebyshev against a 354 px
> requirement. See §6.1. Fixing the radius to `margin_px / sqrt(2)` closes it
> exactly (verified at 60 px and 354 px, worst-case diagonal).
>
> The baseline in this kit uses square (`any`) pooling precisely so it cannot
> make this mistake. Do not copy the shortcut: you are asked to be both
> **correct** and **shorter**.

**Pixel margin conversion.** Clearances are given in millimetres and must be
converted with a ceiling, never rounded down:

```python
def pixels_for_mm(mm, dpi):
    return 0 if mm <= 0 else ceil(mm / 25.4 * dpi - 1e-9)
```

## 4. What you are given

```
packer-optimization-kit/
├── printsheet_nest/
│   ├── types.py        # Case, DesignSpec, PackParams, Placement, Layout
│   ├── referee.py      # the judge — exact, full resolution, not yours to change
│   ├── baseline.py     # the reference solver you must beat
│   ├── cases.py        # benchmark case generation
│   ├── harness.py      # run + score
│   ├── cli.py          # `python -m printsheet_nest.cli ...`
│   ├── production.py   # runs the *shipped* packer on a case (calibration)
│   └── crosscheck.py   # proves the referee agrees with production
├── cases/              # generated inputs (PNGs + case.json), regenerable
├── results/            # scores from previous runs
└── tests/              # tests for the referee and the baseline
```

Your solver is one callable:

```python
def solve(case: Case) -> Layout: ...
```

`Case` gives you the design list, each PNG's absolute path, its pixel
dimensions, and the sheet geometry. `Layout` is what you return: placements,
unplaced designs, and the sheet height you are claiming.

Read `types.py` first. It is short and it is the whole interface.

## 5. How you are scored

```bash
cd packer-optimization-kit
python -m printsheet_nest.cli build            # once: write cases/
python -m printsheet_nest.cli run --solver printsheet_nest.mine:solve --out results/mine.json
```

The harness:

1. calls your `solve(case)` and times **only that call**;
2. hands the returned `Layout` to `referee.judge`, which re-decodes every PNG at
   full resolution and checks all eight constraints;
3. scores `sheet_height_px` if the layout is legal, and `0` if it is not.

```
score = 0                       if the referee rejects the layout
score = sheet_height_px         otherwise
```

Aggregate across cases by summing the heights of the feasible cases. A run that
fails any case is a regression, regardless of its total: production must never
be able to place something you cannot.

Reading and judging happen **outside** the timer, so you cannot gain by doing
less verification — the referee always runs.

### Cases

| Case | What it stresses |
|---|---|
| `synthetic-04/08/12/20/30` | Smooth difficulty ramp. Soft-edged ellipses, some with holes. Rewards interlocking and order search. |
| `shop-ten` | Ten real fixtures at plausible print sizes: a flat vector logo (large dead area inside its bbox), a thin signature, a full-bleed collage (rectangular, no alpha), a pale smoke plume, a tall banner, a wide banner, a sticker with fringe, a logo with a black margin, and a low-res screenshot. |

`shop-ten` is the case that matters most: those are the shapes the packer
actually sees. The synthetic cases exist so you can iterate quickly and see a
smooth gradient rather than a single data point.

## 6. The baseline

`printsheet_nest.baseline:solve` is a **greedy bottom-left contact fill on a
coarse bitmap**:

* designs ordered largest visible area first, plus 7 seeded random permutations;
* for each design, the lowest legal row, then the leftmost free column, with the
  rotation that ranks lowest;
* collisions evaluated by FFT cross-correlation against a max-pooled bitmap;
* all positions quantized to `cell_px` (~16 px at 58 cm / 300 dpi).

It is safe by construction — pooling uses `any` and the clearance is padded in
whole cells, so a coarse clearance implies a legal pixel clearance — but it
leaves real value on the table.

Recorded results (`results/baseline.json` and `results/production.json`):

| Case | Baseline height (px) | Production height (px) | Production verdict |
|---|---|---|---|
| `shop-ten` | 8238 | 8157 | feasible |
| `synthetic-04` | 3846 | 4754 | feasible |
| `synthetic-08` | 6755 | 6573 | feasible |
| `synthetic-12` | 9710 | 9925 | **infeasible** |
| `synthetic-20` | 14723 | 15393 | **infeasible** |
| `synthetic-30` | 21497 | 20816 | **infeasible** |

Two things to read off that table.

**Production is only "shorter" on the cases it fails.** On `synthetic-12/20/30`
it reports a smaller height than the baseline, but the referee rejects the
layout, so the height is not a legal sheet and the run would deadlock the
workbench at export. Compare only *feasible* layouts — the three cases both
solvers actually solve:

| Case | Baseline | Production | Winner |
|---|---|---|---|
| `shop-ten` | 8238 | 8157 | production, by 81 px (1.0%) |
| `synthetic-04` | 3846 | 4754 | baseline, by 908 px (23.6%) |
| `synthetic-08` | 6755 | 6573 | production, by 182 px (2.8%) |

So production is modestly better on the two real-ish cases and much worse on
`synthetic-04`. Neither number is impressive: all three leave large areas empty.

**The baseline is slower than production but correct on all six.** Mean wall
clock is 21.2 s for the baseline versus ~617 s for production, but production's
number is dominated by `synthetic-30` at 2 375 s (39 minutes) — it has no
intra-ordering time cap, only a between-ordering one.

### 6.1 Production's gap-certification bug (measured, reproducible)

The shipped search certifies clearance with a **mitre buffer**, which is a
radial (Euclidean) offset, while its own integrity gate requires a **Chebyshev**
gap. The two agree on axis-aligned separations and diverge by up to `sqrt(2)`
on diagonals, so the search can emit a layout its gate then rejects.

The arithmetic is simple enough to check by hand. The gate wants
`max(|dx|, |dy|) >= margin_px`, which a *square* offset of half-width
`r = ceil((margin_px - 1) / 2)` certifies exactly (that is what
`block_radius_cells()` computes for the bitmap path). A *radial* buffer of `r`
instead certifies a Euclidean gap of `2r`, which is a Chebyshev gap of only
`2r / sqrt(2)` on a diagonal. Matching the gate therefore needs
`r >= margin_px / sqrt(2)`, but production uses `r = margin_px / 2 + 1`, which
is ~29% short for every margin above ~7 px:

| `margin_px` | radius used | radius needed | worst certified Chebyshev gap | shortfall |
|---|---|---|---|---|
| 30 | 16.0 | 21.2 | 22.6 px | 7.4 px |
| 60 | 31.0 | 42.4 | 43.8 px | 16.2 px |
| 120 | 61.0 | 84.9 | 86.3 px | 33.7 px |
| 354 | 178.0 | 250.3 | 251.7 px | 102.3 px |

Verified independently of the kit: two identical shapes, each buffered by
production's radius, stop intersecting only once they are 43.8 px apart in
Chebyshev terms at `margin_px=60` — a 16.2 px violation — for both a square and
a circular silhouette. Changing the radius to `margin_px / sqrt(2)` makes the
worst case exactly `margin_px` (60.00 and 354.00 px measured).

Reproduced on `synthetic-12` with production defaults (`cellMm=2.0`,
`randomizedOrderings=40`, `timeBudgetMs=5000`). The result is identical at
`cellMm=5.0`, so this is not a harness artefact:

| Pair | Euclidean silhouette gap | Packer's buffered test | Chebyshev gap | Required | Shortfall |
|---|---|---|---|---|---|
| `blob-03` / `blob-05` | 363.17 px | no overlap → **accept** | 273 px | 354 px | 81 px |
| `blob-10` / `blob-05` | 422.83 px | no overlap → **accept** | 329 px | 354 px | 25 px |

Production's own `verify_layout` agrees with the kit referee on the same layout:
2 overlapping dilated pairs, minimum pair gap 262 px against 354 required,
edge clearance 119 px against 118 required (passes). There are **no literally
overlapping visible pixels** — the violation is purely the gap rule, which is
still blocking.

Consequence in the product: packing succeeds, the integrity check fails, and
export is refused with `sheet-integrity-failed`. The operator is stuck until
they hand-edit placements. This is why correctness is a scored constraint and
not an afterthought, and why the kit's referee is independent of the solver.

Read `results/production.json` for the shipped packer's numbers on every case.
Beating the baseline is not the goal; beating production *while staying
feasible* is.

## 7. Where the value is

Ordered by expected payoff, from the baseline's own docstring:

1. **Greedy, single-pass.** A design that fits badly early is never moved. There
   is no backtracking, no local search, no repacking of a sub-region. Ruin-and-
   recreate (remove `k` designs, reinsert them in a better order) is the
   standard fix and usually the largest single win.
2. **Order sensitivity.** Only a fixed ordering plus random permutations are
   tried. Height, width, aspect ratio, perimeter, and contact-graph degree are
   all untried; there is no beam and no lookahead.
3. **No re-packing.** Once a design is down it never moves. Note that a
   slide-down post-pass is *provably a no-op* here — bottom-left already places
   each design as low as it can go given its predecessors — so the only way to
   improve is to remove and reinsert, not to nudge.
4. **Quantized positions.** Positions land on `cell_px` boundaries. A pixel-exact
   refinement pass that slides each design down and left in whole pixels,
   re-checking exact clearance, recovers up to `cell_px` px per stacked design.
5. **Sheet height is an output, not an objective.** Nothing minimises
   `max(visible y1)`. Treating height as an explicit objective — binary search
   on a candidate height, or a penalty term — opens up a much better search.
6. **Rotation choice is myopic.** The lowest-ranked rotation wins even when a
   taller, narrower one would let a later design nest above it.
7. **No interlocking search.** Concave regions are exploited only by accident of
   the scan order, never by explicitly targeting holes and pockets.
8. **One evaluation per ordering.** No beam, no lookahead, no lower bound on the
   remaining designs to cut a bad ordering early.

Two structural observations that are easy to miss:

* **The bbox is not the shape.** `flat-vector-logo` and `pale-mist` have large
  transparent regions inside their bounding boxes. Bbox-based packing wastes
  most of that area; silhouette-based packing does not. The referee only cares
  about visible pixels, so nesting into a neighbour's concavity is legal and
  valuable.
* **Full-bleed designs are rectangles.** `full-bleed-collage` has no alpha at
  all, so every pixel counts and no interlocking is possible with it. Treating
  it like a blob will mislead you.

## 8. Rules of engagement

**Allowed**

* Any algorithm, any library already in `requirements.txt` (`numpy`,
  `Pillow`, `shapely`), any amount of search within the time budget.
* Reading the PNGs however you like, including precomputing distance transforms
  or silhouette polygons.
* Returning unplaced designs when they genuinely cannot fit (the referee will
  still fail the case, but the run must not crash).

**Not allowed**

* Modifying `referee.py`, `types.py`, `cases/`, or the PNGs. The referee is the
  contract; changing it invalidates every score.
* Resampling, rescaling, or otherwise altering design pixels. Rotations by
  90° are the only permitted transform.
* Reporting a sheet height shorter than the artwork it contains.
* Special-casing a specific case by name or by exact dimensions. Tuning
  parameters per *shape class* is fine; hardcoding `if case.name == "shop-ten"`
  is not.
* Using the referee's internals to pre-compute answers. You may use the same
  geometric ideas, but the solver must stand alone.

## 9. Definition of done

A submission is acceptable when all of the following hold:

1. `python -m pytest tests -q` passes (the referee and baseline tests still
   pass; add your own tests alongside them).
2. `python -m printsheet_nest.cli run --solver <yours>` reports **6/6 feasible**.
3. The summed sheet height across the six cases is **strictly lower** than
   production's total in `results/production.json`.
4. No case is individually worse than production by more than 2%.
5. The solver is deterministic given `case.params.seed`, and respects
   `params.time_budget_ms` (checked between search iterations is fine).
6. Every placement it returns is legal under `referee.judge` — not "probably
   legal", not "legal after a fixup", but legal as returned.

Report your numbers in `results/<yourname>.json` and state, per case, the height
you reached versus production and versus the baseline.

## 10. Porting back to production

The kit is a research harness; the product still runs
`packer/printsheet_packer/nesting.py`. When your solver wins:

* the winning *search strategy* gets ported into `Packer` in the production
  package, keeping the existing `Layout`/`Placement` contracts;
* `printsheet_packer.integrity` stays exactly as it is — it is the shipped
  verifier and it already agrees with this kit's referee, pixel for pixel
  (see `python -m printsheet_nest.crosscheck cases/shop-ten`);
* the production packer must keep honouring `noInterlocking`, `cellMm`,
  `randomizedOrderings`, `timeBudgetMs`, and `seed` from the request contract.

Verify the port with:

```bash
cd packer && .venv/bin/python -m pytest -q
cd .. && python -m printsheet_nest.crosscheck cases/shop-ten
```
