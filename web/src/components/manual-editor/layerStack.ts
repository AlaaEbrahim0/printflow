/**
 * Layer-stack operations for the editor shell.
 *
 * The document model already describes a full stack — a base raster, adjustment
 * layers and colour-key layers, each with visibility, opacity, blend mode and a
 * mask — and `compositeDocument` renders it. What was missing was a way for a
 * person to *build* one: the editor only ever constructed a single base layer.
 *
 * Every mutation here goes through `applyCommand` from `document.ts` rather than
 * editing the layer array directly, so the invariants `validateDocument`
 * enforces (exactly one base raster, an existing active layer, legal opacity,
 * normal blend on the base) are checked on every keystroke instead of being
 * re-implemented here and drifting.
 */
import { isIdentityAdjustments, type Adjustments } from './adjustments'
import {
  applyCommand,
  type AdjustmentLayer,
  type BlendMode,
  type EditorDocument,
  type EditorLayer,
  type PackedMask,
  type PixelOperation,
  type PixelOpLayer,
} from './document'
import { packMask, unpackMask } from './documentBuild'

/** Layers the operator can add. The base raster is created with the document. */
export type AddableLayerKind = 'adjustment' | 'pixel-op'

/**
 * Stable ids without a random source.
 *
 * A counter is enough: ids only need to be unique within one document, and
 * deriving them from the existing stack means a restored draft never collides
 * with a layer the operator adds afterwards.
 */
