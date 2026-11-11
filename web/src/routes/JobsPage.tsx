import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type BatchSummary, type Job, type JobStatus, type JobType } from '../api/client'
import { ApiError } from '../api/problem'
import { ErrorBanner } from '../components/ui/Banner'
import { StatusChip } from '../components/ui/Chip'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { useAsync } from '../hooks/useAsync'
import { formatDateTime, formatNumber } from '../lib/format'

type JobStatusFilter = JobStatus | 'all'
type JobTypeFilter = JobType | 'all'

const STATUS_OPTIONS: { value: JobStatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const TYPE_OPTIONS: { value: JobTypeFilter; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'classify', label: 'Classify' },
  { value: 'trim', label: 'Trim' },
  { value: 'upscale', label: 'Upscale' },
  { value: 'resize', label: 'Resize' },
  { value: 'pack-sheet', label: 'Pack sheet' },
  { value: 'integrity-check', label: 'Integrity check' },
  { value: 'export', label: 'Export' },
  { value: 'background-removal', label: 'Background removal' },
  { value: 'vectorize', label: 'Vectorize (retired)' },
]

/** Human-readable label for a job type, mirroring the review screen's own
 *  vocabulary. Retired types stay readable instead of vanishing. */
const JOB_LABELS: Record<string, string> = {
  classify: 'Artwork analysis',
  trim: 'Trim / crop',
  'background-removal': 'Background removal',
  upscale: 'Upscale',
  vectorize: 'Vectorize',
  resize: 'Resize to print size',
  'pack-sheet': 'Pack sheet',
  'integrity-check': 'Integrity check',
  export: 'Export',
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function elapsedFrom(job: Job): string | null {
  const startedAt = job.startedAt ?? job.createdAt
  if (!startedAt) return null
  const ms = Date.now() - Date.parse(startedAt)
  return formatElapsed(ms)
}

function isTerminal(status: JobStatus): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(status)
}

function isCancellable(status: JobStatus): boolean {
  return status === 'queued' || status === 'running'
}

interface JobsView {
  jobs: { items: Job[]; total: number }
  batches: BatchSummary[]
}

