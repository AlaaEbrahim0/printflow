# ADR 0002 — Database-backed job queue with leases

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** PrintSheet engineering

## Context

Processing steps, packing, integrity checks and exports are asynchronous. The
system needs:

- at-least-once execution with bounded retries;
- a visible status for the UI (queued/running/succeeded/failed/cancelled);
- GPU serialization on one 4 GB device;
- job results applied only if the source version is still current;
- no extra infrastructure to operate on a single workstation;
- transactional consistency between “job completed” and “version created”.

Expected volume is tens of jobs per batch and a few batches per day, not
thousands per second. There is one operator and one image worker.

## Decision

Use the **application database** (PostgreSQL in Compose, SQLite in native
development) as the job queue. A `jobs` table holds type, capability, status,
parameters, paths, attempts, lease owner/token/expiry, timestamps and error.

Claim protocol:

1. Worker POSTs `workerId`, capabilities and desired lease seconds to
   `/api/v1/internal/jobs/claim`.
2. The API runs a short transaction that selects the oldest eligible `queued`
   job, marks it `running`, increments attempts, sets a random lease token and
   expiry, and returns the job envelope.
3. PostgreSQL uses `FOR UPDATE SKIP LOCKED`; SQLite uses a guarded update
   (`UPDATE ... WHERE id = ? AND status = 'queued'`).
4. Worker heartbeats before the lease expires and completes or fails with the
   lease token.
5. An expired lease requeues the job if attempts remain, otherwise marks it
   failed. A stale token cannot complete a job.
6. GPU capability is serialized: the claim query refuses a second `running`
   GPU job while one is active. The worker also validates
   `max_gpu_jobs = 1` at startup.

Jobs are separate from the `Batch` aggregate. The worker result is applied to
the batch in its own transaction, with a re-check that the parent version is
still current.

## Consequences

Positive:

- No Redis/RabbitMQ/Celery to install, monitor or back up. The database backup
  contains the queue.
- Enqueue and domain mutation can share a transaction (for example, create the
  export row and its job atomically).
- Job status is queryable with SQL and exposed directly by the API.
- Lease semantics handle worker crashes without a separate scheduler.
- GPU serialization is a query concern, not a worker convention.

Negative:

- Polling adds latency (default poll interval will be ~1 s). Acceptable for a
  human-in-the-loop tool.
- The jobs table needs cleanup/archival; completed jobs should be retained for
  audit but can be pruned after a configured period.
- A single database is a single point of failure. Acceptable on one
  workstation; revisit for multi-machine deployment.
- `SKIP LOCKED` is PostgreSQL-specific; SQLite has a separate implementation
  and weaker concurrency. The MVP is single-writer for SQLite development.

## Alternatives considered

- **Celery + Redis.** Mature Python queue, but adds two services and splits job
  state from domain state. The worker is Python, but the producer is .NET, so
  Celery would need an extra bridge anyway.
- **Hangfire (.NET).** Good fit for the API, but the Python worker would need
  custom polling; job state would still be duplicated.
- **RabbitMQ / NATS.** Operationally heavier than the problem justifies.
- **In-memory `Channel`/`BackgroundService`.** Loses jobs on restart and cannot
  coordinate the external worker.
- **Filesystem lock files.** No status, no attempts, no audit, fragile on
  Windows/Docker mounts.

## References

- `ARCHITECTURE.md` section 12.
- `contracts/openapi/printsheet-api.yaml` internal endpoints.
- `docs/domain-model.md` section 5.5.
