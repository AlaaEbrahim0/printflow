/**
 * The editable path behind the polygon tool.
 *
 * A lasso is a gesture: you draw it, you release, it is what it is. A polygon
 * path is an *object*: you click corners, then you drag a corner that landed in
 * the wrong place, or drop one, and only then fill it. That difference is the
 * whole reason the path exists, so it lives in its own module with its own
 * operations rather than being a mode flag inside the pointer handler.
 *
 * Points are in raster pixels. The path is never self-closing here; closing is
 * an explicit action, because an accidental click near the start point should
 * not silently commit the selection.
 */
import { fillPolygon, type Point } from './selectionGeometry'

export interface PathState {
  points: Point[]
  closed: boolean
}

export const EMPTY_PATH: PathState = { points: [], closed: false }

/** Distance in pixels within which a click grabs an existing vertex. */
export const VERTEX_HIT_RADIUS = 8

export function addPathPoint(path: PathState, point: Point): PathState {
  // No duplicate first point: clicking the start closes the path instead, and
  // a duplicated corner would make the fill render a zero-length edge. A path
  // with fewer than three corners cannot close, so there the click is kept —
  // swallowing it would look like the editor dropped the click.
  if (path.points.length >= 3) {
    const first = path.points[0]
    if (Math.abs(first.x - point.x) <= 1 && Math.abs(first.y - point.y) <= 1) {
      return closePath(path)
    }
  }
  return { points: [...path.points, { x: Math.round(point.x), y: Math.round(point.y) }], closed: path.closed }
}

export function closePath(path: PathState): PathState {
  if (path.points.length < 3) return path
  return { points: path.points, closed: true }
}

/** Remove the most recent corner; open a closed path rather than deleting it. */
export function undoPathPoint(path: PathState): PathState {
  if (path.closed) return { points: path.points, closed: false }
  if (path.points.length === 0) return path
  return { points: path.points.slice(0, -1), closed: false }
}

/**
 * Index of the vertex under `point`, or −1.
 *
 * Nearest wins, so two corners within the radius resolve to the one the cursor
 * is actually over instead of whichever comes first in the array.
 */
export function hitPathVertex(path: PathState, point: Point, radius = VERTEX_HIT_RADIUS): number {
  let bestIndex = -1
  let bestDistance = radius * radius
  for (let i = 0; i < path.points.length; i += 1) {
    const dx = path.points[i].x - point.x
    const dy = path.points[i].y - point.y
    const distance = dx * dx + dy * dy
    if (distance <= bestDistance) {
      bestDistance = distance
      bestIndex = i
    }
  }
  return bestIndex
}

export function movePathVertex(path: PathState, index: number, point: Point): PathState {
  if (index < 0 || index >= path.points.length) return path
  const points = path.points.slice()
  points[index] = { x: Math.round(point.x), y: Math.round(point.y) }
  return { points, closed: path.closed }
}

export function removePathVertex(path: PathState, index: number): PathState {
  if (index < 0 || index >= path.points.length) return path
  const points = path.points.slice(0, index).concat(path.points.slice(index + 1))
  // Losing a corner can leave a path that is no longer a polygon; it stays
  // open so the operator can keep placing points instead of getting a
  // degenerate two-point fill.
  return { points, closed: path.closed && points.length >= 3 }
}

export function canFillPath(path: PathState): boolean {
  // An open path can still be filled — Photoshop fills stroke-to-stroke — but
  // it needs a real polygon, not a line.
  return path.points.length >= 3
}

/** Rasterise a closed path into `base`, returning a new buffer. */
export function fillPath(
  base: Uint8Array,
  width: number,
  height: number,
  path: PathState,
): Uint8Array {
  if (!canFillPath(path)) return base.slice()
  return fillPolygon(base, width, height, path.points)
}

/** Whether this is the degenerate "one point placed" state worth showing. */
export function isPathInProgress(path: PathState): boolean {
  return path.points.length > 0
}
