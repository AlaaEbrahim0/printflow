# ADR 0007 — Placement guarantee, target fitting and retired steps

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** PrintSheet engineering
- **Supersedes:** [0004](0004-packer-algorithm.md) for placement geometry and
  the integrity check set

## Context

Contract 1.0 assumed the packer could place every approved design by search and
treated four checks as the whole export gate. Real batches showed three gaps:

1. The packer could return fewer placements than the operator selected without
   the report saying so. The sheet then looked exportable while a design was
   missing.
2. Operators sometimes set a physical target size without a matching resize
   proposal. The packer had to either reject the sheet or ignore the target.
3. Background removal and vectorization consumed most of the worker surface
   (masks, brushes, AI models, Potrace/VTracer, SVG rasterization) while the shop
   continued to finish cleanup in Photoshop. The user prioritized enhancement,
   GPU speed and review time instead.

Product constraints that remain: originals are immutable, every visible-pixel
change is a proposal, export is blocked by a machine-readable check, and nothing
may be silently omitted from a sheet.

## Decision

1. **Retire background removal and vectorization for new work.** The API no
   longer exposes their proposal endpoints; the worker rejects their job types
   with a structured `retired` reason. Historical versions, mask/SVG artifacts
   and schema documents remain readable. The web UI drops the brush editor and
   those controls.
2. **Use exact alpha-silhouette polygons for placement.** The packer buffers the
   visible silhouette by `margin/2` (Shapely), generates integer-pixel contact
   candidates from polygon bounds, holes and obstacle vertices, and rejects any
   intersecting placement. The full rotated source raster must fit on the sheet;
   transparent padding cannot be clipped.
3. **Report every unplaced design.** Designs that exceed the roll or have no
   legal placement are returned in `unplacedDesigns` with a stable reason. The
   deterministic order is tried first, then seeded random orderings; the
   objective minimizes unplaced count before sheet height.
4. **Make `all-designs-placed` a fifth blocking check.** `IntegrityReport`
   `schemaVersion` becomes `2.0`. `passed` is false if any requested design is
   unplaced. A `designIds` subset pack is a preview: omitted designs are
   reported as `not-selected`, so that sheet cannot export until they are packed
   too or explicitly excluded.
5. **Fit to an explicit target box at pack time only when needed.** If the
   approved pixels already match the operator's target box at the working DPI,
   nothing is resampled. If they differ, the packer Lanczos-fits once preserving
   aspect ratio and emits a `target-resampled` warning. The final resize
   proposal remains the normal path.
6. **Version the envelopes.** Packer responses and integrity reports use
   `schemaVersion` `2.0`. Historical `1.0` documents remain valid to read but do
   not satisfy the five-check export gate.

## Consequences

- A sheet can no longer be exported with a silently missing design.
- Subset packing is useful for layout preview but cannot become an export
  shortcut; the operator must include or exclude every design explicitly.
- Exact polygons place tightly around real silhouettes and expose contact
  positions the grid search missed, at the cost of more Shapely work per
  candidate. Seeded orderings keep results reproducible.
- The worker and Compose image are smaller and no longer depend on rembg,
  Potrace, VTracer or SVG rasterization. Historical artifacts stay available.
- A target change without a resize proposal is visible in the report and
  reviewable instead of silently ignored or rejected.
- Contract 2.0.0 is a breaking API change; every track must stay aligned.

## Alternatives considered

- **Keep the grid packer and add a warning for missing placements.** Rejected:
  a warning does not block export and still loses a design.
- **Reject any pack that omits a selected design.** Rejected: it hides the
  useful subset-preview workflow and gives no per-design reason.
- **Let subset packs export.** Rejected: it silently drops customer designs.
- **Scale the artwork in the browser or exporter.** Rejected: it moves a
  visible-pixel change outside the immutable proposal/approval path.
- **Keep removal/vectorization behind a flag.** Rejected for now: the user
  explicitly prioritized enhancement, and an unused second path would keep the
  heavy dependencies and tests alive.
