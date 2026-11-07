import type { CropRect } from '../api/client'

/**
 * All crop geometry, as pure functions over integers. No React, no DOM, no
 * canvas.
 *
 * Two product rules shape this module (AGENTS.md §2):
 *
 * 1. A crop is a *proposal* about an immutable version file, so the only output
 *    that matters is a `CropRect` in **source pixels**. Nothing here resamples,
 *    scales or redraws pixels — that is the worker's job after a human approves.
 * 2. Zoom and pan are a display transform. Every conversion between screen space
 *    and source space goes through the functions below, so the rectangle a human
 *    drags out is provably the same at 0.5× and at 4×, and never depends on the
 *    pixel size of the viewport element.
 */

/** Pixel bounds of the immutable version file being cropped. */
export interface PixelBounds {
  widthPx: number
  heightPx: number
}

/** The eight resize grips: four corners plus four edge midpoints. */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const CROP_HANDLES: readonly CropHandle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
] as const

/** Which axes a grip moves, and which corner/edge stays anchored. */
export interface GripAxes {
  west: boolean
  east: boolean
  north: boolean
  south: boolean
  /** Grip lies on the left side, so the right edge is the anchor. */
  leftGrip: boolean
  /** Grip lies on the top side, so the bottom edge is the anchor. */
  topGrip: boolean
  /** Corners move both axes; edge midpoints move exactly one. */
  corner: boolean
}

export function gripAxes(handle: CropHandle): GripAxes {
  const west = handle === 'w' || handle === 'nw' || handle === 'sw'
  const east = handle === 'e' || handle === 'ne' || handle === 'se'
  const north = handle === 'n' || handle === 'nw' || handle === 'ne'
  const south = handle === 's' || handle === 'sw' || handle === 'se'
  return {
    west,
    east,
    north,
    south,
    leftGrip: west,
    topGrip: north,
    corner: (west || east) && (north || south),
  }
}

/** A crop can never collapse to nothing: one source pixel is the floor. */
export const MIN_CROP_PX = 1

/** Display scale, in screen pixels per source pixel. */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 32
/** Wheel and ± buttons multiply, so zooming feels even on a log scale. */
export const ZOOM_STEP = 1.25

export const NUDGE_STEP_PX = 1
export const NUDGE_COARSE_STEP_PX = 10

/** Size of an element in screen (CSS) pixels. */
export interface SizePx {
  width: number
  height: number
}

export interface ScreenPoint {
  x: number
  y: number
}

/** A rectangle in screen space, relative to the viewport element. */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The display transform: a scale plus where source pixel (0, 0) sits inside the
 * viewport element. `pan` is the *only* offset — the viewport is the reference
 * frame, so the image itself is laid out by `zoom` and `pan` alone.
 */
export interface ViewState {
  zoom: number
  /** Screen x of source x = 0. */
  panX: number
  /** Screen y of source y = 0. */
  panY: number
}

/** The viewport element's box in screen pixels: the reference frame. */
export interface ViewportFrame {
  width: number
  height: number
}

export type CropField = 'x' | 'y' | 'width' | 'height'

export interface CropFieldError {
  field: CropField
  message: string
}

export interface CropInputResult {
  rect: CropRect
  errors: CropFieldError[]
}

/** Numeric inputs arrive as strings, empty fields or `NaN`. */
export type CropFieldInput = number | string | null | undefined

export interface CropInputFields {
  x?: CropFieldInput
  y?: CropFieldInput
  width?: CropFieldInput
  height?: CropFieldInput
}

export interface ResizeOptions {
  aspectLock?: number | null
}

/**
 * What a pointer interaction is doing. One drag is one gesture: the rectangle
 * is moved or resized from the grip that started it, never both.
 */
export type DragMode =
  | { kind: 'move' }
  | { kind: 'resize'; handle: CropHandle }
  | { kind: 'draw'; anchor: ScreenPoint }

export const HANDLE_LABELS: Record<CropHandle, string> = {
  nw: 'top-left corner',
  n: 'top edge',
  ne: 'top-right corner',
  e: 'right edge',
  se: 'bottom-right corner',
  s: 'bottom edge',
  sw: 'bottom-left corner',
  w: 'left edge',
}

