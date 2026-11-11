import type { Adjustments } from './adjustments'

export interface Point { x: number; y: number }

export interface PackedMask {
  encoding: 'bitpack-v1'
  width: number
  height: number
  feather: number
  bytes: Uint8Array
}

export interface MaskDelta {
  encoding: 'xor-bitpack-v1'
  width: number
  height: number
  feather: number
  beforeFeather: number
  bytes: Uint8Array
}

export type BlendMode = 'normal' | 'multiply'
export type LayerKind = 'base-raster' | 'adjustment' | 'pixel-op'

interface LayerBase {
  id: string
  kind: LayerKind
  name: string
  visible: boolean
  opacity: number
  mask: PackedMask | null
  blendMode: BlendMode
}

export interface BaseRasterLayer extends LayerBase {
  kind: 'base-raster'
  sourceId: string
}

export interface AdjustmentLayer extends LayerBase {
  kind: 'adjustment'
  adjustment: Adjustments
}

export type PixelOperation = {
  type: 'color-key'
  color: { r: number; g: number; b: number }
  tolerance: number
  feather: number
  contiguous: boolean
  useAlpha: boolean
  seeds: Point[]
}

export interface PixelOpLayer extends LayerBase {
  kind: 'pixel-op'
  operation: PixelOperation
}

export type EditorLayer = BaseRasterLayer | AdjustmentLayer | PixelOpLayer

export interface EditorDocument {
  schemaVersion: 1
  id: string
  designId: string
  sourceVersionId: string
  width: number
  height: number
  layers: EditorLayer[]
  activeLayerId: string
  selection: PackedMask | null
}

export type DocumentCommand =
  | { type: 'set-selection'; before: PackedMask | null; after: PackedMask | null; delta: MaskDelta | null; coalesceKey?: string }
  | { type: 'set-layer-mask'; layerId: string; before: PackedMask | null; after: PackedMask | null; delta: MaskDelta | null; coalesceKey?: string }
  | { type: 'add-layer'; layer: EditorLayer; index: number; coalesceKey?: string }
  | { type: 'remove-layer'; layer: EditorLayer; index: number; coalesceKey?: string }
  | { type: 'update-layer'; layerId: string; before: Partial<EditorLayer>; after: Partial<EditorLayer>; coalesceKey?: string }
  | { type: 'reorder-layer'; layerId: string; from: number; to: number; coalesceKey?: string }
  | { type: 'set-active-layer'; before: string; after: string; coalesceKey?: string }

export interface HistoryEntry { label: string; command: DocumentCommand; byteSize: number }
export interface DocumentHistory { entries: HistoryEntry[]; cursor: number; usedBytes: number; maxBytes: number; evictedSteps: number }

export function cloneMask(mask: PackedMask | null): PackedMask | null {
  return mask ? { ...mask, bytes: mask.bytes.slice() } : null
}

export function validateDocument(doc: EditorDocument): void {
  if (doc.layers.filter(layer => layer.kind === 'base-raster').length !== 1) throw new Error('document requires exactly one base-raster layer')
  if (!doc.layers.some(layer => layer.id === doc.activeLayerId)) throw new Error('active layer does not exist')
  for (const layer of doc.layers) {
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw new Error('layer opacity out of range')
    if (layer.mask && (layer.mask.width !== doc.width || layer.mask.height !== doc.height || layer.mask.bytes.length !== Math.ceil(doc.width * doc.height / 8))) throw new Error('mask dimensions mismatch')
    if (layer.kind === 'base-raster' && layer.blendMode !== 'normal') throw new Error('base blend mode invalid')
  }
}

function replaceLayer(doc: EditorDocument, layerId: string, update: (layer: EditorLayer) => EditorLayer): EditorDocument {
  return { ...doc, layers: doc.layers.map(layer => layer.id === layerId ? update(layer) : layer) }
}

