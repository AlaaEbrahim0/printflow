import { describe, expect, it } from 'vitest'
import { compositeDocument } from './composite'
import type { EditorDocument } from './document'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData { data: Uint8ClampedArray; width: number; height: number; constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) { this.width = typeof dataOrWidth === 'number' ? dataOrWidth : width; this.height = typeof dataOrWidth === 'number' ? width : height!; this.data = typeof dataOrWidth === 'number' ? new Uint8ClampedArray(this.width * this.height * 4) : dataOrWidth } }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const source = new ImageData(new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 220, 0, 0, 255, 0, 255, 255, 0, 180,
  30, 40, 50, 255, 60, 70, 80, 255, 90, 100, 110, 255, 120, 130, 140, 255,
  0, 0, 0, 0, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255,
  100, 110, 120, 255, 130, 140, 150, 255, 160, 170, 180, 255, 190, 200, 210, 255,
]), 4, 4)

const document: EditorDocument = {
  schemaVersion: 1, id: 'golden', designId: 'golden', sourceVersionId: 'source', width: 4, height: 4,
  activeLayerId: 'base', selection: null,
  layers: [{ id: 'base', kind: 'base-raster', name: 'base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }],
}
const resolver = { resolve: () => source }

describe('compositor golden fixture', () => {
  it('is deterministic and selection-invariant', () => {
    const first = compositeDocument(document, resolver)
    const second = compositeDocument(document, resolver)
    expect(Array.from(first.data)).toEqual(Array.from(second.data))
    expect(Array.from(compositeDocument({ ...document, selection: { encoding: 'bitpack-v1', width: 4, height: 4, feather: 0, bytes: new Uint8Array([0]) } }, resolver).data)).toEqual(Array.from(first.data))
  })

  it('keeps transparent RGB normalized', () => {
    const output = compositeDocument(document, resolver)
    for (let i = 0; i < output.data.length; i += 4) {
      if (output.data[i + 3] === 0) expect(Array.from(output.data.slice(i, i + 3))).toEqual([0, 0, 0])
    }
  })
})
