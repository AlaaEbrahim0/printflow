# ADR 0001 — Service split and stack

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** PrintSheet engineering

## Context

PrintSheet is an internal, single-operator workbench for a DTF T-shirt printing
business. The workload has four very different shapes:

1. **Domain and review state.** Batches, designs, immutable versions, approvals,
   target sizes, packing revisions and exports. Transactional, auditable,
   strongly typed.
2. **Image processing.** Trim, crop, upscale (Real-ESRGAN), resize.
   Python-native libraries, GPU-bound, failure-prone, long-running. Background
   removal and vectorization were later retired; see
   [0007](0007-placement-guarantee-and-scope.md).
3. **Packing and export.** Raster masks, nesting search, integrity checks and
   strip rendering of very tall sheets. CPU/memory-bound, Python-native
   (NumPy/Pillow/Shapely), independently testable.
4. **Review UI.** Canvas-heavy crop/brush tools, honest alpha previews, batch
   grid and packing preview. Browser-side.

The machine is a modest workstation: GTX 1650 Ti with 4 GB VRAM. GPU work must
be serialized. There is no ops team and no cloud requirement; Docker Compose is
the deployment target.

## Decision

Use four deployable units with one language per concern:

| Unit | Stack | Responsibility |
| --- | --- | --- |
| `api/` | ASP.NET Core 10 LTS, C#, Clean Architecture | Domain state, version pointers, jobs, HTTP, persistence |
| `worker/` | Python 3.12 + FastAPI | Pixel processing and classification |
| `packer/` | Python package + CLI, no API/worker imports | Nesting, integrity checks, rendering, export artifacts |
| `web/` | React 19 + TypeScript + Vite | Review and packing UI |

The API uses EF Core with PostgreSQL (Compose) and SQLite (native
development). The worker and packer exchange files with the API through a
shared storage directory, never by embedding image bytes in JSON.

The packer is deliberately not a long-running service in Phase 0/1. It is a
library/CLI so it can be run from tests, a benchmark, or a job runner. A thin
runner in Phase 2 adapts it to the job queue.

## Consequences

Positive:

- The domain is implemented in a language with strong typing and good
  transactional tooling; EF Core migrations and optimistic concurrency are
  straightforward.
- Image work uses the Python ecosystem directly (Pillow, psd-tools,
  Real-ESRGAN wrappers, potrace/vtracer bindings, rembg/BiRefNet).
- The packer can be unit-tested and benchmarked without a database, an API or
  a running worker. That matters because it carries the strongest invariants.
- Failure domains are separate: a GPU OOM or a huge sheet cannot take down the
  review UI or corrupt domain state.
- The web app never needs filesystem knowledge or service secrets.

Negative:

- Two runtimes and two dependency ecosystems to build and secure.
- The contract between API and worker must be versioned and validated. This is
  mitigated by the frozen JSON Schemas and `scripts/validate_contracts.py`.
- Cross-service operations are asynchronous; the UI must poll jobs and handle
  partial failure.
- Docker images are larger and Compose has more moving parts.

## Alternatives considered

- **Single Python monolith (FastAPI + SQLAlchemy + worker in-process).** Faster
  to start, but mixes long GPU jobs with request handling, weakens the domain
  model, and makes immutable-version transactions harder to keep clean.
- **Single .NET service with Python sidecars for imaging.** Keeps domain
  cohesion but still has two runtimes; the packer would lose its standalone
  testability.
- **Node/TypeScript backend.** Good for the web team, but the image and packing
  ecosystem is weaker and the packer would still be Python.
- **Serverless/cloud functions.** Contradicts the local, confidential-artwork
  requirement and the fixed workstation/GPU.

## References

- `ARCHITECTURE.md` sections 2, 4, 5.
- ADR 0002 (queue), ADR 0005 (file exchange), ADR 0006 (versioning).
