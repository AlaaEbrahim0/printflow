import { describe, expect, it } from 'vitest'
import { applyCommand, applyMaskDelta, createMaskDelta, invertCommand, pushHistory, validateDocument, type DocumentCommand, type DocumentHistory, type EditorDocument, MASK_HISTORY_MAX_BYTES } from './document'

const mask = (width = 2, height = 2) => ({ encoding: 'bitpack-v1' as const, width, height, feather: 0, bytes: new Uint8Array([15]) })
const doc = (): EditorDocument => ({ schemaVersion: 1, id: 'd', designId: 'design', sourceVersionId: 'source', width: 2, height: 2, activeLayerId: 'base', selection: null, layers: [{ id: 'base', kind: 'base-raster', name: 'Base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }] })

function history(): DocumentHistory { return { entries: [], cursor: -1, usedBytes: 0, maxBytes: MASK_HISTORY_MAX_BYTES, evictedSteps: 0 } }

describe('EditorDocument', () => {
  it('round trips every command type', () => {
    const commands: DocumentCommand[] = [
      { type: 'set-selection', before: null, after: mask(), delta: null },
      { type: 'set-layer-mask', layerId: 'base', before: null, after: mask(), delta: null },
      { type: 'add-layer', index: 1, layer: { id: 'adj', kind: 'adjustment', name: 'Levels', adjustment: { levels: { black: 1, white: 254, gamma: 1, outputBlack: 0, outputWhite: 255 }, hue: 0, saturation: 0, lightness: 0 }, visible: true, opacity: 1, blendMode: 'normal', mask: null } },
      { type: 'remove-layer', index: 1, layer: { id: 'adj', kind: 'adjustment', name: 'Levels', adjustment: { levels: { black: 1, white: 254, gamma: 1, outputBlack: 0, outputWhite: 255 }, hue: 0, saturation: 0, lightness: 0 }, visible: true, opacity: 1, blendMode: 'normal', mask: null } },
      { type: 'update-layer', layerId: 'base', before: { opacity: 1 }, after: { opacity: 0.5 } },
      { type: 'reorder-layer', layerId: 'base', from: 0, to: 0 },
      { type: 'set-active-layer', before: 'base', after: 'base' },
    ]
    for (const command of commands) {
      const original = structuredClone(doc())
      const start = command.type === 'remove-layer' ? applyCommand(original, commands[2]) : original
      const changed = applyCommand(start, command)
      const restored = applyCommand(changed, invertCommand(command))
      expect(restored).toEqual(start)
      validateDocument(restored)
    }
  })

  it('coalesces consecutive commands and keeps first before and last after', () => {
    let state = history()
    state = pushHistory(state, 'slider', { type: 'update-layer', layerId: 'base', before: { opacity: 1 }, after: { opacity: .8 }, coalesceKey: 'opacity' })
    state = pushHistory(state, 'slider', { type: 'update-layer', layerId: 'base', before: { opacity: .8 }, after: { opacity: .2 }, coalesceKey: 'opacity' })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].command).toMatchObject({ before: { opacity: 1 }, after: { opacity: .2 } })
  })

  it('round trips a brush mask delta', () => {
    const before = mask()
    const after = { ...before, bytes: Uint8Array.from([5]), feather: 2 }
    const delta = createMaskDelta(before, after)!
    expect(applyMaskDelta(before, delta)).toEqual(after)
    expect(applyMaskDelta(after, delta)).toEqual({ ...before, feather: 2 })
  })

  it('rejects invalid masks and base removal', () => {
    expect(() => validateDocument({ ...doc(), layers: [{ ...doc().layers[0], mask: mask(1, 1) }] })).toThrow('mask dimensions mismatch')
    expect(() => applyCommand(doc(), { type: 'remove-layer', index: 0, layer: doc().layers[0] })).toThrow('base layer cannot be removed')
  })
})
