import { describe, expect, it } from 'vitest'
import { workflowProgress } from './workflowProgress'
import type { BatchDetail, DesignSummary, Sheet } from '../../api/client'

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

function batch(designs: DesignSummary[], sheet: Sheet | null = null): BatchDetail {
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
    sheetHeightCm: sheet ? 100 : null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    designs,
    sheet,
  } as BatchDetail
}

function sheet(overrides: Partial<Sheet> = {}): Sheet {
  return {
    id: 's1',
    batchId: 'b1',
    revision: 1,
    state: 'valid',
    stale: false,
    widthPx: 6850,
    heightPx: 12000,
    widthCm: 58,
    heightCm: 101.6,
    estimatedCost: { amount: 12.5, currency: 'EUR' },
    placements: [],
    integrityReport: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Sheet
}

const stateOf = (progress: ReturnType<typeof workflowProgress>, id: string) =>
  progress.stages.find((stage) => stage.id === id)?.state

describe('workflowProgress', () => {
  it('starts an empty batch at artwork', () => {
    const progress = workflowProgress({ batch: batch([]), sheet: null, exported: false })
    expect(progress.current).toBe('artwork')
    expect(stateOf(progress, 'artwork')).toBe('current')
    expect(stateOf(progress, 'review')).toBe('todo')
  })

  it('moves to review as soon as artwork exists but is not ready', () => {
    const progress = workflowProgress({
      batch: batch([design({ status: 'in-progress' })]),
      sheet: null,
      exported: false,
    })
    expect(stateOf(progress, 'artwork')).toBe('done')
    expect(stateOf(progress, 'review')).toBe('current')
    expect(progress.current).toBe('review')
  })

  it('moves to packing once every included design is ready', () => {
    const progress = workflowProgress({
      batch: batch([design(), design({ id: 'd2' })]),
      sheet: null,
      exported: false,
    })
    expect(stateOf(progress, 'review')).toBe('done')
    expect(stateOf(progress, 'pack')).toBe('current')
  })

  it('ignores excluded designs when deciding whether everything is ready', () => {
    const progress = workflowProgress({
      batch: batch([design(), design({ id: 'd2', status: 'excluded' })]),
      sheet: null,
      exported: false,
    })
    expect(stateOf(progress, 'review')).toBe('done')
    expect(stateOf(progress, 'pack')).toBe('current')
  })

  it('moves to checking once a sheet exists but has not passed', () => {
    const progress = workflowProgress({
      batch: batch([design()], sheet({ state: 'unchecked' })),
      sheet: sheet({ state: 'unchecked' }),
      exported: false,
    })
    expect(stateOf(progress, 'pack')).toBe('done')
    expect(stateOf(progress, 'check')).toBe('current')
  })

  it('marks the check stage blocked when the sheet is stale', () => {
    const stale = sheet({ stale: true })
    const progress = workflowProgress({
      batch: batch([design()], stale),
      sheet: stale,
      exported: false,
    })
    expect(stateOf(progress, 'check')).toBe('blocked')
    expect(progress.current).toBe('export')
  })

  it('offers export only after a passing, non-stale check', () => {
    const valid = sheet()
    const progress = workflowProgress({
      batch: batch([design()], valid),
      sheet: valid,
      exported: false,
    })
    expect(stateOf(progress, 'check')).toBe('done')
    expect(stateOf(progress, 'export')).toBe('current')
  })

  it('marks the whole run done once exported', () => {
    const valid = sheet()
    const progress = workflowProgress({
      batch: batch([design()], valid),
      sheet: valid,
      exported: true,
    })
    expect(progress.stages.every((stage) => stage.state === 'done')).toBe(true)
  })

  it('does not mark export done when a newer revision invalidated the check', () => {
    // An old export exists, but the sheet was repacked and is now unchecked, so
    // the export stage must fall back to pending rather than claiming success.
    const unchecked = sheet({ revision: 2, state: 'unchecked' })
    const progress = workflowProgress({
      batch: batch([design()], unchecked),
      sheet: unchecked,
      exported: true,
    })
    expect(stateOf(progress, 'export')).toBe('todo')
  })

  it('does not count an invalid report as a passing check', () => {
    const invalid = sheet({ state: 'invalid' })
    const progress = workflowProgress({
      batch: batch([design()], invalid),
      sheet: invalid,
      exported: false,
    })
    expect(stateOf(progress, 'check')).toBe('current')
    expect(stateOf(progress, 'export')).toBe('todo')
  })

  it('always returns the five stages in workflow order', () => {
    const progress = workflowProgress({ batch: batch([]), sheet: null, exported: false })
    expect(progress.stages.map((stage) => stage.id)).toEqual([
      'artwork',
      'review',
      'pack',
      'check',
      'export',
    ])
  })
})
