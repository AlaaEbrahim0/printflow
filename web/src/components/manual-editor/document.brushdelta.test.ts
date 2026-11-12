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
  type MaskDelta,
  type PackedMask,
} from './document'

const maskBytes = (width: number, height: number): number => Math.ceil(width * height / 8)

const packed = (width: number, height: number, bytes: Uint8Array, feather = 0): PackedMask => ({
  encoding: 'bitpack-v1',
  width,
  height,
  feather,
  bytes,
})

const emptyDocument = (width: number, height: number, selection: PackedMask | null = null): EditorDocument => ({
  schemaVersion: 1,
  id: 'brush-delta-doc',
  designId: 'design',
  sourceVersionId: 'source',
  width,
  height,
  activeLayerId: 'base',
  selection,
  layers: [{ id: 'base', kind: 'base-raster', name: 'Base', sourceId: 'source', visible: true, opacity: 1, blendMode: 'normal', mask: null }],
})

describe('brush mask deltas', () => {
  it('applies and inverts a painted brush delta without mutating either mask', () => {
    const width = 64
    const height = 32
    const length = maskBytes(width, height)
    const beforeBytes = Uint8Array.from({ length }, (_, index) => (index * 7) & 0xff)
    const afterBytes = beforeBytes.slice()
    // A short brush stroke: paint a run through the middle of the mask.
    for (let index = 8; index < 48; index += 1) afterBytes[index] = (index * 13) & 0xff

    const before = packed(width, height, beforeBytes)
    const after = packed(width, height, afterBytes, 2)
    const delta = createMaskDelta(before, after)
    expect(delta).not.toBeNull()
    expect(delta).toMatchObject({ width, height, feather: 2, beforeFeather: 0 })
    expect(['xor-rle-v1', 'xor-bitpack-v1']).toContain(delta!.encoding)

    const beforeSnapshot = beforeBytes.slice()
    const afterSnapshot = afterBytes.slice()

    expect(applyMaskDelta(before, delta!)).toEqual(after)
    // XOR is its own inverse; feather travels with the destination mask.
    expect(applyMaskDelta(after, delta!)).toEqual({ ...before, feather: 2 })

    expect(before.bytes).toEqual(beforeSnapshot)
    expect(after.bytes).toEqual(afterSnapshot)

    // The same delta drives a document command forwards, backwards and
    // forwards again; invertCommand swaps the masks without rebuilding it.
    const command: DocumentCommand = { type: 'set-selection', before, after, delta }
    const applied = applyCommand(emptyDocument(width, height, before), command)
    expect(applied.selection).toEqual(after)

    const undone = applyCommand(applied, invertCommand(command))
    expect(undone.selection).toEqual(before)
    expect(applyCommand(undone, command).selection).toEqual(after)

    expect(createMaskDelta(null, after)).toBeNull()
    expect(createMaskDelta(before, null)).toBeNull()
    expect(createMaskDelta(before, packed(32, 64, new Uint8Array(maskBytes(32, 64))))).toBeNull()
  })

  it('merges a coalesced stroke gesture into one history entry', () => {
    const width = 1024
    const height = 1024
    const length = maskBytes(width, height)
    const strokeStart = packed(width, height, new Uint8Array(length), 0)

    let current = strokeStart
    let history = emptyDocumentHistory()
    let lastDelta: MaskDelta | null = null

    const samples = 24
    for (let sample = 0; sample < samples; sample += 1) {
      const nextBytes = current.bytes.slice()
      const center = Math.round((sample / (samples - 1)) * (length - 1))
      const radius = 4096
      for (let offset = -radius; offset <= radius; offset += 1) {
        const index = center + offset
        if (index < 0 || index >= length) continue
        const strength = Math.round(255 * (1 - Math.abs(offset) / radius))
        nextBytes[index] = Math.max(nextBytes[index], strength)
      }
      const next = packed(width, height, nextBytes)
      // Every sample records the gesture-start mask as `before`, so the
      // coalesced entry remains a whole-gesture undo rather than the last
      // pointer move.
      lastDelta = createMaskDelta(strokeStart, next)
      expect(lastDelta).not.toBeNull()
      history = pushHistory(history, 'Brush stroke', {
        type: 'set-selection',
        before: strokeStart,
        after: next,
        delta: lastDelta,
        coalesceKey: 'stroke-1',
      })
      current = next
    }

    expect(samples).toBe(24)
    expect(history.entries).toHaveLength(1)
    expect(history.cursor).toBe(0)
    expect(history.evictedSteps).toBe(0)
    expect(history.entries[0].label).toBe('Brush stroke')

    const entry = history.entries[0]
    expect(entry.command).toMatchObject({ type: 'set-selection', coalesceKey: 'stroke-1' })
    expect(entry.command.type === 'set-selection' && entry.command.before?.bytes).toEqual(strokeStart.bytes)
    expect(entry.command.type === 'set-selection' && entry.command.after?.bytes).toEqual(current.bytes)
    expect(entry.command.type === 'set-selection' && entry.command.delta).toBe(lastDelta)
    expect(entry.byteSize).toBe(128 + lastDelta!.bytes.byteLength)
    expect(history.usedBytes).toBe(entry.byteSize)

    // The surviving entry replays the gesture in one step and inverts back.
    const forward = applyCommand(emptyDocument(width, height, strokeStart), entry.command)
    expect(forward.selection?.bytes).toEqual(current.bytes)
    const backward = applyCommand(forward, invertCommand(entry.command))
    expect(backward.selection?.bytes).toEqual(strokeStart.bytes)

    // A new gesture key starts a second entry; reusing an older key after that
    // cannot reach back and merge into the first entry.
    history = pushHistory(history, 'Brush stroke', {
      type: 'set-selection',
      before: current,
      after: current,
      delta: createMaskDelta(current, current),
      coalesceKey: 'stroke-2',
    })
    expect(history.entries).toHaveLength(2)
    expect(history.cursor).toBe(1)

    history = pushHistory(history, 'Brush stroke', {
      type: 'set-selection',
      before: current,
      after: current,
      delta: createMaskDelta(current, current),
      coalesceKey: 'stroke-1',
    })
    expect(history.entries).toHaveLength(3)
    expect(history.cursor).toBe(2)
    expect(history.evictedSteps).toBe(0)
  })

  it('reports sparse versus large-area 36 MP delta sizes', () => {
    const width = 6000
    const height = 6000
    const pixels = width * height
    const length = maskBytes(width, height)
    const empty = packed(width, height, new Uint8Array(length))

    // A sparse dab: one changed bit in the middle of the canvas.
    const sparseBytes = new Uint8Array(length)
    sparseBytes[Math.floor(length / 2)] = 0x01
    const sparse = packed(width, height, sparseBytes)
    const sparseDelta = createMaskDelta(empty, sparse)!
    expect(sparseDelta).not.toBeNull()

    // A large-area soft stroke: a varied-value swath covering >50% of the
    // canvas, which cannot collapse into runs the way a uniform fill can.
    const largeBytes = new Uint8Array(length)
    for (let index = 1_000_000; index < 3_500_000; index += 1) largeBytes[index] = (index * 31 + (index >>> 8)) & 0xff
    const large = packed(width, height, largeBytes)
    const largeDelta = createMaskDelta(empty, large)!

    const report = {
      pixels,
      maskBytes: length,
      sparseEncoding: sparseDelta.encoding,
      sparseDeltaBytes: sparseDelta.bytes.byteLength,
      largeEncoding: largeDelta.encoding,
      largeDeltaBytes: largeDelta.bytes.byteLength,
      ratio: Math.round(largeDelta.bytes.byteLength / sparseDelta.bytes.byteLength),
    }

    expect(report).toEqual({
      pixels: 36_000_000,
      maskBytes: 4_500_000,
      sparseEncoding: 'xor-rle-v1',
      sparseDeltaBytes: 35_298,
      largeEncoding: 'xor-bitpack-v1',
      largeDeltaBytes: 4_500_000,
      ratio: 127,
    })
    expect(report.sparseDeltaBytes).toBeLessThan(report.maskBytes / 100)
    expect(report.largeDeltaBytes).toBe(report.maskBytes)
    expect(report.largeDeltaBytes).toBeGreaterThan(report.sparseDeltaBytes * 100)

    expect(applyMaskDelta(sparse, sparseDelta)).toEqual(empty)
    expect(applyMaskDelta(large, largeDelta)).toEqual(empty)
  }, 30_000)

  it('uses raw fallback for synthetic PRNG noise and never exceeds raw mask bytes', () => {
    const width = 6000
    const height = 6000
    const length = maskBytes(width, height)
    const before = packed(width, height, new Uint8Array(length))
    const noisyBytes = new Uint8Array(length)
    let state = 0x12345678
    for (let index = 0; index < noisyBytes.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      noisyBytes[index] = state >>> 24
    }
    const delta = createMaskDelta(before, packed(width, height, noisyBytes))!
    expect(delta.encoding).toBe('xor-bitpack-v1')
    expect(delta.bytes.byteLength).toBe(length)
    expect(delta.bytes.byteLength).toBeLessThanOrEqual(4_500_000)
  }, 30_000)
})
