import { describe, expect, it } from 'vitest'
import { EMPTY_PATH, type PathState } from './pathModel'
import { dragWorkPath, pressWorkPath, workPathKeyAction } from './workPath'

const path = (points: [number, number][], closed = false): PathState => ({
  points: points.map(([x, y]) => ({ x, y })),
  closed,
})

const triangle = (): PathState => path([[0, 0], [30, 0], [30, 30]])

describe('pressWorkPath', () => {
  it('adds a corner on empty space', () => {
    const press = pressWorkPath(EMPTY_PATH, { x: 10, y: 10 })
    expect(press.path.points).toEqual([{ x: 10, y: 10 }])
    expect(press.vertex).toBeNull()
    expect(press.completed).toBe(false)
  })

  it('closes and completes when the first corner is pressed on a fillable path', () => {
    // Regression: the vertex hit radius (8 px) is far larger than the
    // one-pixel duplicate test inside addPathPoint, so before this the press
    // could only ever grab corner 0 and a polygon could never be closed by
    // clicking. The documented "click the start point to finish" gesture did
    // not work at all.
    const press = pressWorkPath(triangle(), { x: 1, y: 1 })
    expect(press.completed).toBe(true)
    expect(press.path.closed).toBe(true)
    expect(press.vertex).toBeNull()
  })

  it('grabs a middle corner instead of closing', () => {
    const press = pressWorkPath(triangle(), { x: 30, y: 1 })
    expect(press.completed).toBe(false)
    expect(press.vertex).toBe(1)
    expect(press.path.closed).toBe(false)
  })

  it('does not close a path with too few corners', () => {
    // Two corners cannot enclose anything, so pressing the first must be an
    // ordinary grab rather than a close.
    const press = pressWorkPath(path([[0, 0], [30, 0]]), { x: 0, y: 0 })
    expect(press.completed).toBe(false)
    expect(press.path.closed).toBe(false)
  })

  it('drops a corner on alt-click without starting a drag', () => {
    const press = pressWorkPath(triangle(), { x: 30, y: 1 }, { altKey: true })
    expect(press.path.points).toHaveLength(2)
    expect(press.vertex).toBeNull()
    expect(press.completed).toBe(false)
  })
})

describe('dragWorkPath', () => {
  it('moves the grabbed corner only', () => {
    const moved = dragWorkPath(triangle(), 1, { x: 40, y: 5 })
    expect(moved.points[1]).toEqual({ x: 40, y: 5 })
    expect(moved.points[0]).toEqual({ x: 0, y: 0 })
    expect(moved.points[2]).toEqual({ x: 30, y: 30 })
  })

  it('is a no-op without a grabbed corner', () => {
    const original = triangle()
    expect(dragWorkPath(original, null, { x: 40, y: 5 })).toBe(original)
  })
})

describe('workPathKeyAction', () => {
  it('claims Enter only when the path can be filled', () => {
    expect(workPathKeyAction(triangle(), 'Enter')).toBe('fill')
    expect(workPathKeyAction(path([[0, 0], [10, 10]]), 'Enter')).toBeNull()
  })

  it('maps Escape and Delete to cancel and undo-point', () => {
    expect(workPathKeyAction(triangle(), 'Escape')).toBe('cancel')
    expect(workPathKeyAction(triangle(), 'Delete')).toBe('undo-point')
    expect(workPathKeyAction(triangle(), 'Backspace')).toBe('undo-point')
  })

  it('returns null for keys that are not ours, so they still reach the editor', () => {
    // Ctrl+Z must not be swallowed here: the history handler needs it.
    expect(workPathKeyAction(triangle(), 'z')).toBeNull()
    expect(workPathKeyAction(triangle(), 'Shift')).toBeNull()
  })

  it('returns null when no path is open', () => {
    expect(workPathKeyAction(EMPTY_PATH, 'Enter')).toBeNull()
    expect(workPathKeyAction(EMPTY_PATH, 'Escape')).toBeNull()
  })
})
