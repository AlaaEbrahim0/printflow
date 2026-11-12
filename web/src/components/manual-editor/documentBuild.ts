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
  /** Extra layers above the base, in bottom-to-top order. */
  layers?: EditorLayer[]
  /** Global colour adjustments; appended as a layer when non-identity. */
  adjustments?: Adjustments
}

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
  const layers: EditorLayer[] = [buildBaseLayer(options), ...(options.layers ?? [])]
  const adjustments = options.adjustments
  if (adjustments && !isIdentityAdjustments(adjustments)) layers.push(buildAdjustmentLayer(adjustments))
  return {
    schemaVersion: 1,
    id: 'manual-editor',
    designId: options.sourceId,
    sourceVersionId: options.sourceId,
    width: options.width,
    height: options.height,
    layers,
    activeLayerId: 'base',
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
