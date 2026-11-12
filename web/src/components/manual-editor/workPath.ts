/**
 * Pointer and keyboard glue for the polygon work path.
 *
 * `pathModel` owns the path *data*; this module owns the *gesture* that edits
 * it, so the component's pointer handler stays a switch instead of a tangle of
 * hit tests. Keeping it separate also makes the interaction testable without a
 * canvas: every rule below is "given this path and this click, what happens".
 *
 * The rules mirror a pen tool, because that is the muscle memory the shop
 * already has from Photoshop:
 *   - click empty space        → add a corner
 *   - click the first corner   → close the path (three corners minimum)
 *   - drag an existing corner  → move it
 *   - Alt-click a corner       → remove it
 *   - Enter / Escape / Delete  → fill, cancel, drop the last corner
 *
 * A press that grabbed a corner reports `vertex`, and the caller feeds pointer
 * moves back through `dragWorkPath` until release. A press that closed the
 * path reports `completed`, and the caller fills it immediately — that is the
 * "click the start point to finish" gesture.
 */
import {
  addPathPoint,
  canFillPath,
  closePath,
  hitPathVertex,
  movePathVertex,
  removePathVertex,
  type PathState,
} from './pathModel'

export interface WorkPathPress {
  /** Path after the press. */
  path: PathState
  /** Corner being dragged, or `null` when the press did not grab one. */
  vertex: number | null
  /** True when this press closed the path, so the caller should fill it. */
  completed: boolean
}

export function pressWorkPath(
  path: PathState,
  point: { x: number; y: number },
  options: { altKey?: boolean } = {},
): WorkPathPress {
  const hit = hitPathVertex(path, point)
  if (hit >= 0) {
    // Alt-click drops a corner without starting a drag; a plain press grabs
    // it. Both leave the path open, so a corner that landed in the wrong place
    // is fixed without discarding the whole polygon.
    if (options.altKey) {
      return { path: removePathVertex(path, hit), vertex: null, completed: false }
    }
    // Pressing the *first* corner of a fillable path closes it — the "click the
    // start point to finish" gesture every pen tool has. This has to be decided
    // before the grab, because the hit radius (8 px) is far larger than
    // `addPathPoint`'s one-pixel duplicate test, so otherwise a press on the
    // start corner could only ever grab it and the path could never be closed
    // by clicking.
    if (hit === 0 && canFillPath(path) && !path.closed) {
      return { path: closePath(path), vertex: null, completed: true }
    }
    return { path, vertex: hit, completed: false }
  }
  const next = addPathPoint(path, point)
  const completed = next.closed && !path.closed
  return { path: next, vertex: null, completed }
}

/** Move the corner grabbed by `pressWorkPath`; a no-op without one. */
export function dragWorkPath(
  path: PathState,
  vertex: number | null,
  point: { x: number; y: number },
): PathState {
  if (vertex === null) return path
  return movePathVertex(path, vertex, point)
}

export type WorkPathKeyAction = 'fill' | 'cancel' | 'undo-point'

/**
 * What a key press means while a work path is open.
 *
 * `null` means "not ours" — the caller must not `preventDefault`, so Ctrl+Z
 * and friends still reach the editor's history handler.
 */
export function workPathKeyAction(path: PathState, key: string): WorkPathKeyAction | null {
  if (path.points.length === 0) return null
  if (key === 'Enter') return canFillPath(path) ? 'fill' : null
  if (key === 'Escape') return 'cancel'
  if (key === 'Backspace' || key === 'Delete') return 'undo-point'
  return null
}

/** One-line hint for the panel, so the gesture is discoverable. */
export function workPathHint(path: PathState): string {
  const count = path.points.length
  if (count === 0) return 'Click to place the first corner.'
  if (count < 3) return `${count} corner${count === 1 ? '' : 's'} · add ${3 - count} more to fill.`
  return `${count} corners · click the first corner or press Enter to fill · drag a corner to move it · Alt-click to remove it.`
}
