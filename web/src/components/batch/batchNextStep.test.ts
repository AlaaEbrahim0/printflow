import { describe, expect, it } from 'vitest'
import { nextStepFor } from './batchNextStep'
import type { BatchSummary } from '../../api/client'

function batch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Test batch',
    status: 'collecting',
    rollWidthCm: 58,
    marginMm: 30,
    edgeMarginMm: 10,
    workingDpi: 300,
    designCount: 3,
    readyCount: 0,
    excludedCount: 0,
    sheetHeightCm: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('nextStepFor', () => {
  it('asks for artwork when the batch is empty', () => {
    const step = nextStepFor(batch({ designCount: 0, readyCount: 0 }))
    expect(step.label).toBe('Add artwork')
    expect(step.detail).toContain('Nothing uploaded yet')
    expect(step.tone).toBe('warn')
  })

  it('distinguishes an all-excluded batch from an empty one', () => {
    const step = nextStepFor(batch({ designCount: 2, excludedCount: 2, readyCount: 0 }))
    expect(step.label).toBe('Add artwork')
    expect(step.detail).toContain('Every design is excluded')
  })

  it('counts only included designs when reporting what needs review', () => {
    const step = nextStepFor(batch({ designCount: 5, excludedCount: 2, readyCount: 1 }))
    // 5 total - 2 excluded = 3 included; 1 ready leaves 2 to review.
    expect(step.label).toBe('Review 2 designs')
    expect(step.detail).toContain('1 of 3 included designs are ready')
  })

  it('uses the singular for a single design', () => {
    const step = nextStepFor(batch({ designCount: 2, readyCount: 1 }))
    expect(step.label).toBe('Review 1 design')
  })

  it('says ready to pack when everything is ready and no sheet exists', () => {
    const step = nextStepFor(batch({ designCount: 2, readyCount: 2 }))
    expect(step.label).toBe('Ready to pack')
    expect(step.tone).toBe('good')
  })

  it('points at the sheet once one exists', () => {
    const step = nextStepFor(batch({ designCount: 2, readyCount: 2, sheetHeightCm: 42.5 }))
    expect(step.label).toBe('Check the sheet')
    expect(step.detail).toContain('integrity gate')
  })

  it('treats a zero-height sheet as a real sheet, not a missing one', () => {
    // A falsy check would misreport this as "ready to pack".
    const step = nextStepFor(batch({ designCount: 1, readyCount: 1, sheetHeightCm: 0 }))
    expect(step.label).toBe('Check the sheet')
  })

  it('reports an exported batch as done', () => {
    const step = nextStepFor(
      batch({ status: 'exported', designCount: 2, readyCount: 2, sheetHeightCm: 40 }),
    )
    expect(step.label).toBe('Exported')
    expect(step.tone).toBe('good')
  })

  it('prioritises outstanding reviews over an existing sheet', () => {
    // Adding a new design to a packed batch must not read as "check the sheet".
    const step = nextStepFor(
      batch({ designCount: 3, readyCount: 2, sheetHeightCm: 40 }),
    )
    expect(step.label).toBe('Review 1 design')
  })
})
