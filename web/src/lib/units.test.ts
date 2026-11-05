import { describe, expect, it } from 'vitest'
import {
  centimetersForPixels,
  dpiWarningLevel,
  dpiWarningMessage,
  effectiveDpi,
  matchesTargetPixels,
  pixelsForCentimeters,
  resizeOutputPixels,
  snapCentimeters,
  targetPixels,
  usableRollWidthCm,
} from './units'

describe('cm <-> px conversion', () => {
  it('matches PrintUnits.PixelsForCentimeters on the canonical cases', () => {
    expect(pixelsForCentimeters(58, 300)).toBe(6850)
    expect(pixelsForCentimeters(20, 300)).toBe(2362)
    expect(pixelsForCentimeters(15, 300)).toBe(1772)
  })

  it('rounds half away from zero, not half up', () => {
    expect(pixelsForCentimeters(2.54, 50)).toBe(50)
    expect(pixelsForCentimeters(1.27, 100)).toBe(50)
    // px are lossy on the way back to cm: 6850 px at 300 DPI is 57.9967 cm.
    expect(centimetersForPixels(6850, 300)).toBeCloseTo(58, 2)
  })

  it('refuses nonsense geometry instead of silently producing a size', () => {
    expect(pixelsForCentimeters(0, 300)).toBe(0)
    expect(pixelsForCentimeters(-5, 300)).toBe(0)
    expect(pixelsForCentimeters(10, 0)).toBe(0)
  })

  it('keeps the resize canvas exactly on the target box for every fit mode', () => {
    const target = { widthCm: 20, heightCm: 15 }
    for (const mode of ['contain', 'width', 'height'] as const) {
      expect(resizeOutputPixels(target, 300, mode)).toEqual({ widthPx: 2362, heightPx: 1772 })
    }
  })

  it('readies a design only on an exact target match', () => {
    const target = { widthCm: 20, heightCm: 15 }
    expect(matchesTargetPixels({ widthPx: 2362, heightPx: 1772 }, target, 300)).toBe(true)
    expect(matchesTargetPixels({ widthPx: 2361, heightPx: 1772 }, target, 300)).toBe(false)
    expect(matchesTargetPixels({ widthPx: 2362, heightPx: 1772 }, null, 300)).toBe(false)
  })

  it('computes the lower effective DPI of the two axes', () => {
    // 1000 px across 20 cm is 127 DPI, but 600 px across 15 cm is only 101.6.
    expect(effectiveDpi({ widthPx: 1000, heightPx: 600 }, { widthCm: 20, heightCm: 15 })).toBeCloseTo(
      101.6, 1,
    )
    expect(effectiveDpi({ widthPx: 600, heightPx: 1000 }, { widthCm: 20, heightCm: 15 })).toBeCloseTo(
      76.2, 1,
    )
    expect(effectiveDpi({ widthPx: 0, heightPx: 100 }, { widthCm: 10, heightCm: 10 })).toBeNull()
    expect(effectiveDpi({ widthPx: 100, heightPx: 100 }, { widthCm: 0, heightCm: 10 })).toBeNull()
  })

  it('warns below 150 and strongly warns below 100 without blocking', () => {
    const thresholds = { warnBelow: 150, strongWarnBelow: 100 }
    expect(dpiWarningLevel(150, thresholds)).toBe('ok')
    expect(dpiWarningLevel(149.9, thresholds)).toBe('warn')
    expect(dpiWarningLevel(100, thresholds)).toBe('warn')
    expect(dpiWarningLevel(99, thresholds)).toBe('strong')
    expect(dpiWarningLevel(null, thresholds)).toBe('ok')
    expect(dpiWarningMessage(80, thresholds)).toContain('below 100')
    expect(dpiWarningMessage(300, thresholds)).toBeNull()
  })

  it('honours the configurable thresholds from settings', () => {
    expect(dpiWarningLevel(120, { warnBelow: 100, strongWarnBelow: 50 })).toBe('ok')
  })

  it('derives the usable roll width from the edge margin in mm', () => {
    expect(usableRollWidthCm(58, 0)).toBe(58)
    // 20 mm of edge margin on both sides costs 4 cm of usable width.
    expect(usableRollWidthCm(58, 20)).toBeCloseTo(54, 6)
  })

  it('snaps placement drags to a tenth of a centimetre', () => {
    expect(snapCentimeters(12.34)).toBe(12.3)
    expect(snapCentimeters(12.36)).toBe(12.4)
    expect(snapCentimeters(-0.04)).toBe(-0)
    expect(targetPixels({ widthCm: 8, heightCm: 30 }, 300)).toEqual({ widthPx: 945, heightPx: 3543 })
  })
})