export const HANDLE_CURSORS: Record<CropHandle, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

/** Rule-of-thirds guide positions, as fractions across the crop. */
export const GUIDE_FRACTIONS: readonly number[] = [1 / 3, 2 / 3]

function toInteger(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0
}

function toPositiveInteger(value: number, fallback: number): number {
  const integer = Math.round(value)
  return Number.isFinite(integer) && integer > 0 ? integer : fallback
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return value < min ? min : value > max ? max : value
}

function parseField(value: CropFieldInput): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** Sanitized bounds: always at least 1×1, always whole pixels. */
export function makeBounds(widthPx: number, heightPx: number): PixelBounds {
  return {
    widthPx: toPositiveInteger(widthPx, 1),
    heightPx: toPositiveInteger(heightPx, 1),
  }
}

export function fullImageRect(bounds: PixelBounds): CropRect {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  return { x: 0, y: 0, width: safe.widthPx, height: safe.heightPx }
}

/**
 * Integer rect inside the image, minimum 1×1. The size is clamped first, so an
 * over-wide rect shrinks to the image instead of sliding out of it.
 */
export function clampRect(rect: CropRect, bounds: PixelBounds): CropRect {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const width = clamp(toInteger(parseField(rect.width) ?? 0), MIN_CROP_PX, safe.widthPx)
  const height = clamp(toInteger(parseField(rect.height) ?? 0), MIN_CROP_PX, safe.heightPx)
  const x = clamp(toInteger(parseField(rect.x) ?? 0), 0, safe.widthPx - width)
  const y = clamp(toInteger(parseField(rect.y) ?? 0), 0, safe.heightPx - height)
  return { x, y, width, height }
}

/** Translation, kept inside the image. Never changes the size. */
export function moveRect(
  rect: CropRect,
  dxPx: number,
  dyPx: number,
  bounds: PixelBounds,
): CropRect {
  const base = clampRect(rect, bounds)
  return clampRect(
    { ...base, x: base.x + toInteger(dxPx), y: base.y + toInteger(dyPx) },
    bounds,
  )
}

/** Keyboard nudge step: 1 source pixel, or 10 with Shift. */
export function nudgeStep(shiftKey: boolean): number {
  return shiftKey ? NUDGE_COARSE_STEP_PX : NUDGE_STEP_PX
}

export function aspectFor(rect: CropRect): number {
  const width = parseField(rect.width) ?? 0
  const height = parseField(rect.height) ?? 0
  if (height <= 0 || width <= 0) return 0
  return width / height
}

/**
 * Force `ratio` (width ÷ height) onto `rect`, keeping the edge opposite `handle`
 * anchored. Corners and the `e`/`w` grips drive the height from the width; the
 * `n`/`s` grips drive the width from the height. When the locked rect would not
 * fit the image it shrinks on both axes, because an image edge always beats the
 * ratio — a crop must never reach outside the file.
 */
export function applyAspectLock(
  rect: CropRect,
  ratio: number,
  handle: CropHandle,
  bounds: PixelBounds,
): CropRect {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const base = clampRect(rect, safe)
  if (!Number.isFinite(ratio) || ratio <= 0) return base

  const axes = gripAxes(handle)
  const rightAnchor = base.x + base.width
  const bottomAnchor = base.y + base.height
  // A grip on the left keeps the right edge fixed, so it may consume everything
  // to that anchor, including the space the grip itself vacated.
  const maxWidth = axes.leftGrip ? rightAnchor : safe.widthPx - base.x
  const maxHeight = axes.topGrip ? bottomAnchor : safe.heightPx - base.y

  let width: number
  let height: number
  if (handle === 'n' || handle === 's') {
    height = base.height
    width = toInteger(base.height * ratio)
  } else {
    width = base.width
    height = toInteger(base.width / ratio)
  }

  if (width > maxWidth) {
    width = maxWidth
    height = toInteger(width / ratio)
  }
  if (height > maxHeight) {
    height = maxHeight
    width = toInteger(height * ratio)
  }

  width = clamp(width, MIN_CROP_PX, maxWidth)
  height = clamp(height, MIN_CROP_PX, maxHeight)

  const x = axes.leftGrip ? rightAnchor - width : base.x
  const y = axes.topGrip ? bottomAnchor - height : base.y

  return clampRect({ x, y, width, height }, safe)
}

