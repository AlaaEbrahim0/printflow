import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../api/client'
import { BatchCard } from '../components/batch/BatchCard'
import { CreateBatchDialog } from '../components/batch/CreateBatchDialog'
import {
  batchFilterLabel,
  needsAction,
  prepareBatchList,
  type BatchFilter,
} from '../components/batch/batchList'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'

const FILTERS: BatchFilter[] = ['needs-action', 'all', 'packed', 'exported']

export default function BatchListPage() {
  const [creating, setCreating] = useState(false)
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null)
  const [filter, setFilter] = useState<BatchFilter | null>(null)
  const [query, setQuery] = useState('')
  const { state, reload } = useAsync(
    (signal) => api.batches.list({ limit: 100 }, { signal }),
    [],
  )

  const batchList = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  // Default to the work queue, but only when there is one. A shop whose batches
  // are all packed or exported should not land on an empty screen every visit.
  const activeFilter: BatchFilter =
    filter ??
    (batchList && batchList.items.some(needsAction) ? 'needs-action' : 'all')
  const prepared = useMemo(
    () => (batchList ? prepareBatchList(batchList.items, { filter: activeFilter, query }) : null),
    [batchList, activeFilter, query],
  )
  const counts = useMemo(() => {
    if (!batchList) return null
    return {
      'needs-action': batchList.items.filter(needsAction).length,
      all: batchList.items.length,
      packed: batchList.items.filter((batch) => batch.status === 'packed').length,
      exported: batchList.items.filter((batch) => batch.status === 'exported').length,
    } satisfies Record<BatchFilter, number>
  }, [batchList])

  if (createdBatchId) return <Navigate to={`/batches/${createdBatchId}`} replace />

  return (
    <section>
      <header className="page-head">
        <div>
          <h1 className="page-title">Batches</h1>
          <p className="page-subtitle">
            Intake customer artwork, review each proposed change, then pack approved designs.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn" onClick={reload}>
            Refresh
          </button>
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            New batch
          </button>
        </div>
      </header>

      {state.kind === 'loading' ? <Loading label="Loading batches…" /> : null}
      {state.kind === 'error' ? (
        <ErrorState error={state.error} onRetry={reload} title="Could not load batches" />
      ) : null}
      {batchList && prepared ? (
        <>
          {batchList.items.length === 0 ? (
            <EmptyState
              title="No batches yet"
              actions={
                <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                  Create the first batch
                </button>
              }
            >
              Start with a batch for one customer order. Roll geometry and working DPI are
              snapshotted when it is created.
            </EmptyState>
          ) : (
            <>
              <div className="batch-toolbar">
                <div className="batch-filters" role="group" aria-label="Filter batches">
                  {FILTERS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`batch-filter${activeFilter === option ? ' is-active' : ''}`}
                      aria-pressed={activeFilter === option}
                      onClick={() => setFilter(option)}
                    >
                      {batchFilterLabel(option)}
                      <span className="batch-filter-count">{counts?.[option] ?? 0}</span>
                    </button>
                  ))}
                </div>
                <input
                  className="batch-search"
                  type="search"
                  placeholder="Search by batch name"
                  aria-label="Search batches by name"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>

              <p className="mono muted" aria-live="polite">
                {prepared.narrowed
                  ? `Showing ${prepared.items.length} of ${prepared.total} batches`
                  : `${prepared.total} ${prepared.total === 1 ? 'batch' : 'batches'}`}
                {state.kind === 'reloading' ? ' · refreshing…' : ''}
              </p>

              {prepared.items.length === 0 ? (
                <EmptyState
                  title={query.trim() === '' ? 'Nothing in this view' : 'No batch matches that name'}
                  actions={
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setFilter('all')
                        setQuery('')
                      }}
                    >
                      Show all batches
                    </button>
                  }
                >
                  {query.trim() === ''
                    ? 'No batch is waiting on you. Switch to All batches to see packed and exported work.'
                    : `Nothing matches “${query.trim()}”. Clear the search to see every batch.`}
                </EmptyState>
              ) : (
                <div className="grid-cards">
                  {prepared.items.map((batch) => (
                    <BatchCard key={batch.id} batch={batch} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      ) : null}

      {creating ? (
        <CreateBatchDialog
          onClose={() => setCreating(false)}
          onCreated={(batch) => {
            setCreating(false)
            setCreatedBatchId(batch.id)
          }}
        />
      ) : null}
    </section>
  )
}
