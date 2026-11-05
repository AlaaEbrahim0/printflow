# Architecture Decision Records

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-service-split-and-stack.md) | Service split and stack | Accepted |
| [0002](0002-job-queue.md) | Database-backed job queue with leases | Accepted |
| [0003](0003-layered-export-format.md) | Layered export format and PSD/PSB limits | Accepted |
| [0004](0004-packer-algorithm.md) | Packer algorithm | Accepted |
| [0005](0005-storage-and-file-exchange.md) | Storage layout and file exchange | Accepted |
| [0006](0006-immutable-versioning.md) | Immutable versioning and approval | Accepted |

## Format

Each ADR contains: status, date, context, decision, consequences and
alternatives considered. Superseding an ADR means writing a new one and adding
a `Superseded by` line to the old one; do not rewrite accepted decisions
silently.

## Rules

- ADRs are part of the frozen Phase 0 design until changed explicitly.
- A decision that changes a contract also requires a contract version bump and
  a note in `AGENTS.md`.
- Keep ADRs short enough to read before touching the area they govern.
