import { describe, expect, it } from 'vitest'
import { DEFAULT_ADJUSTMENTS } from './adjustments'
import { validateDocument, type AdjustmentLayer, type BaseRasterLayer } from './document'
import { buildDraftDocument, buildRenderDocument, packMask } from './documentBuild'

const base = (): BaseRasterLayer => ({
  id: 'base', kind: 'base-raster', name: 'Original', sourceId: 'source',
  visible: true, opacity: 1, blendMode: 'normal', mask: null,
})

describe('packMask', () => {
  it('returns null for no mask so the compositor treats everything as opaque', () => {
    expect(packMask(null, 4, 4, 128)).toBeNull()
  })

  it('packs at the threshold, not at 128', () => {
    // The editor's Threshold slider decides what counts as kept; the packed mask
    // has to honour it or the preview and the mask disagree.
    const packed = packMask(Uint8Array.from([0, 100, 199, 200, 255]), 5, 1, 200)!
    expect(packed.encoding).toBe('bitpack-v1')
    expect(packed.width).toBe(5)
    expect(packed.height).toBe(1)
    // 0, 100 and 199 are below the threshold; 200 and 255 are kept.
    expect(packed.bytes.length).toBe(1)
    expect(packed.bytes[0]).toBe(0b0001_1000)
  })

  it('carries the feather radius, because the compositor reads it from the mask', () => {
    expect(packMask(new Uint8Array(4).fill(255), 2, 2, 128, 3)!.feather).toBe(3)
    expect(packMask(new Uint8Array(4).fill(255), 2, 2, 128)!.feather).toBe(0)
  })

  it('allocates the bit-packed length the document validator expects', () => {
    const width = 8
    const height = 6
    const packed = packMask(new Uint8Array(width * height).fill(255), width, height, 128)!
    expect(packed.bytes.length).toBe(Math.ceil((width * height) / 8))
  })
})

describe('buildRenderDocument', () => {
  it('always produces a document the compositor can validate', () => {
    const document = buildRenderDocument({ width: 4, height: 4, mask: null, threshold: 128, sourceId: 'art' })
    expect(() => validateDocument(document)).not.toThrow()
    expect(document.layers).toHaveLength(1)
    expect(document.layers[0]).toEqual(base())
  })

  it('omits the adjustment layer entirely at identity', () => {
    // An identity layer would be a full-canvas copy per render for no change.
    const document = buildRenderDocument({
      width: 4, height: 4, mask: null, threshold: 128, sourceId: 'art',
      adjustments: DEFAULT_ADJUSTMENTS,
    })
    expect(document.layers).toHaveLength(1)
  })

  it('appends one adjustment layer above the base when adjustments are active', () => {
    const adjustments = { ...DEFAULT_ADJUSTMENTS, hue: 30 }
    const document = buildRenderDocument({
      width: 4, height: 4, mask: null, threshold: 128, sourceId: 'art', adjustments,
    })
    expect(document.layers).toHaveLength(2)
    const layer = document.layers[1] as AdjustmentLayer
    expect(layer.kind).toBe('adjustment')
    expect(layer.adjustment).toBe(adjustments)
    // Above the base, or the adjustment would be hidden behind it.
    expect(document.layers[0].id).toBe('base')
    expect(() => validateDocument(document)).not.toThrow()
  })

  it('keeps the base blend mode legal, as the validator requires', () => {
    const document = buildRenderDocument({ width: 2, height: 2, mask: null, threshold: 128, sourceId: 'art' })
    expect(document.layers[0].blendMode).toBe('normal')
  })

  it('passes the threshold through to the packed mask', () => {
    const mask = Uint8Array.from([10, 240])
    const document = buildRenderDocument({ width: 2, height: 1, mask, threshold: 200, sourceId: 'art' })
    const packed = (document.layers[0] as BaseRasterLayer).mask!
    expect(packed.bytes[0]).toBe(0b0000_0010)
  })

  it('produces a mask the document validator accepts, so drafts can be saved', () => {
    // Regression: the packer used to write one byte per pixel while
    // `validateDocument` requires ceil(width * height / 8). Every draft with a
    // non-empty mask failed validation, which the editor reported as "Draft save
    // failed" — silently, for the whole of Phase 1b.
    const width = 37
    const height = 23
    const mask = new Uint8Array(width * height)
    for (let i = 0; i < mask.length; i += 1) mask[i] = i % 3 === 0 ? 255 : 0
    const document = buildRenderDocument({ width, height, mask, threshold: 128, sourceId: 'art' })
    expect(() => validateDocument(document)).not.toThrow()
    const packed = (document.layers[0] as BaseRasterLayer).mask!
    expect(packed.bytes.length).toBe(Math.ceil((width * height) / 8))
    // The kept pixels are still the ones above the threshold, bit for bit.
    for (let i = 0; i < mask.length; i += 1) {
      const bit = (packed.bytes[i >> 3] >> (i & 7)) & 1
      expect(bit).toBe(mask[i] >= 128 ? 1 : 0)
    }
  })

  it('passes the feather radius through to the packed mask', () => {
    const document = buildRenderDocument({
      width: 2, height: 1, mask: Uint8Array.from([255, 255]), feather: 4, threshold: 128, sourceId: 'art',
    })
    expect((document.layers[0] as BaseRasterLayer).mask!.feather).toBe(4)
  })

  it('keeps caller-supplied layers between the base and the adjustment', () => {
    const extra = {
      id: 'key', kind: 'pixel-op' as const, name: 'Colour key', visible: true, opacity: 1,
      blendMode: 'normal' as const, mask: null,
      operation: {
        type: 'color-key' as const, color: { r: 255, g: 0, b: 0 }, tolerance: 10,
        feather: 0, contiguous: false, useAlpha: false, seeds: [],
      },
    }
    const document = buildRenderDocument({
      width: 2, height: 1, mask: null, threshold: 128, sourceId: 'art',
      layers: [extra], adjustments: { ...DEFAULT_ADJUSTMENTS, saturation: 20 },
    })
    expect(document.layers.map(layer => layer.id)).toEqual(['base', 'key', 'adjustments'])
    expect(() => validateDocument(document)).not.toThrow()
  })
})

describe('buildDraftDocument', () => {
  it('is the render document, so a restored draft recomposes identically', () => {
    const mask = Uint8Array.from([0, 255, 255, 0])
    const draft = buildDraftDocument(2, 2, mask, 128, 'art')
    const render = buildRenderDocument({ width: 2, height: 2, mask, threshold: 128, sourceId: 'art' })
    expect(draft).toEqual(render)
  })

  it('identifies the design by its source, not by the display title', () => {
    const draft = buildDraftDocument(1, 1, null, 128, '/designs/abc.png')
    expect(draft.designId).toBe('/designs/abc.png')
    expect(draft.sourceVersionId).toBe('/designs/abc.png')
  })
})