/**
 * Resize from one of the eight grips. The edge opposite the grip stays put; an
 * attempted inversion collapses to the 1 px minimum instead of flipping the
 * rectangle, because a flipped crop would silently move the region.
 */
export function resizeRect(
  rect: CropRect,
  handle: CropHandle,
  dxPx: number,
  dyPx: number,
  bounds: PixelBounds,
  options: ResizeOptions = {},
): CropRect {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const base = clampRect(rect, safe)
  const dx = toInteger(dxPx)
  const dy = toInteger(dyPx)
  const axes = gripAxes(handle)

  const right = base.x + base.width
  const bottom = base.y + base.height

  let x = base.x
  let y = base.y
  let width = base.width
  let height = base.height

  if (axes.west) {
    x = clamp(base.x + dx, 0, right - MIN_CROP_PX)
    width = right - x
  }
  if (axes.east) {
    width = clamp(right + dx, base.x + MIN_CROP_PX, safe.widthPx) - base.x
  }
  if (axes.north) {
    y = clamp(base.y + dy, 0, bottom - MIN_CROP_PX)
    height = bottom - y
  }
  if (axes.south) {
    height = clamp(bottom + dy, base.y + MIN_CROP_PX, safe.heightPx) - base.y
  }

  const moved = { x, y, width, height }
  const ratio = options.aspectLock ?? null
  if (ratio !== null && ratio > 0) return applyAspectLock(moved, ratio, handle, safe)
  return clampRect(moved, safe)
}

/**
 * Apply one gesture. `move` and `resize` start from the current rectangle;
 * `draw` ignores it and produces a brand-new one from the anchor captured when
 * the pointer went down, so a fresh marquee is as zoom-independent as dragging
 * a handle.
 */
export function applyDrag(
  rect: CropRect,
  mode: DragMode,
  delta: ScreenPoint,
  bounds: PixelBounds,
  options: ResizeOptions = {},
): CropRect {
  if (mode.kind === 'move') return moveRect(rect, delta.x, delta.y, bounds)
  if (mode.kind === 'resize') {
    return resizeRect(rect, mode.handle, delta.x, delta.y, bounds, options)
  }
  return rectFromSourcePoints(
    mode.anchor,
    { x: mode.anchor.x + delta.x, y: mode.anchor.y + delta.y },
    bounds,
  )
}

/** The crop between two source points: order-independent, never inverted. */
export function rectFromSourcePoints(
  a: ScreenPoint,
  b: ScreenPoint,
  bounds: PixelBounds,
): CropRect {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const left = clamp(Math.round(Math.min(a.x, b.x)), 0, safe.widthPx - MIN_CROP_PX)
  const top = clamp(Math.round(Math.min(a.y, b.y)), 0, safe.heightPx - MIN_CROP_PX)
  const right = clamp(Math.round(Math.max(a.x, b.x)), left + MIN_CROP_PX, safe.widthPx)
  const bottom = clamp(Math.round(Math.max(a.y, b.y)), top + MIN_CROP_PX, safe.heightPx)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Validate the four numeric inputs. Invalid or missing entries fall back to a
 * sane value and are reported, so the form never emits a broken rect while the
 * operator is still typing.
 */
export function rectFromInputs(
  input: CropInputFields,
  bounds: PixelBounds,
  current?: CropRect,
): CropInputResult {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const errors: CropFieldError[] = []

  /**
   * An unparsable field must not throw away the crop: fall back to the current
   * rectangle, or to the full image when there is none.
   */
  const fallbackFor = (field: CropField): number => {
    if (current) return toInteger(current[field])
    return field === 'width' ? safe.widthPx : field === 'height' ? safe.heightPx : 0
  }

  const read = (field: CropField, value: CropFieldInput, max: number, minimum = 0): number => {
    const parsed = parseField(value)
    if (parsed === null) {
      errors.push({
        field,
        message: `${labelFor(field)} must be a whole number between ${minimum} and ${max}.`,
      })
      return clamp(fallbackFor(field), minimum, max)
    }
    const integer = Math.round(parsed)
    if (integer < minimum) {
      errors.push({
        field,
        message: `${labelFor(field)} cannot be below ${minimum} px; using ${minimum}.`,
      })
      return minimum
    }
    if (integer > max) {
      errors.push({ field, message: `${labelFor(field)} is limited to ${max} px here.` })
      return max
    }
    return integer
  }

  // Size first: it decides how much room the origin still has.
  const width = read('width', input.width, safe.widthPx, MIN_CROP_PX)
  const height = read('height', input.height, safe.heightPx, MIN_CROP_PX)
  const x = read('x', input.x, safe.widthPx - width)
  const y = read('y', input.y, safe.heightPx - height)

  return { rect: clampRect({ x, y, width, height }, safe), errors }
}

function labelFor(field: CropField): string {
  return field === 'x' ? 'X' : field === 'y' ? 'Y' : field === 'width' ? 'Width' : 'Height'
}

/** True when the crop is the whole file, i.e. a crop that would change nothing. */
export function isFullImage(rect: CropRect, bounds: PixelBounds): boolean {
  const safe = makeBounds(bounds.widthPx, bounds.heightPx)
  const base = clampRect(rect, safe)
  return base.x === 0 && base.y === 0 && base.width === safe.widthPx && base.height === safe.heightPx
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM)
}

