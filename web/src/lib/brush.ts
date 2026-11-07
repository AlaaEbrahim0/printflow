import type { BrushOp } from '../api/client'

/**
 * Pure geometry for the background-removal brush editor.
 *
 * There is deliberately no canvas, no image decoding and no pixel writing in
 * this file (or anywhere in the editor): background removal is a
 * **non-destructive mask** and the brush strokes are *parameters recorded on a
 * new immutable version* (AGENTS.md §2 rules 1, 2 and 4). The editor produces a
 * `BrushOp[]` in the frozen contract shape and nothing else.
 *
 * Two units are used and never mixed up:
 *   - **source pixels** — the coordinate space of the immutable version file and
 *     therefore the only space that is ever recorded;
 *   - **CSS pixels** — viewport space, which depends on zoom and never reaches
 *     the recorded output.
 */

/** The two tools, taken straight from the frozen `BrushOp` contract. */
export type BrushTool = BrushOp['tool']

/** A point in source pixels. Fractional until it is recorded. */
export interface SourcePoint {
  x: number
  y: number
}

/** Extent of the immutable artwork being edited, in source pixels. */
export interface ImageBounds {
  widthPx: number
  heightPx: number
}

/** Size of the scrollable editor surface, in CSS pixels. */
export interface CssSize {
  width: number
  height: number
}

/** How source pixels map onto the visible surface. */
export interface ViewportMapping {
  /** CSS pixels per source pixel (contain-fit at zoom 1, multiplied by zoom). */
  scale: number
  /**
   * Content-space position of the image origin, in CSS pixels. Clamped at 0 so
   * zooming only ever grows the content box: a negative origin could not be
   * scrolled to inside `overflow: auto`, so it would hide artwork.
   */
  offsetX: number
  offsetY: number
  /** Source extent, echoed for callers that render without re-deriving it. */
  widthPx: number
  heightPx: number
  /** `widthPx * scale`, the box the image is painted into (CSS pixels). */
  displayWidth: number
  displayHeight: number
}

/** One continuous brush pass. Immutable: every mutation returns a new value. */
export interface Stroke {
  id: string
  tool: BrushTool
  radiusPx: number
  /** Integer source-pixel points, clipped to the image bounds, in stroke order. */
  points: SourcePoint[]
  /**
   * True when the stroke was replayed from a version's recorded `brushOps`.
   * Recorded strokes are history: undo/clear never removes them.
   */
  recorded: boolean
}

/** Conservative rectangle around a stroke, in source pixels. */
export interface StrokeBounds {
  x0: number
  y0: number
  x1: number
  y1: number
  widthPx: number
  heightPx: number
}

/** Contract limits (`contracts/openapi/printsheet-api.yaml`, schema `BrushOp`). */
export const MIN_RADIUS_PX = 1
export const MAX_RADIUS_PX = 4096
/** Contract `brushOps` maxItems. */
export const MAX_BRUSH_OPS = 10000
/** Contract `points` maxItems. */
export const MAX_POINTS_PER_STROKE = 100000

export const DEFAULT_RADIUS_PX = 24
export const MIN_ZOOM = 1
export const MAX_ZOOM = 8
export const DEFAULT_ZOOM = 1
/** Single-key shortcuts for the tools. */
export const ERASE_TOOL_KEY = 'e'
export const RESTORE_TOOL_KEY = 'r'
/** Keyboard cursor steps, in source pixels. */
export const KEYBOARD_CURSOR_STEP_PX = 1
export const KEYBOARD_CURSOR_BIG_STEP_PX = 10
export const KEYBOARD_RADIUS_STEP_PX = 2

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function isBrushToolValue(value: unknown): value is BrushTool {
  return value === 'erase' || value === 'restore'
}

/** Re-exported so callers can narrow server-supplied parameters safely. */
export function isBrushTool(value: unknown): value is BrushTool {
  return isBrushToolValue(value)
}

export function clamp(value: number, min: number, max: number): number {
  const numeric = finiteOr(Number(value), min)
  if (numeric < min) return min
  if (numeric > max) return max
  return numeric
}

