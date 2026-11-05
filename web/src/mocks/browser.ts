import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'
import { store } from './store'

/**
 * Browser mocks are only started by `npm run dev:mock`
 * (`VITE_USE_MOCKS=true`, see `.env.mock`). Plain `npm run dev` keeps the Vite
 * proxy to the real API.
 */
export async function startMockWorker(): Promise<void> {
  const mock = store()
  mock.latencyMs = 140
  mock.jobDelayMs = 900
  const worker = setupWorker(...handlers)
  await worker.start({ onUnhandledFrame: 'warn', quiet: true })
  console.info('[mock] PrintSheet API mock active — state lives in memory only.')
}
