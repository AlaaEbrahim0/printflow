/**
 * Immutability and invertibility contracts for the committed `document.ts`.
 *
 * Locks pinned here:
 *
 *  1. `applyCommand` never writes to the document (top level, layers, nested
 *     payloads, arrays) nor to the command it is handed. The document, and every
 *     plain object/array reachable from it, is frozen with `Object.freeze`
 *     before the call. Typed arrays cannot be frozen in this runtime
 *     (`Object.freeze(new Uint8Array())` throws "Cannot freeze array buffer
 *     views with elements", index properties are non-configurable and
 *     `Object.preventExtensions` still accepts index writes), so mask bytes are
 *     guarded by deep snapshots compared *including every byte* plus structural
 *     checks that no command-owned array is aliased into the result.
 *
 *  2. `invertCommand` never writes to its argument, and inverting twice gives
 *     back an equivalent command.
 *
 *  3. Every command type undoes exactly: apply → invert → apply restores the
 *     previous document. A fixed-seed generator builds long sequences of
 *     commands that are valid for the live document (base layer preserved,
 *     active layer kept alive, every mask dimension-matched, `before` fields
 *     describing the live state), and undo-all / redo-all must land on the
 *     starting document and on the direct result respectively.
 *
 * `before`/`after` snapshots are stored *before* the document is frozen, so
 * they share no bytes with the frozen document: if a byte is written in place,
 * the snapshot comparison still sees it.
 */
import { describe, expect, it } from 'vitest'
import type { Adjustments } from './adjustments'
import {
  applyCommand,
  invertCommand,
  validateDocument,
  type DocumentCommand,
  type EditorDocument,
  type EditorLayer,
  type PackedMask,
} from './document'

const WIDTH = 24
const HEIGHT = 9
const MASK_BYTES = Math.ceil(WIDTH * HEIGHT / 8)

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function adjustments(overrides: Partial<Adjustments> = {}): Adjustments {
  const base: Adjustments = {
    levels: { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
    hue: 0,
    saturation: 0,
    lightness: 0,
  }
  return { ...base, ...overrides, levels: { ...base.levels, ...(overrides.levels ?? {}) } }
}

/** A dimension-correct mask; `validateDocument` requires exactly `MASK_BYTES` bytes. */
function mask(bytes: Uint8Array, feather = 0): PackedMask {
  if (bytes.length !== MASK_BYTES) throw new Error(`test mask must have ${MASK_BYTES} bytes`)
  return { encoding: 'bitpack-v1', width: WIDTH, height: HEIGHT, feather, bytes }
}

function filled(fill: number, feather = 0): PackedMask {
  return mask(new Uint8Array(MASK_BYTES).fill(fill), feather)
}

function patterned(step: number, feather = 0): PackedMask {
  const bytes = new Uint8Array(MASK_BYTES)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + step * 11) & 0xff
  return mask(bytes, feather)
}

function baseLayer(): EditorLayer {
  return {
    id: 'base',
    kind: 'base-raster',
    name: 'Base',
    sourceId: 'source-1',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
  }
}

function adjustmentLayer(id: string, overrides: Partial<Adjustments> = {}, overridesLayer: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id,
    kind: 'adjustment',
    name: id,
    adjustment: adjustments(overrides),
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    ...overridesLayer,
  } as EditorLayer
}

function pixelOpLayer(id: string, overridesLayer: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id,
    kind: 'pixel-op',
    name: id,
    operation: {
      type: 'color-key',
      color: { r: 10, g: 20, b: 30 },
      tolerance: 12,
      feather: 1,
      contiguous: true,
      useAlpha: true,
      seeds: [{ x: 1, y: 2 }, { x: 3, y: 0 }],
    },
    visible: true,
    opacity: 0.75,
    blendMode: 'multiply',
    mask: patterned(1, 2),
    ...overridesLayer,
  } as EditorLayer
}