/** Brush radius in source pixels, clamped to the contract range and integral. */
export function clampRadius(value: number): number {
  return Math.round(clamp(value, MIN_RADIUS_PX, MAX_RADIUS_PX))
}

export function clampZoom(value: number): number {
  return clamp(value, MIN_ZOOM, MAX_ZOOM)
}

/** Last valid source-pixel index on an axis; at least one pixel always exists. */
function lastIndex(sizePx: number): number {
  const rounded = Math.max(1, Math.round(finiteOr(sizePx, 1)))
  return rounded - 1
}

/**
 * Contain-fit mapping of the artwork into the surface, then zoom and pan.
 *
 * A container of unknown size (jsdom, or a surface that has not been measured
 * yet) degrades to 1 CSS pixel per source pixel with no offset, so the maths
 * stays defined instead of inventing a viewport.
 */
export function viewportMapping(
  source: ImageBounds,
  container: CssSize,
  zoom: number = DEFAULT_ZOOM,
  pan: SourcePoint = { x: 0, y: 0 },
): ViewportMapping {
  const widthPx = Math.max(1, Math.round(finiteOr(source.widthPx, 1)))
  const heightPx = Math.max(1, Math.round(finiteOr(source.heightPx, 1)))
  const containerWidth = Math.max(0, finiteOr(container.width, 0))
  const containerHeight = Math.max(0, finiteOr(container.height, 0))

  const fitScale =
    containerWidth > 0 && containerHeight > 0
      ? Math.min(containerWidth / widthPx, containerHeight / heightPx)
      : 1
  const scale = fitScale * clampZoom(zoom)
  const displayWidth = widthPx * scale
  const displayHeight = heightPx * scale
  const panX = finiteOr(pan.x, 0)
  const panY = finiteOr(pan.y, 0)

  return {
    scale,
    // Never negative: a stage placed at a negative origin inside `overflow: auto`
    // could not be scrolled to, so zooming can only grow the content box.
    offsetX: Math.max(0, (containerWidth - displayWidth) / 2 + panX),
    offsetY: Math.max(0, (containerHeight - displayHeight) / 2 + panY),
    widthPx,
    heightPx,
    displayWidth,
    displayHeight,
  }
}

/** Surface (CSS) coordinates of a source point, in content space. */
export function toViewportPoint(point: SourcePoint, mapping: ViewportMapping): SourcePoint {
  return {
    x: mapping.offsetX + finiteOr(point.x, 0) * mapping.scale,
    y: mapping.offsetY + finiteOr(point.y, 0) * mapping.scale,
  }
}

/**
 * Source-pixel coordinates of a point on the surface, given as CSS pixels
 * relative to the surface element's own box (plus its scroll offsets).
 *
 * Returns fractional source coordinates: rounding happens when a point is
 * recorded, so zoom can never change the geometry that gets emitted.
 */
export function toSourcePoint(viewportX: number, viewportY: number, mapping: ViewportMapping): SourcePoint {
  const scale = mapping.scale > 0 && Number.isFinite(mapping.scale) ? mapping.scale : 1
  return {
    x: (finiteOr(viewportX, 0) - mapping.offsetX) / scale,
    y: (finiteOr(viewportY, 0) - mapping.offsetY) / scale,
  }
}

/** Round to an integral source point, then clip to the image, point by point. */
export function snapPointToImage(point: SourcePoint, imageBounds: ImageBounds): SourcePoint {
  return {
    x: clamp(Math.round(finiteOr(point.x, 0)), 0, lastIndex(imageBounds.widthPx)),
    y: clamp(Math.round(finiteOr(point.y, 0)), 0, lastIndex(imageBounds.heightPx)),
  }
}

export interface BeginStrokeOptions {
  id?: string
  recorded?: boolean
}

/**
 * Start a stroke. The starting point is snapped and clipped so even the first
 * point is contract-legal; a stroke therefore always has exactly one point and
 * `strokesToOps` can never emit the contract-forbidden empty `points` array
 * from it.
 */
export function beginStroke(
  tool: BrushTool,
  radiusPx: number,
  point: SourcePoint,
  imageBounds: ImageBounds,
  options: BeginStrokeOptions = {},
): Stroke {
  return {
    id: options.id ?? `${tool}-stroke`,
    tool,
    radiusPx: clampRadius(radiusPx),
    points: [snapPointToImage(point, imageBounds)],
    recorded: options.recorded ?? false,
  }
}

