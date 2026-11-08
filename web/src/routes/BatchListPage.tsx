import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../api/client'
import { BatchCard } from '../components/batch/BatchCard'
import { CreateBatchDialog } from '../components/batch/CreateBatchDialog'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'

export default function BatchListPage() {
  const [creating, setCreating] = useState(false)
  const [createdBatchId, setCreatedBatchId] = useState<string | null>(null)
  const { state, reload } = useAsync(
    (signal) => api.batches.list({ limit: 100 }, { signal }),
    [],
  )

  const batchList = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
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
      {batchList ? (
        <>
          <p className="mono muted" aria-live="polite">
            {batchList.total} {batchList.total === 1 ? 'batch' : 'batches'}
            {state.kind === 'reloading' ? ' · refreshing…' : ''}
          </p>
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
            <div className="grid-cards">
              {batchList.items.map((batch) => (
                <BatchCard key={batch.id} batch={batch} />
              ))}
            </div>
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
