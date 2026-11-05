# ADR 0004 — Packer algorithm

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** PrintSheet engineering

## Context

The packer receives 20–40 approved designs (occasionally up to ~200) with
transparent alpha, and must place them on a sheet that is exactly 58 cm wide
(6850 px at 300 DPI). Sheet height is variable and directly determines print
cost, so the objective is to minimize height while keeping a configurable gap
between visible pixels.

Hard constraints:

- never resample, recolor or crop pixels;
- only translate and rotate by exactly 0/90/180/270°;
- render from full-resolution approved files, not previews or masks;
- faint alpha (smoke, mist, anti-aliased edges) counts as occupied;
- a gap of `marginMm` (default 30 mm) must remain between visible pixels;
- placements must not overlap after dilation;
- a design wider than the usable roll is rejected, never auto-scaled;
- the result must be reproducible from a recorded seed.

Designs are irregular: logos with holes, signatures, smoke clouds, tall
banners. Rectangle bin packing is too coarse and would waste height.

## Decision

Use **raster-mask nesting with conservative occupancy grids**:

1. **Mask construction.** Decode each approved RGBA version. A pixel is
   occupied when `alpha > alphaThreshold` (default 5/255). The low threshold
   deliberately includes faint smoke. Preserve interior holes (do not fill
   them). Record the visible bounding box.
2. **Dilation.** Dilate each mask by `margin / 2` (in pixels, rounded up). Two
   dilated masks may not overlap; therefore the visible pixels of any two
   designs are at least `margin` apart. Edge margins are enforced against the
   sheet border.
3. **Occupancy grid.** Downsample masks to a grid with `cellMm` (default 5 mm)
   cells. Grid dimensions round **up**, so a cell is occupied if any pixel in
   it is occupied. The grid may overestimate occupied area, never underestimate.
4. **Placement search.** Sort by descending mask area (largest first). For each
   design, try rotations `0, 90, 180, 270` when `allowRotation`, and place at
   the lowest feasible y then lowest x (bottom-left skyline style). Collision
   checks are vectorized NumPy bitwise operations on the grid; the full mask is
   used for verification after a candidate placement.
5. **Randomized restarts.** Run N randomized orderings (default 30) within a
   time budget (default 60 s), keeping the shortest sheet. Ties break on lower
   total occupied area / earlier placement. The RNG seed is recorded in the
   response; the same seed and inputs reproduce the same placement.
6. **Optional simple mode.** `noInterlocking = true` uses axis-aligned bounding
   boxes or convex hulls (Shapely) instead of raster masks. This is a
   predictable fallback for troubleshooting, not the default.
7. **Verification.** Before returning, re-check every placement against the
   full-resolution masks and reject any overlap or out-of-bounds result.
8. **Rendering.** Render the sheet from the approved full-resolution version
   files, in horizontal strips (target ~512–1024 rows), applying only 90°
   rotations and integer translation. Never allocate the full sheet canvas.
   Rotated dimensions swap width/height; no interpolation is used.
9. **Manual edits.** The UI may translate/rotate (90° steps). The server
   accepts the arrangement, marks the sheet `unchecked`, and requires a new
   integrity check. The packer never “fixes” manual placements silently.

The response contains placements in cm (top-left origin) and px, plus the
integrity report. All four checks are blocking:

- `visible-pixels-inside-sheet`
- `dilated-masks-no-overlap`
- `minimum-gap`
- `pixel-equality` (rendered region equals the approved source after rotation)

## Consequences

Positive:

- Irregular shapes and holes are handled naturally; smoke and thin lines are
  respected.
- The low alpha threshold and round-up grid are conservative: they may waste a
  little space but never under-count occupancy.
- Deterministic seeds make packing debuggable and support regression tests.
- Strip rendering keeps memory bounded for ~59,000 px tall sheets.
- The algorithm is pure Python/NumPy and independently testable, with no
  database or API dependency.

Negative:

- Occupancy grids and repeated collision checks are slower than rectangle
  packing. The time budget and randomized restarts bound it; a 40-design batch
  should stay in seconds-to-a-minute.
- Downsampling can lose thin features unless the grid is fine enough; the full
  mask verification is the safety net. The default 5 mm cell at 300 DPI is
  ~59 px, which is a compromise; tests must cover 1-pixel lines and faint
  gradients.
- The search is heuristic; it does not prove optimal height.
- Very large designs increase mask memory; masks are stored at grid resolution,
  not full sheet resolution, but per-design full masks are still needed for
  verification.

## Alternatives considered

- **Rectangle bin packing (MaxRects, skyline).** Fast but wastes height on
  irregular art and ignores holes/smoke. Rejected as the default; kept as the
  `noInterlocking` fallback.
- **No-fit polygon / computational geometry nesting.** Better packing for
  vector shapes, but complex, sensitive to floating point, and still needs
  raster verification. Possible future optimization.
- **Commercial nesting library.** Cost, licensing, and integration risk;
  unclear quality on faint alpha.
- **Downsample everything to the grid and never verify full-res.** Fast but
  violates the “never underestimate” rule and can clip faint edges.
- **Arbitrary-angle rotation.** Would require resampling and violates the
  product rule. Never.

## References

- `ARCHITECTURE.md` section 8.
- `contracts/jsonschema/packer-request.schema.json`,
  `packer-response.schema.json`, `integrity-report.schema.json`.
- `docs/domain-model.md` sections 3.4 and 7.