/** A stroke with no points, kept for callers that need a placeholder. */
export function emptyStroke(tool: BrushTool, radiusPx: number, id = 'empty'): Stroke {
  return { id, tool, radiusPx: clampRadius(radiusPx), points: [], recorded: false }
}

/**
 * Append a point to a stroke, immutably.
 *
 * Consecutive duplicates (after rounding and clipping) are dropped: a pointer
 * that jitters in place must not flood the op with identical points. Points
 * outside the image are clipped to the border rather than dropped, so a stroke
 * that leaves the artwork still records how far the operator dragged.
 */
export function appendPoint(stroke: Stroke, point: SourcePoint, imageBounds: ImageBounds): Stroke {
  if (stroke.points.length >= MAX_POINTS_PER_STROKE) return stroke
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return stroke
  const snapped = snapPointToImage(point, imageBounds)
  const last = stroke.points[stroke.points.length - 1]
  if (last && last.x === snapped.x && last.y === snapped.y) return stroke
  return { ...stroke, points: [...stroke.points, snapped] }
}

/** Rebuild a stroke from a raw point list, snapping and deduplicating each. */
export function strokeFromPoints(
  tool: BrushTool,
  radiusPx: number,
  points: readonly SourcePoint[],
  imageBounds: ImageBounds,
  options: BeginStrokeOptions = {},
): Stroke {
  let stroke: Stroke = {
    id: options.id ?? `${tool}-rebuilt`,
    tool,
    radiusPx: clampRadius(radiusPx),
    points: [],
    recorded: options.recorded ?? false,
  }
  for (const point of points) {
    stroke = appendPoint(stroke, point, imageBounds)
  }
  return stroke
}

function toContractPoint(point: SourcePoint): number[] {
  return [
    clamp(Math.round(finiteOr(point.x, 0)), 0, Number.MAX_SAFE_INTEGER),
    clamp(Math.round(finiteOr(point.y, 0)), 0, Number.MAX_SAFE_INTEGER),
  ]
}

/**
 * Strokes in draw order to `BrushOp[]`.
 *
 * Empty strokes are dropped (`points` has `minItems: 1`), the radius is clamped
 * into the contract range and every coordinate is an integer source pixel.
 */
export function strokesToOps(strokes: readonly Stroke[]): BrushOp[] {
  return strokes
    .filter((stroke) => stroke.points.length > 0)
    .map((stroke) => ({
      tool: isBrushToolValue(stroke.tool) ? stroke.tool : 'erase',
      radiusPx: clampRadius(stroke.radiusPx),
      points: stroke.points.map(toContractPoint),
    }))
}

/**
 * Recorded `brushOps` back to strokes, so a version can be re-opened and its
 * history replayed. Unknown tools and malformed points are skipped instead of
 * guessed at; `strokesToOps(opsToStrokes(ops))` reproduces well-formed ops
 * exactly.
 */
export function opsToStrokes(
  ops: readonly BrushOp[],
  imageBounds: ImageBounds,
  idPrefix = 'recorded',
): Stroke[] {
  const strokes: Stroke[] = []
  ops.forEach((op, index) => {
    if (!op || !isBrushToolValue(op.tool)) return
    const points: SourcePoint[] = []
    for (const raw of op.points ?? []) {
      if (!Array.isArray(raw) || raw.length < 2) continue
      const [x, y] = raw
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push(snapPointToImage({ x, y }, imageBounds))
    }
    strokes.push(
      strokeFromPoints(op.tool, clampRadius(op.radiusPx), points, imageBounds, {
        id: `${idPrefix}-${index}`,
        recorded: true,
      }),
    )
  })
  return strokes
}

function isEditable(stroke: Stroke): boolean {
  return !stroke.recorded
}

/** Drop the most recent stroke drawn here. Recorded history is untouched. */
export function undoLastStroke(strokes: readonly Stroke[]): Stroke[] {
  for (let index = strokes.length - 1; index >= 0; index -= 1) {
    if (isEditable(strokes[index]!)) {
      return [...strokes.slice(0, index), ...strokes.slice(index + 1)]
    }
  }
  return [...strokes]
}

