import { describe, expect, it } from 'vitest'
import { isFlatArt, luminance, percentileAt, quickLevelsFrom } from './quickLevels'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const pixels = (values: number[][]): ImageData => {
  const flat = values.flatMap(([r, g, b]) => [r, g, b, 255])
  return new ImageData(new Uint8ClampedArray(flat), values.length, 1)
}

describe('quick levels', () => {
  it('bins opaque pixels by BT.601 luminance and skips transparent ones', () => {
    const histogram = luminance(pixels([[0, 0, 0], [255, 255, 255], [255, 255, 255]]))
    expect(histogram.sampled).toBe(3)
    expect(histogram.bins[0]).toBe(1)
    expect(histogram.bins[255]).toBe(2)
  })

  it('returns percentile thresholds from the histogram', () => {
    const histogram = luminance(pixels([
      ...Array.from({ length: 50 }, () => [0, 0, 0] as [number, number, number]),
      ...Array.from({ length: 50 }, () => [255, 255, 255] as [number, number, number]),
    ]))
    expect(percentileAt(histogram, 0.01)).toBe(0)
    expect(percentileAt(histogram, 0.99)).toBe(255)
  })

  it('proposes black/white points from the measured range', () => {
    const histogram = luminance(pixels([
      ...Array.from({ length: 40 }, () => [8, 8, 8] as [number, number, number]),
      ...Array.from({ length: 40 }, () => [250, 250, 250] as [number, number, number]),
    ]))
    const proposal = quickLevelsFrom(histogram)
    expect(proposal).not.toBeNull()
    expect(proposal!.levels.blackPoint).toBeLessThanOrEqual(20)
    expect(proposal!.levels.whitePoint).toBeGreaterThanOrEqual(235)
    expect(proposal!.summary).toMatch(/Measured range/)
  })

  it('refuses a proposal when the range is too narrow to spread', () => {
    const histogram = luminance(pixels([
      [128, 128, 128],
      [130, 130, 130],
    ]))
    expect(quickLevelsFrom(histogram)).toBeNull()
  })

  it('detects flat artwork from a dominant bucket', () => {
    const flat = luminance(pixels(Array.from({ length: 10 }, () => [250, 250, 250] as [number, number, number])))
    const busy = luminance(pixels(Array.from({ length: 10 }, (_, i) => [i * 25, i * 25, i * 25] as [number, number, number])))
    expect(isFlatArt(flat)).toBe(true)
    expect(isFlatArt(busy)).toBe(false)
  })
})
