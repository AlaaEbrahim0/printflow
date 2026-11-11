/**
 * Pixel-space geometry for the manual cleanup editor.
 *
 * Everything here is pure and unitless-but-for-pixels: no DOM, no canvas, no
 * React. The renderer, the pointer handlers and the tests all agree because
 * they all come through these functions. A "mask" is a `Uint8Array` of
 * `width * height` bytes, row-major, where 255 means selected and 0 means not.
 * The same shape carries the layer mask, which is why the operators live here
 * rather than being bolted onto the selection code.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Clamp one axis into `[0, size - 1]`; an empty axis collapses to 0. */
export function clampAxis(value: number, size: number): number {
  if (!Number.isFinite(value) || size <= 0) return 0
  return Math.min(Math.max(Math.round(value), 0), size - 1)
}

/** Pointer position → integer pixel inside the raster. */
export function toPixel(point: Point, width: number, height: number): Point {
  return { x: clampAxis(point.x, width), y: clampAxis(point.y, height) }
}

export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x < rect.x + rect.width &&
    point.y < rect.y + rect.height
  )
}

/** Half-open rectangle covering both drag corners, clamped to the raster. */
export function dragRect(a: Point, b: Point, width: number, height: number): Rect {
  const x0 = clampAxis(Math.min(a.x, b.x), width)
  const y0 = clampAxis(Math.min(a.y, b.y), height)
  const x1 = clampAxis(Math.max(a.x, b.x), width)
  const y1 = clampAxis(Math.max(a.y, b.y), height)
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/**
 * Ellipse inscribed in the drag rectangle. A one-pixel drag is a point, not a
 * division by zero, so the degenerate case fills the single pixel.
 */
export function ellipseContains(rect: Rect, x: number, y: number): boolean {
  if (rect.width <= 1 && rect.height <= 1) return x === rect.x && y === rect.y
  const rx = rect.width / 2
  const ry = rect.height / 2
  const cx = rect.x + rx
  const cy = rect.y + ry
  const dx = (x + 0.5 - cx) / rx
  const dy = (y + 0.5 - cy) / ry
  return dx * dx + dy * dy <= 1
}

/** True when the pixel (scanned row-major) sits inside the given shape. */
export function shapeContains(
  rect: Rect,
  shape: 'marquee' | 'ellipse',
  x: number,
  y: number,
): boolean {
  return shape === 'marquee' ? pointInRect({ x, y }, rect) : ellipseContains(rect, x, y)
}

/**
 * Rasterise a polygon with the even-odd rule, boundary included.
 *
 * The sample for a pixel is the pixel's own integer coordinate `(x, y)`, not
 * its centre `(x + 0.5, y + 0.5)`. That is the same convention `dragRect` uses
 * (inclusive of both drag corners), so a path clicked along pixel coordinates
 * selects exactly the pixels that were clicked plus the ones it encloses: a
 * triangle from (1,1) to (3,1) to (1,3) is three pixels wide on its top row.
 * Sampling centres instead leaves the outline the operator just clicked
 * *outside* the selection — the "selection that never quite touches the
 * artwork" bug — because a centre is half a pixel in from the drawn edge.
 *
 * Two passes, because no single scanline rule gets both right:
 *   1. Scanline fill at integer `y` with a half-open y rule (`a.y <= y < b.y`,
 *      or the mirror). Half-open is what counts a shared vertex once, which is
 *      the standard cure for the double-count that leaves a notch. The x range
 *      is inclusive — `ceil(left) .. floor(right)` — so a pixel whose sample
 *      sits exactly on the edge is selected.
 *   2. Explicit edge rasterisation (DDA). The half-open rule deliberately
 *      skips the bottom-most row and horizontal edges, so those boundary
 *      pixels are added here. A boundary pixel belongs to the polygon by
 *      definition, and a filled path must not be missing the row the operator
 *      dragged along.
 */
export function fillPolygon(
  src: Uint8Array,
  width: number,
  height: number,
  points: readonly Point[],
): Uint8Array {
  const out = src.slice()
  if (points.length < 3 || width <= 0 || height <= 0) return out
  const ys = points.map((p) => p.y)
  const minY = Math.max(0, Math.ceil(Math.min(...ys)))
  const maxY = Math.min(height - 1, Math.floor(Math.max(...ys)))
  for (let y = minY; y <= maxY; y += 1) {
    const crossings: number[] = []
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      if (a.y === b.y) continue
      if ((a.y <= y && y < b.y) || (b.y <= y && y < a.y)) {
        crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x))
      }
    }
    crossings.sort((l, r) => l - r)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const startX = Math.max(0, Math.ceil(crossings[i]))
      const endX = Math.min(width - 1, Math.floor(crossings[i + 1]))
      for (let x = startX; x <= endX; x += 1) out[y * width + x] = 255
    }
  }
  for (let i = 0; i < points.length; i += 1) {
    rasteriseEdge(out, width, height, points[i], points[(i + 1) % points.length])
  }
  return out
}

