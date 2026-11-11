import { describe, expect, it } from 'vitest'
import {
  combineSelection,
  invertSelection,
  isSelectionEmpty,
  magicWandSelect,
  resolveSelectionMode,
  selectionCount,
  wandThreshold,
} from './selectionModes'

/**
 * A 5×3 image: a red blob on the left, a red pixel isolated on the right, and
 * a blue field between them. This is the fixture that separates a contiguous
 * wand from a global one.
 *
 *   R R R B R
 *   R R R B B
 *   B B B B B
 */
function fixture() {
  const width = 5
  const height = 3
  const data = new Uint8ClampedArray(width * height * 4)
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const offset = (y * width + x) * 4
    data[offset] = r
    data[offset + 1] = g
    data[offset + 2] = b
    data[offset + 3] = 255
  }
  const red: [number, number, number] = [255, 0, 0]
  const blue: [number, number, number] = [0, 0, 255]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isRed = (y < 2 && x < 3) || (x === 4 && y === 0)
      set(x, y, ...(isRed ? red : blue))
    }
  }
  return { data, width, height }
}

function selectedPoints(mask: Uint8Array, width: number): string[] {
  const points: string[] = []
  for (let i = 0; i < mask.length; i += 1) if (mask[i] !== 0) points.push(`${i % width},${Math.floor(i / width)}`)
  return points
}

describe('resolveSelectionMode', () => {
  it('maps modifier keys to the Photoshop conventions', () => {
    expect(resolveSelectionMode({})).toBe('replace')
    expect(resolveSelectionMode({ shiftKey: true })).toBe('add')
    expect(resolveSelectionMode({ altKey: true })).toBe('subtract')
    expect(resolveSelectionMode({ shiftKey: true, altKey: true })).toBe('intersect')
    expect(resolveSelectionMode({ metaKey: true })).toBe('add')
  })

  it('falls back to the toolbar mode when no key is held', () => {
    expect(resolveSelectionMode({}, 'subtract')).toBe('subtract')
    // A held modifier always outranks the sticky toolbar mode.
    expect(resolveSelectionMode({ shiftKey: true }, 'subtract')).toBe('add')
  })
})

describe('combineSelection', () => {
  const a = Uint8Array.from([255, 255, 0, 0])
  const b = Uint8Array.from([0, 255, 255, 0])

  it('adds, subtracts and intersects', () => {
    expect([...combineSelection(a, b, 'add')]).toEqual([255, 255, 255, 0])
    expect([...combineSelection(a, b, 'subtract')]).toEqual([255, 0, 0, 0])
    expect([...combineSelection(a, b, 'intersect')]).toEqual([0, 255, 0, 0])
    expect([...combineSelection(a, b, 'replace')]).toEqual([0, 255, 255, 0])
  })

  it('replaces rather than misaligning when the lengths differ', () => {
    const shorter = Uint8Array.from([0, 0])
    expect([...combineSelection(a, shorter, 'add')]).toEqual([0, 0])
  })

  it('treats nothing selected as a replace, so the first gesture works', () => {
    expect([...combineSelection(null, b, 'add')]).toEqual([0, 255, 255, 0])
  })

  it('never mutates its operands', () => {
    const base = a.slice()
    combineSelection(a, b, 'subtract')
    expect([...a]).toEqual([...base])
  })
})

describe('selection helpers', () => {
  it('treats an all-zero mask as empty', () => {
    expect(isSelectionEmpty(null)).toBe(true)
    expect(isSelectionEmpty(new Uint8Array([0, 0]))).toBe(true)
    expect(isSelectionEmpty(new Uint8Array([0, 1]))).toBe(false)
  })

  it('inverts and counts', () => {
    const inverted = invertSelection(Uint8Array.from([0, 255, 128]))
    expect([...inverted]).toEqual([255, 0, 127])
    expect(selectionCount(Uint8Array.from([0, 255, 1]))).toBe(2)
    expect(selectionCount(null)).toBe(0)
  })

  it('maps the 0–100 slider onto a 0–255 per-channel tolerance', () => {
    expect(wandThreshold(0)).toBe(0)
    expect(wandThreshold(100)).toBe(255)
    expect(wandThreshold(50)).toBe(128)
    expect(wandThreshold(Number.NaN)).toBe(0)
  })
})

describe('magicWandSelect', () => {
  it('stops at the first colour boundary when contiguous', () => {
    const { data, width, height } = fixture()
    const mask = magicWandSelect(data, width, height, { x: 0, y: 0 }, { tolerance: 10, contiguous: true })!
    // Only the connected red blob, not the isolated red pixel at (4, 0).
    expect(selectedPoints(mask, width).sort()).toEqual(['0,0', '0,1', '1,0', '1,1', '2,0', '2,1'])
  })

  it('reaches every matching pixel when not contiguous', () => {
    const { data, width, height } = fixture()
    const mask = magicWandSelect(data, width, height, { x: 0, y: 0 }, { tolerance: 10, contiguous: false })!
    expect(selectedPoints(mask, width)).toContain('4,0')
    expect(mask.length).toBe(width * height)
  })

  it('cannot escape a fully enclosed region', () => {
    // A blue ring around a red centre: a contiguous wand on the centre must not
    // leak into the blue even at a huge tolerance, as long as the colours differ
    // by more than the budget.
    const width = 3
    const height = 3
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i += 1) {
      const centre = i === 4
      data[i * 4] = centre ? 255 : 0
      data[i * 4 + 1] = 0
      data[i * 4 + 2] = centre ? 0 : 255
      data[i * 4 + 3] = 255
    }
    const mask = magicWandSelect(data, width, height, { x: 1, y: 1 }, { tolerance: 10, contiguous: true })!
    expect(selectionCount(mask)).toBe(1)
  })

  it('returns null for a click outside the raster so the selection is kept', () => {
    const { data, width, height } = fixture()
    expect(magicWandSelect(data, width, height, { x: -1, y: 0 }, { tolerance: 10, contiguous: true })).toBeNull()
    expect(magicWandSelect(data, width, height, { x: 0, y: 9 }, { tolerance: 10, contiguous: true })).toBeNull()
  })

  it('selects the whole image when everything matches', () => {
    const width = 4
    const height = 4
    const data = new Uint8ClampedArray(width * height * 4).fill(120)
    const mask = magicWandSelect(data, width, height, { x: 2, y: 2 }, { tolerance: 0, contiguous: true })!
    expect(selectionCount(mask)).toBe(width * height)
  })
})