export default function JobsPage() {
  const { batchId } = useParams()
  const scoped = Boolean(batchId)
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>('all')
  const [actionError, setActionError] = useState<unknown>(null)

  const { state, reload } = useAsync<JobsView>(
    async (signal) => {
      const query = {
        status: statusFilter === 'all' ? undefined : statusFilter,
        type: typeFilter === 'all' ? undefined : typeFilter,
        limit: scoped ? 100 : 200,
      }

      if (batchId) {
        const [jobs, batch] = await Promise.all([
          api.batches.jobs(batchId, query, { signal }),
          api.batches.get(batchId, { signal }),
        ])
        return { jobs, batches: [batch] }
      }

      // The global screen lists jobs across every batch and resolves batch
      // names from the batch list in the same pass.
      const [jobs, batches] = await Promise.all([
        api.jobs.list(query, { signal }),
        api.batches.list({ limit: 100 }, { signal }),
      ])
      return { jobs, batches: batches.items }
    },
    [batchId, scoped, statusFilter, typeFilter],
  )

  // A jobs screen must pick up work queued on another screen (or by a worker)
  // without a manual refresh. Keep polling while the page is mounted.
  useEffect(() => {
    const timer = window.setInterval(() => reload(), 2000)
    return () => window.clearInterval(timer)
  }, [reload])

  const batchNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const batch of state.kind === 'ready' || state.kind === 'reloading' ? state.value.batches : []) {
      names.set(batch.id, batch.name)
    }
    return names
  }, [state])

  const jobs = state.kind === 'ready' || state.kind === 'reloading' ? state.value.jobs.items : []
  const total = state.kind === 'ready' || state.kind === 'reloading' ? state.value.jobs.total : 0
  const scopedBatchName =
    state.kind === 'ready' || state.kind === 'reloading'
      ? state.value.batches[0]?.name
      : undefined

  // Live work always sits at the top: the reason to open this page is usually
  // "what is running right now", not the newest completed row.
  const sortedJobs = [...jobs].sort((left, right) => {
    const leftLive = !isTerminal(left.status)
    const rightLive = !isTerminal(right.status)
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    return Date.parse(right.createdAt) - Date.parse(left.createdAt)
  })
  const liveJobs = sortedJobs.filter((job) => !isTerminal(job.status))
  const hasLive = liveJobs.length > 0

  async function cancelJob(jobId: string) {
    setActionError(null)
    try {
      await api.jobs.cancel(jobId)
      reload()
    } catch (error: unknown) {
      setActionError(error)
      // A 409 means the job settled between the poll and the click; refreshing
      // shows the server's final state instead of an impossible action.
      if (error instanceof ApiError && error.status === 409) {
        reload()
      }
    }
  }

  const heading = scoped ? 'Jobs for this batch' : 'Jobs'
  const subtitle = scoped
    ? 'Monitor and control every job for this batch. Live jobs are listed first and refresh automatically.'
    : 'Every job across all batches. Live jobs are listed first and refresh automatically.'

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <p className="breadcrumb">
            <Link to="/">Batches</Link>
            {scoped ? (
              <>
                {' / '}
                <Link to={`/batches/${batchId}`}>{scopedBatchName ?? batchId?.slice(0, 8)}</Link>
                {' / Jobs'}
              </>
            ) : (
              <> / Jobs</>
            )}
          </p>
          <h1 className="page-title">{heading}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div className="row">
          {scoped ? (
            <Link className="btn" to="/jobs">
              All jobs
            </Link>
          ) : null}
          <button type="button" className="btn" onClick={reload}>
            Refresh
          </button>
        </div>
      </header>

      {actionError ? (
        <ErrorBanner error={actionError} title="Could not cancel job" />
      ) : null}

      <div className="card">
        <div className="card-heading">
          <h2 className="card-title">Filters</h2>
          {hasLive ? (
            <span className="mono muted" data-testid="live-job-count">
              {liveJobs.length} live
            </span>
          ) : (
            <span className="mono muted" data-testid="live-job-count">
              no live jobs
            </span>
          )}
        </div>
        <div className="split" style={{ padding: '0 14px 14px' }}>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as JobStatusFilter)}
            className="field"
            style={{ flex: 1 }}
            aria-label="Filter jobs by status"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as JobTypeFilter)}
            className="field"
            style={{ flex: 1, marginLeft: 12 }}
            aria-label="Filter jobs by type"
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.kind === 'loading' ? (
        <Loading label="Loading jobs…" />
      ) : state.kind === 'error' ? (
        <ErrorState error={state.error} onRetry={reload} title="Could not load jobs" />
      ) : total === 0 ? (
        <EmptyState
          title="No jobs yet"
          actions={
            <Link to={scoped ? `/batches/${batchId}/designs` : '/'} className="btn">
              {scoped ? 'Review artwork' : 'Go to batches'}
            </Link>
          }
        >
          <p>Queued jobs appear here as they are submitted.</p>
        </EmptyState>
      ) : (
        <div className="batch-card">
          <div className="card-heading">
            <h2 className="card-title">
              {hasLive ? `${liveJobs.length} live, ${total} total` : `${total} job${total === 1 ? '' : 's'} recorded`}
            </h2>
            <span className="mono muted">refreshes every 2s</span>
          </div>

          <div className="table-wrap">
            <table className="jobs-table">
              <thead>
                <tr>
                  {scoped ? null : <th>Batch</th>}
                  <th>Type</th>
                  <th>Design</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Elapsed</th>
                  <th>Last activity</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sortedJobs.map((job) => (
                  <tr key={job.id}>
                    {scoped ? null : (
                      <td>
                        <Link to={`/batches/${job.batchId}`} className="link">
                          {batchNames.get(job.batchId) ?? job.batchId.slice(0, 8)}
                        </Link>
                      </td>
                    )}
                    <td className="mono">{JOB_LABELS[job.type] ?? job.type}</td>
                    <td className="mono muted">
                      {job.designId ? (
                        <>
                          <Link
                            to={`/batches/${job.batchId}/designs/${job.designId}`}
                            className="link"
                          >
                            {job.designId.slice(0, 8)}
                          </Link>
                          <span className="muted">{job.designId.slice(8)}</span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <StatusChip status={job.status} />
                    </td>
                    <td>{formatNumber(job.attempts, 0)}</td>
                    <td className="mono">{elapsedFrom(job) ?? '—'}</td>
                    <td className="mono muted">
                      {formatDateTime(job.createdAt)}
                      {job.startedAt ? ` · ${formatDateTime(job.startedAt)}` : ''}
                      {job.completedAt ? ` · ${formatDateTime(job.completedAt)}` : ''}
                    </td>
                    <td className="row-end">
                      {isCancellable(job.status) ? (
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={() => void cancelJob(job.id)}
                          disabled={job.status === 'running'}
                        >
                          {job.status === 'running' ? 'Cancelling…' : 'Cancel'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasLive ? (
            <p className="hint">
              A job is running when an engine is actively processing it. The
              indicator shows activity, not a reported percentage.
            </p>
          ) : null}

          {sortedJobs.some((job) => job.error) ? (
            <div className="artifact-list">
              {sortedJobs.map((job) => job.error ? (
                <div key={job.id} className="artifact-link">
                  <strong>{JOB_LABELS[job.type] ?? job.type}</strong>
                  <span className="mono muted">{job.error.message}</span>
                </div>
              ) : null)}
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
