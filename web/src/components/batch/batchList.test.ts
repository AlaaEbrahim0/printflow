import { describe, expect, it } from 'vitest'
import {
  batchFilterLabel,
  filterBatches,
  needsAction,
  prepareBatchList,
  searchBatches,
  sortBatches,
} from './batchList'
import type { BatchSummary } from '../../api/client'

function batch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'b1',
    name: 'Batch',
    status: 'collecting',
    rollWidthCm: 58,
    marginMm: 30,
    edgeMarginMm: 10,
    workingDpi: 300,
    designCount: 2,
    readyCount: 2,
    excludedCount: 0,
    sheetHeightCm: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as BatchSummary
}

describe('sortBatches', () => {
  it('puts batches that need action above finished ones', () => {
    const exported = batch({ id: 'a', name: 'Done', status: 'exported', sheetHeightCm: 40 })
    const needsReview = batch({ id: 'b', name: 'Waiting', readyCount: 0, status: 'collecting' })
    const sorted = sortBatches([exported, needsReview])
    expect(sorted.map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('breaks ties with the newest batch first', () => {
    const older = batch({ id: 'a', name: 'Older', readyCount: 0, createdAt: '2026-01-01T00:00:00Z' })
    const newer = batch({ id: 'b', name: 'Newer', readyCount: 0, createdAt: '2026-03-01T00:00:00Z' })
    expect(sortBatches([older, newer]).map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('falls back to name when timestamps are unparseable', () => {
    const a = batch({ id: 'a', name: 'Alpha', readyCount: 0, createdAt: 'nonsense' })
    const b = batch({ id: 'b', name: 'Beta', readyCount: 0, createdAt: 'nonsense' })
    expect(sortBatches([b, a]).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const items = [batch({ id: 'a' }), batch({ id: 'b', readyCount: 0 })]
    const before = items.map((item) => item.id)
    sortBatches(items)
    expect(items.map((item) => item.id)).toEqual(before)
  })

  it('ranks ready-to-pack above exported but below needs-action', () => {
    const needsReview = batch({ id: 'n', readyCount: 0 })
    const readyToPack = batch({ id: 'r' })
    const exported = batch({ id: 'e', status: 'exported', sheetHeightCm: 40 })
    expect(sortBatches([exported, readyToPack, needsReview]).map((item) => item.id)).toEqual([
      'n',
      'r',
      'e',
    ])
  })
})

describe('needsAction', () => {
  it('is true while designs are not ready', () => {
    expect(needsAction(batch({ readyCount: 0 }))).toBe(true)
  })

  it('is false when everything is ready and a sheet exists', () => {
    expect(needsAction(batch({ sheetHeightCm: 40 }))).toBe(false)
  })
})

describe('searchBatches', () => {
  it('matches a case-insensitive substring of the name', () => {
    const items = [batch({ id: 'a', name: 'ACME summer' }), batch({ id: 'b', name: 'Winter drop' })]
    expect(searchBatches(items, 'acme').map((item) => item.id)).toEqual(['a'])
  })

  it('returns everything for a blank query', () => {
    const items = [batch({ id: 'a' }), batch({ id: 'b' })]
    expect(searchBatches(items, '   ')).toHaveLength(2)
  })
})

describe('filterBatches', () => {
  const items = [
    batch({ id: 'review', readyCount: 0 }),
    batch({ id: 'packed', status: 'packed', sheetHeightCm: 40 }),
    batch({ id: 'exported', status: 'exported', sheetHeightCm: 40 }),
  ]

  it('keeps only batches that need action', () => {
    expect(filterBatches(items, 'needs-action').map((item) => item.id)).toEqual(['review'])
  })

  it('filters by packed and exported status', () => {
    expect(filterBatches(items, 'packed').map((item) => item.id)).toEqual(['packed'])
    expect(filterBatches(items, 'exported').map((item) => item.id)).toEqual(['exported'])
  })

  it('returns everything for the all filter', () => {
    expect(filterBatches(items, 'all')).toHaveLength(3)
  })

  it('labels every filter', () => {
    expect(batchFilterLabel('needs-action')).toBe('Needs action')
    expect(batchFilterLabel('all')).toBe('All batches')
  })
})

describe('prepareBatchList', () => {
  it('reports how many batches were hidden', () => {
    const items = [batch({ id: 'a', readyCount: 0 }), batch({ id: 'b', sheetHeightCm: 40 })]
    const result = prepareBatchList(items, { filter: 'needs-action', query: '' })
    expect(result.items.map((item) => item.id)).toEqual(['a'])
    expect(result.total).toBe(2)
    expect(result.narrowed).toBe(true)
  })

  it('is not narrowed when everything passes', () => {
    const items = [batch({ id: 'a' }), batch({ id: 'b' })]
    const result = prepareBatchList(items, { filter: 'all', query: '' })
    expect(result.narrowed).toBe(false)
  })

  it('applies search before the status filter', () => {
    const items = [
      batch({ id: 'a', name: 'ACME', readyCount: 0 }),
      batch({ id: 'b', name: 'ACME', sheetHeightCm: 40 }),
      batch({ id: 'c', name: 'Other', readyCount: 0 }),
    ]
    const result = prepareBatchList(items, { filter: 'needs-action', query: 'acme' })
    expect(result.items.map((item) => item.id)).toEqual(['a'])
  })
})