/** Three layers, two non-trivial masks, nested objects and a typed array per mask. */
function documentFixture(): EditorDocument {
  return {
    schemaVersion: 1,
    id: 'doc-immutability',
    designId: 'design-1',
    sourceVersionId: 'version-7',
    width: WIDTH,
    height: HEIGHT,
    activeLayerId: 'adj',
    selection: patterned(5, 1),
    layers: [
      baseLayer(),
      adjustmentLayer('adj', { hue: 15, saturation: -20 }),
      pixelOpLayer('op'),
    ],
  }
}

/* ------------------------------------------------------------------ */
/* Snapshot helpers                                                    */
/* ------------------------------------------------------------------ */

// `structuredClone` is not usable here: this runtime hands back typed arrays
// from another realm whose own indices enumerate as properties, so they stop
// being `Uint8Array` instances in this realm. Clone by hand instead.

/** A view of any byte array, whether from this realm or another one. */
function isBytes(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === '[object Uint8Array]'
}

/** Deep clone that keeps typed arrays typed, copies their bytes, and never mutates the source. */
function deepCopy<T>(value: T): T {
  if (isBytes(value)) {
    const out = new Uint8Array(value.length)
    for (let i = 0; i < value.length; i += 1) out[i] = value[i]
    return out as unknown as T
  }
  if (Array.isArray(value)) return value.map(item => deepCopy(item)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepCopy((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

/** Typed arrays are recorded as arrays of byte values, so `toEqual` diffs bytes. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function snapshot(value: unknown): Json {
  if (isBytes(value)) {
    const bytes: Json[] = []
    for (let i = 0; i < value.length; i += 1) bytes.push(value[i])
    return { $typedArray: 'Uint8Array', bytes }
  }
  if (Array.isArray(value)) return value.map(item => snapshot(item))
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    // `undefined`-valued keys are dropped, exactly as `toEqual` ignores them.
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined) continue
      out[key] = snapshot(child)
    }
    return out
  }
  const primitive = value as string | number | boolean | null
  if (typeof primitive === 'number' && !Number.isFinite(primitive)) return String(primitive)
  return primitive
}

/** Layered view of a snapshot: `fields` for scalars, `layers` for layer snapshots. */
interface SnapRecord {
  fields: { [key: string]: unknown }
  layers: SnapRecord[]
}

/** Read a snapshot (or any plain object) structurally, without narrowing at each use. */
function asRecord(snap: unknown): SnapRecord {
  const fields = (snap !== null && typeof snap === 'object' && !Array.isArray(snap) ? snap : {}) as { [key: string]: unknown }
  const layers = Array.isArray(fields.layers) ? fields.layers.map(asRecord) : []
  return { fields, layers }
}

/** A layer snapshot by id, or `undefined` when this document has no such layer. */
function layerSnapshot(snap: unknown, layerId: string): unknown {
  return asRecord(snap).layers.find(layer => layer.fields.id === layerId)?.fields ?? undefined
}

function snapshotBytes(value: unknown): number[] {
  const found: number[] = []
  const visit = (node: unknown): void => {
    if (isBytes(node)) {
      for (let i = 0; i < node.length; i += 1) found.push(node[i])
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) visit((node as Record<string, unknown>)[key])
    }
  }
  visit(value)
  return found
}

function typedArrays(value: unknown): Uint8Array[] {
  const found: Uint8Array[] = []
  const visit = (node: unknown): void => {
    if (isBytes(node)) {
      found.push(node)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) visit((node as Record<string, unknown>)[key])
    }
  }
  visit(value)
  return found
}

/** Every byte recorded in a snapshot, in document order. */
function snapshotBytesOf(snap: Json): number[] {
  if (Array.isArray(snap)) return snap.flatMap(snapshotBytesOf)
  if (snap !== null && typeof snap === 'object') {
    const record = snap as { [key: string]: Json }
    if (record.$typedArray === 'Uint8Array' && Array.isArray(record.bytes)) {
      return (record.bytes as Json[]).map(byte => byte as number)
    }
    return Object.keys(record).flatMap(key => snapshotBytesOf(record[key]))
  }
  return []
}

/** Both the structural `toEqual` and an explicit byte-by-byte comparison. */
function expectUnchanged(actual: unknown, pristine: Json): void {
  expect(snapshot(actual)).toEqual(pristine)
  expect(snapshotBytes(actual)).toEqual(snapshotBytesOf(pristine))
}

/**
 * Freeze every plain object and array reachable from `value` with
 * `Object.freeze`. Typed arrays are deliberately left alone: this runtime
 * refuses `Object.freeze` on any view with elements, and the acceptance rules
 * forbid redefining their indices. Byte integrity is covered by snapshots.
 */
function deepFreezeObjects(value: unknown): number {
  let frozen = 0
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (isBytes(node)) return
    if (Object.isFrozen(node)) return
    for (const key of Object.keys(node as Record<string, unknown>)) visit((node as Record<string, unknown>)[key])
    Object.freeze(node)
    frozen += 1
  }
  visit(value)
  return frozen
}

function expectDeeplyFrozenObjects(value: unknown): void {
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (isBytes(node)) return
    expect(Object.isFrozen(node)).toBe(true)
    for (const key of Object.keys(node as Record<string, unknown>)) visit((node as Record<string, unknown>)[key])
  }
  visit(value)
}

