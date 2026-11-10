import { afterAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../state/SettingsContext'
import { WorkbenchRoutes } from '../App'
import { startTestMockApi, stopTestMockApi } from '../mocks/server'
import type { MockStore } from '../mocks/store'
import type { PhotopeaEditorHandle, PhotopeaEditorProps } from '../components/photopea/PhotopeaEditor'
import { api, type DesignDetail, type UploadDesignInput } from '../api/client'

const exportPng = vi.fn(async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer)

// jsdom + MSW cannot decode a multipart body (`request.formData()` throws), so a
// real POST cannot be exercised in this environment. `api.designs.upload` is
// covered by the API client tests; here we assert the editor page hands the
// exported PNG to that exact existing intake path without replacing the source.
// The spy is created per test because this config sets `restoreMocks: true`.
let uploadSpy: MockInstance<(batchId: string, input: UploadDesignInput) => Promise<DesignDetail>>

vi.mock('../components/photopea/PhotopeaEditor', async () => {
  const React = await import('react')
  return {
    PhotopeaEditor: React.forwardRef<PhotopeaEditorHandle, PhotopeaEditorProps>(
      function MockPhotopeaEditor({ onStatusChange, fileUrl, documentName }, ref) {
        React.useEffect(() => {
          onStatusChange?.('ready', null)
        }, [onStatusChange])
        React.useImperativeHandle(ref, () => ({
          status: 'ready' as 'ready' | 'loading-editor' | 'loading-image' | 'exporting' | 'error',
          exportPng: () => exportPng(),
        }))
        return (
          <div
            data-testid="photopea-stage"
            data-status="ready"
            data-file-url={fileUrl}
            data-document-name={documentName}
          />
        )
      },
    ),
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

beforeEach(() => {
  exportPng.mockClear()
  uploadSpy = vi.spyOn(api.designs, 'upload')
  startTestMockApi()
  cleanup()
})

afterAll(() => {
  stopTestMockApi()
})

describe('Photopea editor route', () => {
  it('opens the exact current version linked from design review', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'Riverside run club')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!

    renderAt(`/batches/${batch.id}/designs/${designId}`)
    const link = await screen.findByTestId('open-photopea-current')
    expect(link).toHaveAttribute(
      'href',
      `/batches/${batch.id}/designs/${designId}/photopea?versionId=${design.currentVersionId}`,
    )

    await user.click(link)
    expect(await screen.findByTestId('photopea-editor-page')).toBeInTheDocument()
    const stage = screen.getByTestId('photopea-stage')
    expect(stage).toHaveAttribute('data-status', 'ready')
    // The editor is handed the authenticated same-origin version file, never a
    // public URL, so image endpoint access controls stay in force.
    expect(stage).toHaveAttribute(
      'data-file-url',
      `/api/v1/designs/${designId}/versions/${design.currentVersionId}/file`,
    )
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
    expect(screen.getByText(design.name, { exact: false })).toBeInTheDocument()
  })

  it('opens the exact proposal version when that action is used', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!
    if (!design.pendingVersionId) throw new Error('Expected a pending proposal')

    renderAt(`/batches/${batch.id}/designs/${designId}`)
    const link = await screen.findByTestId('open-photopea-proposal')
    expect(link).toHaveAttribute(
      'href',
      `/batches/${batch.id}/designs/${designId}/photopea?versionId=${design.pendingVersionId}`,
    )
  })

  it('exposes a Photopea action on the design grid for the current version', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!

    renderAt(`/batches/${batch.id}`)
    const link = await screen.findByTestId(`photopea-link-${designId}`)
    expect(link).toHaveAttribute(
      'href',
      `/batches/${batch.id}/designs/${designId}/photopea?versionId=${design.currentVersionId}`,
    )
  })

  it('gives every design grid card its own Photopea link, not a shared selection', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const [firstId, secondId] = batch.designIds
    if (!firstId || !secondId) throw new Error('Expected at least two seeded designs')
    const first = mock.designs.get(firstId)!
    const second = mock.designs.get(secondId)!

    renderAt(`/batches/${batch.id}`)

    const firstLink = await screen.findByTestId(`photopea-link-${firstId}`)
    const secondLink = await screen.findByTestId(`photopea-link-${secondId}`)
    expect(firstLink).toHaveAttribute(
      'href',
      `/batches/${batch.id}/designs/${firstId}/photopea?versionId=${first.currentVersionId}`,
    )
    expect(secondLink).toHaveAttribute(
      'href',
      `/batches/${batch.id}/designs/${secondId}/photopea?versionId=${second.currentVersionId}`,
    )
    // The two actions must not collapse onto the same version.
    expect(firstLink.getAttribute('href')).not.toBe(secondLink.getAttribute('href'))
  })

  it('opens the version named in the URL and not merely the current one', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!
    const older = design.versionIds.find((id) => id !== design.currentVersionId)
    if (!older) throw new Error('Expected a non-current version to exist')

    renderAt(`/batches/${batch.id}/designs/${designId}/photopea?versionId=${older}`)
    expect(await screen.findByTestId('photopea-editor-page')).toBeInTheDocument()
    // The header identifies the exact version that was requested.
    expect(screen.getByText(older.slice(0, 8), { exact: false })).toBeInTheDocument()
  })

  it('saves the exported PNG as a new ready-to-pack design without replacing the source', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!

    uploadSpy.mockImplementation(async (targetBatchId, input) => {
      const detail = mock.uploadDesign(targetBatchId, {
        name: input.name,
        readyToPack: input.readyToPack,
      })
      return detail
    })

    renderAt(
      `/batches/${batch.id}/designs/${designId}/photopea?versionId=${design.currentVersionId}`,
    )

    expect(await screen.findByTestId('photopea-editor-page')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('photopea-save')).toBeEnabled())

    await user.click(screen.getByTestId('photopea-save'))
    await user.click(screen.getByTestId('photopea-confirm-save'))

    await waitFor(() => expect(exportPng).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1))

    const [targetBatchId, input] = uploadSpy.mock.calls[0]!
    expect(targetBatchId).toBe(batch.id)
    // The edited result enters through the existing ready-to-pack intake as a PNG File.
    expect(input.readyToPack).toBe(true)
    expect(input.file).toBeInstanceOf(File)
    expect((input.file as File).type).toBe('image/png')
    expect((input.file as File).name).toMatch(/\.png$/)
    expect(input.name).toContain('Photopea')

    // The source design and its current version are untouched.
    const source = mock.designs.get(designId)
    expect(source?.currentVersionId).toBe(design.currentVersionId)
    expect(mock.batches.get(batch.id)?.designIds).toContain(designId)
  })

  it('reports a failed save without navigating away or replacing the source', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!

    uploadSpy.mockRejectedValue(new Error('Storage rejected the edited PNG'))

    renderAt(
      `/batches/${batch.id}/designs/${designId}/photopea?versionId=${design.currentVersionId}`,
    )

    await waitFor(() => expect(screen.getByTestId('photopea-save')).toBeEnabled())
    await user.click(screen.getByTestId('photopea-save'))
    await user.click(screen.getByTestId('photopea-confirm-save'))

    expect(await screen.findByText('Storage rejected the edited PNG')).toBeInTheDocument()
    // The editor stays open so the operator can retry or download instead.
    expect(screen.getByTestId('photopea-editor-page')).toBeInTheDocument()
    expect(mock.designs.get(designId)?.currentVersionId).toBe(design.currentVersionId)
  })

  it('explains a missing version instead of rendering a blank editor', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!

    renderAt(`/batches/${batch.id}/designs/${designId}/photopea?versionId=does-not-exist`)

    expect(await screen.findByText('Version not found')).toBeInTheDocument()
    expect(screen.queryByTestId('photopea-stage')).not.toBeInTheDocument()
  })

  it('falls back to the current version when no versionId is supplied', async () => {
    const mock = startTestMockApi()
    const batch = batchNamed(mock, 'ACME summer drop 01')
    const designId = batch.designIds[0]!
    const design = mock.designs.get(designId)!

    renderAt(`/batches/${batch.id}/designs/${designId}/photopea`)

    expect(await screen.findByTestId('photopea-editor-page')).toBeInTheDocument()
    expect(screen.getByText(design.currentVersionId.slice(0, 8), { exact: false })).toBeInTheDocument()
  })
})
