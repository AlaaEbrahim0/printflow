# ADR 0005 — Storage layout and file exchange

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** PrintSheet engineering

## Context

The API, worker, packer and export runner run in separate processes and,
under Compose, separate containers. They must exchange images, masks, SVG
artifacts, sheet manifests and exports. The options are:

- embed bytes in JSON (base64 or multipart between services);
- store blobs in the database;
- use an object store (S3/MinIO);
- use a shared filesystem volume.

The files are large (a tall sheet can be hundreds of MB), immutable once
written, and need random access for strip rendering. The deployment is a
single workstation. The packer must be runnable standalone from the CLI for
tests and benchmarks, without an API or database.

## Decision

Use a **shared storage directory** with **relative paths** in every
service-to-service contract.

Layout:

```text
storage/
  {batchId}/
    designs/{designId}/versions/{versionId}.png
    designs/{designId}/versions/{versionId}/mask.png
    designs/{designId}/versions/{versionId}/vector.svg
    jobs/{jobId}/input/...
    jobs/{jobId}/output/...
    sheets/{sheetId}/{revision}/preview.png
    sheets/{sheetId}/{revision}/placements.json
    sheets/{sheetId}/{revision}/source-manifest.json
    exports/{exportId}/{artifact}
    exports/{exportId}/integrity-report.json
```

Rules:

1. Contracts carry paths relative to the storage root, never absolute paths
   and never `..`. The JSON Schemas encode the pattern; `IFileStore` validates
   again.
2. The API assigns input and output paths when it creates a job. Workers do not
   choose their own paths.
3. **Version files are write-once.** A new step gets a new version directory and
   file. Nothing overwrites an existing version, original or approved.
4. Writes are atomic: write to a temporary file in the same directory, flush,
   then rename. A crash leaves a `.tmp` file, never a truncated version.
5. Reads use opaque IDs; user-supplied filenames never become path segments.
6. The browser downloads through the API; it never sees the storage root.
7. Intake is the sole exception to “no file bytes over HTTP”: a browser must
   upload the original somehow. The API validates it and writes it immutably.
8. Cleanup may remove temporary files and unreferenced job scratch space. It
   must never remove a version, sheet artifact or export recorded in the
   database. “Nothing is lost” outranks disk savings.
9. The storage root is configurable (`Storage:Root`; `/data/storage` in
   Compose, `storage` in native development) and mounted into the API and
   worker. The packer CLI receives the root plus relative paths.

The database stores only paths, IDs, hashes and metadata, never image blobs.

## Consequences

Positive:

- Large files stay out of JSON and out of the database; no base64 inflation.
- The packer can run against a directory in tests with no service running.
- Strip rendering can seek/read source files directly.
- Backups are “database + storage directory”, both easy to reason about.
- The same layout works natively and in Compose.

Negative:

- Compose must mount the same volume into API and worker; a misconfigured mount
  is a real failure mode. Health checks should verify writability.
- A single filesystem is a single point of failure and does not scale across
  machines. Revisit with object storage if the shop adds a second workstation.
- Atomic rename semantics differ on some network filesystems; the MVP uses
  local disks or Docker volumes, not SMB/NFS.
- Orphan cleanup needs care; a conservative “never delete referenced files”
  policy means disk usage grows.

## Alternatives considered

- **S3/MinIO.** Correct for multi-machine, but adds a service and network
  dependency to a local workstation. The packer would need an S3 client and
  range reads. Future option behind the same `IFileStore` port.
- **Database blobs.** Simple consistency, but bloats backups, hurts streaming
  and strip rendering, and makes the standalone packer depend on the database.
- **Base64 in JSON.** 33% inflation, huge request bodies, memory spikes; the
  contracts explicitly forbid it.
- **Per-service private storage + copy.** Duplicates large files and creates
  consistency problems; the packer and API need the same bytes.

## References

- `ARCHITECTURE.md` section 11.
- `AGENTS.md` section 4.
- `contracts/jsonschema/*.schema.json` (`relativePath` definitions).
- `docs/domain-model.md` sections 3.3 and 8.
