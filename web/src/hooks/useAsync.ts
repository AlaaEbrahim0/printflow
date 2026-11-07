import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { api } from '../api/client'
import type { Job } from '../api/client'

export type AsyncState<T> =
  | { kind: 'loading' }
  | { kind: 'reloading'; value: T }
  | { kind: 'ready'; value: T }
  | { kind: 'error'; error: unknown }

export interface UseAsyncResult<T> {
  state: AsyncState<T>
  reload: () => void
}

/**
 * Fetch on mount, abort on unmount, re-run when `deps` change. `reload()` is how
 * screens pick up server-truth after a mutation — the UI never caches derived
 * state like `batch.status`.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
): UseAsyncResult<T> {
  const [state, setState] = useState<AsyncState<T>>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)
  const loaderRef = useRef(loader)

  useEffect(() => {
    loaderRef.current = loader
  })

  useEffect(() => {
    const controller = new AbortController()
    setState((previous) => (previous.kind === 'ready' ? { kind: 'reloading', value: previous.value } : previous))
    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setState({ kind: 'ready', value })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: 'error', error })
      })
    return () => controller.abort()
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  return { state, reload }
}

const TERMINAL: Job['status'][] = ['succeeded', 'failed', 'cancelled']

export interface JobPollerResult {
  job: Job | null
  error: unknown
  settled: boolean
}

/** Polls a job until it reaches a terminal state, then stops. */
export function useJobPoller(jobId: string | null, intervalMs = 400): JobPollerResult {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    setJob(null)
    setError(null)
    if (!jobId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const tick = async () => {
      try {
        const next = await api.jobs.get(jobId)
        if (cancelled) return
        setJob(next)
        setError(null)
        if (!TERMINAL.includes(next.status)) timer = setTimeout(tick, intervalMs)
      } catch (caught) {
        if (!cancelled) setError(caught)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId, intervalMs])

  return { job, error, settled: job !== null && TERMINAL.includes(job.status) }
}