export function nextLayerId(layers: readonly EditorLayer[], prefix: string): string {
  let index = 1
  const taken = new Set(layers.map(layer => layer.id))
  while (taken.has(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

export function baseLayer(document: EditorDocument): EditorLayer {
  const base = document.layers.find(layer => layer.kind === 'base-raster')
  if (!base) throw new Error('document has no base layer')
  return base
}

export function activeLayer(document: EditorDocument): EditorLayer {
  const layer = document.layers.find(item => item.id === document.activeLayerId)
  if (!layer) throw new Error('active layer does not exist')
  return layer
}

export function layerIndex(document: EditorDocument, layerId: string): number {
  return document.layers.findIndex(layer => layer.id === layerId)
}

/** The base raster cannot be deleted: it is the artwork everything sits on. */
export function canRemoveLayer(document: EditorDocument, layerId: string): boolean {
  const layer = document.layers.find(item => item.id === layerId)
  return Boolean(layer) && layer!.kind !== 'base-raster' && document.layers.length > 1
}

export function canMoveLayer(document: EditorDocument, layerId: string, direction: -1 | 1): boolean {
  const from = layerIndex(document, layerId)
  if (from < 0) return false
  const to = from + direction
  // The base raster is the bottom of the stack, so nothing may move below it.
  if (to < 1 || to >= document.layers.length) return false
  return true
}

export function addAdjustmentLayer(
  document: EditorDocument,
  adjustments: Adjustments,
  name = 'Levels',
): EditorDocument {
  const layer: AdjustmentLayer = {
    id: nextLayerId(document.layers, 'adjust'),
    kind: 'adjustment',
    name,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    adjustment: adjustments,
  }
  return applyCommand(document, { type: 'add-layer', layer, index: document.layers.length })
}

export function addColorKeyLayer(
  document: EditorDocument,
  operation: PixelOperation,
  name = 'Colour key',
): EditorDocument {
  const layer: PixelOpLayer = {
    id: nextLayerId(document.layers, 'key'),
    kind: 'pixel-op',
    name,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    operation,
  }
  return applyCommand(document, { type: 'add-layer', layer, index: document.layers.length })
}

export function removeLayer(document: EditorDocument, layerId: string): EditorDocument {
  if (!canRemoveLayer(document, layerId)) return document
  const index = layerIndex(document, layerId)
  const layer = document.layers[index]
  // `applyCommand` validates the document it produces, so the active-layer
  // pointer has to move *before* the removal: deleting the active layer first
  // would validate a document whose active id no longer exists and throw.
  const detached =
    document.activeLayerId === layerId
      ? applyCommand(document, {
          type: 'set-active-layer',
          before: document.activeLayerId,
          after: baseLayer(document).id,
        })
      : document
  return applyCommand(detached, { type: 'remove-layer', layer, index })
}

export function moveLayer(document: EditorDocument, layerId: string, direction: -1 | 1): EditorDocument {
  if (!canMoveLayer(document, layerId, direction)) return document
  const from = layerIndex(document, layerId)
  return applyCommand(document, { type: 'reorder-layer', layerId, from, to: from + direction })
}

export function setLayerVisible(document: EditorDocument, layerId: string, visible: boolean): EditorDocument {
  const layer = document.layers.find(item => item.id === layerId)
  if (!layer || layer.visible === visible) return document
  return applyCommand(document, {
    type: 'update-layer',
    layerId,
    before: { visible: layer.visible },
    after: { visible },
  })
}

export function setLayerOpacity(document: EditorDocument, layerId: string, opacity: number): EditorDocument {
  const layer = document.layers.find(item => item.id === layerId)
  if (!layer) return document
  const clamped = Math.max(0, Math.min(1, Number.isFinite(opacity) ? opacity : 1))
  if (layer.opacity === clamped) return document
  return applyCommand(document, {
    type: 'update-layer',
    layerId,
    before: { opacity: layer.opacity },
    after: { opacity: clamped },
  })
}

export function setLayerBlend(document: EditorDocument, layerId: string, blendMode: BlendMode): EditorDocument {
  const layer = document.layers.find(item => item.id === layerId)
  if (!layer || layer.blendMode === blendMode) return document
  // validateDocument rejects a non-normal blend on the base raster, because
  // there is nothing underneath it to blend with.
  if (layer.kind === 'base-raster' && blendMode !== 'normal') return document
  return applyCommand(document, {
    type: 'update-layer',
    layerId,
    before: { blendMode: layer.blendMode },
    after: { blendMode },
  })
}

export function setActiveLayer(document: EditorDocument, layerId: string): EditorDocument {
  if (!document.layers.some(layer => layer.id === layerId)) return document
  if (document.activeLayerId === layerId) return document
  return applyCommand(document, {
    type: 'set-active-layer',
    before: document.activeLayerId,
    after: layerId,
  })
}

/** Replace one layer's mask. Used when the operator edits the active layer. */
export function setLayerMask(
  document: EditorDocument,
  layerId: string,
  mask: PackedMask | null,
): EditorDocument {
  const layer = document.layers.find(item => item.id === layerId)
  if (!layer) return document
  return applyCommand(document, {
    type: 'set-layer-mask',
    layerId,
    before: layer.mask,
    after: mask,
    delta: null,
  })
}

export function setLayerAdjustment(
  document: EditorDocument,
  layerId: string,
  adjustments: Adjustments,
): EditorDocument {
  const layer = document.layers.find(item => item.id === layerId)
  if (!layer || layer.kind !== 'adjustment') return document
  if (JSON.stringify(layer.adjustment) === JSON.stringify(adjustments)) return document
  return applyCommand(document, {
    type: 'update-layer',
    layerId,
    before: { adjustment: layer.adjustment } as Partial<EditorLayer>,
    after: { adjustment: adjustments } as Partial<EditorLayer>,
  })
}

/**
 * Write the live mask bytes back onto the layer that owns them.
 *
 * The editor paints one mask at a time, but the stack is the record of every
 * layer's coverage. Without this fold, switching layers would drop the mask that
 * was just painted: the stack still held the stale packed copy, and the new
 * paint target replaced the live bytes. Folding before every stack read is what
 * makes per-layer masks survive a switch.
 */
export function applyLiveMaskToStack(
  stack: EditorLayer[],
  maskLayerId: string,
  mask: Uint8Array | null,
  width: number,
  height: number,
  threshold: number,
  feather = 0,
): EditorLayer[] {
  const packed = packMask(mask, width, height, threshold, feather)
  return stack.map(layer => (layer.id === maskLayerId ? { ...layer, mask: packed } : layer))
}

/**
 * Read a layer's mask as one byte per pixel.
 *
 * Returns null when the layer has no mask, which the editor treats as "every
 * pixel kept" — the same meaning the compositor gives it.
 */
export function layerMaskBytes(layer: EditorLayer | undefined): Uint8Array | null {
  if (!layer?.mask) return null
  return unpackMask(layer.mask)
}

/** How a layer is described in the list.
 *
 * The panel has to say what each row *is* without the operator opening it, and
 * "adjustment" is not a word that means anything at a glance.
 */
export function describeLayer(layer: EditorLayer): string {
  if (layer.kind === 'base-raster') return 'Artwork'
  if (layer.kind === 'pixel-op') return `Colour key ±${layer.operation.tolerance}`
  return isIdentityAdjustments(layer.adjustment) ? 'Levels (no change)' : 'Levels'
}

/** Layers top-first, which is how every layer panel is read. */
export function layersTopFirst(document: EditorDocument): EditorLayer[] {
  return document.layers.slice().reverse()
}
