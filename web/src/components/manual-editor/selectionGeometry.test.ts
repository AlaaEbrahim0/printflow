import { describe, expect, it } from 'vitest'
import {
  contentBounds,
  dragRect,
  ellipseContains,
  fillPolygon,
  shapeContains,
  strokePath,
  toPixel,
} from './selectionGeometry'

/** Build a mask from an ASCII map; '#' = selected. Mirrors a 1-byte mask. */
function fromAscii(rows: string[]): { mask: Uint8Array; width: number; height: number } {
  const width = rows[0].length
  const height = rows.length
  const mask = new Uint8Array(width * height)
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x += 1) mask[y * width + x] = row[x] === '#' ? 255 : 0
  })
  return { mask, width, height }
}

function toAscii(mask: Uint8Array, width: number, height: number): string[] {
  const rows: string[] = []
  for (let y = 0; y < height; y += 1) {
    let row = ''
    for (let x = 0; x < width; x += 1) row += mask[y * width + x] !== 0 ? '#' : '.'
    rows.push(row)
  }
  return rows
}

describe('toPixel', () => {
  it('rounds and clamps a pointer position into the raster', () => {
    expect(toPixel({ x: 3.6, y: 1.2 }, 10, 10)).toEqual({ x: 4, y: 1 })
    expect(toPixel({ x: -5, y: 99 }, 10, 10)).toEqual({ x: 0, y: 9 })
    // NaN must not leak into a buffer index.
    expect(toPixel({ x: Number.NaN, y: Number.NaN }, 10, 10)).toEqual({ x: 0, y: 0 })
  })
})

describe('dragRect', () => {
  it('is inclusive of both corners so a 1 px drag selects 1 px', () => {
    expect(dragRect({ x: 2, y: 2 }, { x: 2, y: 2 }, 10, 10)).toEqual({ x: 2, y: 2, width: 1, height: 1 })
    expect(dragRect({ x: 5, y: 6 }, { x: 1, y: 2 }, 10, 10)).toEqual({ x: 1, y: 2, width: 5, height: 5 })
  })

  it('clamps to the raster instead of running off the edge', () => {
    const rect = dragRect({ x: -3, y: -3 }, { x: 99, y: 99 }, 8, 6)
    expect(rect).toEqual({ x: 0, y: 0, width: 8, height: 6 })
  })
})

describe('ellipse vs marquee', () => {
  it('fills the marquee completely and cuts the ellipse corners', () => {
    const rect = { x: 0, y: 0, width: 5, height: 5 }
    expect(shapeContains(rect, 'marquee', 0, 0)).toBe(true)
    expect(shapeContains(rect, 'marquee', 4, 4)).toBe(true)
    expect(shapeContains(rect, 'ellipse', 0, 0)).toBe(false)
    expect(shapeContains(rect, 'ellipse', 2, 2)).toBe(true)
  })

  it('treats a single-pixel drag as one pixel, not a divide by zero', () => {
    const rect = { x: 3, y: 3, width: 1, height: 1 }
    expect(ellipseContains(rect, 3, 3)).toBe(true)
    expect(ellipseContains(rect, 4, 3)).toBe(false)
  })
})