/* ------------------------------------------------------------------ */
/* One case for every command variant                                  */
/* ------------------------------------------------------------------ */

interface CommandCase {
  label: string
  command: DocumentCommand
  /** Optional structural expectation about the applied result. */
  assertResult?: (result: EditorDocument) => void
}

const COMMAND_TYPES = [
  'add-layer',
  'remove-layer',
  'reorder-layer',
  'set-active-layer',
  'set-layer-mask',
  'set-selection',
  'update-layer',
] as const

function commandCases(): CommandCase[] {
  return [
    {
      label: 'set-selection',
      command: { type: 'set-selection', before: patterned(5, 1), after: filled(0xa5, 3), delta: null, coalesceKey: 'select' },
      assertResult: result => {
        expect(result.selection?.bytes).toEqual(new Uint8Array(MASK_BYTES).fill(0xa5))
        expect(result.selection?.feather).toBe(3)
      },
    },
    {
      label: 'set-selection clearing to null',
      command: { type: 'set-selection', before: patterned(5, 1), after: null, delta: null },
      assertResult: result => { expect(result.selection).toBeNull() },
    },
    {
      label: 'set-layer-mask',
      command: { type: 'set-layer-mask', layerId: 'op', before: patterned(1, 2), after: filled(0x3c, 5), delta: null },
      assertResult: result => {
        expect(result.layers[2].mask?.bytes).toEqual(new Uint8Array(MASK_BYTES).fill(0x3c))
        expect(result.layers[2].mask?.feather).toBe(5)
        expect(result.layers[0].mask).toBeNull()
      },
    },
    {
      label: 'set-layer-mask on the base layer',
      command: { type: 'set-layer-mask', layerId: 'base', before: null, after: patterned(9, 0), delta: null },
      assertResult: result => { expect([...(result.layers[0].mask?.bytes ?? [])]).toEqual([...patterned(9).bytes]) },
    },
    {
      label: 'add-layer in the middle',
      command: { type: 'add-layer', layer: adjustmentLayer('new', { lightness: 10 }, { mask: filled(0x0f, 1) }), index: 1 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['base', 'new', 'adj', 'op']) },
    },
    {
      label: 'add-layer a masked pixel-op at the end',
      command: { type: 'add-layer', layer: pixelOpLayer('tail'), index: 3 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['base', 'adj', 'op', 'tail']) },
    },
    {
      label: 'remove-layer',
      // `op` is targeted, not the active `adj`: removing the active layer is a
      // validation error by design and is covered by the rejection test below.
      command: { type: 'remove-layer', layer: pixelOpLayer('op'), index: 2 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['base', 'adj']) },
    },
    {
      label: 'update-layer scalars',
      command: { type: 'update-layer', layerId: 'adj', before: { opacity: 1, visible: true }, after: { opacity: 0.25, visible: false } },
      assertResult: result => {
        expect(result.layers[1].opacity).toBe(0.25)
        expect(result.layers[1].visible).toBe(false)
        expect(result.layers[1].kind).toBe('adjustment')
      },
    },
    {
      label: 'update-layer nested payload',
      command: {
        type: 'update-layer',
        layerId: 'adj',
        before: { adjustment: adjustments({ hue: 15, saturation: -20 }) },
        after: { adjustment: adjustments({ hue: -90, lightness: 40 }) },
      },
      assertResult: result => { expect(result.layers[1]).toMatchObject({ adjustment: { hue: -90, lightness: 40 } }) },
    },
    {
      label: 'reorder-layer upwards',
      command: { type: 'reorder-layer', layerId: 'op', from: 2, to: 1 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['base', 'op', 'adj']) },
    },
    {
      label: 'reorder-layer to the front',
      command: { type: 'reorder-layer', layerId: 'op', from: 2, to: 0 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['op', 'base', 'adj']) },
    },
    {
      label: 'reorder-layer onto itself',
      command: { type: 'reorder-layer', layerId: 'adj', from: 1, to: 1 },
      assertResult: result => { expect(result.layers.map(layer => layer.id)).toEqual(['base', 'adj', 'op']) },
    },
    {
      label: 'set-active-layer',
      command: { type: 'set-active-layer', before: 'adj', after: 'op' },
      assertResult: result => { expect(result.activeLayerId).toBe('op') },
    },
  ]
}

