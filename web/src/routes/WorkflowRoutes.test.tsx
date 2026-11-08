import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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

function batchNamed(mock: MockStore, name: string) {
  const batch = [...mock.batches.values()].find((item) => item.name === name)
  if (!batch) throw new Error(`Seed batch "${name}" was not created`)
  return batch
}

beforeEach(() => {
  startTestMockApi()
})

afterAll(() => {
  stopTestMockApi()
})

describe('core workbench routes', () => {
  it('prioritizes an explicit Real-ESRGAN enhancement proposal', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Image enhancement',
      designs: [{
        assetKey: 'thin-signature',
        name: 'Signature enhancement sample',
        chain: [],
      }],
    }])
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    expect(screen.queryByText('Clean or vectorize')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Propose background cleanup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Propose vector version' })).not.toBeInTheDocument()
    expect(screen.getByText(/ask for a better original|enlargement adds pixels/i)).toBeInTheDocument()
    expect(await screen.findByText(/Source: about .* DPI at target size/i)).toBeInTheDocument()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Model' }),
      'realesrgan-x4plus-anime',
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Scale' }), '2')
    await user.click(screen.getByRole('button', { name: 'Enhance image' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find((item) => item.designId === design.id && item.type === 'upscale')
      expect(job?.parameters).toMatchObject({
        model: 'realesrgan-x4plus-anime',
        scale: 2,
        gpu: true,
      })
    })
  })

  it('shows indeterminate progress, elapsed time, and GPU queue guidance', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Visible job progress',
      designs: [{
        assetKey: 'thin-signature',
        name: 'Slow enhancement sample',
        chain: [],
      }],
    }])
    mock.jobDelayMs = 10_000
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    const route = `/batches/${batch.id}/designs/${design.id}`
    const page = renderAt(route)
    await screen.findByTestId('current-design-preview')
    await user.click(screen.getByRole('button', { name: 'Enhance image' }))

    expect(await screen.findByRole('progressbar', { name: 'Image processing progress' })).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('Progress percentage is not reported'),
    )
    expect(await screen.findByText(/Waiting for a GPU worker/)).toBeInTheDocument()

    const job = [...mock.jobs.values()].find((item) => item.designId === design.id && item.type === 'upscale')
    expect(job).toBeDefined()
    if (!job) throw new Error('Enhancement job was not created')
    job.status = 'running'
    job.startedAt = new Date(Date.now() - 3_000).toISOString()
    await waitFor(() => expect(screen.getByText(/Processing · 0:\d+ elapsed/)).toBeInTheDocument())
    expect(screen.getByText(/Small-image GTX tests took about 5–16 seconds/)).toBeInTheDocument()

    page.unmount()
    renderAt(route)
    expect(await screen.findByText(/Processing · 0:\d+ elapsed/)).toBeInTheDocument()

    mock.dispose()
  })

  it('creates a batch from the batch list', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    renderAt('/')

    expect(await screen.findByRole('heading', { name: 'ACME summer drop 01' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New batch' }))
    await user.type(screen.getByRole('textbox', { name: 'Batch name' }), 'New shop order')
    await user.click(screen.getByRole('button', { name: 'Create batch' }))

    await waitFor(() => expect([...mock.batches.values()].some((batch) => batch.name === 'New shop order')).toBe(true))
    expect(await screen.findByRole('heading', { name: 'New shop order' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Add customer artwork' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Import ready-to-pack PNGs' })).toBeInTheDocument()
  })

  it('loads a batch and applies include/exclude changes through the API', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    renderAt(`/batches/${batch.id}`)

    expect(await screen.findByRole('heading', { name: batch.name })).toBeInTheDocument()
    const card = await screen.findByTestId(`design-card-${designId}`)
    expect(card).toHaveAttribute('data-status', 'in-progress')
    await user.click(screen.getByTestId(`toggle-${designId}`))

    await waitFor(() => expect(screen.getByTestId(`design-card-${designId}`)).toHaveAttribute('data-status', 'excluded'))
    expect(mock.designs.get(designId)?.status).toBe('excluded')
  })

  it('shows the pending version and makes approval the only way it becomes current', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)
    if (!design?.pendingVersionId) throw new Error('Expected the seed design to have a proposal')
    const proposalId = design.pendingVersionId

    renderAt(`/batches/${batch.id}/designs/${designId}`)
    expect(await screen.findByTestId('current-design-preview')).toBeInTheDocument()
    expect(screen.getByTestId('proposed-design-preview')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Preview background' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve proposal' }))

    await waitFor(() => expect(mock.designs.get(designId)?.currentVersionId).toBe(proposalId))
    expect(mock.designs.get(designId)?.pendingVersionId).toBeNull()
  })

  it('offers full-resolution Photoshop downloads for current and proposed artwork', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    renderAt(`/batches/${batch.id}/designs/${designId}`)

    const currentLink = await screen.findByRole('link', { name: 'Download for Photoshop' })
    expect(currentLink).toHaveAttribute('download')
    expect(currentLink.getAttribute('href')).toContain('/versions/')
    expect(currentLink.getAttribute('href')).toContain('/file')

    const proposalLink = screen.getByRole('link', { name: 'Download proposal for Photoshop' })
    expect(proposalLink).toHaveAttribute('download')
    expect(proposalLink.getAttribute('href')).toContain('/file')
  })

  it('loads a packed sheet and exposes its integrity and export gates', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'Northgate cafe merch')
    renderAt(`/batches/${batch.id}/sheet`)

    expect(await screen.findByRole('heading', { name: 'Packing sheet' })).toBeInTheDocument()
    expect(await screen.findByAltText(/Packing sheet preview/)).toBeInTheDocument()
    expect(screen.getByText('pixel-equality')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run blocking integrity check' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Export flat PNG' })).toBeEnabled()
  })
})
