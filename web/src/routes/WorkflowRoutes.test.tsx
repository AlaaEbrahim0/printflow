import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
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

  it('proposes background removal with BiRefNet AI model', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Cutout batch',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Logo cutout sample',
        chain: [],
      }],
    }])
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    await user.click(screen.getByRole('button', { name: 'Remove background' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'background-removal',
      )
      expect(job?.parameters).toMatchObject({
        mode: 'ai',
        aiModel: 'birefnet-massive',
      })
    })
  })

  it('links print width and height to the artwork aspect ratio at the batch DPI', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Aspect ratio',
      workingDpi: 300,
      designs: [{ assetKey: 'full-bleed-collage', name: 'Linked size', chain: [] }],
    }])
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    expect(screen.getByTestId('print-resolution')).toHaveTextContent('300 DPI')

    await user.click(screen.getByTestId('use-artwork-size'))
    const width = screen.getByLabelText('Width') as HTMLInputElement
    const height = screen.getByLabelText('Height') as HTMLInputElement
    // 1200 × 900 px at 300 DPI is 10.16 × 7.62 cm.
    expect(width.value).toBe('10.16')
    expect(height.value).toBe('7.62')

    await user.clear(width)
    await user.type(width, '20')
    // The 4:3 artwork shape links 20 cm to 15 cm, and the output pixels follow
    // the batch DPI rather than the browser's screen density.
    expect(height.value).toBe('15')
    expect(screen.getByTestId('resize-output-pixels')).toHaveTextContent('2362 px × 1772 px')
  })

  it('keeps an intentionally saved free size instead of silently relinking it', async () => {
    const user = userEvent.setup()
    // 1200 × 900 is 4:3, but this design was deliberately saved at 30 × 22 cm.
    const mock = startTestMockApi([{
      name: 'Saved free size',
      workingDpi: 300,
      designs: [{
        assetKey: 'full-bleed-collage',
        name: 'Deliberate size',
        targetCm: [30, 22],
        chain: [],
      }],
    }])
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    const width = screen.getByLabelText('Width') as HTMLInputElement
    const height = screen.getByLabelText('Height') as HTMLInputElement
    // The saved size arrives with the design payload, one render after mount.
    await waitFor(() => expect(width.value).toBe('30'))
    expect(height.value).toBe('22')

    // Editing a side must not snap the other side back to the artwork ratio.
    await user.clear(width)
    await user.type(width, '24')
    expect(height.value).toBe('22')

    // Relinking is an explicit choice, and then the shape follows the artwork.
    const link = screen.getByRole('checkbox', { name: /Keep width and height at the artwork ratio/ })
    expect(link).not.toBeChecked()
    await user.click(link)
    expect(link).toBeChecked()
    expect(height.value).toBe('18')
  })

  it('freezes the displayed height when the operator unlinks the sides', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Unlink',
      workingDpi: 300,
      designs: [{ assetKey: 'full-bleed-collage', name: 'Free size', chain: [] }],
    }])
    const batch = [...mock.batches.values()][0]!
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    const width = screen.getByLabelText('Width') as HTMLInputElement
    const height = screen.getByLabelText('Height') as HTMLInputElement
    await user.click(screen.getByTestId('use-artwork-size'))
    expect(height.value).toBe('7.62')

    const link = screen.getByRole('checkbox', { name: /Keep width and height at the artwork ratio/ })
    await user.click(link)
    expect(link).not.toBeChecked()
    // Unlinking must not blank or snap the height: the operator keeps the value
    // that was on screen and can now change each side independently.
    expect(height.value).toBe('7.62')

    await user.clear(width)
    await user.type(width, '20')
    expect(height.value).toBe('7.62')
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
    // The poller ticks once a second; give it more than one tick so a loaded
    // CI worker cannot lose the race against waitFor's own default timeout.
    await waitFor(
      () => expect(screen.getByText(/Processing · 0:\d+ elapsed/)).toBeInTheDocument(),
      { timeout: 4_000 },
    )
    expect(screen.getByText(/Small-image GTX tests took about 5–16 seconds/)).toBeInTheDocument()

    page.unmount()
    renderAt(route)
    expect(await screen.findByText(/Processing · 0:\d+ elapsed/, {}, { timeout: 4_000 })).toBeInTheDocument()

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
    // The grid gets a bounded server-rendered thumbnail, not the full PNG.
    const thumbnail = within(card).getByTestId('preview-image')
    expect(thumbnail.getAttribute('src')).toContain('maxPx=640')
    expect(thumbnail).toHaveAttribute('loading', 'lazy')
    expect(thumbnail).toHaveAttribute('decoding', 'async')
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
    expect(await screen.findByTestId('design-comparison')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Preview background' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve proposal' }))

    await waitFor(() => expect(mock.designs.get(designId)?.currentVersionId).toBe(proposalId))
    expect(mock.designs.get(designId)?.pendingVersionId).toBeNull()
  })

  it('offers full-resolution Photoshop download for proposed artwork when a proposal exists', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    renderAt(`/batches/${batch.id}/designs/${designId}`)

    const proposalLink = await screen.findByRole('link', { name: 'Download proposal for Photoshop' })
    expect(proposalLink).toHaveAttribute('download')
    expect(proposalLink.getAttribute('href')).toContain('/versions/')
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
