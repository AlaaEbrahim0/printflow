import { describe, expect, it } from 'vitest'
import {
  applyMaskToAlpha,
  contractMask,
  featherMask,
  growMask,
  invertMask,
  maskCoverage,
  thresholdMask,
} from './maskOps'

const size = { width: 5, height: 5 }

function centreOnly(): Uint8Array {
  const mask = new Uint8Array(size.width * size.height)
  mask[2 * size.width + 2] = 255
  return mask
}

describe('mask operations', () => {
  it('grows by a square kernel and leaves the input untouched', () => {
    const mask = centreOnly()
    const grown = growMask(mask, size, 1)
    // Separable max with radius 1 reaches the full 3x3 neighbourhood.
    expect([...grown].filter(Boolean)).toHaveLength(9)
    expect(grown[2 * size.width + 1]).toBe(255)
    expect(grown[1 * size.width + 2]).toBe(255)
    expect(grown[0]).toBe(0)
    expect([...mask].filter(Boolean)).toHaveLength(1)
  })

  it('contracts by growing the inverse', () => {
    const mask = new Uint8Array(size.width * size.height)
    mask.fill(255)
    mask[2 * size.width + 2] = 0
    const contracted = contractMask(mask, size, 1)
    expect(contracted[2 * size.width + 2]).toBe(0)
    expect(contracted[2 * size.width + 1]).toBe(0)
    expect(contracted[0]).toBe(255)
  })

  it('inverts and thresholds at the requested cut', () => {
    const soft = Uint8Array.from([0, 100, 128, 200, 255])
    expect([...invertMask(soft)]).toEqual([255, 155, 127, 55, 0])
    expect([...thresholdMask(soft, 128)]).toEqual([0, 0, 255, 255, 255])
  })

  it('feathers a single pixel into a soft falloff', () => {
    const feathered = featherMask(centreOnly(), size, 1)
    const centre = feathered[2 * size.width + 2]
    expect(centre).toBeGreaterThan(0)
    expect(centre).toBeLessThan(255)
    expect(feathered[2 * size.width + 1]).toBeGreaterThan(0)
    expect(feathered[0]).toBeLessThan(centre)
  })

  it('returns a copy when the radius is zero', () => {
    const mask = centreOnly()
    const copy = growMask(mask, size, 0)
    expect(copy).not.toBe(mask)
    expect([...copy]).toEqual([...mask])
  })

  it('multiplies alpha and reports coverage', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 200, 10, 20, 30, 200])
    applyMaskToAlpha(data, Uint8Array.from([255, 128]))
    expect(data[3]).toBe(200)
    expect(data[7]).toBe(100)
    expect(maskCoverage(Uint8Array.from([0, 255]))).toBeCloseTo(0.5)
    expect(maskCoverage(null)).toBe(0)
  })
})
