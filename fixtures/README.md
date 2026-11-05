# Fixtures

Realistic, deliberately awkward sample inputs for Phase 2 end-to-end tests and
for manual review of trim, background removal, upscale, vectorize and packing.

The images are **generated, not committed**. This keeps the repository small
and makes every input reproducible.

```bash
python3 scripts/generate_fixtures.py
# or
python3 scripts/generate_fixtures.py --out /tmp/printsheet-fixtures --clean
```

Requires Pillow. Output (git-ignored):

```text
fixtures/generated/
  images/*.png|jpg
  manifest.json
  contact-sheet.png
```

The manifest records dimensions, alpha, target size, effective DPI, SHA-256 and
the expected classification/trim/background behavior for each design. The
contact sheet composites every design over a checkerboard so alpha fringes are
visible.

## Coverage

| Fixture | What it exercises |
| --- | --- |
| `full-bleed-collage.png` | No auto-trim when all four edges are non-uniform |
| `white-smoke-on-black.png` | Faint smoke/mist; low alpha threshold; color-to-alpha |
| `flat-logo-black-margin.png` | Uniform background, clean trim, vectorize candidate |
| `thin-signature-gray.png` | Thin 3 px strokes, ~94 DPI, 4× upscale |
| `pale-mist-white.png` | Low contrast; aggressive AI cutout would destroy the art |
| `sticker-fringe.png` | Alpha, white halo, semi-transparent speckles |
| `tall-banner.png` | Tall transparent art, 90° rotation, strip rendering |
| `overwide-banner.png` | 67.7 cm wide at 300 DPI; must not be silently scaled |
| `lowres-screenshot.jpg` | 360 × 240 JPEG, block artifacts, ~91 DPI |
| `flat-vector-logo.png` | Flat shape on transparency; vectorize should win |

## Rules

- Do not hand-edit generated images; change the script and regenerate.
- Keep the manifest deterministic (`generatedAt` is fixed).
- Never commit `fixtures/generated/`.
- When a Phase 2 test needs a new edge case, add it to the script and to this
  table, not as an ad-hoc binary.
