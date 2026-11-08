import type { ReactNode } from 'react'
import { ErrorBanner } from './Banner'

export function Loading({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="stack" role="status" aria-live="polite" data-testid="loading">
      <p className="muted">{label}</p>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton" key={index} style={{ height: index === 0 ? 52 : 30 }} />
      ))}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
  title = 'The API refused the request',
}: {
  error: unknown
  onRetry?: () => void
  title?: string
}) {
  return (
    <div className="stack">
      <ErrorBanner error={error} title={title} />
      {onRetry ? (
        <div className="row">
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
      {actions ? <div className="row" style={{ justifyContent: 'center' }}>{actions}</div> : null}
    </div>
  )
}

export function ProgressBar({
  percent,
  label,
}: {
  percent: number
  label?: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <div className="stack-sm">
      {label ? (
        <span className="mono muted" data-testid="progress-label">
          {label}
        </span>
      ) : null}
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={Number.isFinite(clamped) ? clamped : 0}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span data-testid="progress-bar" style={{ width: `${Number.isFinite(clamped) ? clamped : 0}%` }} />
      </div>
    </div>
  )
}
