import { describe, expect, it } from 'vitest'
import { DEFAULT_ADJUSTMENTS } from './adjustments'
import { validateDocument, type EditorDocument, type PixelOperation } from './document'
import {
  activeLayer,
  addAdjustmentLayer,
  addColorKeyLayer,
  baseLayer,
  canMoveLayer,
  canRemoveLayer,
  describeLayer,
  layerIndex,
  layersTopFirst,
  moveLayer,
  nextLayerId,
  removeLayer,
  setActiveLayer,
  setLayerAdjustment,
  setLayerBlend,
  setLayerOpacity,
  setLayerVisible,
} from './layerStack'
import { buildRenderDocument } from './documentBuild'

const document = (): EditorDocument =>
  buildRenderDocument({ width: 4, height: 4, mask: null, threshold: 128, sourceId: 'art' })

const colorKey = (): PixelOperation => ({
  type: 'color-key', color: { r: 255, g: 0, b: 0 }, tolerance: 24,
  feather: 0, contiguous: false, useAlpha: false, seeds: [],
})

describe('layer ids', () => {
  it('never collides with an id already in the stack', () => {
    const doc = addAdjustmentLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), DEFAULT_ADJUSTMENTS)
    expect(doc.layers.map(layer => layer.id)).toEqual(['base', 'adjust-1', 'adjust-2'])
    expect(nextLayerId(doc.layers, 'adjust')).toBe('adjust-3')
  })

  it('fills a gap left by a removed layer instead of skipping the number', () => {
    // Ids only need to be unique within a document, so reusing a freed number
    // keeps the list readable rather than growing forever in a long session.
    const one = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    const two = addAdjustmentLayer(one, DEFAULT_ADJUSTMENTS)
    const removed = removeLayer(two, 'adjust-1')
    expect(nextLayerId(removed.layers, 'adjust')).toBe('adjust-1')
  })
})

describe('adding layers', () => {
  it('adds an adjustment layer above the base and keeps the document valid', () => {
    const doc = addAdjustmentLayer(document(), { ...DEFAULT_ADJUSTMENTS, hue: 20 })
    expect(doc.layers).toHaveLength(2)
    expect(doc.layers[1].kind).toBe('adjustment')
    expect(doc.layers[0].id).toBe('base')
    expect(() => validateDocument(doc)).not.toThrow()
  })

  it('adds a colour-key layer above the base', () => {
    const doc = addColorKeyLayer(document(), colorKey())
    expect(doc.layers[1].kind).toBe('pixel-op')
    expect((doc.layers[1] as { operation: PixelOperation }).operation.tolerance).toBe(24)
    expect(() => validateDocument(doc)).not.toThrow()
  })

  it('stacks layers in the order they were added', () => {
    const doc = addColorKeyLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), colorKey())
    expect(doc.layers.map(layer => layer.id)).toEqual(['base', 'adjust-1', 'key-1'])
  })

  it('does not mutate the document it was given', () => {
    const original = document()
    addAdjustmentLayer(original, DEFAULT_ADJUSTMENTS)
    expect(original.layers).toHaveLength(1)
  })
})

describe('removing layers', () => {
  it('refuses to remove the base raster', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(canRemoveLayer(doc, 'base')).toBe(false)
    expect(removeLayer(doc, 'base')).toBe(doc)
  })

  it('removes an added layer', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(removeLayer(doc, 'adjust-1').layers).toHaveLength(1)
  })

  it('moves the active layer back to the base when the active layer is removed', () => {
    // Otherwise the document points at an id that no longer exists and
    // validateDocument throws on the next render.
    const doc = setActiveLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), 'adjust-1')
    const after = removeLayer(doc, 'adjust-1')
    expect(after.activeLayerId).toBe('base')
    expect(() => validateDocument(after)).not.toThrow()
  })

  it('leaves the active layer alone when a different layer is removed', () => {
    const doc = addColorKeyLayer(setActiveLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), 'adjust-1'), colorKey())
    const after = removeLayer(doc, 'key-1')
    expect(after.activeLayerId).toBe('adjust-1')
  })

  it('returns the same document for an unknown id', () => {
    const doc = document()
    expect(removeLayer(doc, 'nope')).toBe(doc)
  })
})

