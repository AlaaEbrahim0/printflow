import { api } from '../../api/client'
import { useAsync } from '../../hooks/useAsync'
import { IS_MOCK } from '../../lib/env'

export function HealthDot() {
  const { state } = useAsync((signal) => api.system.health({ signal }), [])

  if (state.kind === 'loading') {
    return (
      <span className="pill" title="Checking the API health endpoint">
        <span className="dot loading" /> checking
      </span>
    )
  }
  if (state.kind === 'error') {
    return (
      <span className="pill" title="The API health endpoint is unreachable">
        <span className="dot bad" /> api unreachable
      </span>
    )
  }
  const healthy = state.value.status.toLowerCase() === 'healthy'
  return (
    <span
      className="pill"
      title={state.value.checks?.map((check) => `${check.name}: ${check.status}`).join(' · ') ?? ''}
    >
      <span className={`dot ${healthy ? 'ok' : 'warn'}`} />
      {IS_MOCK ? 'mock api' : healthy ? 'api healthy' : 'api degraded'}
    </span>
  )
}