/**
 * Mark every pixel a segment passes through, one sample per major-axis step.
 *
 * Rounding the interpolated coordinate keeps the trace connected on any slope
 * (a 1 px pencil line must not come out dashed) while staying within half a
 * pixel of the true edge, so it cannot leak visibly outside the polygon.
 */
function rasteriseEdge(
  out: Uint8Array,
  width: number,
  height: number,
  a: Point,
  b: Point,
  value = 255,
): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps
    const x = Math.round(a.x + (b.x - a.x) * t)
    const y = Math.round(a.y + (b.y - a.y) * t)
    if (x < 0 || y < 0 || x >= width || y >= height) continue
    out[y * width + x] = value
  }
}

/**
 * Squared distance from point `p` to segment `a`–`b`.
 *
 * The lasso keeps every pointer sample, but a `move` event can still straddle
 * a fast flick. The stroke rasteriser closes those gaps by testing every pixel
 * in a segment's bounding box against this.
 */
export function segmentDistanceSquared(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    const px = p.x - a.x
    const py = p.y - a.y
    return px * px + py * py
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared
  t = Math.min(1, Math.max(0, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  const px = p.x - cx
  const py = p.y - cy
  return px * px + py * py
}

/** Stamp a circular brush (radius in pixels, inclusive centre) into `out`. */
export function stampBrush(
  out: Uint8Array,
  width: number,
  height: number,
  centre: Point,
  radius: number,
  value = 255,
): void {
  const r = Math.max(0, Math.round(radius))
  const rSquared = r * r
  const minX = Math.max(0, centre.x - r)
  const maxX = Math.min(width - 1, centre.x + r)
  const minY = Math.max(0, centre.y - r)
  const maxY = Math.min(height - 1, centre.y + r)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centre.x
      const dy = y - centre.y
      if (dx * dx + dy * dy <= rSquared) out[y * width + x] = value
    }
  }
}

/**
 * Rasterise a freehand stroke: a disc of `radius` at every sample, plus the
 * connecting segments so a fast drag is continuous rather than a dotted line.
 *
 * `radius` 0 is a 1 px pencil: the samples and the segments between them are
 * rasterised as a single connected line (`rasteriseEdge`). Testing exact
 * distance instead would select only the pixels an off-axis segment happens to
 * cross, which is a dashed line — fine for a point, wrong for a stroke. A
 * larger radius stamps a disc at each sample and tests distance against the
 * segment, so the stroke keeps the requested width.
 *
 * `closed` joins the last sample back to the first, which is what a lasso
 * release does; without it the stroke is an open polyline and the gap between
 * the two ends is genuinely not selected.
 */
export function strokePath(
  out: Uint8Array,
  width: number,
  height: number,
  points: readonly Point[],
  radius: number,
  closed = false,
  value = 255,
): void {
  if (points.length === 0) return
  const r = Math.max(0, Math.round(radius))
  const rSquared = r * r
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    stampBrush(out, width, height, a, r, value)
    const b = points[i + 1] ?? (closed ? points[0] : null)
    if (!b) continue
    if (r === 0) {
      rasteriseEdge(out, width, height, a, b, value)
      continue
    }
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - r))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x) + r))
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - r))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y) + r))
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (segmentDistanceSquared({ x, y }, a, b) <= rSquared) out[y * width + x] = value
      }
    }
  }
}

/** Axis-aligned bounds of every non-zero byte. `null` when nothing is set. */
export function contentBounds(
  mask: Uint8Array,
  width: number,
  height: number,
): Rect | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
