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
  adjustments: { levels: { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }, hue: 0, saturation: 0, lightness: 0 },
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
    history = commitHistory(history, { selection, mask: growMask(selection, size, 1), adjustments: snapshot('Grow mask').adjustments, label: 'Grow mask' })
    expect(currentSnapshot(history)?.mask?.filter(Boolean)).toHaveLength(9)
    history = undoHistory(history)
    expect(currentSnapshot(history)?.mask).toBeNull()
  })
})

describe('layer history', () => {
  const layers = (ids: string[]): { id: string; kind: 'adjustment'; name: string; visible: boolean; opacity: number; blendMode: 'normal'; mask: null; adjustment: ReturnType<typeof snapshot>['adjustments'] }[] =>
    ids.map(id => ({
      id, kind: 'adjustment' as const, name: id, visible: true, opacity: 1,
      blendMode: 'normal' as const, mask: null, adjustment: snapshot(id).adjustments,
    }))

  it('carries the layer stack through a snapshot', () => {
    const history = commitHistory(emptyHistory(), {
      ...snapshot('Add layer'), layers: layers(['adjust-1']), activeLayerId: 'adjust-1',
    })
    expect(currentSnapshot(history)?.layers).toHaveLength(1)
    expect(currentSnapshot(history)?.activeLayerId).toBe('adjust-1')
  })

  it('treats a layer change as a real edit, not a duplicate', () => {
    // Without the stack in the comparison, adding a layer would look identical
    // to the previous state and Undo would silently do nothing.
    const before = commitHistory(emptyHistory(), { ...snapshot('Original'), layers: layers(['adjust-1']) })
    const after = commitHistory(before, { ...snapshot('Add layer'), layers: layers(['adjust-1', 'adjust-2']) })
    expect(after.entries).toHaveLength(2)
    expect(undoHistory(after).cursor).toBe(0)
    expect(currentSnapshot(undoHistory(after))?.layers).toHaveLength(1)
  })

  it('detects a reorder even though the layer count is unchanged', () => {
    const before = commitHistory(emptyHistory(), { ...snapshot('Original'), layers: layers(['a', 'b']) })
    const reordered = commitHistory(before, { ...snapshot('Move up'), layers: layers(['b', 'a']) })
    expect(reordered.entries).toHaveLength(2)
  })

  it('detects a visibility toggle, which changes no bytes anywhere', () => {
    const shown = layers(['a'])
    const hidden = [{ ...shown[0], visible: false }]
    const before = commitHistory(emptyHistory(), { ...snapshot('Original'), layers: shown })
    expect(commitHistory(before, { ...snapshot('Hide'), layers: hidden }).entries).toHaveLength(2)
  })

  it('detects an active-layer change on its own', () => {
    const before = commitHistory(emptyHistory(), { ...snapshot('Original'), layers: layers(['a', 'b']), activeLayerId: 'a' })
    const after = commitHistory(before, { ...snapshot('Select layer'), layers: layers(['a', 'b']), activeLayerId: 'b' })
    expect(after.entries).toHaveLength(2)
  })

  it('still collapses an identical layer state', () => {
    const state = { ...snapshot('Original'), layers: layers(['a']) }
    const before = commitHistory(emptyHistory(), state)
    expect(commitHistory(before, state)).toBe(before)
  })

  it('copies layer payloads so undo cannot rewrite the redo state', () => {
    const original = { ...snapshot('Original'), layers: layers(['a']) }
    const history = commitHistory(emptyHistory(), original)
    // Mutating the caller's object must not reach into stored history.
    original.layers[0].adjustment.hue = 90
    expect(currentSnapshot(history)?.layers?.[0].kind === 'adjustment'
      ? (currentSnapshot(history)!.layers![0] as { adjustment: { hue: number } }).adjustment.hue
      : null).toBe(0)
  })

  it('round-trips through undo and redo', () => {
    const one = commitHistory(emptyHistory(), { ...snapshot('Original'), layers: layers(['a']) })
    const two = commitHistory(one, { ...snapshot('Add b'), layers: layers(['a', 'b']) })
    const back = undoHistory(two)
    expect(currentSnapshot(back)?.layers).toHaveLength(1)
    expect(currentSnapshot(redoHistory(back))?.layers).toHaveLength(2)
  })
})
