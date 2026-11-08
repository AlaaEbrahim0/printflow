import { api } from '../../api/client'
import { useAsync } from '../../hooks/useAsync'
import { CONTRACT_VERSION } from '../../lib/env'

/**
 * The contract version the running API actually speaks.
 *
 * This used to be a hard-coded string in the shell, which silently went stale
 * when the API moved to 2.0.0 — the badge claimed 1.0.0 against a 2.0.0 server.
 * Reading `/api/info` means the badge can only ever be wrong for the moment
 * before the request lands, and a mismatch becomes visible instead of hidden.
 */
export function ContractBadge() {
  const { state } = useAsync((signal) => api.system.info({ signal }), [])

  if (state.kind === 'ready' || state.kind === 'reloading') {
    return (
      <span className="pill" title={`API version ${state.value.version}`}>
        contract {state.value.contractVersion}
      </span>
    )
  }

  return (
    <span className="pill" title="Contract version from this build; the API has not answered yet">
      contract {CONTRACT_VERSION}
    </span>
  )
}
