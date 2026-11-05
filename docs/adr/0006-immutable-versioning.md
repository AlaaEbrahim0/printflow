# ADR 0006 — Immutable versioning and approval

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** PrintSheet engineering

## Context

Customer artwork is often a low-quality screenshot. Every processing step can
destroy detail: an aggressive trim can cut a signature, background removal can
eat smoke, an upscale can hallucinate, vectorization can simplify away a thin
line. The operator must be able to compare, reject and go back. The business
cannot afford silently altered artwork or lost originals.

The product rules are explicit:

- the original upload is never modified;
- every processing step creates a new immutable version;
- only approved versions may become current;
- reject, undo and revert-to-any-earlier-version must work;
- anything that changes visible pixels is a proposal requiring approval.

## Decision

Model designs as an **append-only version history with a current pointer**.

- A `DesignVersion` is created once with a file, step type, parameters and
  parent. Its pixels and parameters never change. Only its status changes:
  `proposed` → `approved` or `rejected`.
- The original upload is an `original` version, `approved` at creation, and is
  never overwritten.
- A step command snapshots the current version as the parent, creates a new
  output path, and enqueues a job. The result becomes a `proposed` version; the
  current pointer does not move.
- A human approves or rejects the proposal. Approval moves the current pointer
  and marks the version approved. Rejection marks it rejected and leaves the
  current pointer alone.
- There is **at most one proposed version per design**. Starting a new step
  while one is pending is rejected (`proposal-in-flight`).
- A proposal is valid only while its parent is the current version. If the
  current pointer moves, the proposal is marked `rejected` with
  `stale-parent`; it is **never rebased** onto the new current version. A stale
  result must be re-run against the new source.
- Revert moves the current pointer to any earlier approved version. It does
  not create, delete or modify a version. Undo is revert-to-parent.
- If the reverted-to version is not a resize matching the declared target size,
  the design returns to `in-progress`; readiness is always derived, never
  remembered.
- Version files are write-once. Reject, revert and exclude only move pointers
  and statuses. Cleanup never deletes a version file.
- Every transition writes an append-only audit entry (actor label, action,
  entity IDs, reason, before/after summary).

The expensive consequence is storage and file count; that is accepted. A
20-design batch with five versions each is 100 files, which is trivial compared
with the cost of losing artwork.

## Consequences

Positive:

- The original and every intermediate result remain available for comparison,
  audit and recovery.
- Reject/undo/revert are pointer operations, not destructive edits, so they are
  cheap and safe.
- Proposals are reviewable without risking the current approved pixels.
- Stale-result handling is explicit and testable: a job that finishes after its
  parent moved fails `stale-source` instead of silently producing a
  half-related version.
- The history is the audit trail; no separate “what changed” reconstruction is
  needed.

Negative:

- Disk usage grows monotonically until a deliberate retention policy exists.
  The MVP prefers safety over cleanup; any future pruning must never touch
  versions referenced by a sheet/export or the current pointer.
- The UI must make history legible (thumbnails, parent chain, status), or the
  operator will be confused by many versions.
- Only one pending proposal means the operator cannot queue two alternative
  steps for the same design simultaneously. This is deliberate: it prevents
  ambiguous approvals.
- Reverting to a non-resize requires re-approving a resize before the design is
  ready again. That is correct but adds a step.

## Alternatives considered

- **Mutable “current image” with undo in memory.** Fast but violates the
  original-preservation rule and loses history on restart. Rejected.
- **Git-like DAG with branches and merges.** More general than needed. The
  linear parent chain plus a current pointer covers revert and undo; branches
  would complicate approval and packing without a user need.
- **Auto-apply every step.** Contradicts “the machine proposes, the human
  approves” and makes silent damage likely.
- **Keep only the original and the final.** Saves disk but prevents auditing
  which step introduced a halo or lost a line, and prevents reverting to an
  intermediate good version.
- **Rebase stale proposals automatically.** Convenient but changes the
  relationship between the reviewed preview and the actual parent; rejected
  explicitly by the product rules.

## References

- `AGENTS.md` section 2 and section 8.
- `docs/domain-model.md` sections 3.2, 3.3, 5.2, 6.2–6.5.
- `contracts/openapi/printsheet-api.yaml` version endpoints.
