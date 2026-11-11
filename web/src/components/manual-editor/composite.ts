import { applyAdjustments } from './adjustments'
import type { EditorDocument, PackedMask, PixelOperation } from './document'

/**
 * Shared compositor contract. Selection is intentionally ignored. Adjustment
 * layers transform composite pixels below, then source-over by opacity × mask.
 * Color-key operates on composite pixels below its layer. Commit and preview
 * call this same function; `region`/`scale` only change returned sampling.
 * Transparent output always has RGB = 0.
 */
export interface PixelResolver { resolve(sourceId: string): ImageData }
export interface CompositeRegion { x: number; y: number; width: number; height: number }
export interface CompositeOptions { region?: CompositeRegion; scale?: number; colorKeyCache?: ColorKeyCache; inputRevision?: string }

function makeImageData(width: number, height: number, data?: Uint8ClampedArray): ImageData {
  if (typeof ImageData !== 'undefined') return data ? new ImageData(data, width, height) : new ImageData(width, height)
  return { data: data ?? new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' } as ImageData
}

export class ColorKeyCache {
  private readonly values = new Map<string, Uint8Array>()
  get(descriptor: PixelOperation, revision: string): Uint8Array | undefined { return this.values.get(JSON.stringify(descriptor) + revision) }
  set(descriptor: PixelOperation, revision: string, mask: Uint8Array): void { this.values.set(JSON.stringify(descriptor) + revision, mask) }
}

function maskValue(mask: PackedMask | null, index: number): number {
  if (!mask) return 255
  return (mask.bytes[index >> 3] >> (index & 7)) & 1 ? 255 : 0
}

function featherValue(mask: PackedMask, index: number): number {
  if (!mask.feather) return maskValue(mask, index)
  const radius = Math.max(1, Math.round(mask.feather))
  const x = index % mask.width
  const y = Math.floor(index / mask.width)
  let total = 0
  let count = 0
  for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
    if (dx * dx + dy * dy > radius * radius) continue
    const nx = x + dx; const ny = y + dy
    if (nx >= 0 && ny >= 0 && nx < mask.width && ny < mask.height) { total += maskValue(mask, ny * mask.width + nx); count += 1 }
  }
  return Math.round(total / count)
}

function alphaAt(mask: PackedMask | null, index: number): number { return mask ? featherValue(mask, index) / 255 : 1 }

function sourceOver(dst: Uint8ClampedArray, src: Uint8ClampedArray, index: number, opacity: number, blend: 'normal' | 'multiply', mask: PackedMask | null): void {
  const sa = src[index + 3] / 255 * opacity * alphaAt(mask, index / 4)
  const da = dst[index + 3] / 255
  const oa = sa + da * (1 - sa)
  if (!oa) { dst[index] = 0; dst[index + 1] = 0; dst[index + 2] = 0; dst[index + 3] = 0; return }
  for (let channel = 0; channel < 3; channel += 1) {
    const sv = blend === 'multiply' ? src[index + channel] * dst[index + channel] / 255 : src[index + channel]
    dst[index + channel] = Math.round((sv * sa + dst[index + channel] * da * (1 - sa)) / oa)
  }
  dst[index + 3] = Math.round(oa * 255)
}

function colorKeyMask(input: ImageData, operation: PixelOperation): Uint8Array {
  const result = new Uint8Array(input.width * input.height)
  const threshold = Math.max(0, operation.tolerance) * 3
  const matches = (index: number) => {
    const p = index * 4
    return Math.abs(input.data[p] - operation.color.r) + Math.abs(input.data[p + 1] - operation.color.g) + Math.abs(input.data[p + 2] - operation.color.b) <= threshold
  }
  if (!operation.contiguous) { for (let i = 0; i < result.length; i += 1) result[i] = matches(i) ? 255 : 0; return result }
  const queue: number[] = []
  for (const seed of operation.seeds) {
    const x = Math.floor(seed.x); const y = Math.floor(seed.y)
    if (x >= 0 && y >= 0 && x < input.width && y < input.height) queue.push(y * input.width + x)
  }
  while (queue.length) {
    const index = queue.pop()!
    if (result[index] || !matches(index)) continue
    result[index] = 255
    const x = index % input.width; const y = Math.floor(index / input.width)
    if (x) queue.push(index - 1); if (x + 1 < input.width) queue.push(index + 1)
    if (y) queue.push(index - input.width); if (y + 1 < input.height) queue.push(index + input.width)
  }
  return result
}

function applyPixelOperation(pixels: ImageData, operation: PixelOperation, cache?: ColorKeyCache, revision = ''): void {
  const mask = cache?.get(operation, revision) ?? colorKeyMask(pixels, operation)
  if (cache && !cache.get(operation, revision)) cache.set(operation, revision, mask)
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) pixels.data[i * 4 + 3] = 0
}

function compositeFull(document: EditorDocument, resolver: PixelResolver, options: CompositeOptions): ImageData {
  const full = makeImageData(document.width, document.height)
  for (const layer of document.layers) {
    if (!layer.visible) continue
    const pixels = layer.kind === 'base-raster'
      ? makeImageData(document.width, document.height, resolver.resolve(layer.sourceId).data.slice())
      : makeImageData(document.width, document.height, full.data.slice())
    if (layer.kind === 'adjustment') applyAdjustments(pixels, layer.adjustment)
    if (layer.kind === 'pixel-op') applyPixelOperation(pixels, layer.operation, options.colorKeyCache, options.inputRevision)
    for (let i = 0; i < full.data.length; i += 4) sourceOver(full.data, pixels.data, i, Math.max(0, Math.min(1, layer.opacity)), layer.blendMode, layer.mask)
  }
  for (let i = 0; i < full.data.length; i += 4) if (!full.data[i + 3]) full.data[i] = full.data[i + 1] = full.data[i + 2] = 0
  return full
}

export function compositeDocument(document: EditorDocument, resolver: PixelResolver, options: CompositeOptions = {}): ImageData {
  const full = compositeFull(document, resolver, options)
  const region = options.region ?? { x: 0, y: 0, width: document.width, height: document.height }
  const scale = options.scale ?? 1
  const out = makeImageData(Math.max(1, Math.round(region.width * scale)), Math.max(1, Math.round(region.height * scale)))
  for (let y = 0; y < out.height; y += 1) for (let x = 0; x < out.width; x += 1) {
    const sx = Math.min(document.width - 1, region.x + Math.floor(x / scale))
    const sy = Math.min(document.height - 1, region.y + Math.floor(y / scale))
    const source = (sy * document.width + sx) * 4; const target = (y * out.width + x) * 4
    out.data.set(full.data.subarray(source, source + 4), target)
  }
  return out
}
