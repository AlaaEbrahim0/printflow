/**
 * Canvas rendering for the manual cleanup editor.
 *
 * Two layers, on purpose:
 *   - `renderBaseImage` is pure pixel maths. It takes an `ImageData`, the
 *     adjustments and the mask, and mutates the buffer. Tests can call it
 *     directly on a hand-built 4×4 raster with no DOM at all.
 *   - `drawBase` / `drawSelectionOverlay` / `drawPathOverlay` are the thin
 *     canvas wrappers the component calls. They hold no state.
 *
 * The overlay is drawn on a *separate* canvas stacked over the artwork. That
 * keeps the base canvas re-renderable without repainting the marching ants, and
 * it means an in-progress lasso trace never dirties the pixels that get
 * exported.
 */
import { applyAdjustments, isIdentityAdjustments, type Adjustments } from './adjustments'
import { applyMaskToAlpha } from './maskOps'
import type { Point, Rect } from './selectionGeometry'

/** Final pixels for display/export: adjustments baked, mask → alpha. */
export function renderBaseImage(
  image: ImageData,
  adjustments: Adjustments,
  mask: Uint8Array | null,
): ImageData {
  applyAdjustments(image, adjustments)
  if (mask) applyMaskToAlpha(image.data, mask)
  return image
}

/** Copy the source canvas into the visible canvas and bake adjustments. */
export function drawBase(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  adjustments: Adjustments,
  mask: Uint8Array | null,
): void {
  const width = source.width
  const height = source.height
  if (width <= 0 || height <= 0) return
  if (target.width !== width) target.width = width
  if (target.height !== height) target.height = height
  const ctx = target.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0)
  if (!mask && isIdentityAdjustments(adjustments)) return
  let image: ImageData
  try {
    image = ctx.getImageData(0, 0, width, height)
  } catch {
    // A tainted canvas (cross-origin artwork without CORS) cannot be read
    // back. Showing the unadjusted image is far better than a blank stage.
    return
  }
  renderBaseImage(image, adjustments, mask)
  ctx.putImageData(image, 0, 0)
}

/**
 * Marching ants along the selection boundary.
 *
 * Walks the mask once and strokes only edge pixels, as four 1 px runs rather
 * than a rect per edge. On a full-frame selection that is the difference
 * between one path and several million `strokeRect` calls — the old code did
 * the latter and froze the tab on a 6 MP scan.
 *
 * `dashOffset` animates the ants; the component advances it on a timer.
 */
export function drawSelectionOverlay(
  overlay: HTMLCanvasElement,
  selection: Uint8Array | null,
  width: number,
  height: number,
  dashOffset = 0,
): void {
  const ctx = overlay.getContext('2d')
  if (!ctx) return
  if (overlay.width !== width) overlay.width = width
  if (overlay.height !== height) overlay.height = height
  ctx.clearRect(0, 0, width, height)
  if (!selection || selection.length < width * height) return
  ctx.save()
  ctx.beginPath()
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && selection[y * width + x] !== 0
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      if (selection[row + x] === 0) continue
      if (!on(x - 1, y)) {
        ctx.moveTo(x, y)
        ctx.lineTo(x, y + 1)
      } else if (!on(x + 1, y)) {
        ctx.moveTo(x + 1, y)
        ctx.lineTo(x + 1, y + 1)
      }
      if (!on(x, y - 1)) {
        ctx.moveTo(x, y)
        ctx.lineTo(x + 1, y)
      } else if (!on(x, y + 1)) {
        ctx.moveTo(x, y + 1)
        ctx.lineTo(x + 1, y + 1)
      }
    }
  }
  ctx.lineWidth = 1
  // Two passes: black underneath, white dashes on top. On its own the dashed
  // teal line disappears over teal artwork, which is exactly what this editor
  // is used to clean up.
  ctx.strokeStyle = 'rgba(0,0,0,0.85)'
  ctx.setLineDash([])
  ctx.stroke()
  ctx.strokeStyle = '#ffffff'
  ctx.setLineDash([4, 4])
  ctx.lineDashOffset = dashOffset
  ctx.stroke()
  ctx.restore()
}

/** Live trace for lasso / polygon-in-progress / wand hover, never exported. */
export function drawPathOverlay(
  overlay: HTMLCanvasElement,
  points: readonly Point[],
  width: number,
  height: number,
  options: { closed?: boolean; dashed?: boolean } = {},
): void {
  const ctx = overlay.getContext('2d')
  if (!ctx) return
  if (overlay.width !== width) overlay.width = width
  if (overlay.height !== height) overlay.height = height
  ctx.clearRect(0, 0, width, height)
  if (points.length === 0) return
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(points[0].x + 0.5, points[0].y + 0.5)
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x + 0.5, points[i].y + 0.5)
  if (options.closed && points.length > 2) ctx.closePath()
  // Outline twice so the trace reads on both light and dark artwork.
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.stroke()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = '#2dd4bf'
  if (options.dashed) ctx.setLineDash([5, 4])
  ctx.stroke()
  if (!options.closed) {
    ctx.setLineDash([])
    ctx.fillStyle = '#2dd4bf'
    for (const p of points) ctx.fillRect(p.x - 1, p.y - 1, 3, 3)
  }
  ctx.restore()
}

/** Dim everything outside the mask, the way a "mask view" toggle does. */
export function drawMaskOverlay(
  overlay: HTMLCanvasElement,
  mask: Uint8Array | null,
  width: number,
  height: number,
  options: { show: boolean; tint?: string },
): void {
  const ctx = overlay.getContext('2d')
  if (!ctx) return
  if (overlay.width !== width) overlay.width = width
  if (overlay.height !== height) overlay.height = height
  ctx.clearRect(0, 0, width, height)
  if (!options.show || !mask) return
  const image = ctx.createImageData(width, height)
  const tint = parseHex(options.tint ?? '#ff2d55')
  for (let i = 0; i < mask.length; i += 1) {
    const hidden = 255 - mask[i]
    if (hidden === 0) continue
    image.data[i * 4] = tint[0]
    image.data[i * 4 + 1] = tint[1]
    image.data[i * 4 + 2] = tint[2]
    image.data[i * 4 + 3] = Math.round(hidden * 0.55)
  }
  ctx.putImageData(image, 0, 0)
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const value = Number.parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16)
  if (!Number.isFinite(value)) return [255, 45, 85]
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** Display rectangle for a drag in progress: marquee is solid, ellipse fits it. */
export function dragPreviewRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x) + 1,
    height: Math.abs(b.y - a.y) + 1,
  }
}
