import type { ReactNode } from 'react'
import { ApiError } from '../../api/problem'
import { toDisplayMessage } from '../../api/problem'

export interface BannerProps {
  kind?: 'error' | 'warn' | 'info' | 'good'
  strong?: boolean
  title?: ReactNode
  code?: string | null
  children?: ReactNode
}

export function Banner({ kind = 'info', strong, title, code, children }: BannerProps) {
  return (
    <div
      className={`banner ${kind}${strong ? ' strong' : ''}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span aria-hidden="true">{kind === 'error' ? '!' : kind === 'warn' ? '▲' : 'ℹ'}</span>
      <div>
        {title ? <strong className="banner-title">{title}</strong> : null}
        {children ? <div>{children}</div> : null}
        {code ? (
          <span className="banner-code" data-testid="problem-code">
            code: {code}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** Turns any thrown value into the copy a print-shop operator can act on. */
export function ErrorBanner({
  error,
  title,
  strong,
}: {
  error: unknown
  title?: string
  strong?: boolean
}) {
  const apiError = error instanceof ApiError ? error : null
  const fieldErrors = apiError ? Object.entries(apiError.fieldErrors) : []
  return (
    <Banner kind="error" strong={strong ?? apiError?.status === 422} title={title} code={apiError?.code ?? null}>
      <span data-testid="error-message">{toDisplayMessage(error)}</span>
      {fieldErrors.length > 0 && (
        <ul className="list-plain">
          {fieldErrors.map(([field, messages]) => (
            <li key={field}>
              <span className="mono">{field}</span>: {messages.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  )
}
