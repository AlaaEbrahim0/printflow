import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, describeErrorCode, toProblem } from './problem'
import { api, uploadDesign } from './client'
import { stopTestMockApi, startTestMockApi } from '../mocks/server'
import { MAX_UPLOAD_BYTES } from '../lib/upload'

beforeAll(() => startTestMockApi())
afterEach(() => startTestMockApi())
afterAll(() => stopTestMockApi())

describe('ProblemDetails mapping', () => {
  it('keeps the stable code and gives the operator a sentence they can act on', async () => {
    const error = await api.batches.get('no-such-batch').then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ApiError)
    const apiError = error as ApiError
    expect(apiError.status).toBe(404)
    expect(apiError.code).toBe('batch-not-found')
    expect(apiError.message).toBe('This batch no longer exists.')
    expect(apiError.problem.title).toBe('Batch not found')
  })

  it('maps every documented error code to distinct copy', () => {
    expect(describeErrorCode('design-exceeds-roll')).toContain('wider than the roll')
    expect(describeErrorCode('sheet-integrity-failed')).toContain('integrity report')
    expect(describeErrorCode('stale-proposal')).toContain('never rebased')
    expect(describeErrorCode('brand-new-code')).toBeNull()
  })

  it('falls back to detail, then title, when no code is known', () => {
    expect(new ApiError(toProblem({ title: 'Nope', status: 422, detail: 'rect is required' }, 422)).message).toBe(
      'rect is required',
    )
    expect(new ApiError(toProblem({ title: 'Nope', status: 500 }, 500)).message).toBe('Nope (500)')
    expect(toProblem('not json at all', 502).title).toBe('Request failed with status 502')
    expect(toProblem(null, 500, 'gateway died').detail).toBe('gateway died')
  })

  it('surfaces a 409 conflict from the mock store with its code', async () => {
    const batches = await api.batches.list({ limit: 100 })
    const acme = batches.items.find((item) => item.name === 'ACME summer drop 01')!
    const caught = await api.sheets.pack(acme.id, {}).then(
      () => null,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(409)
    expect((caught as ApiError).code).toBe('design-not-ready')
    expect((caught as ApiError).isConflict).toBe(true)
  })
})

describe('typed client over the mock network', () => {
  it('lists batches and reads a batch with its designs', async () => {
    const list = await api.batches.list({ status: 'ready-to-pack' })
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((item) => item.status === 'ready-to-pack')).toBe(true)
    const detail = await api.batches.get(list.items[0]!.id)
    expect(detail.designs.length).toBeGreaterThan(0)
    expect(detail.sheet).toBeNull()
  })

  it('reads version files as relative URLs, never a hard-coded host', async () => {
    const list = await api.batches.list({ limit: 100 })
    const withDesigns = list.items.find((batch) => batch.designCount > 0)!
    const detail = await api.batches.get(withDesigns.id)
    const design = await api.designs.get(detail.designs[0]!.id)
    const version = design.versions[0]!
    expect(version.fileUrl).toMatch(/^\/api\/v1\/designs\/[0-9a-f-]+\/versions\/[0-9a-f-]+\/file$/)
    const file = await fetch(version.fileUrl)
    const body = await file.text()
    expect(file.status, body.slice(0, 200)).toBe(200)
    expect(file.headers.get('content-type')).toContain('image/svg')
    expect(file.headers.get('etag')).toBeTruthy()
    expect(body).toContain('<svg')
  })

  it('aborts an in-flight request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(api.batches.list(undefined, { signal: controller.signal })).rejects.toThrow()
  })

  it('refuses an oversized upload before sending bytes', async () => {
    const created = await api.batches.create({ name: 'Upload smoke test' })
    const tooBig = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' })
    Object.defineProperty(tooBig, 'size', { value: MAX_UPLOAD_BYTES + 1 })
    const caught = await uploadDesign(created.id, { file: tooBig }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).status).toBe(413)
    expect((caught as ApiError).code).toBe('upload-too-large')

    const wrongType = new File([new Uint8Array([1])], 'scan.pdf', { type: 'application/pdf' })
    const rejected = await uploadDesign(created.id, { file: wrongType }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((rejected as ApiError).code).toBe('unsupported-image')
  })

  it('completes a step job and exposes the proposed version', async () => {
    const batches = await api.batches.list({ limit: 100 })
    const acme = batches.items.find((item) => item.name === 'ACME summer drop 01')!
    const detail = await api.batches.get(acme.id)
    const logo = detail.designs.find((design) => design.name === 'APEX logo')!
    const accepted = await api.steps.trim(logo.id, { mode: 'auto', paddingPx: 8, tolerance: 24 })
    expect(accepted.status).toBe('succeeded')
    expect(accepted.pollUrl).toContain('/jobs/')
    const polled = await api.jobs.get(accepted.jobId)
    expect(polled.result?.outputVersionId).toBeTruthy()
    const after = await api.designs.get(logo.id)
    expect(after.pendingVersion?.stepType).toBe('trim')
    expect(after.currentVersionId).toBe(logo.currentVersionId)
  })

  it('refuses a second proposal with proposal-in-flight', async () => {
    const batches = await api.batches.list({ limit: 100 })
    const acme = batches.items.find((item) => item.name === 'ACME summer drop 01')!
    const logo = (await api.batches.get(acme.id)).designs.find((d) => d.name === 'APEX logo')!
    await api.steps.trim(logo.id, { mode: 'auto' })
    const caught = await api.steps.trim(logo.id, { mode: 'auto' }).then(
      () => null,
      (error: unknown) => error,
    )
    expect((caught as ApiError).code).toBe('proposal-in-flight')
  })
})
