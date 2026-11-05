# PrintSheet Packer

Standalone Python library and CLI. It has no dependency on `/api` or `/worker`;
the contract is file-based.

Phase 0 contains the package shell, the frozen JSON contract references and the
PSD/PSB spike. The nesting engine, integrity checks, strip renderer and
exporters are implemented in Phase 1 track C.

## Contract

```bash
python -m printsheet_packer version
python -m printsheet_packer validate \
  --contract packer-request \
  --document ../contracts/examples/packer-request.json
```

Contract version 1.0 is frozen in `../contracts/jsonschema/`.

## Phase 1 boundaries

- Mask from alpha at a low threshold (default 5/255).
- Conservative occupancy grid (default 5 mm), dilation by half the margin.
- Placement by largest area, rotations 0/90/180/270, randomized orderings.
- No interlocking mode via convex hulls.
- Integrity checks and strip-based lossless rendering.
- Flat PNG/TIFF, layered export and the PSD rebuild fallback.
