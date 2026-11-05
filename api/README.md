# PrintSheet API

ASP.NET Core 10 LTS Web API, Clean Architecture layout.

Phase 0 contains only the composition root, a database-connectivity health
check and the unit-conversion domain primitive. Aggregates, state machines,
versioning, jobs and EF Core mappings arrive in Phase 1 track A.

## Projects

| Project | Responsibility |
| --- | --- |
| `PrintSheet.Domain` | Aggregates, value objects, invariants. No infrastructure dependencies. |
| `PrintSheet.Application` | Use cases, ports, validation, result types. |
| `PrintSheet.Infrastructure` | EF Core, PostgreSQL/SQLite, file store, job dispatch adapters. |
| `PrintSheet.Api` | HTTP transport and composition root. |
| `PrintSheet.Domain.Tests` | Fast domain tests without infrastructure. |

## Run natively

```bash
dotnet run --project src/PrintSheet.Api
```

The Development profile uses SQLite at `printsheet.dev.db`; Docker Compose uses
PostgreSQL. The database is only health-checked in Phase 0, not migrated.

## Test

```bash
dotnet test PrintSheet.slnx
```

The frozen HTTP contract lives in `../contracts/openapi/printsheet-api.yaml`.
