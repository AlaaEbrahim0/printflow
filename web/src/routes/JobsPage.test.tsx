import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SettingsProvider } from '../state/SettingsContext'
import { WorkbenchRoutes } from '../App'
import { startTestMockApi, stopTestMockApi } from '../mocks/server'

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <WorkbenchRoutes />
      </SettingsProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  startTestMockApi()
})

afterAll(() => {
  stopTestMockApi()
})

function pendingUpscale() {
  const mock = startTestMockApi()
  const batch = [...mock.batches.values()].find((item) => item.name === 'ACME summer drop 01')
  if (!batch) throw new Error('Seed batch was not created')
  const designId = batch.designIds.find((id) => {
    const design = mock.designs.get(id)
    return design && !design.pendingVersionId && design.status === 'received'
  })
  if (!designId) throw new Error('Seed batch has no proposable design')

  // Keep this job queued: the jobs screen must show live work, not just history.
  mock.jobDelayMs = 60_000
  const accepted = mock.proposeStep(designId, 'upscale', {
    model: 'realesrgan-x4plus',
    scale: 4,
    gpu: true,
  })
  return { mock, batch, designId, jobId: accepted.jobId }
}

describe('jobs screen', () => {
  it('lists live jobs across every batch from the top-level Jobs link', async () => {
    const { batch, designId } = pendingUpscale()
    renderAt('/jobs')

    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument()
    expect(await screen.findByTestId('live-job-count')).toHaveTextContent('1 live')

    const table = screen.getByRole('table')
    expect(within(table).getByText('Upscale')).toBeInTheDocument()
    expect(within(table).getByText('Queued')).toBeInTheDocument()
    expect(
      within(table).getByRole('link', { name: batch.name }),
    ).toHaveAttribute('href', `/batches/${batch.id}`)
    expect(
      within(table).getByRole('link', { name: new RegExp(designId.slice(0, 8)) }),
    ).toHaveAttribute('href', `/batches/${batch.id}/designs/${designId}`)
  })

  it('keeps the batch-scoped view focused on that batch', async () => {
    const { batch, designId } = pendingUpscale()
    renderAt(`/batches/${batch.id}/jobs`)

    expect(
      await screen.findByRole('heading', { name: 'Jobs for this batch' }),
    ).toBeInTheDocument()
    expect(await screen.findByTestId('live-job-count')).toHaveTextContent('1 live')
    expect(screen.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/jobs')

    const table = screen.getByRole('table')
    expect(within(table).getByText('Upscale')).toBeInTheDocument()
    // Northgate's historical pack/export jobs belong to another batch.
    expect(within(table).queryByText('Pack sheet')).not.toBeInTheDocument()
    expect(
      within(table).getByRole('link', { name: new RegExp(designId.slice(0, 8)) }),
    ).toHaveAttribute('href', `/batches/${batch.id}/designs/${designId}`)
  })

  it('offers a Jobs link from the batch screen', async () => {
    const user = userEvent.setup()
    const mock = startTestMockApi()
    const batch = [...mock.batches.values()].find((item) => item.name === 'ACME summer drop 01')
    if (!batch) throw new Error('Seed batch was not created')
    renderAt(`/batches/${batch.id}`)

    const jobsLink = await screen.findByTestId('batch-jobs-link')
    expect(jobsLink).toHaveAttribute('href', `/batches/${batch.id}/jobs`)
    await user.click(jobsLink)
    expect(
      await screen.findByRole('heading', { name: 'Jobs for this batch' }),
    ).toBeInTheDocument()
  })
})
