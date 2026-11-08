import { describe, expect, it } from 'vitest'
import { evaluatePackReadiness } from './packReadiness'
import type { BatchDetail, DesignSummary } from '../../api/client'

function design(overrides: Partial<DesignSummary> = {}): DesignSummary {
  return {
    id: 'd1',
    batchId: 'b1',
    name: 'Design',
    status: 'ready',
    garmentColor: { kind: 'light', hex: '#ffffff' },
    allowRotation: true,
    originalVersionId: 'v1',
    currentVersionId: 'v2',
    targetWidthCm: 30,
    targetHeightCm: 12,
    effectiveDpi: 300,
    versionCount: 2,
    currentVersion: null,
    pendingVersion: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as DesignSummary
}

function batch(designs: DesignSummary[], overrides: Partial<BatchDetail> = {}): BatchDetail {
  return {
    id: 'b1',
    name: 'Batch',
    status: 'collecting',
    rollWidthCm: 58,
    marginMm: 30,
    edgeMarginMm: 10,
    workingDpi: 300,
    designCount: designs.length,
    readyCount: designs.filter((item) => item.status === 'ready').length,
    excludedCount: designs.filter((item) => item.status === 'excluded').length,
    sheetHeightCm: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    designs,
    ...overrides,
  } as BatchDetail
}

describe('evaluatePackReadiness', () => {
  it('allows packing when every included design is ready', () => {
    const readiness = evaluatePackReadiness(batch([design(), design({ id: 'd2' })]))
    expect(readiness.canPack).toBe(true)
    expect(readiness.blockingReason).toBeNull()
    expect(readiness.ready).toHaveLength(2)
  })

  it('distinguishes an empty batch from an all-excluded one', () => {
    const empty = evaluatePackReadiness(batch([]))
    expect(empty.blockingReason).toContain('upload the customer artwork first')

    const allExcluded = evaluatePackReadiness(batch([design({ status: 'excluded' })]))
    expect(allExcluded.blockingReason).toContain('every design in this batch is excluded')
  })

  it('names the designs that are not ready', () => {
    const readiness = evaluatePackReadiness(
      batch([
        design(),
        design({ id: 'd2', name: 'Wordmark', status: 'in-progress' }),
        design({ id: 'd3', name: 'Badge', status: 'received' }),
      ]),
    )
    expect(readiness.canPack).toBe(false)
    expect(readiness.blockingReason).toContain('2 designs are not ready')
    expect(readiness.blockingReason).toContain('Wordmark')
    expect(readiness.blockingReason).toContain('Badge')
  })

  it('uses the singular for one blocking design', () => {
    const readiness = evaluatePackReadiness(
      batch([design(), design({ id: 'd2', name: 'Badge', status: 'received' })]),
    )
    expect(readiness.blockingReason).toContain('1 design is not ready')
  })

  it('never counts an excluded design as blocking', () => {
    const readiness = evaluatePackReadiness(
      batch([design(), design({ id: 'd2', status: 'excluded' })]),
    )
    expect(readiness.canPack).toBe(true)
    expect(readiness.notReady).toHaveLength(0)
  })

  it('treats a needs-better-source design as blocking', () => {
    const readiness = evaluatePackReadiness(batch([design({ status: 'needs-better-source' })]))
    expect(readiness.canPack).toBe(false)
  })

  it('flags a design wider than the usable roll', () => {
    // 58 cm roll minus 10 mm edge margins on both sides = 56 cm usable.
    const readiness = evaluatePackReadiness(batch([design({ targetWidthCm: 57 })]))
    expect(readiness.usableWidthCm).toBeCloseTo(56, 6)
    expect(readiness.overWide.map((item) => item.id)).toEqual(['d1'])
  })

  it('does not flag a design that exactly fills the usable width', () => {
    const readiness = evaluatePackReadiness(batch([design({ targetWidthCm: 56 })]))
    expect(readiness.overWide).toHaveLength(0)
  })

  it('does not flag an excluded design as over-wide', () => {
    const readiness = evaluatePackReadiness(
      batch([design({ targetWidthCm: 57, status: 'excluded' })]),
    )
    expect(readiness.overWide).toHaveLength(0)
  })

  it('collapses a long blocking list to a count', () => {
    const designs = Array.from({ length: 10 }, (_, index) =>
      design({ id: `d${index}`, name: `Design ${index}`, status: 'received' }),
    )
    const readiness = evaluatePackReadiness(batch(designs))
    expect(readiness.blockingReason).toContain('+4 more')
  })

  it('reports over-wide separately from not-ready, since the fix differs', () => {
    // An over-wide design can still be `ready`; only rotation or resizing helps.
    const readiness = evaluatePackReadiness(batch([design({ targetWidthCm: 57 })]))
    expect(readiness.canPack).toBe(true)
    expect(readiness.overWide).toHaveLength(1)
  })
})