/* ------------------------------------------------------------------ */
/* Contract 1: frozen inputs, no mutation                              */
/* ------------------------------------------------------------------ */

describe('applyCommand never mutates its inputs', () => {
  it('has a case for every DocumentCommand variant', () => {
    const types = [...new Set(commandCases().map(item => item.command.type))].sort()
    expect(types).toEqual([...COMMAND_TYPES])
  })

  for (const item of commandCases()) {
    it(`frozen document and command: ${item.label}`, () => {
      const start = documentFixture()
      // Whatever document the case runs against must itself be legal.
      validateDocument(start)

      const doc = deepCopy(start)
      const command = deepCopy(item.command)
      // Snapshots are taken before freezing: they share no bytes with `doc`.
      const pristineDoc = snapshot(start)
      const pristineCommand = snapshot(item.command)

      deepFreezeObjects(doc)
      deepFreezeObjects(command)
      expectDeeplyFrozenObjects(doc)
      expectDeeplyFrozenObjects(command)
      expect(Object.isFrozen(doc)).toBe(true)
      expect(Object.isFrozen(doc.layers)).toBe(true)

      const result = applyCommand(doc, command)

      expectUnchanged(doc, pristineDoc)
      expectUnchanged(command, pristineCommand)
      expect(result).not.toBe(doc)
      // No byte array owned by the command is ever aliased into the result:
      // `before` payloads belong to the previous state and `after` payloads are
      // cloned into the document, so a later command edit cannot rewrite it.
      const resultArrays = typedArrays(result)
      for (const boundary of ['before', 'after'] as const) {
        if (!(boundary in command)) continue
        for (const supplied of typedArrays((command as Record<string, unknown>)[boundary])) {
          expect(resultArrays.some(array => Object.is(array, supplied))).toBe(false)
        }
      }

      validateDocument(result)
      item.assertResult?.(result)

      // And again after the result is validated and inspected.
      expectUnchanged(doc, pristineDoc)
      expectUnchanged(command, pristineCommand)
    })
  }

  it('a rejected command leaves the frozen document intact', () => {
    const start = documentFixture()
    const doc = deepCopy(start)
    const pristine = snapshot(start)
    deepFreezeObjects(doc)

    expect(() => applyCommand(doc, { type: 'remove-layer', layer: deepCopy(start.layers[0]), index: 0 }))
      .toThrow('base layer cannot be removed')
    expect(() => applyCommand(doc, { type: 'remove-layer', layer: deepCopy(start.layers[1]), index: 1 }))
      .toThrow('active layer does not exist')
    // A mask whose byte length does not match the document is rejected too.
    expect(() => applyCommand(doc, {
      type: 'set-layer-mask',
      layerId: 'op',
      before: null,
      after: { encoding: 'bitpack-v1', width: WIDTH, height: HEIGHT, feather: 0, bytes: new Uint8Array(MASK_BYTES + 1) },
      delta: null,
    })).toThrow('mask dimensions mismatch')
    expectUnchanged(doc, pristine)
  })

  it('pins remove-layer: index guards, id selects, index also drives the undo', () => {
    // The committed implementation refuses when `layers[index]` is the base
    // layer, then filters by `layer.id`, and `invertCommand` re-adds at the same
    // index. Both facts are pinned so a change is deliberate; the frozen input
    // document is untouched either way.
    const start = documentFixture()
    const doc = deepCopy(start)
    const pristine = snapshot(start)
    deepFreezeObjects(doc)

    // `index: 0` points at the base layer, so even a non-base target is refused.
    expect(() => applyCommand(doc, { type: 'remove-layer', layer: pixelOpLayer('op'), index: 0 }))
      .toThrow('base layer cannot be removed')
    // With a non-base index the layer is dropped by id: an unknown id is a no-op.
    expect(applyCommand(doc, { type: 'remove-layer', layer: pixelOpLayer('nope'), index: 2 }).layers.map(layer => layer.id))
      .toEqual(['base', 'adj', 'op'])
    // Removing with a slot that is not the layer's own makes the undo land in
    // the wrong position: the inverse re-adds at `index`. Documents produced by
    // the editor pass the layer's real slot, which the sequence test covers.
    const stale = { type: 'remove-layer' as const, layer: pixelOpLayer('op'), index: 1 }
    const undone = applyCommand(applyCommand(doc, stale), invertCommand(stale))
    expect(undone.layers.map(layer => layer.id)).toEqual(['base', 'op', 'adj'])
    expectUnchanged(doc, pristine)
  })

  it('the freeze really blocks object writes (harness sanity check)', () => {
    const doc = documentFixture()
    const pristine = snapshot(doc)
    deepFreezeObjects(doc)
    expect(() => { doc.layers.push(baseLayer()) }).toThrow(TypeError)
    expect(() => { doc.activeLayerId = 'nope' }).toThrow(TypeError)
    expect(() => { delete (doc.layers[1] as unknown as Record<string, unknown>).opacity }).toThrow(TypeError)
    // Typed arrays cannot be frozen here: prove the fallback (snapshot) catches a byte write.
    doc.selection!.bytes[0] ^= 0xff
    expect(snapshot(doc)).not.toEqual(pristine)
  })

  it('invertCommand never writes to its argument', () => {
    for (const item of commandCases()) {
      const command = deepCopy(item.command)
      const pristine = snapshot(item.command)
      deepFreezeObjects(command)
      const inverse = invertCommand(command)
      expectUnchanged(command, pristine)
      expect(inverse).not.toBe(command)
    }
  })
})

