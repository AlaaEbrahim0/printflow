import { describe, expect, it } from 'vitest'
import { compositeDocument } from './composite'
import { DEFAULT_ADJUSTMENTS, type Adjustments } from './adjustments'
import type { AdjustmentLayer, BaseRasterLayer, EditorDocument, PixelOperation, PixelOpLayer } from './document'

/**
 * Adjustment and pixel-op layers are transforms of the composite below them,
 * not new artwork. They used to be composited with source-over, which was wrong
 * in two visible ways:
 *
 *   - a pixel at 50% alpha came out at 75%, because source-over adds the layer's
 *     own coverage on top of the existing coverage. A soft mask edge therefore
 *     crept back towards opaque on every pass through an adjustment layer.
 *   - a colour-key layer re-emitted the composite it had just keyed, so keyed
 *     pixels were painted straight back and the operation did nothing at all.
 *
 * These tests pin the transform semantics so the layer shell can be built on a
 * compositor that actually layers.
 */

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) {
      this.width = typeof dataOrWidth === 'number' ? dataOrWidth : width
      this.height = typeof dataOrWidth === 'number' ? width : height!
      this.data = typeof dataOrWidth === 'number' ? new Uint8ClampedArray(this.width * this.height * 4) : dataOrWidth
    }
  }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const baseLayer = (): BaseRasterLayer => ({
  id: 'base', kind: 'base-raster', name: 'Original', sourceId: 'source',
  visible: true, opacity: 1, blendMode: 'normal', mask: null,
})

function adjustmentLayer(adjustment: Partial<Adjustments> = {}): AdjustmentLayer {
  return {
    id: 'adjust', kind: 'adjustment', name: 'Levels',
    visible: true, opacity: 1, blendMode: 'normal', mask: null,
    adjustment: { ...DEFAULT_ADJUSTMENTS, ...adjustment },
  }
}

function colorKeyLayer(color: { r: number; g: number; b: number }, tolerance = 10): PixelOpLayer {
  const operation: PixelOperation = {
    type: 'color-key', color, tolerance, feather: 0, contiguous: false, useAlpha: false, seeds: [],
  }
  return {
    id: 'key', kind: 'pixel-op', name: 'Colour key',
    visible: true, opacity: 1, blendMode: 'normal', mask: null, operation,
  }
}

function documentOf(width: number, height: number, layers: EditorDocument['layers']): EditorDocument {
  return {
    schemaVersion: 1, id: 'layers', designId: 'layers', sourceVersionId: 'source',
    width, height, activeLayerId: 'base', selection: null, layers,
  }
}

function raster(pixels: [number, number, number, number][], width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  pixels.forEach((pixel, i) => data.set(pixel, i * 4))
  return new ImageData(data, width, height)
}

describe('adjustment layers preserve coverage', () => {
  it('leaves a 50% alpha pixel at 50% instead of lifting it to 75%', () => {
    const source = raster([[128, 128, 128, 128]], 1, 1)
    const result = compositeDocument(
      documentOf(1, 1, [baseLayer(), adjustmentLayer({ lightness: 50 })]),
      { resolve: () => source },
    )
    // The colour moves (lightness +50 is a real edit) but coverage must not.
    expect(result.data[3]).toBe(128)
    expect(result.data[0]).toBeGreaterThan(128)
  })

  it('keeps fully transparent pixels transparent', () => {
    const source = raster([[200, 100, 50, 0]], 1, 1)
    const result = compositeDocument(
      documentOf(1, 1, [baseLayer(), adjustmentLayer({ saturation: 40 })]),
      { resolve: () => source },
    )
    expect(Array.from(result.data)).toEqual([0, 0, 0, 0])
  })

  it('interpolates towards the transformed colour by layer opacity', () => {
    // Half opacity must land halfway between the source and the full adjustment,
    // not somewhere past it as an over-composite would.
    const source = raster([[100, 100, 100, 255]], 1, 1)
    const resolver = { resolve: () => source }
    const full = compositeDocument(documentOf(1, 1, [baseLayer(), adjustmentLayer({ lightness: 40 })]), resolver)
    const half = compositeDocument(
      documentOf(1, 1, [baseLayer(), { ...adjustmentLayer({ lightness: 40 }), opacity: 0.5 }]),
      resolver,
    )
    const expected = Math.round(100 + (full.data[0] - 100) * 0.5)
    expect(Math.abs(half.data[0] - expected)).toBeLessThanOrEqual(1)
    expect(half.data[3]).toBe(255)
  })

  it('is idempotent when the adjustment is the identity', () => {
    const source = raster([[10, 20, 30, 200]], 1, 1)
    const result = compositeDocument(
      documentOf(1, 1, [baseLayer(), adjustmentLayer()]),
      { resolve: () => source },
    )
    expect(Array.from(result.data)).toEqual([10, 20, 30, 200])
  })
})

describe('colour-key layers actually key', () => {
  it('clears matched pixels instead of re-emitting the composite', () => {
    // Regression: the layer copy was built from the composite below, the key
    // zeroed its alpha, and source-over then painted the composite back — the
    // operation was a no-op.
    const source = raster([[255, 0, 0, 255], [0, 0, 255, 255]], 2, 1)
    const result = compositeDocument(
      documentOf(2, 1, [baseLayer(), colorKeyLayer({ r: 255, g: 0, b: 0 })]),
      { resolve: () => source },
    )
    expect(Array.from(result.data)).toEqual([0, 0, 0, 0, 0, 0, 255, 255])
  })

  it('leaves non-matching pixels byte-identical', () => {
    const source = raster([[0, 200, 0, 255]], 1, 1)
    const result = compositeDocument(
      documentOf(1, 1, [baseLayer(), colorKeyLayer({ r: 255, g: 0, b: 0 })]),
      { resolve: () => source },
    )
    expect(Array.from(result.data)).toEqual([0, 200, 0, 255])
  })

  it('honours layer opacity so a key can be dialled back', () => {
    const source = raster([[255, 0, 0, 255]], 1, 1)
    const half = compositeDocument(
      documentOf(1, 1, [baseLayer(), { ...colorKeyLayer({ r: 255, g: 0, b: 0 }), opacity: 0.5 }]),
      { resolve: () => source },
    )
    expect(half.data[3]).toBeGreaterThan(0)
    expect(half.data[3]).toBeLessThan(255)
  })

  it('skips a hidden layer entirely', () => {
    const source = raster([[255, 0, 0, 255]], 1, 1)
    const result = compositeDocument(
      documentOf(1, 1, [baseLayer(), { ...colorKeyLayer({ r: 255, g: 0, b: 0 }), visible: false }]),
      { resolve: () => source },
    )
    expect(Array.from(result.data)).toEqual([255, 0, 0, 255])
  })
})