describe('reordering', () => {
  it('moves a layer up and down within the stack', () => {
    const doc = addColorKeyLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), colorKey())
    const down = moveLayer(doc, 'key-1', -1)
    expect(down.layers.map(layer => layer.id)).toEqual(['base', 'key-1', 'adjust-1'])
    const up = moveLayer(down, 'key-1', 1)
    expect(up.layers.map(layer => layer.id)).toEqual(['base', 'adjust-1', 'key-1'])
  })

  it('never moves a layer below the base raster', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(canMoveLayer(doc, 'adjust-1', -1)).toBe(false)
    expect(moveLayer(doc, 'adjust-1', -1).layers.map(layer => layer.id)).toEqual(['base', 'adjust-1'])
  })

  it('never moves a layer past the top', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(canMoveLayer(doc, 'adjust-1', 1)).toBe(false)
  })

  it('keeps the document valid through a reorder', () => {
    const doc = addColorKeyLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), colorKey())
    expect(() => validateDocument(moveLayer(doc, 'key-1', -1))).not.toThrow()
  })
})

describe('layer properties', () => {
  it('toggles visibility', () => {
    const doc = setLayerVisible(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), 'adjust-1', false)
    expect(doc.layers[1].visible).toBe(false)
    expect(setLayerVisible(doc, 'adjust-1', false)).toBe(doc)
  })

  it('clamps opacity into the range the validator accepts', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(setLayerOpacity(doc, 'adjust-1', 0.5).layers[1].opacity).toBe(0.5)
    expect(setLayerOpacity(doc, 'adjust-1', 2).layers[1].opacity).toBe(1)
    expect(setLayerOpacity(doc, 'adjust-1', -1).layers[1].opacity).toBe(0)
    // A NaN would reach the validator and throw, so it falls back to opaque.
    expect(setLayerOpacity(doc, 'adjust-1', Number.NaN).layers[1].opacity).toBe(1)
    expect(() => validateDocument(setLayerOpacity(doc, 'adjust-1', 5))).not.toThrow()
  })

  it('sets a blend mode on an added layer', () => {
    const doc = setLayerBlend(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), 'adjust-1', 'multiply')
    expect(doc.layers[1].blendMode).toBe('multiply')
    expect(() => validateDocument(doc)).not.toThrow()
  })

  it('refuses to blend the base raster, which has nothing underneath', () => {
    const doc = document()
    expect(setLayerBlend(doc, 'base', 'multiply')).toBe(doc)
  })

  it('replaces an adjustment layer’s settings', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    const next = setLayerAdjustment(doc, 'adjust-1', { ...DEFAULT_ADJUSTMENTS, saturation: 40 })
    expect((next.layers[1] as { adjustment: { saturation: number } }).adjustment.saturation).toBe(40)
    expect(setLayerAdjustment(next, 'adjust-1', { ...DEFAULT_ADJUSTMENTS, saturation: 40 })).toBe(next)
  })

  it('ignores an adjustment update aimed at a non-adjustment layer', () => {
    const doc = document()
    expect(setLayerAdjustment(doc, 'base', DEFAULT_ADJUSTMENTS)).toBe(doc)
  })
})

describe('active layer', () => {
  it('selects an existing layer and ignores an unknown one', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(setActiveLayer(doc, 'adjust-1').activeLayerId).toBe('adjust-1')
    expect(setActiveLayer(doc, 'ghost')).toBe(doc)
    expect(activeLayer(setActiveLayer(doc, 'adjust-1')).id).toBe('adjust-1')
  })

  it('does not record a redundant change', () => {
    const doc = document()
    expect(setActiveLayer(doc, 'base')).toBe(doc)
  })

  it('reports the base layer and its index', () => {
    const doc = addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS)
    expect(baseLayer(doc).id).toBe('base')
    expect(layerIndex(doc, 'adjust-1')).toBe(1)
    expect(layerIndex(doc, 'ghost')).toBe(-1)
  })
})

describe('presentation', () => {
  it('lists layers top first, the way a layer panel reads', () => {
    const doc = addColorKeyLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), colorKey())
    expect(layersTopFirst(doc).map(layer => layer.id)).toEqual(['key-1', 'adjust-1', 'base'])
    // Reverses a copy: the document itself must keep its bottom-first order.
    expect(doc.layers[0].id).toBe('base')
  })

  it('describes each layer kind in operator language', () => {
    const doc = addColorKeyLayer(addAdjustmentLayer(document(), DEFAULT_ADJUSTMENTS), colorKey())
    expect(describeLayer(doc.layers[0])).toBe('Artwork')
    expect(describeLayer(doc.layers[1])).toBe('Levels (no change)')
    expect(describeLayer(doc.layers[2])).toBe('Colour key ±24')
  })

  it('says so when an adjustment layer would change nothing', () => {
    const doc = addAdjustmentLayer(document(), { ...DEFAULT_ADJUSTMENTS, hue: 10 })
    expect(describeLayer(doc.layers[1])).toBe('Levels')
  })
})
