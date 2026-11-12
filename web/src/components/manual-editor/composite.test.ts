import { describe, expect, it } from 'vitest'
import { ColorKeyCache, compositeDocument } from './composite'
import type { EditorDocument } from './document'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData { data: Uint8ClampedArray; width: number; height: number; constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) { this.width = typeof dataOrWidth === 'number' ? dataOrWidth : width; this.height = typeof dataOrWidth === 'number' ? width : height!; this.data = typeof dataOrWidth === 'number' ? new Uint8ClampedArray(this.width * this.height * 4) : dataOrWidth } }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const doc = (): EditorDocument => ({ schemaVersion: 1, id: 'd', designId: 'd', sourceVersionId: 's', width: 4, height: 4, activeLayerId: 'base', selection: null, layers: [{ id: 'base', kind: 'base-raster', name: 'base', sourceId: 's', visible: true, opacity: 1, blendMode: 'normal', mask: null }] })
const image = new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 255, 0, 255, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 4, 4)

describe('compositor', () => {
  it('ignores selection and normalizes transparent RGB', () => {
    const resolver = { resolve: () => image }
    const a = compositeDocument(doc(), resolver)
    const selected = { ...doc(), selection: { encoding: 'bitpack-v1' as const, width: 4, height: 4, feather: 0, bytes: new Uint8Array([0]) } }
    const b = compositeDocument(selected, resolver)
    expect(Array.from(a.data)).toEqual(Array.from(b.data))
    expect(Array.from(a.data.slice(8, 12))).toEqual([0, 0, 0, 0])
  })

  it('matches region sampling and repeats feather deterministically', () => {
    const resolver = { resolve: () => image }
    const full = compositeDocument(doc(), resolver)
    const region = compositeDocument(doc(), resolver, { region: { x: 1, y: 1, width: 2, height: 2 } })
    const expected: number[] = []
    for (let y = 1; y < 3; y += 1) expected.push(...full.data.slice((y * 4 + 1) * 4, (y * 4 + 3) * 4))
    expect(Array.from(region.data)).toEqual(expected)
    expect(Array.from(compositeDocument(doc(), resolver).data)).toEqual(Array.from(full.data))
  })

  it('caches color-key masks by descriptor and revision', () => {
    const cache = new ColorKeyCache()
    const operation = { type: 'color-key' as const, color: { r: 255, g: 0, b: 0 }, tolerance: 0, feather: 0, contiguous: true, useAlpha: false, seeds: [{ x: 0, y: 0 }] }
    const d = { ...doc(), layers: [doc().layers[0], { id: 'op', kind: 'pixel-op' as const, name: 'op', visible: true, opacity: 1, blendMode: 'normal' as const, mask: null, operation }] }
    let resolves = 0
    const resolver = { resolve: () => { resolves += 1; return image } }
    compositeDocument(d, resolver, { colorKeyCache: cache, inputRevision: '1' })
    compositeDocument(d, resolver, { colorKeyCache: cache, inputRevision: '1' })
    expect(cache.get(operation, '1')).toBeDefined()
    expect(resolves).toBe(2)
  })
})
