import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  createMaskDelta,
  invertCommand,
  pushHistory,
  validateDocument,
  type DocumentCommand,
  type DocumentHistory,
  type EditorDocument,
  type PackedMask,
} from './document'

const mask = (width = 2, height = 2, fill = 0xff): PackedMask => ({
  encoding: 'bitpack-v1', width, height, feather: 0, bytes: new Uint8Array(Math.ceil(width * height / 8)).fill(fill),
})
const adjustment = (id: string) => ({ id, kind: 'adjustment' as const, name: id, adjustment: { levels: { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 }, hue: 0, saturation: 0, lightness: 0 }, visible: true, opacity: 1, blendMode: 'normal' as const, mask: null })
const doc = (): EditorDocument => ({ schemaVersion: 1, id: 'd', designId: 'design', sourceVersionId: 'source', width: 2, height: 2, activeLayerId: 'base', selection: null, layers: [{ id: 'base', kind: 'base-raster', name: 'Base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }, adjustment('adj')] })
const history = (maxBytes = 200 * 1024 * 1024): DocumentHistory => ({ entries: [], cursor: -1, usedBytes: 0, maxBytes, evictedSteps: 0 })
const clone = <T>(value: T): T => structuredClone(value)

const commandsFor = (state: EditorDocument, seed: number): DocumentCommand[] => {
  let random = seed >>> 0
  const next = () => (random = (random * 1664525 + 1013904223) >>> 0) / 0x100000000
  const commands: DocumentCommand[] = []
  for (let i = 0; i < 100; i += 1) {
    const choice = Math.floor(next() * 6)
    if (choice === 0) commands.push({ type: 'set-selection', before: state.selection, after: next() > .5 ? mask(2, 2, i) : null, delta: null })
    else if (choice === 1) commands.push({ type: 'set-layer-mask', layerId: 'base', before: state.layers[0].mask, after: next() > .5 ? mask(2, 2, i) : null, delta: null })
    else if (choice === 2) commands.push({ type: 'update-layer', layerId: 'adj', before: { opacity: state.layers[1].opacity }, after: { opacity: Math.round(next() * 100) / 100 } })
    else if (choice === 3) commands.push({ type: 'reorder-layer', layerId: 'adj', from: 1, to: 1 })
    else if (choice === 4) commands.push({ type: 'set-active-layer', before: state.activeLayerId, after: next() > .5 ? 'base' : 'adj' })
    else commands.push({ type: 'update-layer', layerId: 'base', before: { visible: state.layers[0].visible }, after: { visible: next() > .5 } })
  }
  return commands
}

describe('document core contracts', () => {
  it('keeps frozen input for every command', () => {
    const layer = adjustment('new')
    const cases: DocumentCommand[] = [
      { type: 'set-selection', before: null, after: mask(), delta: null },
      { type: 'set-layer-mask', layerId: 'base', before: null, after: mask(), delta: null },
      { type: 'add-layer', layer, index: 1 },
      { type: 'remove-layer', layer: adjustment('adj'), index: 1 },
      { type: 'update-layer', layerId: 'base', before: { opacity: 1 }, after: { opacity: .5 } },
      { type: 'reorder-layer', layerId: 'adj', from: 1, to: 0 },
      { type: 'set-active-layer', before: 'base', after: 'adj' },
    ]
    for (const command of cases) {
      const input = doc()
      const frozen = clone(input)
      applyCommand(input, command.type === 'remove-layer' ? command : command)
      expect(input).toEqual(frozen)
    }
  })

  it('runs fixed-seed valid command sequences through undo and redo', () => {
    for (const seed of [1, 7, 99, 0xdecafbad]) {
      let current = doc()
      const initial = clone(current)
      const commands: DocumentCommand[] = []
      for (const command of commandsFor(current, seed)) {
        const before = clone(current)
        current = applyCommand(current, command)
        commands.push(command.type === 'set-selection' ? { ...command, before: before.selection } : command)
      }
      for (let i = commands.length - 1; i >= 0; i -= 1) current = applyCommand(current, invertCommand(commands[i]))
      expect(current).toEqual(initial)
      for (const command of commands) current = applyCommand(current, command)
      validateDocument(current)
    }
  })

  it('evicts oldest 16MP history entries at 200MB and keeps accounting correct', () => {
    const pixels = 16_000_000
    const big = mask(4000, 4000, 0)
    expect(big.bytes.byteLength).toBe(Math.ceil(pixels / 8))
    const command: DocumentCommand = { type: 'set-selection', before: big, after: big, delta: null }
    const one = pushHistory(history(), 'big', command).entries[0].byteSize
    const fit = Math.floor((200 * 1024 * 1024) / one)
    expect(fit).toBeGreaterThan(0)
    let state = history()
    for (let i = 0; i < fit + 2; i += 1) state = pushHistory(state, 'big', command)
    expect(state.entries).toHaveLength(fit)
    expect(state.usedBytes).toBeLessThanOrEqual(state.maxBytes)
    expect(state.evictedSteps).toBe(2)
  })

  it('round-trips and coalesces brush mask deltas', () => {
    const before = mask(8, 1, 0b00001111)
    const after = mask(8, 1, 0b11110000)
    const delta = createMaskDelta(before, after)
    expect(delta?.bytes).toEqual(new Uint8Array([0xff]))
    const restored = new Uint8Array(after.bytes)
    for (let i = 0; i < restored.length; i += 1) restored[i] ^= delta!.bytes[i]
    expect(restored).toEqual(before.bytes)
    let state = history()
    state = pushHistory(state, 'brush', { type: 'set-selection', before, after, delta, coalesceKey: 'brush' })
    state = pushHistory(state, 'brush', { type: 'set-selection', before: after, after: before, delta, coalesceKey: 'brush' })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].command).toMatchObject({ before, after: before })
  })

  it('covers document validation invariants', () => {
    expect(() => validateDocument({ ...doc(), layers: [] })).toThrow('exactly one base-raster')
    expect(() => validateDocument({ ...doc(), activeLayerId: 'missing' })).toThrow('active layer does not exist')
    expect(() => validateDocument({ ...doc(), layers: [{ ...doc().layers[0], opacity: 2 }] })).toThrow('opacity out of range')
    expect(() => validateDocument({ ...doc(), layers: [{ ...doc().layers[0], mask: mask(1, 1) }] })).toThrow('mask dimensions mismatch')
    expect(() => validateDocument({ ...doc(), layers: [{ ...doc().layers[0], blendMode: 'multiply' }] })).toThrow('base blend mode invalid')
  })
})
