import { describe, expect, it } from 'vitest'
import {
  colorRangeSelect,
  describeColorRange,
  hueDistance,
  rgbToHsl,
  sampleColor,
} from './colorRange'

/** Build an RGBA buffer from `[r, g, b]` triples, alpha fixed at 255. */
const raster = (pixels: [number, number, number][], alpha = 255): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = alpha
  })
  return data
}

describe('rgbToHsl', () => {
  it('maps the primaries to their hue angles', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 })
    expect(rgbToHsl(0, 255, 0).h).toBeCloseTo(120)
    expect(rgbToHsl(0, 0, 255).h).toBeCloseTo(240)
  })

  it('reports zero saturation for greys and keeps lightness', () => {
    expect(rgbToHsl(128, 128, 128)).toEqual({ h: 0, s: 0, l: 128 / 255 })
    expect(rgbToHsl(255, 255, 255).l).toBe(1)
    expect(rgbToHsl(0, 0, 0).l).toBe(0)
  })
})

describe('hueDistance', () => {
  it('takes the shorter way around the wheel', () => {
    expect(hueDistance(10, 350)).toBe(20)
    expect(hueDistance(350, 10)).toBe(20)
    expect(hueDistance(0, 180)).toBe(180)
    expect(hueDistance(90, 90)).toBe(0)
  })
})

describe('sampleColor', () => {
  const image = raster([[10, 20, 30], [40, 50, 60]])

  it('reads the pixel under the point', () => {
    expect(sampleColor(image, 2, 1, { x: 1, y: 0 })).toEqual({ r: 40, g: 50, b: 60, a: 255 })
  })

  it('rounds a fractional point into the raster', () => {
    expect(sampleColor(image, 2, 1, { x: 1.4, y: 0.2 })?.r).toBe(40)
  })

  it('returns null outside the raster instead of reading adjacent memory', () => {
    expect(sampleColor(image, 2, 1, { x: 2, y: 0 })).toBeNull()
    expect(sampleColor(image, 2, 1, { x: -1, y: 0 })).toBeNull()
    expect(sampleColor(image, 2, 1, { x: 0, y: 1 })).toBeNull()
  })
})

describe('colorRangeSelect in RGB mode', () => {
  it('selects an exact match even at fuzziness 0', () => {
    // Regression: the budget used to be zero here, so every pixel normalised to
    // NaN and stored as 0 — the slider at its minimum produced an empty
    // selection with no explanation.
    const out = colorRangeSelect(raster([[255, 0, 0]]), 1, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 0 })
    expect(out[0]).toBe(255)
  })

  it('rejects a one-step difference at fuzziness 0', () => {
    const out = colorRangeSelect(raster([[255, 0, 1]]), 1, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 0 })
    expect(out[0]).toBe(0)
  })

  it('selects a matching colour wherever it appears, unlike the wand', () => {
    // Two separate red blobs with an unrelated pixel between them.
    const image = raster([
      [255, 0, 0], [0, 0, 255], [255, 0, 0],
    ])
    const out = colorRangeSelect(image, 3, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10 })
    expect(Array.from(out)).toEqual([255, 0, 255])
  })

  it('widens with fuzziness', () => {
    // The window is the *sum* of per-channel differences: fuzziness 10 gives a
    // budget of round(25.5) * 3 = 78, so a 20-away colour is inside it and a
    // 100-away colour is not.
    const image = raster([[255, 0, 0], [235, 0, 0], [155, 0, 0]])
    const tight = colorRangeSelect(image, 3, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 1 })
    const loose = colorRangeSelect(image, 3, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10 })
    expect(tight[0]).toBe(255)
    expect(tight[1]).toBe(0)
    expect(loose[1]).toBe(255)
    expect(loose[2]).toBe(0)
  })

  it('ramps the last quarter of the window instead of stepping hard', () => {
    // Budget 78 at fuzziness 10, so the feather covers distance 58–78. Measured
    // ramp: 60 → 235, 62 → 209, 70 → 105, 78 → 0. Each step further out must
    // fade, never snap from selected to rejected.
    const image = raster([[255, 0, 0], [195, 0, 0], [193, 0, 0], [185, 0, 0]])
    const out = colorRangeSelect(image, 4, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10 })
    expect(out[0]).toBe(255)
    expect(out[1]).toBeGreaterThan(0)
    expect(out[1]).toBeLessThan(255)
    expect(out[2]).toBeLessThan(out[1])
    expect(out[3]).toBeLessThan(out[2])
  })

  it('counts alpha as a channel only when asked', () => {
    const opaque = raster([[255, 0, 0]], 255)
    const transparent = raster([[255, 0, 0]], 0)
    const withoutAlpha = colorRangeSelect(transparent, 1, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10 })
    const withAlpha = colorRangeSelect(transparent, 1, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10, useAlpha: true })
    expect(withoutAlpha[0]).toBe(255)
    expect(withAlpha[0]).toBe(0)
    expect(colorRangeSelect(opaque, 1, 1, { r: 255, g: 0, b: 0 }, { fuzziness: 10, useAlpha: true })[0]).toBe(255)
  })

  it('returns an empty selection for a degenerate raster', () => {
    expect(colorRangeSelect(new Uint8ClampedArray(0), 0, 0, { r: 0, g: 0, b: 0 }, { fuzziness: 50 }).length).toBe(0)
  })
})

describe('colorRangeSelect in HSL mode', () => {
  it('keeps a gradient that shares the hue', () => {
    // A blue background varying only in lightness: an RGB key would need a
    // tolerance wide enough to bleed into artwork, HSL holds the hue. The
    // lightness window has to cover the full 0.42 spread from 255 to 40.
    const image = raster([[0, 0, 255], [0, 0, 128], [0, 0, 40]])
    const out = colorRangeSelect(image, 3, 1, { r: 0, g: 0, b: 255 }, {
      fuzziness: 30,
      metric: 'hsl',
      hueTolerance: 5,
      lightnessTolerance: 80,
    })
    expect(Array.from(out)).toEqual([255, 255, 255])
  })

  it('rejects a different hue however close in lightness', () => {
    const image = raster([[255, 0, 0], [0, 255, 0]])
    const out = colorRangeSelect(image, 2, 1, { r: 255, g: 0, b: 0 }, {
      fuzziness: 30,
      metric: 'hsl',
      hueTolerance: 5,
      lightnessTolerance: 60,
    })
    expect(out[0]).toBe(255)
    expect(out[1]).toBe(0)
  })

  it('selects only the exact colour when every window is zero', () => {
    const image = raster([[255, 0, 0], [255, 0, 1]])
    const out = colorRangeSelect(image, 2, 1, { r: 255, g: 0, b: 0 }, {
      fuzziness: 0,
      metric: 'hsl',
      hueTolerance: 0,
      saturationTolerance: 0,
      lightnessTolerance: 0,
    })
    expect(out[0]).toBe(255)
    expect(out[1]).toBe(0)
  })
})

describe('describeColorRange', () => {
  it('names the single knob in RGB mode', () => {
    expect(describeColorRange({ fuzziness: 42 })).toBe('fuzziness 42')
  })

  it('lists each window in HSL mode', () => {
    const text = describeColorRange({ fuzziness: 20, metric: 'hsl' })
    expect(text).toContain('fuzziness 20')
    expect(text).toContain('hue ±36°')
    expect(text).toContain('sat ±20')
    expect(text).toContain('light ±20')
  })
})