/* ------------------------------------------------------------------ */
/* Contract 2: undo correctness per command                            */
/* ------------------------------------------------------------------ */

describe('invertCommand undoes every command exactly', () => {
  for (const item of commandCases()) {
    it(`apply → invert → apply restores the start: ${item.label}`, () => {
      const start = documentFixture()
      const pristineStart = snapshot(start)
      const command = deepCopy(item.command)
      const applied = applyCommand(start, command)
      const undone = applyCommand(applied, invertCommand(command))
      expectUnchanged(undone, pristineStart)
      // The forward document was not touched by the undo.
      expectUnchanged(applied, snapshot(applyCommand(deepCopy(start), deepCopy(item.command))))
    })
  }
})

/* ------------------------------------------------------------------ */
/* Contract 3: fixed-seed valid sequences                              */
/* ------------------------------------------------------------------ */

/** Deterministic LCG; no time, no `Math.random`. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * The document's own invariants, re-checked by the generator: the candidate is
 * applied to a copy and only accepted when `validateDocument` still passes, so
 * a step can never leave an illegal document behind.
 */
function keepValid(doc: EditorDocument, candidate: DocumentCommand, fallback: DocumentCommand): DocumentCommand {
  try {
    validateDocument(applyCommand(doc, deepCopy(candidate)))
    return candidate
  } catch {
    return fallback
  }
}

