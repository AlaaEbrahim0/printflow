import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('defaults to the dark theme and remembers an explicit switch', async () => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    renderAt('/')

    const toggle = await screen.findByTestId('theme-toggle')
    // A new operator starts dark, and the button advertises the theme it
    // switches *to* rather than restating the current one.
    expect(toggle).toHaveAttribute('data-theme-current', 'dark')
    expect(toggle).toHaveAccessibleName('Switch to light theme')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('data-theme-current', 'light')
    expect(toggle).toHaveAccessibleName('Switch to dark theme')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(window.localStorage.getItem('printsheet.theme')).toBe('light')

    // The choice survives a reload instead of falling back to the default.
    cleanup()
    renderAt('/')
    expect(await screen.findByTestId('theme-toggle')).toHaveAttribute('data-theme-current', 'light')
    window.localStorage.clear()
  })
})
