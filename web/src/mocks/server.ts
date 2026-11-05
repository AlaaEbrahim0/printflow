import { setupServer } from 'msw/node'
import { handlers } from './handlers'
import { resetStore } from './store'
import type { MockStore, SeedBatch } from './store'

export const server = setupServer(...handlers)

let listening = false

/**
 * Tests run against the same handlers as the browser, with no network: the
 * store is re-seeded and all simulated latency is removed so job completion is
 * synchronous.
 */
export function startTestMockApi(seed?: SeedBatch[]): MockStore {
  const mock = resetStore(seed)
  mock.jobDelayMs = 0
  mock.latencyMs = 0
  if (!listening) {
    server.listen({ onUnhandledFrame: 'error' })
    listening = true
  } else {
    server.resetHandlers()
  }
  return mock
}

export function stopTestMockApi(): void {
  server.close()
}
