import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

    // The two intake paths are mutually exclusive, so exactly one upload form is
    // on screen at a time and the operator chooses which one applies.
    expect(screen.getByRole('heading', { name: 'Add customer artwork' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Import ready-to-pack PNGs' })).not.toBeInTheDocument()

    const readyPath = screen.getByRole('button', { name: /Ready-to-pack PNGs/ })
    expect(readyPath).toHaveAttribute('aria-pressed', 'false')
    await user.click(readyPath)

    expect(await screen.findByRole('heading', { name: 'Import ready-to-pack PNGs' })).toBeInTheDocument()
    expect(readyPath).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('heading', { name: 'Add customer artwork' })).not.toBeInTheDocument()
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
    // Checks are listed in operator language; the schema id stays available as
    // the hover title so a failure can still be quoted to support.
    expect(screen.getByText('Printed pixels match the approved files')).toBeInTheDocument()
    expect(
      screen.getByText('Printed pixels match the approved files').closest('li'),
    ).toHaveAttribute('data-check', 'pixel-equality')
    expect(screen.queryByText('pixel-equality')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run blocking integrity check' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Export flat PNG' })).toBeEnabled()
  })

  it('shows the five-stage workflow spine on the batch and sheet pages', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'Northgate cafe merch')

    renderAt(`/batches/${batch.id}`)
    const batchStepper = await screen.findByRole('navigation', { name: 'Batch progress' })
    expect(batchStepper.querySelectorAll('[data-stage]')).toHaveLength(5)

    cleanup()
    renderAt(`/batches/${batch.id}/sheet`)
    const sheetStepper = await screen.findByRole('navigation', { name: 'Batch progress' })
    expect(sheetStepper.querySelectorAll('[data-stage]')).toHaveLength(5)
    // The sheet page marks packing done and integrity as the live step.
    expect(sheetStepper.querySelector('[data-stage="pack"]')).toHaveClass('is-done')
  })

  it('lets an operator narrow the design grid to the designs that need work', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    renderAt(`/batches/${batch.id}`)

    const needsWork = await screen.findByRole('button', { name: /Needs work/ })
    await user.click(needsWork)
    expect(needsWork).toHaveAttribute('aria-pressed', 'true')

    // Every visible card is a design that is neither ready nor excluded.
    const cards = document.querySelectorAll<HTMLElement>('[data-testid^="design-card-"]')
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      expect(['ready', 'excluded']).not.toContain(card.dataset.status)
    }

    // Searching for a name that cannot exist empties the view and offers a way back.
    await user.type(screen.getByRole('searchbox', { name: 'Search designs by name' }), 'zzzz')
    expect(await screen.findByText('No design matches this view')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show all designs' }))
    expect(document.querySelectorAll('[data-testid^="design-card-"]').length).toBeGreaterThan(0)
  })

  it('defaults the batch list to the batches that need action', async () => {
    startTestMockApi()
    renderAt('/')

    const needsAction = await screen.findByRole('button', { name: /Needs action/ })
    expect(needsAction).toHaveAttribute('aria-pressed', 'true')

    // Switching to All batches reveals packed/exported work too.
    await userEvent.click(screen.getByRole('button', { name: /All batches/ }))
    expect(await screen.findByText(/^\d+ batches$/)).toBeInTheDocument()
  })

  it('opens on All batches when nothing needs action', async () => {
    const mock = startTestMockApi()
    // Finish every design and give each batch a sheet. The seeded empty batch is
    // removed because an intake queue with no artwork legitimately needs action.
    for (const batch of [...mock.batches.values()]) {
      if (batch.designIds.length === 0) {
        mock.batches.delete(batch.id)
        continue
      }
      for (const designId of batch.designIds) {
        const design = mock.designs.get(designId)
        if (design) design.status = 'ready'
      }
      batch.status = 'packed'
      batch.sheet ??= { heightCm: 42 } as NonNullable<typeof batch.sheet>
    }
    renderAt('/')

    const all = await screen.findByRole('button', { name: /All batches/ })
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /Needs action/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