interface GeneratedStep { command: DocumentCommand; result: EditorDocument }

/**
 * Turn one random draw into a command that is valid for exactly this document:
 * `before` mirrors the live state, indices are in bounds, the base layer and the
 * active layer are never removed, every mask fits the document, and the result
 * is accepted by `validateDocument`. A one-layer document is handled without
 * indexing into an empty layer list.
 *
 * Order matters: the patch is chosen and validated first, and `before` is only
 * read off the layer afterwards. Building `before` from a *discarded* candidate
 * would describe a state that never happened, and the inverse would then
 * restore the wrong value.
 *
 * Every payload is a freshly built object. That matters too: `update-layer` and
 * `add-layer` store the command's objects in the document by reference, so two
 * steps sharing one object would couple their undo results (a property of the
 * committed implementation, pinned separately below).
 */
function generateCommand(doc: EditorDocument, random: () => number, counter: number): DocumentCommand {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
  const indices = doc.layers.map((layer, index) => ({ layer, index }))
  // Nothing to remove: the base layer and the active layer are both protected.
  const removable = indices.filter(item => item.layer.kind !== 'base-raster' && item.layer.id !== doc.activeLayerId)
  const idle: DocumentCommand = { type: 'set-active-layer', before: doc.activeLayerId, after: doc.activeLayerId }
  const choice = Math.floor(random() * 10)

  if (choice === 0) {
    const after = random() < 0.5 ? null : (random() < 0.5 ? filled(Math.floor(random() * 256), Math.floor(random() * 4)) : patterned(counter, Math.floor(random() * 4)))
    return { type: 'set-selection', before: deepCopy(doc.selection), after, delta: null }
  }
  if (indices.length === 0) return idle
  if (choice === 1 || choice === 2) {
    const { layer } = pick(indices)
    const after = random() < 0.4 ? null : filled(Math.floor(random() * 256), Math.floor(random() * 6))
    return { type: 'set-layer-mask', layerId: layer.id, before: deepCopy(layer.mask), after, delta: null }
  }
  if (choice === 3 || choice === 4) {
    const index = Math.floor(random() * (doc.layers.length + 1))
    const glyph = `g${counter}`
    const layer = random() < 0.5
      ? adjustmentLayer(glyph, { hue: Math.round(random() * 360 - 180), saturation: Math.round(random() * 200 - 100) })
      : pixelOpLayer(glyph, { mask: filled(Math.floor(random() * 256), 1) })
    return keepValid(doc, { type: 'add-layer', layer, index }, idle)
  }
  if (choice === 5) {
    if (removable.length === 0) return idle
    const { layer, index } = pick(removable)
    return keepValid(doc, { type: 'remove-layer', layer: deepCopy(layer), index }, idle)
  }
  if (choice === 6 || choice === 7) {
    const { layer: target } = pick(indices)
    // Decide the patch and prove it valid *before* describing the live state.
    const patch: Partial<EditorLayer> = random() < 0.3
      ? { visible: !target.visible }
      : target.kind === 'adjustment'
        ? { adjustment: adjustments({ hue: Math.round(random() * 360 - 180), lightness: Math.round(random() * 200 - 100) }) }
        : target.kind === 'pixel-op'
          ? { operation: deepCopy(target.operation) }
          : { opacity: 1 }
    let accepted = true
    try {
      validateDocument(applyCommand(doc, { type: 'update-layer', layerId: target.id, before: {}, after: deepCopy(patch) }))
    } catch {
      accepted = false
    }
    if (!accepted) return idle
    // `before` is read off the live layer *after* the patch was validated, so it
    // can never describe a candidate that was discarded.
    const live = doc.layers.find(layer => layer.id === target.id)!
    const before: Record<string, unknown> = {}
    for (const key of Object.keys(patch) as (keyof EditorLayer)[]) before[key] = deepCopy(live[key])
    return { type: 'update-layer', layerId: target.id, before: before as Partial<EditorLayer>, after: patch }
  }
  if (choice === 8) {
    const { layer, index: from } = pick(indices)
    const to = Math.floor(random() * doc.layers.length)
    return keepValid(doc, { type: 'reorder-layer', layerId: layer.id, from, to }, idle)
  }
  return { type: 'set-active-layer', before: doc.activeLayerId, after: pick(indices).layer.id }
}