/**
 * The view that fits `rect` into a viewport of `viewport` screen pixels and
 * centres it. The returned `pan` is relative to the viewport element, never to
 * the page, so layout can move the element without moving the geometry.
 */
export function viewportFor(
  rect: CropRect,
  viewport: ViewportFrame,
  options: { paddingPx?: number; maxZoom?: number } = {},
): ViewState {
  const padding = Number.isFinite(options.paddingPx) ? (options.paddingPx ?? 0) : 0
  const maxZoom = clampZoom(options.maxZoom ?? MAX_ZOOM)
  const size = makeBounds(rect.width, rect.height)
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const zoom = clamp(Math.min(availableWidth / size.widthPx, availableHeight / size.heightPx), MIN_ZOOM, maxZoom)
  return {
    zoom,
    panX: (viewport.width - size.widthPx * zoom) / 2 - rect.x * zoom,
    panY: (viewport.height - size.heightPx * zoom) / 2 - rect.y * zoom,
  }
}

/** Multiply the scale while pinning whatever is under `anchor`. */
export function zoomAt(view: ViewState, nextZoom: number, anchor: ScreenPoint): ViewState {
  const zoom = clampZoom(nextZoom)
  const source = sourcePointFromViewport(anchor, view)
  return {
    zoom,
    panX: anchor.x - source.x * zoom,
    panY: anchor.y - source.y * zoom,
  }
}

export function panView(view: ViewState, dxPx: number, dyPx: number): ViewState {
  return { ...view, zoom: view.zoom, panX: view.panX + toInteger(dxPx), panY: view.panY + toInteger(dyPx) }
}

/** Where a source rect lands on screen. Fractions are fine: display only. */
export function viewportRectFromSource(rect: CropRect, view: ViewState): ScreenRect {
  return {
    left: rect.x * view.zoom + view.panX,
    top: rect.y * view.zoom + view.panY,
    width: rect.width * view.zoom,
    height: rect.height * view.zoom,
  }
}

/** The source pixel under a screen point, relative to the viewport element. */
export function sourcePointFromViewport(point: ScreenPoint, view: ViewState): ScreenPoint {
  return {
    x: (point.x - view.panX) / view.zoom,
    y: (point.y - view.panY) / view.zoom,
  }
}

/**
 * Convert a screen-space drag into a source-space delta. Deliberately ignores
 * the pan and the viewport size: the same movement on screen maps to fewer
 * source pixels the closer you zoom, which is what keeps the emitted rect
 * identical for the same physical drag at any zoom.
 */
export function sourceDeltaFromViewport(delta: ScreenPoint, view: ViewState): ScreenPoint {
  return { x: toInteger(delta.x / view.zoom), y: toInteger(delta.y / view.zoom) }
}
