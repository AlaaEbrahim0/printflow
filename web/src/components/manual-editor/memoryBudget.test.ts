import { describe, expect, it } from 'vitest'
import {
  assertSupportedSize,
  estimateMemory,
  HISTORY_MAX_BYTES,
  MAX_EDITOR_PIXELS,
} from './memoryBudget'

describe('assertSupportedSize', () => {
  it('accepts an ordinary print source', () => {
    expect(() => assertSupportedSize(1800, 1200)).not.toThrow()
    expect(() => assertSupportedSize(8000, 400)).not.toThrow()
  })

  it('accepts a document exactly at the limit', () => {
    // 40 MP as a square is ~6324 px a side; the boundary itself must pass so the
    // limit is inclusive rather than off by one.
    expect(() => assertSupportedSize(6324, 6324)).not.toThrow()
  })

  it('refuses a full-bleed square at the 58 cm working size', () => {
    // 6850 px is 58 cm at 300 DPI: a legitimate target size, but as a *square*
    // it is 46.9 MP and the editor's three 4-byte-per-pixel canvases would ask
    // for roughly 750 MB. Refusing early beats an out-of-memory tab crash.
    expect(() => assertSupportedSize(6850, 6850)).toThrow(/40 megapixels/)
  })

  it('refuses any document above the limit', () => {
    expect(() => assertSupportedSize(MAX_EDITOR_PIXELS, 2)).toThrow(/40 megapixels/)
  })
})

describe('estimateMemory', () => {
  it('accounts for every buffer the editor allocates', () => {
    const budget = estimateMemory(1000, 1000)
    const pixels = 1_000_000
    expect(budget.decodedBytes).toBe(pixels * 4)
    expect(budget.compositeBytes).toBe(pixels * 4)
    expect(budget.scratchBytes).toBe(pixels * 4)
    expect(budget.usedBytes).toBe(
      budget.decodedBytes + budget.compositeBytes + budget.scratchBytes + budget.workingMaskBytes,
    )
  })

  it('reserves the full history allowance in the limit', () => {
    const budget = estimateMemory(100, 100)
    expect(budget.limitBytes).toBeGreaterThan(HISTORY_MAX_BYTES)
  })

  it('counts history bytes the caller has already used', () => {
    const empty = estimateMemory(100, 100)
    const loaded = estimateMemory(100, 100, 10_000_000)
    expect(loaded.historyBytes).toBe(10_000_000)
    expect(loaded.usedBytes).toBe(empty.usedBytes + 10_000_000)
  })

  it('warns once used memory approaches the limit', () => {
    // The limit reserves a 100 MB history allowance, so a large document with
    // no history stays comfortably under it; the warning is driven by history
    // the operator has actually accumulated.
    expect(estimateMemory(100, 100).warning).toBe(false)
    const big = estimateMemory(6324, 6324)
    expect(big.warning).toBe(false)
    expect(estimateMemory(6324, 6324, 300_000_000).warning).toBe(true)
  })
})