function generateSequence(seed: number, length: number): { initial: EditorDocument; steps: GeneratedStep[] } {
  const initial = documentFixture()
  const random = makeRandom(seed)
  let current = initial
  const steps: GeneratedStep[] = []
  for (let index = 0; index < length; index += 1) {
    const command = generateCommand(current, random, index)
    // Generated commands must be honest about the live state; that is what makes
    // the inversion restore the exact previous document.
    const live = snapshot(current)
    if (command.type === 'set-selection') expect(snapshot(command.before)).toEqual(asRecord(live).fields.selection ?? null)
    if (command.type === 'set-layer-mask') {
      expect(snapshot(command.before)).toEqual(asRecord(layerSnapshot(live, command.layerId)).fields.mask ?? null)
    }
    if (command.type === 'set-active-layer') expect(command.before).toBe(current.activeLayerId)
    if (command.type === 'update-layer') {
      const target = current.layers.find(layer => layer.id === command.layerId)!
      for (const key of Object.keys(command.before) as (keyof EditorLayer)[]) {
        expect(snapshot(command.before[key])).toEqual(snapshot(target[key]))
      }
    }
    const next = applyCommand(current, command)
    validateDocument(next)
    // Apply must not have disturbed the document it started from.
    expect(snapshot(current)).toEqual(live)
    steps.push({ command, result: next })
    current = next
  }
  return { initial, steps }
}

const SEEDS = [1, 7, 99, 0xdecafbad, 0x5eed, 12345]

