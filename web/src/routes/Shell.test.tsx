import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../state/SettingsContext'
import { WorkbenchRoutes } from '../App'
import { startTestMockApi, stopTestMockApi } from '../mocks/server'
import type { MockStore } from '../mocks/store'

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <WorkbenchRoutes />
      </SettingsProvider>
    </MemoryRouter>,
  )
}

function firstDesign(mock: MockStore) {
  const batch = [...mock.batches.values()][0]!
  return { batchId: batch.id, designId: batch.designIds[0]! }
}

beforeAll(() => startTestMockApi())
afterEach(() => startTestMockApi())
afterAll(() => stopTestMockApi())

describe('workbench shell', () => {
  it('renders the navigation, the contract badge and the operating rule', () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Batches' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByText('contract 2.0.0')).toBeInTheDocument()
    expect(screen.getByText(/machine proposes, the human approves/)).toBeInTheDocument()
  })

  it('mounts the batch list and settings routes without an unhandled error', async () => {
    renderAt('/')
    expect(await screen.findByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(document.querySelector('.workspace')).not.toBeNull()
  })

  it('mounts the batch detail route at its frozen path shape', async () => {
    const mock = startTestMockApi()
    const batch = [...mock.batches.values()].find((item) => item.designIds.length > 0)!
    renderAt(`/batches/${batch.id}`)
    expect(await screen.findByRole('link', { name: 'Batches' })).toBeInTheDocument()
  })

  it('mounts the design review route at its frozen path shape', async () => {
    const mock = startTestMockApi()
    const { batchId, designId } = firstDesign(mock)
    renderAt(`/batches/${batchId}/designs/${designId}`)
    expect(await screen.findByRole('link', { name: 'Batches' })).toBeInTheDocument()
  })

  it('mounts the sheet route at its frozen path shape', async () => {
    const mock = startTestMockApi()
    const batch = [...mock.batches.values()].find((item) => item.designIds.length > 0)!
    renderAt(`/batches/${batch.id}/sheet`)
    expect(await screen.findByRole('link', { name: 'Batches' })).toBeInTheDocument()
  })

  it('shows a real not-found screen instead of a blank page', () => {
    renderAt('/nowhere')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })
})
