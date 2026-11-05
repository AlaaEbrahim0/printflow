# Vendored contract schemas

These two files are **byte-for-byte copies** of the frozen contracts:

- `../../contracts/jsonschema/worker-job.schema.json`
- `../../contracts/jsonschema/worker-result.schema.json`

They exist only as a fallback for container images, whose build context is
`worker/` and therefore cannot see the repository's `contracts/` directory.

Resolution order at runtime (see `app/contracts.py`):

1. `PRINTSHEET_CONTRACTS_DIR`
2. the nearest `contracts/jsonschema` found by walking upward from the package
3. this directory

`tests/test_contracts.py` fails if the repository copy and this copy ever
diverge, so the fallback can never silently drift from the frozen contract.
Never edit a file in here to make a test pass — change the real contract in
`contracts/` (with a version bump) and re-copy it.
