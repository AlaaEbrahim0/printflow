import { describe, expect, it } from 'vitest'
import {
  MINIMUM_PREVIEW_CONTRAST,
  contrastRatio,
  contrastingBackground,
  isInvisibleOnPreview,
  parseHexColour,
  previewSurfaceColour,
  relativeLuminance,
  toHexColour,
} from './previewContrast'
import type { PreviewBackground } from './preview'

const WHITE = { kind: 'white', hex: '#ffffff' } as PreviewBackground
const BLACK = { kind: 'black', hex: '#000000' } as PreviewBackground
const CHECKER = { kind: 'checkerboard', hex: '#ffffff' } as PreviewBackground
const NAVY = { kind: 'custom', hex: '#1b2a4a' } as PreviewBackground

describe('preview contrast', () => {
  it('parses only complete hex colours', () => {
    expect(parseHexColour('#FF8000')).toEqual({ r: 255, g: 128, b: 0 })
    expect(parseHexColour('#ff8000')).toEqual({ r: 255, g: 128, b: 0 })
    expect(parseHexColour('ff8000')).toBeNull()
    expect(parseHexColour('#fff')).toBeNull()
    expect(parseHexColour('#GGGGGG')).toBeNull()
    expect(parseHexColour(null)).toBeNull()
    expect(parseHexColour(undefined)).toBeNull()
  })

  it('round-trips a colour and clamps out-of-range channels', () => {
    expect(toHexColour({ r: 255, g: 128, b: 0 })).toBe('#FF8000')
    expect(toHexColour({ r: -20, g: 300, b: 12.6 })).toBe('#00FF0D')
  })

  it('matches the WCAG reference values', () => {
    const white = { r: 255, g: 255, b: 255 }
    const black = { r: 0, g: 0, b: 0 }
    expect(relativeLuminance(white)).toBeCloseTo(1, 6)
    expect(relativeLuminance(black)).toBeCloseTo(0, 6)
    expect(contrastRatio(white, black)).toBeCloseTo(21, 4)
    // Order must not matter.
    expect(contrastRatio(black, white)).toBeCloseTo(21, 4)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 6)
  })

  it('treats the checkerboard as never hiding anything', () => {
    // The two tones guarantee that some tone contrasts with any ink, so the
    // checkerboard is deliberately exempt from the hint.
    expect(previewSurfaceColour(CHECKER)).toBeNull()
    expect(isInvisibleOnPreview('#ffffff', CHECKER)).toBe(false)
    expect(isInvisibleOnPreview('#000000', CHECKER)).toBe(false)
  })

  it('flags white ink on a white preview and black ink on a black one', () => {
    expect(isInvisibleOnPreview('#FEFEFE', WHITE)).toBe(true)
    expect(isInvisibleOnPreview('#000000', WHITE)).toBe(false)
    expect(isInvisibleOnPreview('#000000', BLACK)).toBe(true)
    expect(isInvisibleOnPreview('#FFFFFF', BLACK)).toBe(false)
  })

  it('leaves legible ink alone', () => {
    expect(isInvisibleOnPreview('#1b2a4a', WHITE)).toBe(false)
    expect(isInvisibleOnPreview('#f4f7fa', BLACK)).toBe(false)
  })

  it('uses the same 1.5:1 floor as preflight', () => {
    expect(MINIMUM_PREVIEW_CONTRAST).toBe(1.5)
    // A colour just under the floor is flagged, one just over is not.
    const surface = { r: 128, g: 128, b: 128 }
    const justUnder = toHexColour({ r: 128, g: 128, b: 129 })
    const ratio = contrastRatio(parseHexColour(justUnder)!, surface)
    expect(ratio).toBeLessThan(MINIMUM_PREVIEW_CONTRAST)
    expect(isInvisibleOnPreview(justUnder, { kind: 'custom', hex: '#808080' })).toBe(true)
    expect(isInvisibleOnPreview('#000000', { kind: 'custom', hex: '#808080' })).toBe(false)
  })

  it('reports no hint when either colour is unreadable', () => {
    expect(isInvisibleOnPreview(null, WHITE)).toBe(false)
    expect(isInvisibleOnPreview('#ffffff', { kind: 'custom', hex: 'nonsense' })).toBe(false)
  })

  it('picks a surface that will actually show the ink', () => {
    // White ink needs a dark surface; dark ink needs a light one.
    expect(contrastingBackground('#FEFEFE')).toEqual({ kind: 'black', hex: '#000000' })
    expect(contrastingBackground('#1b2a4a')).toEqual({ kind: 'white', hex: '#ffffff' })
    // An unreadable ink colour falls back to the dark stage, which is the
    // house default, rather than guessing.
    expect(contrastingBackground(null)).toEqual({ kind: 'black', hex: '#000000' })
  })

  it('never recommends a surface that is itself invisible', () => {
    for (const ink of ['#FEFEFE', '#000000', '#808080', '#1b2a4a', '#ff00ff']) {
      const recommended = contrastingBackground(ink)
      expect(isInvisibleOnPreview(ink, recommended)).toBe(false)
    }
  })

  it('covers the custom garment colours the shop actually uses', () => {
    const navy = previewSurfaceColour(NAVY)
    expect(navy).toEqual({ r: 27, g: 42, b: 74 })
    expect(isInvisibleOnPreview('#1b2a4a', NAVY)).toBe(true)
    expect(isInvisibleOnPreview('#ffffff', NAVY)).toBe(false)
  })
})
