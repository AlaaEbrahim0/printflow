import { applyAdjustments } from './adjustments'
import type { EditorDocument, PackedMask, PixelOperation } from './document'

/**
 * Compositor contract: straight-alpha RGBA, sRGB bytes, bottom-to-top layers.
 * Masks apply before layer opacity. Adjustment layers transform the composite
 * below, then blend by opacity × mask. Multiply uses source-over alpha math.
 * RGB becomes 0 whenever output alpha is 0. Every channel conversion rounds
 * with Math.round. Inputs stay immutable; scale uses nearest source samples.
 */
export interface PixelResolver { resolve(sourceId: string): ImageData }
export interface CompositeRegion { x: number; y: number; width: number; height: number }
export interface CompositeOptions { region?: CompositeRegion; scale?: number }

function maskValue(mask: PackedMask | null, index: number): number {
  if (!mask) return 255
  return (mask.bytes[index >> 3] >> (index & 7)) & 1 ? 255 : 0
}

function alphaWithFeather(mask: PackedMask, index: number): number {
  const value = maskValue(mask, index)
  if (!mask.feather || value === 255) return value
  const x = index % mask.width
  const y = Math.floor(index / mask.width)
  const radius = Math.max(1, Math.round(mask.feather))
  let total = 0
  let count = 0
  for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
    if (dx * dx + dy * dy > radius * radius) continue
    const nx = x + dx; const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) continue
    total += maskValue(mask, ny * mask.width + nx); count += 1
  }
  return Math.round(total / Math.max(1, count))
}

function applyMask(data: ImageData, mask: PackedMask | null): void {
  if (!mask) return
  for (let i = 0; i < mask.width * mask.height; i += 1) data.data[i * 4 + 3] = Math.round(data.data[i * 4 + 3] * alphaWithFeather(mask, i) / 255)
}

function applyPixelOperation(data: ImageData, operation: PixelOperation): void {
  if (operation.type !== 'color-key') return
  const threshold = Math.max(0, operation.tolerance) * 3
  for (let i = 0; i < data.data.length; i += 4) {
    const distance = Math.abs(data.data[i] - operation.color.r) + Math.abs(data.data[i + 1] - operation.color.g) + Math.abs(data.data[i + 2] - operation.color.b)
    if (distance <= threshold) data.data[i + 3] = 0
  }
}

export function compositeDocument(document: EditorDocument, resolver: PixelResolver, options: CompositeOptions = {}): ImageData {
  const region = options.region ?? { x: 0, y: 0, width: document.width, height: document.height }
  const scale = options.scale ?? 1
  const out = new ImageData(Math.max(1, Math.round(region.width * scale)), Math.max(1, Math.round(region.height * scale)))
  const full = new ImageData(document.width, document.height)
  for (const layer of document.layers) {
    if (!layer.visible) continue
    const pixels = layer.kind === 'base-raster'
      ? new ImageData(resolver.resolve(layer.sourceId).data.slice(), document.width, document.height)
      : new ImageData(full.data.slice(), document.width, document.height)
    if (layer.kind === 'adjustment') applyAdjustments(pixels, layer.adjustment)
    if (layer.kind === 'pixel-op') applyPixelOperation(pixels, layer.operation)
    applyMask(pixels, layer.mask)
    const opacity = Math.max(0, Math.min(1, layer.opacity))
    for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
      const source = (y * document.width + x) * 4
      const targetX = Math.min(out.width - 1, Math.max(0, Math.round((x - region.x) * scale)))
      const targetY = Math.min(out.height - 1, Math.max(0, Math.round((y - region.y) * scale)))
      const target = (targetY * out.width + targetX) * 4
      const sa = pixels.data[source + 3] / 255 * opacity
      const da = full.data[source + 3] / 255
      const blend = layer.blendMode === 'multiply' ? pixels.data[source] * full.data[source] / 255 : pixels.data[source]
      const oa = sa + da * (1 - sa)
      out.data[target] = oa ? Math.round((blend * sa + full.data[source] * da * (1 - sa)) / oa) : 0
      out.data[target + 1] = oa ? Math.round((pixels.data[source + 1] * sa + full.data[source + 1] * da * (1 - sa)) / oa) : 0
      out.data[target + 2] = oa ? Math.round((pixels.data[source + 2] * sa + full.data[source + 2] * da * (1 - sa)) / oa) : 0
      out.data[target + 3] = Math.round(oa * 255)
      full.data[source + 3] = out.data[target + 3]
      full.data[source] = out.data[target]; full.data[source + 1] = out.data[target + 1]; full.data[source + 2] = out.data[target + 2]
    }
  }
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] === 0) out.data[i] = out.data[i + 1] = out.data[i + 2] = 0
  return out
}
