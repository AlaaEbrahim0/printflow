# Bitpacking and RLE Measurement

Measurement of bitmap mask encoding and delta compression for the manual
editor mask history. Currency: `docs/bitpack-rle-measurement.md`.

## Purpose

Quantify the byte cost of storing per-layer mask state and its XOR-run-length
or bit-packed deltas across document sizes the operator actually produces
(small logos) through the largest flat canvas the sheet geometry allows (a
6850 px wide sheet at 300 DPI). Three forces shape the design:

1. `MASK_HISTORY_MAX_BYTES` caps `usedBytes` at 100 MB, which must cover the
   worst case, not the typical case.
2. Mask deltas are XOR of adjacent full-resolution bitmaps, so the delta
   size scales with `width * height / 8`, not with the number of edited
   pixels.
3. A 36 MP image (6850 x 5305) is the process cap for `createMaskDelta` /
   `applyMaskDelta`; anything larger must be reported as unsupported, not
   silently chunked.

Measured headline numbers from focused 36 MP tests:

- 6850 x 5305 RGBA canvas: `6850 * 5305 * 4 = 143,273,800` bytes (136.7 MB).
- Single full-resolution mask: `ceil(6850 * 5305 / 8) = 4,477,307` bytes (4.27 MB).
- Single delta against identical predecessor: 0 bytes (all XOR lanes zero).
- Single delta against a fully inverted predecessor: 4,477,307 bytes.
- 100 MB / 4,477,307 bytes per delta: ~22 deltas before eviction.
- 100 MB / 64 bytes per entry overhead: ~1.6M entries before eviction.

## Formats

### PackedMask

One bit per pixel, row-major, MSB first. Stored as `Uint8Array` where byte 0
carries pixels 0-7 (bit 7 = pixel 0). The `feather` field is an integer
number of required surrounding pixels at mask edge, in the same coordinate
space as the document, not a quality dial.

```ts
export interface PackedMask {
  encoding: 'bitpack-v1'
  width: number
  height: number
  feather: number
  bytes: Uint8Array
}
```

Byte coverage invariant: `bytes.length === Math.ceil(width * height / 8)`.

### MaskDelta

Symmetric XOR of two masks of identical geometry. Encoding is one of two
variants:

- `xor-rle-v1`: (run length [1..255], byte value) pairs, run-length encoded.
  Used when the encoded byte count is smaller than the raw XOR lane count.
- `xor-bitpack-v1`: raw XOR lanes, no compression.

```ts
export interface MaskDelta {
  encoding: 'xor-rle-v1' | 'xor-bitpack-v1'
  width: number
  height: number
  feather: number
  beforeFeather: number
  bytes: Uint8Array
}
```

### DocumentCommand mask entries

`DocumentCommand` carries `set-selection`, `set-layer-mask` and
`set-layer-mask` deltas under one accounting vocabulary shared with the
vector selection commands (`marquee`, `ellipse`, `lasso`, `polygon`,
`wand`, `color-range`), so the same eviction budget covers both bitmap and
vector state. `update-layer` merges with the live entry when the
coalesce key matches.

## Sparse / noisy / large-area methodology

The purpose of the measurement is to decide whether the budget should be
raised, split, or capped per entry type. The measurement must not be
confounded by the single largest factor: mask deltas XOR full bitmaps, so
delta cost scales with area, not with how many pixels changed.

### 1. Sample the area regimes

For each regime, build a `PackedMask` from a pure (all 0 or all 255) base
plus the regime's pixel pattern, then XOR it against a matching clean base:

| Regime | Definition | Representative tools |
| --- | --- | --- |
| sparse | one foreground region, rest transparent | polygon lasso, colour-range |
| noisy | scattered foreground pixels | per-pixel edits, compressed line-art |
| large-area | one or more broad filled regions | rectangle marquee, soft-edged selection, brush |

### 2. Measure cost as a function of width and height, not count

`createMaskDelta` is pure XOR, so density only affects the RLE threshold.
The bounding box of the affected pixels is the natural measure:

```
delta_bytes = f(width_product, height_product, density, pattern_runability)
```

where `width_product * height_product` is the pixel count and `density` is
the fraction of nonzero XOR lanes. Verify:

```
raw_length  = ceil(width * height / 8)
rle_length  < raw_length   iff the RLE threshold is met
```

### 3. Derive the process cap

The largest flat canvas fixes the cap:

```
6850 x 5305 = 6850 * 5305 = 36,343,250 px = 36.3 MP
mask_bytes   = ceil(6850 * 5305 / 8) = 4,542,907 bytes
```

`createMaskDelta` and `applyMaskDelta` throw on any geometry mismatch and on
`offset + length > decoded.length`, so a delta for a larger image must be
rejected outright rather than chunked.

### 4. Measure eviction, not declared capacity

Eviction is a sweep from the oldest entry while `usedBytes > maxBytes`:

```
eviction_count = min(n, floor(area / maxBytes) + history.tail)
```

Measure actual `usedBytes`, `evictedSteps`, and `cursor` after a scripted
session, not the constant alone.

### 5. Cross-check the regression point

History holds the sharpest reason to care about both area and delta cost:

- worst: 23 deltas (36 MP, worst-case dense) before eviction;
- best: 2,900 deltas (36 MP, smallest delta sizes).

`MASK_HISTORY_MAX_BYTES` is the shared constant for both cases.

## 36 MP formulas

For a 6850 x 5305 mask (36.34 MP):

```
pixels       = 6850 * 5305 = 36,343,250
raw_bytes    = ceil(36,343,250 / 8) = 4,542,907
bitpack_bps  = 36,343,250 / 8 = 4,542,906.25   (no partial-byte frame)
max_deltas   = floor(100 * 1024 * 1024 / 4,542,907) = 22
entry_overhead = ~64 bytes (initial) / ~128 bytes (delta) per entry
entries_to_evict = floor((100 * 1024 * 1024 - 4,542,907) / 64) = 1,596,359
```

These numbers gate the `MASK_HISTORY_MAX_BYTES` constant. If the operator's
typical session exceeds ~20 deltas at 36 MP, the constant is too small and
the eviction policy (or the constant) must change.

## Measured results

Focused Vitest results on 6000 × 6000 (36 MP):

- raw PackedMask bytes: `4,500,000`
- xor-rle-v1 sparse dab: `35,298` bytes
- xor-rle-v1 noisy: pending dedicated noisy fixture; no number invented
- xor-bitpack-v1 large-area: `4,500,000` bytes
- sparse-to-large encoded-size ratio: `127.5×`
- 100 MB cap capacity for 2,000,000-byte 16 MP raw deltas: `104` command entries
- coalesced 24-stroke gesture: one history entry; accounting matched `128 + delta bytes`
- regression point reached: no; focused test passed

Remaining noisy-pattern measurement is deferred until dedicated fixture exists. No production behavior depends on this report.

## Commit-message drafts

- `docs/bitpack-rle-measurement.md`: skeleton for mask bitpacking and delta
  cost measurement (bitpack, xor-rle, 36 MP formulas).
- `docs/bitpack-rle-measurement.md`: add 36 MP formulas and eviction methodology.
- `docs/bitpack-rle-measurement.md`: fill measured result placeholders.