describe('fixed-seed command sequences undo and redo exactly', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: apply N, undo all, redo all`, () => {
      const { initial, steps } = generateSequence(seed, 80)
      const direct = steps[steps.length - 1].result
      const pristineInitial = snapshot(documentFixture())
      const pristineDirect = snapshot(direct)

      // A long sequence that never exercises a variant would prove nothing.
      expect(new Set(steps.map(step => step.command.type)).size).toBe(COMMAND_TYPES.length)

      deepFreezeObjects(initial)
      const at = (index: number): string => `step ${index} (${steps[index].command.type})`

      let current = initial
      for (const step of steps) current = applyCommand(current, step.command)
      expect(snapshot(current)).toEqual(pristineDirect)
      expect(snapshotBytes(current)).toEqual(snapshotBytesOf(pristineDirect))

      for (let index = steps.length - 1; index >= 0; index -= 1) {
        const previous = index === 0 ? pristineInitial : snapshot(steps[index - 1].result)
        current = applyCommand(current, invertCommand(steps[index].command))
        validateDocument(current)
        expect(snapshot(current), `undo did not restore the state before ${at(index)}`).toEqual(previous)
      }
      // Undo-all lands on the starting document, byte for byte.
      expectUnchanged(current, pristineInitial)
      expect(snapshotBytes(initial)).toEqual(snapshotBytesOf(pristineInitial))

      for (let index = 0; index < steps.length; index += 1) {
        current = applyCommand(current, steps[index].command)
        validateDocument(current)
        expect(snapshot(current), `redo did not reproduce ${at(index)}`).toEqual(snapshot(steps[index].result))
        expect(snapshotBytes(current)).toEqual(snapshotBytes(steps[index].result))
      }
      // Redo-all lands on the direct result.
      expectUnchanged(current, pristineDirect)
    })
  }

  it('inverting twice returns an equivalent command', () => {
    const { steps } = generateSequence(0xabc, 80)
    for (const step of steps) {
      expect(snapshot(invertCommand(invertCommand(step.command)))).toEqual(snapshot(step.command))
    }
  })

  it('replays the same sequence deterministically from a fresh fixture', () => {
    const { steps } = generateSequence(0xfeed, 60)
    let replay: EditorDocument = documentFixture()
    for (const step of steps) {
      replay = applyCommand(replay, deepCopy(step.command))
      expect(snapshot(replay)).toEqual(snapshot(step.result))
      expect(snapshotBytes(replay)).toEqual(snapshotBytes(step.result))
    }
  })

  it('add-layer shares the command layer (documented behaviour, not a document mutation)', () => {
    // The committed implementation splices `command.layer` in as-is: the input
    // document is untouched (proven above), but the new layer object is shared
    // with the command. Pinned so a change to that sharing is deliberate.
    const layer = pixelOpLayer('shared')
    const command: DocumentCommand = { type: 'add-layer', layer, index: 3 }
    const result = applyCommand(documentFixture(), command)
    expect(result.layers[3]).toBe(layer)
    expect(result.layers[3].mask).toBe(layer.mask)
  })

  it('update-layer shares the patch payload (documented behaviour, not a document mutation)', () => {
    // `update-layer` spreads `command.after` into the layer, so the nested
    // `adjustment` object is the command's object, not a copy. Two commands that
    // shared one payload object would therefore undo to each other's state —
    // which is exactly why the generator above builds a fresh payload per step.
    const start = documentFixture()
    const pristine = snapshot(start)
    const payload = adjustments({ hue: 42 })
    const command: DocumentCommand = { type: 'update-layer', layerId: 'adj', before: { adjustment: adjustments() }, after: { adjustment: payload } }
    const result = applyCommand(start, command)
    expect((result.layers[1] as { adjustment: Adjustments }).adjustment).toBe(payload)
    // Sharing, not mutating: the input document is unchanged.
    expectUnchanged(start, pristine)
  })

  it('handles a document reduced to the bare base layer', () => {
    // Every removable layer goes first, leaving exactly the base layer; the
    // sequence must then keep generating valid commands (mask, selection,
    // add-layer, re-point) without ever touching an empty layer list.
    let doc = documentFixture()
    doc = applyCommand(doc, { type: 'set-active-layer', before: 'adj', after: 'base' })
    doc = applyCommand(doc, { type: 'remove-layer', layer: doc.layers[2], index: 2 })
    doc = applyCommand(doc, { type: 'remove-layer', layer: doc.layers[1], index: 1 })
    expect(doc.layers.map(layer => layer.id)).toEqual(['base'])
    expect(doc.activeLayerId).toBe('base')

    const random = makeRandom(0xb0b)
    const steps: GeneratedStep[] = []
    const initial = doc
    for (let index = 0; index < 60; index += 1) {
      const command = generateCommand(doc, random, index)
      doc = applyCommand(doc, command)
      validateDocument(doc)
      steps.push({ command, result: doc })
    }

    let current = initial
    for (const step of steps) current = applyCommand(current, step.command)
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      current = applyCommand(current, invertCommand(steps[index].command))
      validateDocument(current)
      expect(snapshot(current), `undo did not restore the state before step ${index}`)
        .toEqual(index === 0 ? snapshot(initial) : snapshot(steps[index - 1].result))
    }
    expectUnchanged(current, snapshot(initial))
    for (const step of steps) current = applyCommand(current, step.command)
    expectUnchanged(current, snapshot(steps[steps.length - 1].result))
  })
})
