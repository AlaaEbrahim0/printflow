import { describe, expect, it } from 'vitest'
import { combineSelection, magicWandSelect } from './selectionModes'

describe('manual editor selection primitives', () => {
  it('combines add/subtract/intersect', () => {
    const a = Uint8Array.from([255, 0, 255]), b = Uint8Array.from([0, 255, 255])
    expect([...combineSelection(a, b, 'add')]).toEqual([255, 255, 255])
    expect([...combineSelection(a, b, 'subtract')]).toEqual([255, 0, 0])
    expect([...combineSelection(a, b, 'intersect')]).toEqual([0, 0, 255])
  })
  it('keeps contiguous wand inside matching region', () => {
    const data = new Uint8ClampedArray(3 * 1 * 4)
    for (let i = 0; i < 3; i++) data.set([255, 0, 0, 255], i * 4)
    data.set([0, 0, 255, 255], 4)
    const selected = magicWandSelect(data, 3, 1, { x: 0, y: 0 }, { tolerance: 0, contiguous: true })!
    expect([...selected]).toEqual([255, 0, 0])
  })
})
