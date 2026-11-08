import { describe, expect, it } from 'vitest'
import {
  designFilterLabel,
  designNeedsWork,
  filterDesigns,
  groupDesigns,
  prepareDesignGrid,
  searchDesigns,
} from './designGrid'
import type { DesignSummary } from '../../api/client'

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

const ready = design({ id: 'r1', name: 'Ready one' })
const inProgress = design({ id: 'p1', name: 'Wordmark', status: 'in-progress' })
const received = design({ id: 'n1', name: 'Badge', status: 'received' })
const betterSource = design({ id: 's1', name: 'Photo', status: 'needs-better-source' })
const excluded = design({ id: 'x1', name: 'Old logo', status: 'excluded' })
const all = [ready, inProgress, received, betterSource, excluded]

describe('designNeedsWork', () => {
  it('counts every non-ready, non-excluded state', () => {
    expect(designNeedsWork(inProgress)).toBe(true)
    expect(designNeedsWork(received)).toBe(true)
    expect(designNeedsWork(betterSource)).toBe(true)
  })

  it('excludes ready and excluded designs', () => {
    expect(designNeedsWork(ready)).toBe(false)
    expect(designNeedsWork(excluded)).toBe(false)
  })
})

describe('filterDesigns', () => {
  it('returns everything for all', () => {
    expect(filterDesigns(all, 'all')).toHaveLength(5)
  })

  it('filters each state separately', () => {
    expect(filterDesigns(all, 'needs-work').map((item) => item.id)).toEqual(['p1', 'n1', 's1'])
    expect(filterDesigns(all, 'ready').map((item) => item.id)).toEqual(['r1'])
    expect(filterDesigns(all, 'excluded').map((item) => item.id)).toEqual(['x1'])
  })

  it('labels every filter', () => {
    expect(designFilterLabel('needs-work')).toBe('Needs work')
    expect(designFilterLabel('excluded')).toBe('Excluded')
  })
})

describe('searchDesigns', () => {
  it('matches names case-insensitively', () => {
    expect(searchDesigns(all, 'word').map((item) => item.id)).toEqual(['p1'])
  })

  it('returns everything for a blank query', () => {
    expect(searchDesigns(all, '  ')).toHaveLength(5)
  })
})

describe('groupDesigns', () => {
  it('puts needs-work first and excluded last', () => {
    const groups = groupDesigns(all)
    expect(groups.map((group) => group.id)).toEqual(['blocking', 'ready', 'excluded'])
  })

  it('drops empty groups rather than rendering empty headings', () => {
    const groups = groupDesigns([ready])
    expect(groups.map((group) => group.id)).toEqual(['ready'])
  })

  it('returns no groups for an empty list', () => {
    expect(groupDesigns([])).toEqual([])
  })

  it('keeps every design exactly once across groups', () => {
    const ids = groupDesigns(all).flatMap((group) => group.designs.map((item) => item.id))
    expect(new Set(ids).size).toBe(all.length)
  })
})

describe('prepareDesignGrid', () => {
  it('applies search before grouping', () => {
    // "logo" matches only the excluded design, so the result has one group.
    const result = prepareDesignGrid(all, { filter: 'all', query: 'logo' })
    expect(result.groups.map((group) => group.id)).toEqual(['excluded'])
    expect(result.shown).toBe(1)
    expect(result.narrowed).toBe(true)
  })

  it('can span several groups at once', () => {
    // "o" appears in Ready one, Wordmark, Photo and Old logo.
    const result = prepareDesignGrid(all, { filter: 'all', query: 'o' })
    expect(result.groups.map((group) => group.id)).toEqual(['blocking', 'ready', 'excluded'])
    expect(result.shown).toBe(4)
  })

  it('reports nothing shown when the search matches nothing', () => {
    const result = prepareDesignGrid(all, { filter: 'all', query: 'zzz' })
    expect(result.groups).toEqual([])
    expect(result.shown).toBe(0)
  })

  it('is not narrowed when nothing is filtered out', () => {
    const result = prepareDesignGrid(all, { filter: 'all', query: '' })
    expect(result.narrowed).toBe(false)
    expect(result.total).toBe(5)
  })

  it('combines a status filter with a search', () => {
    const result = prepareDesignGrid(all, { filter: 'needs-work', query: 'badge' })
    expect(result.groups.flatMap((group) => group.designs.map((item) => item.id))).toEqual(['n1'])
  })
})