export function applyCommand(doc: EditorDocument, command: DocumentCommand): EditorDocument {
  let next: EditorDocument
  switch (command.type) {
    case 'set-selection': next = { ...doc, selection: cloneMask(command.after) }; break
    case 'set-layer-mask': next = replaceLayer(doc, command.layerId, layer => ({ ...layer, mask: cloneMask(command.after) })); break
    case 'add-layer': next = { ...doc, layers: [...doc.layers.slice(0, command.index), command.layer, ...doc.layers.slice(command.index)] }; break
    case 'remove-layer':
      if (doc.layers[command.index]?.kind === 'base-raster') throw new Error('base layer cannot be removed')
      next = { ...doc, layers: doc.layers.filter(layer => layer.id !== command.layer.id) }; break
    case 'update-layer': next = replaceLayer(doc, command.layerId, layer => ({ ...layer, ...command.after } as EditorLayer)); break
    case 'reorder-layer': { const layers = doc.layers.slice(); const [layer] = layers.splice(command.from, 1); layers.splice(command.to, 0, layer); next = { ...doc, layers }; break }
    case 'set-active-layer': next = { ...doc, activeLayerId: command.after }; break
  }
  validateDocument(next)
  return next
}

export function invertCommand(command: DocumentCommand): DocumentCommand {
  switch (command.type) {
    case 'set-selection': return { ...command, before: command.after, after: command.before }
    case 'set-layer-mask': return { ...command, before: command.after, after: command.before }
    case 'add-layer': return { type: 'remove-layer', layer: command.layer, index: command.index, coalesceKey: command.coalesceKey }
    case 'remove-layer': return { type: 'add-layer', layer: command.layer, index: command.index, coalesceKey: command.coalesceKey }
    case 'update-layer': return { ...command, before: command.after, after: command.before }
    case 'reorder-layer': return { ...command, from: command.to, to: command.from }
    case 'set-active-layer': return { ...command, before: command.after, after: command.before }
  }
}

export function createMaskDelta(before: PackedMask | null, after: PackedMask | null): MaskDelta | null {
  if (!before || !after || before.width !== after.width || before.height !== after.height) return null
  const bytes = new Uint8Array(before.bytes.length)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = before.bytes[i] ^ after.bytes[i]
  return { encoding: 'xor-bitpack-v1', width: before.width, height: before.height, feather: after.feather, beforeFeather: before.feather, bytes }
}

export function applyMaskDelta(mask: PackedMask, delta: MaskDelta): PackedMask {
  if (mask.width !== delta.width || mask.height !== delta.height || mask.bytes.length !== delta.bytes.length) throw new Error('mask delta dimensions mismatch')
  const bytes = mask.bytes.slice()
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= delta.bytes[i]
  return { ...mask, feather: delta.feather, bytes }
}

function commandBytes(command: DocumentCommand): number {
  return new TextEncoder().encode(JSON.stringify(command, (_, value) => value instanceof Uint8Array ? Array.from(value) : value)).byteLength
}

export function pushHistory(history: DocumentHistory, label: string, command: DocumentCommand): DocumentHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null
  if (current && current.command.coalesceKey && current.command.coalesceKey === command.coalesceKey) {
    const merged = command.type === 'update-layer' && current.command.type === 'update-layer'
      ? { ...current.command, after: command.after }
      : command
    const replacement = { label, command: merged, byteSize: commandBytes(merged) }
    return { ...history, entries: [...history.entries.slice(0, history.cursor), replacement], usedBytes: history.usedBytes - current.byteSize + replacement.byteSize }
  }
  const entry = { label, command, byteSize: commandBytes(command) }
  const entries = [...history.entries.slice(0, history.cursor + 1), entry]
  let usedBytes = entries.reduce((sum, item) => sum + item.byteSize, 0)
  let start = 0
  while (usedBytes > history.maxBytes && start < entries.length - 1) usedBytes -= entries[start++].byteSize
  return { ...history, entries: entries.slice(start), cursor: entries.length - start - 1, usedBytes, evictedSteps: history.evictedSteps + start }
}
