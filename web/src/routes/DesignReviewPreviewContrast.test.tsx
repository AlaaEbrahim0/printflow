import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../state/SettingsContext'
import { WorkbenchRoutes } from '../App'
import { startTestMockApi, stopTestMockApi } from '../mocks/server'
import type { MockStore } from '../mocks/store'

/**
 * jsdom has no canvas backend, so `sampleInkColour` cannot read a real file.
 * Only the sampler is replaced; `isInvisibleOnPreview` and the component under
 * test stay real, so this pins the wiring and the judgement, not a mock.
 */
const inkSample = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('../lib/previewContrast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/previewContrast')>()
  return {
    ...actual,
    sampleInkColour: async () => inkSample.value,
  }
})

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

function seed(mock: MockStore, name: string) {
  const batch = batchNamed(mock, name)
  const design = mock.designs.get(batch.designIds[0]!)!
  return { batch, design }
}

describe('design review preview contrast', () => {
  it('explains a white-ink cut-out on the white garment preview', async () => {
    const user = userEvent.setup()
    inkSample.value = '#FEFEFE'
    const mock = startTestMockApi([{
      name: 'White ink',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'White ink design',
        chain: [],
        garmentColor: { kind: 'light' },
      }],
    }])
    const { batch, design } = seed(mock, 'White ink')
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')

    // The operator's exact complaint: a white-ink cut-out on a white canvas
    // looks like nothing was produced.
    const hint = await screen.findByTestId('preview-contrast-hint')
    expect(hint).toHaveTextContent('#FEFEFE')
    expect(hint).toHaveTextContent(/intact/)

    // The one click reveals the artwork on a surface that can show it.
    await user.click(screen.getByTestId('preview-contrast-fix'))
    expect(screen.getByTestId('current-design-preview').getAttribute('data-background')).toBe('black')
    // Once the surface can show the ink, the warning has done its job.
    expect(screen.queryByTestId('preview-contrast-hint')).not.toBeInTheDocument()
  })

  it('says nothing when the ink is legible on the garment preview', async () => {
    // Dark ink on a light garment is the ordinary case: no hint, no noise.
    inkSample.value = '#101010'
    const mock = startTestMockApi([{
      name: 'Dark ink',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Dark ink design',
        chain: [],
        garmentColor: { kind: 'light' },
      }],
    }])
    const { batch, design } = seed(mock, 'Dark ink')
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('current-design-preview')
    // The garment colour arrives with the design, so the surface settles on
    // white one render after the preview appears.
    await waitFor(() =>
      expect(screen.getByTestId('current-design-preview').getAttribute('data-background')).toBe('white'),
    )
    expect(screen.queryByTestId('preview-contrast-hint')).not.toBeInTheDocument()
  })

  it('warns for dark ink on a dark garment, where it is equally invisible', async () => {
    // The mirror of the reported case, and the reason the hint is measured
    // rather than special-cased on "white ink".
    inkSample.value = '#101010'
    const mock = startTestMockApi([{
      name: 'Invisible on dark',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Dark on dark',
        chain: [],
        garmentColor: { kind: 'dark' },
      }],
    }])
    const { batch, design } = seed(mock, 'Invisible on dark')
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('preview-contrast-hint')
    expect(screen.getByTestId('current-design-preview').getAttribute('data-background')).toBe('black')
  })

  it('does not change the preview until the operator asks', async () => {
    inkSample.value = '#FEFEFE'
    const mock = startTestMockApi([{
      name: 'No auto switch',
      designs: [{
        assetKey: 'flat-logo-black',
        name: 'Untouched',
        chain: [],
        garmentColor: { kind: 'light' },
      }],
    }])
    const { batch, design } = seed(mock, 'No auto switch')
    renderAt(`/batches/${batch.id}/designs/${design.id}`)

    await screen.findByTestId('preview-contrast-hint')
    // Showing the hint must never be the thing that changes the background:
    // the garment colour is the operator's choice.
    expect(screen.getByTestId('current-design-preview').getAttribute('data-background')).toBe('white')
  })
})