/**
 * Remove every stroke drawn in this editing session. Ops that came from the
 * version's recorded history stay in place: brush history is append-only, so
 * clearing the canvas must not silently rewrite an earlier version's parameters.
 */
export function clearStrokes(strokes: readonly Stroke[] = []): Stroke[] {
  return strokes.filter(isEditable)
}

/** How many more ops fit under the contract's `brushOps` limit. */
export function opBudgetRemaining(existingCount: number): number {
  return Math.max(0, MAX_BRUSH_OPS - Math.max(0, Math.round(finiteOr(existingCount, 0))))
}

export function exceedsOpBudget(ops: readonly BrushOp[]): boolean {
  return ops.length > MAX_BRUSH_OPS
}

/**
 * Append-only merge of recorded history with the ops drawn now.
 *
 * Earlier entries are copied by reference and never rewritten or reordered; if
 * the budget is exhausted the extra new ops are refused (and surfaced in the UI)
 * rather than squeezing out history.
 */
export function mergeOps(existing: readonly BrushOp[], appended: readonly BrushOp[]): BrushOp[] {
  const merged = [...existing]
  for (const op of appended) {
    if (merged.length >= MAX_BRUSH_OPS) break
    merged.push(op)
  }
  return merged
}

/**
 * Bounding rectangle of a stroke including the brush disc.
 *
 * The radius is added on every side without checking whether the disc actually
 * reaches that far, so this is an upper bound — conservative estimates are the
 * house rule. `null` for a stroke with no points.
 */
export function strokeBounds(stroke: Stroke): StrokeBounds | null {
  if (stroke.points.length === 0) return null
  const radius = clampRadius(stroke.radiusPx)
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const point of stroke.points) {
    x0 = Math.min(x0, point.x)
    y0 = Math.min(y0, point.y)
    x1 = Math.max(x1, point.x)
    y1 = Math.max(y1, point.y)
  }
  return {
    x0: x0 - radius,
    y0: y0 - radius,
    x1: x1 + radius,
    y1: y1 + radius,
    widthPx: x1 - x0 + radius * 2 + 1,
    heightPx: y1 - y0 + radius * 2 + 1,
  }
}

/**
 * Upper-bound coverage of a stroke in square source pixels: the sum of one disc
 * per point, with no union, so overlapping discs are counted many times and the
 * result may well exceed the image area. It is a readout for the operator, never
 * a gate — the real mask is computed by the worker.
 */
export function estimateCoveragePx(stroke: Stroke): number {
  const radius = clampRadius(stroke.radiusPx)
  return stroke.points.length * Math.PI * radius * radius
}

/** `e` → erase, `r` → restore, anything else → null. Case-insensitive. */
export function toolFromKey(key: string): BrushTool | null {
  if (typeof key !== 'string') return null
  const normalized = key.trim().toLowerCase()
  if (normalized === ERASE_TOOL_KEY) return 'erase'
  if (normalized === RESTORE_TOOL_KEY) return 'restore'
  return null
}

/** New cursor position after a keyboard step, clipped to the image. */
export function moveCursor(
  cursor: SourcePoint,
  deltaX: number,
  deltaY: number,
  imageBounds: ImageBounds,
): SourcePoint {
  return snapPointToImage(
    {
      x: finiteOr(cursor.x, 0) + finiteOr(deltaX, 0),
      y: finiteOr(cursor.y, 0) + finiteOr(deltaY, 0),
    },
    imageBounds,
  )
}

/** Where the keyboard cursor starts: the centre of the artwork. */
export function centerCursor(imageBounds: ImageBounds): SourcePoint {
  return snapPointToImage(
    { x: imageBounds.widthPx / 2 - 0.5, y: imageBounds.heightPx / 2 - 0.5 },
    imageBounds,
  )
}

export const TOOL_LABELS: Record<BrushTool, string> = {
  erase: 'Erase',
  restore: 'Restore',
}

export const TOOL_HINTS: Record<BrushTool, string> = {
  erase: 'Hide artwork here (alpha 0 in the mask)',
  restore: 'Bring artwork back here (alpha from the original)',
}