describe('fillPolygon', () => {
  it('fills a closed triangle over the pixels it encloses', () => {
    const { mask, width, height } = fromAscii(['.....', '.....', '.....', '.....', '.....'])
    const filled = fillPolygon(mask, width, height, [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 1, y: 3 },
    ])
    expect(toAscii(filled, width, height)).toEqual(['.....', '.###.', '.##..', '.#...', '.....'])
  })

  it('includes the boundary, matching the inclusive drag rectangle', () => {
    // A path drawn corner to corner selects the pixels it was drawn along, so
    // the result agrees with dragRect({1,1},{3,3}) — a 3 × 3 block, not 2 × 2.
    const { mask, width, height } = fromAscii(['.....', '.....', '.....', '.....', '.....'])
    const filled = fillPolygon(mask, width, height, [
      { x: 1, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 1, y: 3 },
    ])
    expect(toAscii(filled, width, height)).toEqual(['.....', '.###.', '.###.', '.###.', '.....'])
  })

  it('honours even-odd fill for a self-intersecting path', () => {
    const { mask, width, height } = fromAscii(['.....', '.....', '.....', '.....', '.....'])
    // A bow tie: the top and bottom rows are fully covered, and the pinch in
    // the middle is where the two lobes cross.
    const filled = fillPolygon(mask, width, height, [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 4 },
      { x: 4, y: 4 },
    ])
    const rows = toAscii(filled, width, height)
    expect(rows[0]).toBe('#####')
    expect(rows[1]).toBe('.###.')
    expect(rows[4]).toBe('#####')
  })

  it('refuses to fill fewer than three points', () => {
    const { mask, width, height } = fromAscii(['...', '...', '...'])
    expect(toAscii(fillPolygon(mask, width, height, [{ x: 0, y: 0 }, { x: 2, y: 2 }]), width, height)).toEqual([
      '...',
      '...',
      '...',
    ])
  })
})

describe('strokePath', () => {
  it('joins fast pointer samples with no gaps', () => {
    const width = 12
    const height = 4
    const mask = new Uint8Array(width * height)
    strokePath(mask, width, height, [{ x: 1, y: 2 }, { x: 10, y: 2 }], 0)
    const row = toAscii(mask, width, height)[2]
    // A dashed line would have holes; a joined stroke is one run.
    expect(row).toBe('.##########.')
  })

  it('stamps a disc of the requested radius', () => {
    // Radius 2 is the smallest that reads as a disc rather than a plus sign;
    // radius 1 is a 5-pixel cross, which is the correct 1 px brush footprint.
    const mask = new Uint8Array(49)
    strokePath(mask, 7, 7, [{ x: 3, y: 3 }], 2)
    expect(toAscii(mask, 7, 7)).toEqual([
      '.......',
      '...#...',
      '..###..',
      '.#####.',
      '..###..',
      '...#...',
      '.......',
    ])
  })

  it('closes a stroke back onto its first sample when asked', () => {
    // Radius 0 is a 1 px pencil, so the selected pixels are exactly the
    // polyline the pointer described: (1,1)→(4,1)→(4,4).
    const width = 6
    const height = 6
    const points = [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }]
    const open = new Uint8Array(width * height)
    strokePath(open, width, height, points, 0)
    expect(toAscii(open, width, height)).toEqual([
      '......',
      '.####.',
      '....#.',
      '....#.',
      '....#.',
      '......',
    ])
    // Closed adds the segment (4,4)→(1,1); the diagonal is continuous rather
    // than the four samples it happens to pass through.
    const closed = new Uint8Array(width * height)
    strokePath(closed, width, height, points, 0, true)
    expect(toAscii(closed, width, height)).toEqual([
      '......',
      '.####.',
      '..#.#.',
      '...##.',
      '....#.',
      '......',
    ])
  })

  it('draws a connected 1 px line on a slope that misses most pixel centres', () => {
    // Exact-distance sampling would keep only (0,0) and (3,1) — a dashed line.
    // The pencil joins them into an 8-connected trace.
    const mask = new Uint8Array(4 * 4)
    strokePath(mask, 4, 4, [{ x: 0, y: 0 }, { x: 3, y: 1 }], 0)
    expect(toAscii(mask, 4, 4)).toEqual(['##..', '..##', '....', '....'])
  })
})

describe('contentBounds', () => {
  it('reports the tight box around selected pixels', () => {
    const { mask, width, height } = fromAscii(['.....', '..#..', '..#..', '.....'])
    expect(contentBounds(mask, width, height)).toEqual({ x: 2, y: 1, width: 1, height: 2 })
  })

  it('is null for an empty selection', () => {
    const { mask, width, height } = fromAscii(['...', '...'])
    expect(contentBounds(mask, width, height)).toBeNull()
  })
})
