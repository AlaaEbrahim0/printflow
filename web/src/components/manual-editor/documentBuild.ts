/**
 * Building the `EditorDocument` the compositor renders.
 *
 * The editor keeps its working state in byte-per-pixel buffers and plain
 * objects (`mask`, `adjustments`), because that is what the pointer handlers and
 * sliders can write to cheaply. The compositor wants the packed document model.
 * This module is the one place that translation happens, so the on-screen
 * preview and the saved draft can never describe different documents.
 *
 * The adjustment layer is appended rather than folded into the base raster for
 * a reason: `compositeDocument` treats an adjustment layer as a transform of
 * everything below it, so the base keeps its untouched pixels and the mask keeps
 * its meaning. Folding adjustments into the base would bake them in and make
 * "turn the Levels off again" impossible.
 */
import { isIdentityAdjustments, type Adjustments } from './adjustments'
import type { AdjustmentLayer, BaseRasterLayer, EditorDocument, EditorLayer, PackedMask } from './document'

export interface DocumentBuildOptions {
  width: number
  height: number
  /** Row-major, one byte per pixel. Values at or above `threshold` are kept. */
  mask: Uint8Array | null
  /** Feather radius in pixels applied to the packed mask. */
  feather?: number
  threshold: number
  /** Identifies the source artwork; also the draft's `designId`. */
  sourceId: string
  /**
   * The full stack, bottom-first, when the editor is driving one.
   *
   * The base layer in it supplies visibility, opacity and blend mode — the
   * operator can hide or fade the artwork — but its *mask* is always rebuilt
   * from `mask` above. The live byte mask stays the one authority for coverage,
   * so a mask stroke and a layer-panel change can never disagree.
   */
  stack?: EditorLayer[]
  /** Extra layers above a freshly built base, bottom-to-top. */
  layers?: EditorLayer[]
  /** Which layer edits apply to. Defaults to the base. */
  activeLayerId?: string
  /**
   * Which layer the live `mask` bytes belong to. Defaults to the base.
   *
   * Masks are per-layer in the document, but the editor paints one at a time:
   * the active layer's. The layers in `stack` keep their own packed masks; this
   * one is overridden with the bytes the operator is currently painting.
   */
  maskLayerId?: string
  /** Global colour adjustments; appended as a layer when non-identity. */
  adjustments?: Adjustments
}

/** Id of the layer that carries the global Levels/HSL panel. */
export const GLOBAL_ADJUSTMENT_LAYER_ID = 'adjustments'

export function packMask(
  mask: Uint8Array | null,
  width: number,
  height: number,
  threshold: number,
  feather = 0,
): PackedMask | null {
  if (!mask) return null
  // One *bit* per pixel, not one byte: `PackedMask` is `bitpack-v1`, and
  // `validateDocument` rejects anything whose byte length is not
  // ceil(width * height / 8). Writing one byte per pixel made every masked
  // document fail validation, so every draft save was rejected and the restore
  // prompt never appeared for exactly the edits worth persisting.
  const pixels = width * height
  const bytes = new Uint8Array(Math.ceil(pixels / 8))
  for (let i = 0; i < pixels; i += 1) {
    if (mask[i] >= threshold) bytes[i >> 3] |= 1 << (i & 7)
  }
  return { encoding: 'bitpack-v1', width, height, feather, bytes }
}

/**
 * Unpack a layer mask back to one byte per pixel.
 *
 * The inverse of `packMask`, and it lives here so the two cannot drift: a layer
 * mask is packed for storage and rendering, but the editor paints it as bytes.
 * A mask packed at a threshold of 128 is a binary decision, so the unpacked
 * values are 0 or 255 — the same shape every `maskOps` function expects.
 */
export function unpackMask(packed: PackedMask): Uint8Array {
  const pixels = packed.width * packed.height
  const mask = new Uint8Array(pixels)
  for (let i = 0; i < pixels; i += 1) {
    mask[i] = (packed.bytes[i >> 3] >> (i & 7)) & 1 ? 255 : 0
  }
  return mask
}

export function buildBaseLayer(options: DocumentBuildOptions): BaseRasterLayer {
  return {
    id: 'base',
    kind: 'base-raster',
    name: 'Original',
    sourceId: 'source',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: packMask(options.mask, options.width, options.height, options.threshold, options.feather ?? 0),
  }
}

export function buildAdjustmentLayer(adjustments: Adjustments, id = 'adjustments'): AdjustmentLayer {
  return {
    id,
    kind: 'adjustment',
    name: 'Levels',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    adjustment: adjustments,
  }
}

/** The document the compositor renders for the editor's current state. */
export function buildRenderDocument(options: DocumentBuildOptions): EditorDocument {
  // The live byte mask belongs to one layer at a time. Everything else keeps the
  // packed mask it was given, so switching the paint target never discards the
  // coverage the operator already painted elsewhere.
  const maskLayerId = options.maskLayerId ?? 'base'
  const liveMask = packMask(options.mask, options.width, options.height, options.threshold, options.feather ?? 0)
  const applyLiveMask = (layer: EditorLayer): EditorLayer =>
    layer.id === maskLayerId ? { ...layer, mask: liveMask } : layer

  // A stack supplied by the caller already contains its base layer, and that
  // base carries the artwork's visibility/opacity/blend. Rebuilding it here
  // would silently reset those three to their defaults on every render.
  const suppliedBase = options.stack?.find(layer => layer.kind === 'base-raster')
  const base: EditorLayer = suppliedBase
    ? applyLiveMask({ ...suppliedBase, kind: 'base-raster', sourceId: 'source' })
    : applyLiveMask(buildBaseLayer(options))

  const layers: EditorLayer[] = [
    base,
    ...(options.stack
      ? options.stack.filter(layer => layer.kind !== 'base-raster').map(applyLiveMask)
      : (options.layers ?? [])),
  ]
  const adjustments = options.adjustments
  if (adjustments && !isIdentityAdjustments(adjustments)) {
    layers.push(buildAdjustmentLayer(adjustments, GLOBAL_ADJUSTMENT_LAYER_ID))
  }
  return {
    schemaVersion: 1,
    id: 'manual-editor',
    designId: options.sourceId,
    sourceVersionId: options.sourceId,
    width: options.width,
    height: options.height,
    layers,
    // The active layer has to exist in the stack the compositor is handed, or
    // validateDocument throws. A stack that lost its active layer (an undo
    // across a delete, say) falls back to the base rather than failing a render.
    activeLayerId: layers.some(layer => layer.id === options.activeLayerId)
      ? options.activeLayerId!
      : 'base',
    selection: null,
  }
}

/**
 * The document persisted with a draft.
 *
 * Drafts deliberately do not persist the adjustment layer: the draft snapshot
 * already carries the slider values, and storing them twice invites a restore
 * where the document and the snapshot disagree. `validateDocument` only requires
 * a well-formed base layer, so this stays the minimal shape a draft needs.
 */
export function buildDraftDocument(
  width: number,
  height: number,
  mask: Uint8Array | null,
  threshold: number,
  sourceId: string,
): EditorDocument {
  return buildRenderDocument({ width, height, mask, threshold, sourceId })
}
