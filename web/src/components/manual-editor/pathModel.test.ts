import { describe, expect, it } from 'vitest'
import {
  EMPTY_PATH,
  VERTEX_HIT_RADIUS,
  addPathPoint,
  canFillPath,
  closePath,
  fillPath,
  hitPathVertex,
  isPathInProgress,
  movePathVertex,
  removePathVertex,
  undoPathPoint,
  type PathState,
} from './pathModel'

function path(...points: Array<[number, number]>): PathState {
  return { points: points.map(([x, y]) => ({ x, y })), closed: false }
}

function toAscii(mask: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < height; y += 1) {
    let row = ''
    for (let x = 0; x < width; x += 1) row += mask[y * width + x] !== 0 ? '#' : '.'
    rows.push(row)
  }
  return rows
}

describe('addPathPoint', () => {
  it('rounds the click and appends it without closing', () => {
    const next = addPathPoint(addPathPoint(EMPTY_PATH, { x: 1.4, y: 2.6 }), { x: 5, y: 6 })
    expect(next.points).toEqual([{ x: 1, y: 3 }, { x: 5, y: 6 }])
    expect(next.closed).toBe(false)
  })

  it('closes instead of duplicating the first corner', () => {
    const triangle = path([1, 1], [5, 1], [1, 5])
    // A click within one pixel of the start is a close, not a fourth corner.
    const next = addPathPoint(triangle, { x: 1, y: 2 })
    expect(next.points).toHaveLength(3)
    expect(next.closed).toBe(true)
  })

  it('does not close a path that has fewer than three corners', () => {
    const next = addPathPoint(path([1, 1], [5, 5]), { x: 1, y: 1 })
    expect(next.closed).toBe(false)
    expect(next.points).toHaveLength(3)
  })
})

describe('closePath / undoPathPoint', () => {
  it('needs three corners to close', () => {
    expect(closePath(path([1, 1], [2, 2])).closed).toBe(false)
    expect(closePath(path([1, 1], [2, 2], [3, 3])).closed).toBe(true)
  })

  it('opens a closed path before deleting corners', () => {
    const closed = closePath(path([1, 1], [5, 1], [5, 5]))
    const opened = undoPathPoint(closed)
    expect(opened.closed).toBe(false)
    expect(opened.points).toHaveLength(3)
    expect(undoPathPoint(opened).points).toEqual([{ x: 1, y: 1 }, { x: 5, y: 1 }])
  })

  it('is a no-op on an empty path', () => {
    expect(undoPathPoint(EMPTY_PATH)).toBe(EMPTY_PATH)
  })
})

describe('hitPathVertex / movePathVertex / removePathVertex', () => {
  it('picks the nearest corner inside the hit radius', () => {
    const square = path([10, 10], [30, 10], [30, 30], [10, 30])
    expect(hitPathVertex(square, { x: 11, y: 11 })).toBe(0)
    expect(hitPathVertex(square, { x: 29, y: 11 })).toBe(1)
    expect(hitPathVertex(square, { x: 29, y: 29 })).toBe(2)
    expect(hitPathVertex(square, { x: 20, y: 20 })).toBe(-1)
    expect(hitPathVertex(square, { x: 10 + VERTEX_HIT_RADIUS + 1, y: 10 })).toBe(-1)
  })

  it('moves one corner and leaves the rest untouched', () => {
    const square = path([10, 10], [14, 10], [14, 14], [10, 14])
    const moved = movePathVertex(square, 1, { x: 18.2, y: 9.7 })
    expect(moved.points).toEqual([{ x: 10, y: 10 }, { x: 18, y: 10 }, { x: 14, y: 14 }, { x: 10, y: 14 }])
    // The input is immutable; history snapshots depend on that.
    expect(square.points[1]).toEqual({ x: 14, y: 10 })
    expect(movePathVertex(square, 9, { x: 0, y: 0 })).toBe(square)
  })

  it('re-opens a closed path when dropping a corner makes it degenerate', () => {
    const closed = closePath(path([1, 1], [5, 1], [5, 5]))
    const dropped = removePathVertex(closed, 0)
    expect(dropped.points).toHaveLength(2)
    expect(dropped.closed).toBe(false)
    expect(removePathVertex(path([1, 1], [5, 1], [5, 5], [1, 5]), 3).closed).toBe(false)
  })
})

describe('canFillPath / fillPath', () => {
  it('needs a real polygon', () => {
    expect(canFillPath(EMPTY_PATH)).toBe(false)
    expect(canFillPath(path([1, 1], [5, 5]))).toBe(false)
    expect(canFillPath(path([1, 1], [5, 1], [5, 5]))).toBe(true)
  })

  it('fills the closed polygon and returns a copy otherwise', () => {
    const base = new Uint8Array(36)
    expect(fillPath(base, 6, 6, path([1, 1], [2, 2]))).not.toBe(base)
    expect([...fillPath(base, 6, 6, path([1, 1], [2, 2]))]).toEqual([...base])

    const filled = fillPath(base, 6, 6, path([1, 1], [4, 1], [4, 4], [1, 4]))
    expect(toAscii(filled, 6, 6)).toEqual([
      '......',
      '.####.',
      '.####.',
      '.####.',
      '.####.',
      '......',
    ])
    // The source is never mutated.
    expect([...base].every((value) => value === 0)).toBe(true)
  })
})

describe('isPathInProgress', () => {
  it('is true from the first corner and false for an empty path', () => {
    expect(isPathInProgress(EMPTY_PATH)).toBe(false)
    expect(isPathInProgress(path([3, 3]))).toBe(true)
  })
})
