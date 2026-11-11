import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  commitHistory,
  currentSnapshot,
  emptyHistory,
  redoHistory,
  undoHistory,
} from './history'
import { growMask } from './maskOps'

const snapshot = (label: string, selection: number[] | null = null) => ({
  selection: selection ? Uint8Array.from(selection) : null,
  mask: null,
  label,
})

describe('editor history', () => {
  it('starts empty and refuses undo/redo', () => {
    const history = emptyHistory()
    expect(history.cursor).toBe(-1)
    expect(currentSnapshot(history)).toBeNull()
    expect(canUndo(history)).toBe(false)
    expect(canRedo(history)).toBe(false)
  })

  it('walks back and forward across committed snapshots', () => {
    let history = emptyHistory(snapshot('Original'))
    history = commitHistory(history, snapshot('Marquee', [255, 0]))
    history = commitHistory(history, snapshot('Grow mask', [255, 255]))
    expect(currentSnapshot(history)?.label).toBe('Grow mask')

    history = undoHistory(history)
    expect(currentSnapshot(history)?.label).toBe('Marquee')
    expect(canRedo(history)).toBe(true)

    history = redoHistory(history)
    expect(currentSnapshot(history)?.label).toBe('Grow mask')
  })

  it('drops redo after a new commit from an undone state', () => {
    let history = emptyHistory(snapshot('Original'))
    history = commitHistory(history, snapshot('Lasso', [255]))
    history = undoHistory(history)
    history = commitHistory(history, snapshot('Wand', [0, 255]))
    expect(redoHistory(history)).toBe(history)
    expect(currentSnapshot(history)?.label).toBe('Wand')
  })

  it('ignores a commit identical to the current entry', () => {
    let history = emptyHistory(snapshot('Original', [255, 0]))
    const before = history.entries.length
    history = commitHistory(history, snapshot('Marquee', [255, 0]))
    expect(history.entries).toHaveLength(before)
  })

  it('copies payloads so later edits cannot rewrite history', () => {
    const next = snapshot('Mask', [255, 0])
    let history = emptyHistory()
    history = commitHistory(history, next)
    next.selection![0] = 0
    const restored = currentSnapshot(history)!
    expect(restored.selection?.[0]).toBe(255)
    restored.selection![1] = 255
    expect(currentSnapshot(history)?.selection?.[1]).toBe(0)
  })

  it('caps entries and keeps the cursor on the newest', () => {
    let history = emptyHistory()
    for (let i = 0; i < MAX_HISTORY + 5; i += 1) {
      history = commitHistory(history, snapshot(`step ${i}`, [i, 255 - i]))
    }
    expect(history.entries).toHaveLength(MAX_HISTORY)
    expect(history.cursor).toBe(MAX_HISTORY - 1)
    expect(currentSnapshot(history)?.label).toBe(`step ${MAX_HISTORY + 4}`)
  })

  it('undoes a mask operation back to the previous selection', () => {
    const size = { width: 3, height: 3 }
    const selection = new Uint8Array(9)
    selection[4] = 255
    let history = emptyHistory(snapshot('Original'))
    history = commitHistory(history, snapshot('Selection', [...selection]))
    history = commitHistory(history, { selection, mask: growMask(selection, size, 1), label: 'Grow mask' })
    expect(currentSnapshot(history)?.mask?.filter(Boolean)).toHaveLength(9)
    history = undoHistory(history)
    expect(currentSnapshot(history)?.mask).toBeNull()
  })
})
