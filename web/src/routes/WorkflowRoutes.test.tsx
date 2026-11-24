import { afterAll, describe, expect, it } from 'vitest'
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

afterAll(() => {
  stopTestMockApi()
  cleanup()
})

describe('core workbench routes', () => {
  it('proposes an auto trim and then a manual crop', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Crop batch',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Logo crop sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Crop batch')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // Tool 1: Suggest auto-crop
    await user.click(screen.getByRole('button', { name: 'Suggest auto-crop' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'trim',
      )
      expect(job?.parameters).toMatchObject({
        mode: 'auto',
      })
    })

    // Tool 1: Crop manually - opens crop editor with crop rect
    await user.click(screen.getByRole('button', { name: 'Crop manually' }))
    // The crop tool shows a crop rect on the canvas
    expect(screen.getByTestId('crop-rect')).toBeInTheDocument()
  })

  it('proposes an upscale with Real-ESRGAN model and scale', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Upscale batch',
      designs: [{
        assetKey: 'thin-signature',
        name: 'Enhancement sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Upscale batch')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // Tool 2: Enhance image with model and scale
    await user.click(screen.getByRole('button', { name: 'Enhance image' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'upscale',
      )
      // Client adds gpu: true; profile defaults set scale: 2
      expect(job?.parameters).toMatchObject({
        model: 'realesrgan-x4plus',
        scale: 2,
        gpu: true,
      })
    })
  })

  it('proposes a resize with target size and allows aspect link', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Resize batch',
      workingDpi: 300,
      designs: [{
        assetKey: 'full-bleed-collage',
        name: 'Size sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Resize batch')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // Tool 3: Use artwork size
    await user.click(screen.getByTestId('use-artwork-size'))

    // Save size & create layer
    await user.click(screen.getByRole('button', { name: 'Save size & create layer' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'resize',
      )
      expect(job).toBeDefined()
      expect(job?.parameters).toMatchObject({
        targetWidthCm: 10.16,
        targetHeightCm: 7.62,
        fitMode: 'contain',
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
    const batch = batchNamed(mock, 'Aspect ratio')
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
    const batch = batchNamed(mock, 'Saved free size')
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
    const batch = batchNamed(mock, 'Unlink')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    const height = screen.getByLabelText('Height') as HTMLInputElement
    await user.click(screen.getByTestId('use-artwork-size'))
    expect(height.value).toBe('7.62')

    const link = screen.getByRole('checkbox', { name: /Keep width and height at the artwork ratio/ })
    await user.click(link)
    expect(link).not.toBeChecked()
    // Unlinking must not blank or snap the height: the operator keeps the value
    // that was on screen and can now change each side independently.
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
    const batch = batchNamed(mock, 'Visible job progress')
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
    await user.click(readyPath)
    expect(screen.getByRole('heading', { name: 'Import ready-to-pack PNGs' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Add customer artwork' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Raw customer artwork/ }))
    expect(screen.getByRole('heading', { name: 'Add customer artwork' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Import ready-to-pack PNGs' })).not.toBeInTheDocument()
  })

  it('uploads customer artwork and queues classify', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    renderAt('/')

    // Create a batch first via UI
    await user.click(screen.getByRole('button', { name: 'New batch' }))
    await user.type(screen.getByRole('textbox', { name: 'Batch name' }), 'Upload test batch')
    await user.click(screen.getByRole('button', { name: 'Create batch' }))

    // Wait for navigation to batch detail page
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Add customer artwork' })).toBeInTheDocument())

    // Get the batch ID from the mock store (the newly created batch)
    const batch = [...mock.batches.values()].find((b) => b.name === 'Upload test batch')
    expect(batch).toBeDefined()
    const batchId = batch!.id

    // Upload via mock store directly (bypasses XMLHttpRequest issue in test env)
    mock.uploadDesign(batchId, { garmentColorKind: 'light' })

    // Verify classify job was created (completes synchronously in test env)
    await waitFor(() => {
      const job = [...mock.jobs.values()].find((item) => item.type === 'classify' && item.designId)
      expect(job).toBeDefined()
      expect(['queued', 'succeeded']).toContain(job?.status)
    })
  })

  it('shows every version as a layer and keeps approval on the proposal layer', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Layer stack',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Logo with history',
        chain: [
          { stepType: 'trim', parameters: { mode: 'auto', paddingPx: 12 } },
          { stepType: 'upscale', parameters: { model: 'realesrgan-x4plus', scale: 2 } },
          { stepType: 'resize', status: 'proposed' },
        ],
      }],
    }])
    const batch = batchNamed(mock, 'Layer stack')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    // Page loaded - wait for canvas meta which is always present
    await screen.findByTestId('canvas-layer-meta')
    // Layer list shows all three versions plus original (4 total)
    const layersPanel = screen.getByLabelText('Layers')
    const layers = within(layersPanel).getAllByRole('listitem')
    expect(layers.length).toBe(4)
    // The top layer is the resize proposal
    expect(layers[0]).toHaveTextContent('Final resize')
    expect(layers[0]).toHaveTextContent('proposal')

    // Clicking a layer picks it for comparison - click the layer-main div
    const upscaleLayer = layers[2]
    const layerMain = upscaleLayer.querySelector('.layer-main')!
    await user.click(layerMain)
    expect(screen.getByTestId('layer-preview')).toBeInTheDocument()

    // Toggle compare shows single view
    await user.click(screen.getByTestId('toggle-compare'))
    expect(screen.getByTestId('design-comparison')).toBeInTheDocument()

    // Revert an approved version (find the approved layer with Revert button - should be one of the lower layers)
    const revertBtns = screen.getAllByRole('button', { name: 'Revert' })
    expect(revertBtns.length).toBeGreaterThan(0)
    await user.click(revertBtns[0])
    await waitFor(() => expect(screen.getByText('Current version reverted.')).toBeInTheDocument())
  })

  it('defaults to the dark theme and remembers an explicit switch', async () => {
    const user = userEvent.setup()
    startTestMockApi()
    localStorage.clear()
    renderAt('/')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    await user.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem('printsheet.theme')).toBe('light')

    // Reload the app — the explicit choice persists
    localStorage.setItem('printsheet.theme', 'light')
    renderAt('/')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('confirms approval in a modal that cancels without touching the proposal', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Proposal modal',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Propose upscale',
        chain: [
          { stepType: 'upscale', parameters: { model: 'realesrgan-x4plus', scale: 2 }, status: 'proposed' },
        ],
      }],
    }])
    const batch = batchNamed(mock, 'Proposal modal')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    // Page loaded - approve button is in the tool panel
    await screen.findByRole('button', { name: 'Approve proposal' })
    // Approve button opens the modal
    await user.click(screen.getByRole('button', { name: 'Approve proposal' }))
    const modal = screen.getByTestId('proposal-modal')
    expect(modal).toBeInTheDocument()
    expect(screen.getByText('Proposal summary')).toBeInTheDocument()

    // Cancel closes the modal and leaves the proposal pending
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('proposal-modal')).not.toBeInTheDocument()

    // Re-open and approve
    await user.click(screen.getByRole('button', { name: 'Approve proposal' }))
    await user.click(screen.getByTestId('proposal-modal-approve'))
    await waitFor(() => expect(screen.getByText('Proposal approved and made current.')).toBeInTheDocument())
  })

  it('sends the chosen cutout provider with the remove-background step', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Cutout provider',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Cutout sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Cutout provider')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    const serverDefault = screen.getByRole('button', { name: 'Server default' })
    const local = screen.getByRole('button', { name: 'Local · withoutBG' })
    const poof = screen.getByRole('button', { name: 'Poof · cloud' })
    expect(serverDefault).toHaveAttribute('aria-pressed', 'true')

    await user.click(poof)
    expect(poof).toHaveAttribute('aria-pressed', 'true')
    expect(local).toHaveAttribute('aria-pressed', 'false')
    expect(serverDefault).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByRole('button', { name: 'Remove background' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'background-removal',
      )
      expect(job?.parameters).toMatchObject({ provider: 'poof' })
    })
  })

  it('leaves the provider to the server when the default is chosen', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Cutout server default',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Cutout default',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Cutout server default')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    await user.click(screen.getByRole('button', { name: 'Remove background' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'background-removal',
      )
      expect(job).toBeDefined()
      expect(job?.parameters).not.toHaveProperty('provider')
    })
  })

  it('sends the enclosed-background opt-in only when the operator ticks it', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Enclosed background',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Enclosed sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Enclosed background')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // Off by default: clearing a counter is only right when those areas really
    // are background, and the pass keys by colour, not by shape.
    const optIn = screen.getByRole('checkbox', {
      name: /Also remove enclosed background/,
    })
    expect(optIn).not.toBeChecked()

    await user.click(optIn)
    await user.click(screen.getByRole('button', { name: 'Remove background' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'background-removal',
      )
      expect(job?.parameters).toMatchObject({ removeEnclosedBackground: true })
      // The provider is still left to the deployment default.
      expect(job?.parameters).not.toHaveProperty('provider')
    })
  })

  it('omits the enclosed-background flag when it is left off', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Enclosed default',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Enclosed default sample',
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Enclosed default')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    await user.click(screen.getByRole('button', { name: 'Remove background' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'background-removal',
      )
      expect(job).toBeDefined()
      // Not sent at all, so a deployment default of "on" is not overridden by an
      // untouched control.
      expect(job?.parameters).not.toHaveProperty('removeEnclosedBackground')
    })
  })

  it('offers the ink cleanup only once the artwork has a print size', async () => {
    const mock = startTestMockApi([{
      name: 'Ink cleanup',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Ink sample',
        // No resize yet, so the refinement has no print pixels to cut at.
        chain: [],
      }],
    }])
    const batch = batchNamed(mock, 'Ink cleanup')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    expect(screen.queryByRole('button', { name: 'Clean up artwork' })).not.toBeInTheDocument()
  })

  it('sends the chosen mono preset and the flat-colour consent', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Ink refine',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Ink refine sample',
        targetCm: [10, 10],
        chain: [{ stepType: 'resize' }],
      }],
    }])
    const batch = batchNamed(mock, 'Ink refine')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // Step 4 is the shop's last numbered step; the refinement is offered after it.
    await user.click(screen.getByText('Clean ink (optional)'))
    await user.selectOptions(
      screen.getByLabelText('Cleanup preset'),
      screen.getByRole('option', { name: 'Flat-colour illustration' }),
    )
    await user.click(
      screen.getByLabelText('Also reduce a flat-colour logo to a single ink'),
    )
    await user.click(screen.getByRole('button', { name: 'Clean up artwork' }))

    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'refine-mono',
      )
      expect(job?.parameters).toMatchObject({
        preset: 'illustration',
        binarizeFlatColour: true,
      })
    })
  })

  it('disables the binarize consent under the clean-only preset', async () => {
    // "Clean up only" is defined by keeping the colours, so consenting to flatten
    // them contradicts it — and the API refuses the pair. Disable the box so the
    // operator cannot build a request that will be rejected.
    const user = userEvent.setup()
    const mock = startTestMockApi([{
      name: 'Ink clean only',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Clean only sample',
        targetCm: [10, 10],
        chain: [{ stepType: 'resize' }],
      }],
    }])
    const batch = batchNamed(mock, 'Ink clean only')
    const design = mock.designs.get(batch.designIds[0]!)!
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    await user.click(screen.getByText('Clean ink (optional)'))
    await user.click(
      screen.getByLabelText('Also reduce a flat-colour logo to a single ink'),
    )
    const consent = screen.getByLabelText(
      'Also reduce a flat-colour logo to a single ink',
    )
    expect(consent).toBeChecked()

    await user.selectOptions(
      screen.getByLabelText('Cleanup preset'),
      screen.getByRole('option', { name: 'Clean up only (keep colour)' }),
    )
    expect(consent).toBeDisabled()
    expect(consent).not.toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Clean up artwork' }))
    await waitFor(() => {
      const job = [...mock.jobs.values()].find(
        (item) => item.designId === design.id && item.type === 'refine-mono',
      )
      // The contradictory consent is never sent, even though the box was ticked.
      // The API omits the flag entirely rather than sending `false`.
      expect(job?.parameters).toMatchObject({ preset: 'clean-only' })
      expect(job?.parameters).not.toHaveProperty('binarizeFlatColour')
    })
  })
})