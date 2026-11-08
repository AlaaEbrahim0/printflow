import type { BatchSummary } from '../../api/client'
import { nextStepFor } from './batchNextStep'

/**
 * Ordering and filtering for the batch list.
 *
 * The list endpoint returns newest-first, which is the wrong order for a shop:
 * the batch that needs attention is rarely the newest one. Operators scan for
 * "what is waiting on me", so batches with outstanding work sort above batches
 * that are simply parked or finished, and the newest breaks ties.
 *
 * Kept pure so the ordering rule is testable without rendering the page.
 */
export type BatchFilter = 'needs-action' | 'all' | 'packed' | 'exported'

const FILTER_LABELS: Record<BatchFilter, string> = {
  'needs-action': 'Needs action',
  all: 'All batches',
  packed: 'Packed',
  exported: 'Exported',
}

export function batchFilterLabel(filter: BatchFilter): string {
  return FILTER_LABELS[filter]
}

/** Batches where somebody has to do something before the sheet can be printed. */
export function needsAction(batch: BatchSummary): boolean {
  return nextStepFor(batch).tone !== 'good'
}

function priority(batch: BatchSummary): number {
  if (needsAction(batch)) return 0
  if (batch.status === 'exported') return 2
  return 1
}

export function sortBatches(batches: BatchSummary[]): BatchSummary[] {
  return [...batches].sort((a, b) => {
    const byPriority = priority(a) - priority(b)
    if (byPriority !== 0) return byPriority
    const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated
    return a.name.localeCompare(b.name)
  })
}

export function filterBatches(batches: BatchSummary[], filter: BatchFilter): BatchSummary[] {
  switch (filter) {
    case 'needs-action':
      return batches.filter(needsAction)
    case 'packed':
      return batches.filter((batch) => batch.status === 'packed')
    case 'exported':
      return batches.filter((batch) => batch.status === 'exported')
    case 'all':
      return batches
  }
}

/** Case-insensitive name search; blank queries match everything. */
export function searchBatches(batches: BatchSummary[], query: string): BatchSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return batches
  return batches.filter((batch) => batch.name.toLowerCase().includes(needle))
}

export interface BatchListResult {
  items: BatchSummary[]
  /** How many batches existed before filtering, for the "showing x of y" line. */
  total: number
  /** True when a filter or search removed something. */
  narrowed: boolean
}

export function prepareBatchList(
  batches: BatchSummary[],
  { filter, query }: { filter: BatchFilter; query: string },
): BatchListResult {
  const searched = searchBatches(sortBatches(batches), query)
  const items = filterBatches(searched, filter)
  return {
    items,
    total: batches.length,
    narrowed: items.length !== batches.length,
  }
}
