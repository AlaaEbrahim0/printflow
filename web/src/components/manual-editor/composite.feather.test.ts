import { describe, expect, it } from 'vitest'
import { compositeDocument } from './composite'
import type { EditorDocument, PackedMask } from './document'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData { data: Uint8ClampedArray; width: number; height: number; constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height } }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const mask = (bytes: number[]): PackedMask => ({ encoding: 'bitpack-v1', width: 3, height: 3, feather: 1, bytes: new Uint8Array(bytes) })
const source = (mirror = false): ImageData => {
  const data = new Uint8ClampedArray(3 * 3 * 4)
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) {
    const sx = mirror ? 2 - x : x
    const i = (y * 3 + x) * 4
    data[i] = 80 + sx * 40
    data[i + 1] = 30 + y * 50
    data[i + 2] = 120
    data[i + 3] = 255
  }
  return new ImageData(data, 3, 3)
}
const document = (bytes: number[]): EditorDocument => ({ schemaVersion: 1, id: 'feather', designId: 'feather', sourceVersionId: 'source', width: 3, height: 3, activeLayerId: 'base', selection: null, layers: [{ id: 'base', kind: 'base-raster', name: 'base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: mask(bytes) }] })
const mirrorBytes = (bytes: number[]): number[] => bytes.map(byte => ((byte & 1) << 2) | (byte & 2) | ((byte & 4) >> 2))

describe('feather determinism and symmetry', () => {
  it('is byte-deterministic', () => {
    const resolver = { resolve: () => source() }
    expect(Array.from(compositeDocument(document([0b00000001]), resolver).data)).toEqual(Array.from(compositeDocument(document([0b00000001]), resolver).data))
  })

  it('mirrors output when source and mask mirror horizontally', () => {
    const bytes = [0b00000101]
    const left = compositeDocument(document(bytes), { resolve: () => source(false) })
    const right = compositeDocument(document(mirrorBytes(bytes)), { resolve: () => source(true) })
    for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) {
      const a = (y * 3 + x) * 4
      const b = (y * 3 + (2 - x)) * 4
      expect(Array.from(Array.prototype.slice.call(right.data, a, a + 4))).toEqual(Array.from(Array.prototype.slice.call(left.data, b, b + 4)))
    }
  })
})
