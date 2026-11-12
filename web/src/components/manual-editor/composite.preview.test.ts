import { describe, expect, it } from 'vitest'
import { compositeDocument } from './composite'
import type { CompositeOptions, PixelResolver } from './composite'
import { DEFAULT_ADJUSTMENTS } from './adjustments'
import type { EditorDocument } from './document'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData { data: Uint8ClampedArray; width: number; height: number; constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) { this.width = typeof dataOrWidth === 'number' ? dataOrWidth : width; this.height = typeof dataOrWidth === 'number' ? width : height!; this.data = typeof dataOrWidth === 'number' ? new Uint8ClampedArray(this.width * this.height * 4) : dataOrWidth } }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const MAX_CHANNEL_DELTA = 1

const width = 8
const height = 6
const source = new ImageData(new Uint8ClampedArray(width * height * 4), width, height)
for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
  const i = (y * width + x) * 4
  source.data[i] = 20 + x * 25
  source.data[i + 1] = 10 + y * 35
  source.data[i + 2] = (x * 37 + y * 19) % 256
  source.data[i + 3] = x === 0 && y === 0 ? 0 : 120 + ((x + y) % 3) * 60
}
source.data[0] = 255
source.data[1] = 255
source.data[2] = 255

const document: EditorDocument = {
  schemaVersion: 1,
  id: 'preview',
  designId: 'preview',
  sourceVersionId: 'source',
  width,
  height,
  activeLayerId: 'base',
  selection: null,
  layers: [
    { id: 'base', kind: 'base-raster', name: 'base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null },
    { id: 'adjust', kind: 'adjustment', name: 'adjust', visible: true, opacity: 0.5, blendMode: 'normal', mask: null, adjustment: { ...DEFAULT_ADJUSTMENTS, saturation: 30 } },
  ],
}

const resolver: PixelResolver = { resolve: () => source }

function assertPreviewMatchesFull(scale: number, options: CompositeOptions = {}): void {
  const full = compositeDocument(document, resolver)
  const preview = compositeDocument(document, resolver, { ...options, scale })
  const region = options.region ?? { x: 0, y: 0, width, height }
  expect(preview.width).toBe(Math.max(1, Math.round(region.width * scale)))
  expect(preview.height).toBe(Math.max(1, Math.round(region.height * scale)))
  for (let y = 0; y < preview.height; y += 1) for (let x = 0; x < preview.width; x += 1) {
    const sx = Math.min(width - 1, region.x + Math.floor(x / scale))
    const sy = Math.min(height - 1, region.y + Math.floor(y / scale))
    const sourceIndex = (sy * width + sx) * 4
    const previewIndex = (y * preview.width + x) * 4
    for (let channel = 0; channel < 4; channel += 1) {
      expect(Math.abs(preview.data[previewIndex + channel] - full.data[sourceIndex + channel])).toBeLessThanOrEqual(MAX_CHANNEL_DELTA)
    }
  }
}

describe('compositeDocument downscaled preview', () => {
  it('samples the same pixels as the full-size composite at common preview scales', () => {
    for (const scale of [0.75, 0.5, 0.25]) assertPreviewMatchesFull(scale)
  })

  it('keeps the same correspondence for a downscaled region preview', () => {
    assertPreviewMatchesFull(0.5, { region: { x: 2, y: 1, width: 4, height: 4 } })
  })
})
