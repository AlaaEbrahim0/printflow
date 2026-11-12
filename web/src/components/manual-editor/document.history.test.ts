import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  applyMaskDelta,
  createMaskDelta,
  emptyDocumentHistory,
  invertCommand,
  pushHistory,
  type DocumentCommand,
  type EditorDocument,
  type PackedMask,
} from './document'

const WIDTH = 4000
const HEIGHT = 4000
const MASK_BYTES = Math.ceil(WIDTH * HEIGHT / 8)
const CAP_200_MB = 200 * 1024 * 1024

const pack = (bytes: Uint8Array): PackedMask => ({
  encoding: 'bitpack-v1', width: WIDTH, height: HEIGHT, feather: 0, bytes,
})

const xorPattern = (): Uint8Array => {
  const bytes = new Uint8Array(MASK_BYTES)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 1 ? 0xaa : 0x55
  return bytes
}

const empty = pack(new Uint8Array(MASK_BYTES))
const noisy = pack(xorPattern())
const delta = createMaskDelta(empty, noisy)!

const document = (): EditorDocument => ({
  schemaVersion: 1,
  id: 'd',
  designId: 'design',
  sourceVersionId: 'source',
  width: WIDTH,
  height: HEIGHT,
  activeLayerId: 'base',
  selection: null,
  layers: [{ id: 'base', kind: 'base-raster', name: 'Base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }],
})

const command = (index: number): DocumentCommand => ({
  type: 'set-selection',
  before: index & 1 ? noisy : empty,
  after: index & 1 ? empty : noisy,
  delta,
})

describe('document mask history', () => {
  it('evicts the oldest entries at a true 200 MB cap and keeps the current entry active', () => {
    const commands = Array.from({ length: 110 }, (_, index) => command(index))
    let history = emptyDocumentHistory({ maxBytes: CAP_200_MB })
    let current = document()

    for (const [index, next] of commands.entries()) {
      history = pushHistory(history, `step ${index}`, next)
      current = applyCommand(current, next)
    }

    expect(MASK_BYTES).toBe(2_000_000)
    expect(delta.encoding).toBe('xor-bitpack-v1')
    expect(delta.bytes.byteLength).toBe(MASK_BYTES)
    expect(history.entries).toHaveLength(104)
    expect(history.cursor).toBe(103)
    expect(history.evictedSteps).toBe(6)
    expect(history.usedBytes).toBe(208_013_312)
    expect(history.usedBytes).toBeLessThanOrEqual(CAP_200_MB)
    expect(history.entries[0].label).toBe('step 6')
    expect(history.entries.at(-1)?.label).toBe('step 109')

    // Eviction moves the window, not the state: the newest entry and the
    // document derived from it are still the current ones.
    expect(history.entries[history.cursor].label).toBe('step 109')
    expect(current.selection?.bytes).toEqual(empty.bytes)
    expect(applyCommand(document(), history.entries[history.cursor].command).selection?.bytes).toEqual(empty.bytes)

    // Undo walks back to the oldest surviving entry, then stops. It cannot
    // reach the six states that were evicted from the 200 MB window.
    let state = current
    let cursor = history.cursor
    let undos = 0
    while (cursor > 0) {
      state = applyCommand(state, invertCommand(history.entries[cursor].command))
      cursor -= 1
      undos += 1
    }
    let evictedState = document()
    for (let index = 0; index < history.evictedSteps; index += 1) evictedState = applyCommand(evictedState, commands[index])

    expect(cursor).toBe(0)
    expect(undos).toBe(history.entries.length - 1)
    const oldestRemaining = commands[history.evictedSteps]
    if (oldestRemaining.type !== 'set-selection') throw new Error('expected selection command')
    expect(state.selection?.bytes).toEqual(oldestRemaining.after!.bytes)
    expect(state.selection?.bytes).not.toEqual(evictedState.selection?.bytes)
  })

  it('measures a 16 MP delta and reports the 200 MB capacity', () => {
    expect(applyMaskDelta(noisy, delta).bytes).toEqual(empty.bytes)

    let history = emptyDocumentHistory({ maxBytes: CAP_200_MB })
    history = pushHistory(history, '16 MP', { type: 'set-selection', before: empty, after: noisy, delta })

    const entry = history.entries[0]
    const report = {
      deltaBytes: delta.bytes.byteLength,
      commandBytes: entry.byteSize,
      usedBytes: history.usedBytes,
      maxBytes: history.maxBytes,
      capacity: Math.floor(history.maxBytes / entry.byteSize),
    }
    expect(report).toEqual({
      deltaBytes: 2_000_000,
      commandBytes: 2_000_128,
      usedBytes: 2_000_128,
      maxBytes: 209_715_200,
      capacity: 104,
    })
  })
})
