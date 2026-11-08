import { delay, http, HttpResponse } from 'msw'
import type { CreateBatchRequest, ExportArtifactName, GarmentColorKind } from '../api/client'
import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_BYTES } from '../lib/upload'
import { MockProblem, store } from './store'

const V1 = '/api/v1'

type JsonBody = Parameters<typeof HttpResponse.json>[0]

function jsonBody(data: unknown, status = 200): Response {
  return HttpResponse.json(data as JsonBody, { status })
}

function problemResponse(error: unknown): Response | null {
  if (!(error instanceof MockProblem)) return null
  return HttpResponse.json(error.toProblemBody(), {
    status: error.status,
    headers: { 'Content-Type': 'application/problem+json' },
  })
}

async function guarded(run: () => Response | Promise<Response>): Promise<Response> {
  const latency = store().latencyMs
  if (latency > 0) await delay(latency)
  try {
    return await run()
  } catch (error) {
    const problem = problemResponse(error)
    if (problem) return problem
    return HttpResponse.json(
      {
        title: 'Mock API internal error',
        status: 500,
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        code: 'mock-internal-error',
      },
      { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
    )
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as Record<string, unknown> | null
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

function imageResponse(svg: string, fileName: string): Response {
  return new HttpResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: `"${hashOf(svg)}"`,
      'Content-Disposition': `inline; filename="${fileName}.svg"`,
    },
  })
}

function hashOf(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

/** Mock-only: the frozen contract exposes `maskUrl`/`svgUrl` without paths. */
function versionAsset(designId: string, versionId: string, kind: 'file' | 'mask' | 'svg') {
  const mock = store()
  const version = mock.versions.get(versionId)
  if (!version || version.designId !== designId) {
    throw new MockProblem(404, 'version-not-found', 'Version not found')
  }
  return imageResponse(mock.fileFor(version, kind), `version-${versionId}-${kind}`)
}

const upload = http.post(`${V1}/batches/:batchId/designs`, async ({ request, params }) =>
  guarded(async () => {
    const mock = store()
    const batchId = params.batchId as string
    const form = await request.formData()
    const raw = form.get('file')
    if (typeof raw === 'string' || raw === null) {
      throw new MockProblem(422, 'unsupported-image', 'No file part in the upload')
    }
    const blob = raw as Blob
    const file = raw
    if (blob.size > MAX_UPLOAD_BYTES) {
      throw new MockProblem(
        413,
        'upload-too-large',
        'Upload exceeds the intake limit',
        `${blob.size} bytes received; the limit is ${MAX_UPLOAD_BYTES} bytes.`,
      )
    }
    const declaredType = blob.type || ''
    const looksImage =
      declaredType === '' || (ACCEPTED_MIME_TYPES as readonly string[]).includes(declaredType)
    if (!looksImage) {
      throw new MockProblem(
        422,
        'unsupported-image',
        'The uploaded file is not a supported image',
        `"${declaredType}" cannot be decoded. Upload PNG, JPEG, WebP or TIFF.`,
      )
    }
    const name = String(form.get('name') ?? (file instanceof File ? file.name : 'upload.png'))
    const garmentColorKind = (form.get('garmentColorKind') as GarmentColorKind | null) ?? undefined
    const garmentColorHex = (form.get('garmentColorHex') as string | null) ?? null
    const targetWidthCm = numberOrNull(form.get('targetWidthCm'))
    const targetHeightCm = numberOrNull(form.get('targetHeightCm'))
    const detail = mock.uploadDesign(batchId, {
      name: name.replace(/\.[a-z0-9]+$/i, ''),
      garmentColorKind,
      garmentColorHex,
      targetWidthCm,
      targetHeightCm,
      readyToPack: String(form.get('readyToPack') ?? '') === 'true',
    })
    return jsonBody(detail, 201)
  }),
)

function numberOrNull(value: FormDataEntryValue | null): number | null {
  if (value === null || value === '') return null
  const parsed = Number(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

export const handlers = [
  http.get('/healthz', () =>
    guarded(() =>
      jsonBody({
        status: 'Healthy',
        service: 'printsheet-api (mock)',
        checks: [
          { name: 'database', status: 'Healthy', durationMs: 2 },
          { name: 'storage', status: 'Healthy', durationMs: 1 },
        ],
      }),
    ),
  ),

  http.get(`${V1}/info`, () =>
    guarded(() =>
      jsonBody({
        service: 'printsheet-api',
        version: '2.0.0-mock',
        contractVersion: '2.0.0',
        phase: 1,
      }),
    ),
  ),

  http.get(`${V1}/settings`, () => guarded(() => jsonBody(structuredClone(store().settings)))),

  http.put(`${V1}/settings`, async ({ request }) =>
    guarded(async () => {
      const body = (await readJson(request)) as Record<string, unknown>
      const mock = store()
      if (body.workingDpi !== undefined && (Number(body.workingDpi) < 72 || Number(body.workingDpi) > 1200)) {
        throw new MockProblem(422, 'invalid-target-size', 'workingDpi must be between 72 and 1200')
      }
      if (
        body.dpiStrongWarnBelow !== undefined &&
        body.dpiWarnBelow !== undefined &&
        Number(body.dpiStrongWarnBelow) >= Number(body.dpiWarnBelow)
      ) {
        throw new MockProblem(
          422,
          'invalid-target-size',
          'dpiStrongWarnBelow must be lower than dpiWarnBelow',
        )
      }
      Object.assign(mock.settings, structuredClone(body))
      return jsonBody(structuredClone(mock.settings))
    }),
  ),

  http.get(`${V1}/batches`, ({ request }) =>
    guarded(() => {
      const url = new URL(request.url)
      const status = url.searchParams.get('status') as import('../api/client').BatchStatus | null
      return jsonBody(
        store().listBatches({
          status: status ?? undefined,
          limit: numberOrNull(url.searchParams.get('limit')) ?? undefined,
          offset: numberOrNull(url.searchParams.get('offset')) ?? undefined,
        }),
      )
    }),
  ),

  http.post(`${V1}/batches`, async ({ request }) =>
    guarded(async () => {
      const body = await readJson(request)
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        throw new MockProblem(422, 'invalid-target-size', 'Batch name is required')
      }
      return jsonBody(store().createBatch(body as CreateBatchRequest), 201)
    }),
  ),

  http.get(`${V1}/batches/:batchId`, ({ params }) =>
    guarded(() => jsonBody(store().batchDetail(params.batchId as string))),
  ),

  http.patch(`${V1}/batches/:batchId`, async ({ request, params }) =>
    guarded(async () =>
      jsonBody(store().updateBatch(params.batchId as string, await readJson(request))),
    ),
  ),

  upload,

  http.get(`${V1}/batches/:batchId/jobs`, ({ params, request }) =>
    guarded(() => {
      const url = new URL(request.url)
      return jsonBody(
        store().listJobs(params.batchId as string, {
          status:
            (url.searchParams.get('status') as import('../api/client').JobStatus | null) ?? undefined,
          type:
            (url.searchParams.get('type') as import('../api/client').JobType | null) ?? undefined,
          limit: numberOrNull(url.searchParams.get('limit')) ?? undefined,
        }),
      )
    }),
  ),

  http.get(`${V1}/batches/:batchId/sheet`, ({ params }) =>
    guarded(() => jsonBody(store().sheet(params.batchId as string))),
  ),

  http.post(`${V1}/batches/:batchId/sheet/pack`, async ({ request, params }) =>
    guarded(async () => jsonBody(store().pack(params.batchId as string, await readJson(request)), 202)),
  ),

  http.put(`${V1}/batches/:batchId/sheet/placements`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      const revision = Number(body.revision)
      if (!Number.isFinite(revision)) {
        throw new MockProblem(422, 'invalid-target-size', 'revision is required')
      }
      const placements = (body.placements ?? []) as import('../api/client').ManualPlacement[]
      return jsonBody(store().updatePlacements(params.batchId as string, revision, placements))
    }),
  ),

  http.post(`${V1}/batches/:batchId/sheet/integrity-check`, ({ params }) =>
    guarded(() => jsonBody(store().runIntegrityCheck(params.batchId as string), 202)),
  ),

  http.get(`${V1}/batches/:batchId/sheet/preview`, ({ params }) =>
    guarded(() => {
      const mock = store()
      const sheet = mock.sheet(params.batchId as string)
      const width = 420
      const height = Math.max(60, Math.round((sheet.heightCm / sheet.widthCm) * width))
      const cells = sheet.placements
        .map((placement) => {
          const x = (placement.xCm / sheet.widthCm) * width
          const y = (placement.yCm / sheet.heightCm) * height
          const w = (placement.widthCm / sheet.widthCm) * width
          const h = (placement.heightCm / sheet.heightCm) * height
          const design = mock.designs.get(placement.designId)
          const assetKey = mock.versions.get(placement.versionId)?.assetKey ?? 'sticker-fringe'
          void design
          const tint = { 'sticker-fringe': '#ff6a3d', 'wide-lockup': '#e2b23c', 'flat-logo-black': '#f3efe6' }[assetKey] ?? '#c9463a'
          return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${tint}" opacity="0.85"/>`
        })
        .join('')
      return imageResponse(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#181513" stroke="#2c2723"/>${cells}</svg>`,
        `sheet-${params.batchId}-preview`,
      )
    }),
  ),

  http.get(`${V1}/batches/:batchId/exports`, ({ params }) =>
    guarded(() => jsonBody(store().listExports(params.batchId as string))),
  ),

  http.post(`${V1}/batches/:batchId/exports`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      const format = body.format as import('../api/client').ExportFormat
      if (!format) throw new MockProblem(422, 'export-format-unavailable', 'format is required')
      return jsonBody(store().createExport(params.batchId as string, format, body.includePreview !== false), 202)
    }),
  ),

  http.get(`${V1}/designs/:designId`, ({ params }) =>
    guarded(() => jsonBody(store().designDetail(params.designId as string))),
  ),

  http.patch(`${V1}/designs/:designId`, async ({ request, params }) =>
    guarded(async () => jsonBody(store().updateDesign(params.designId as string, await readJson(request)))),
  ),

  http.get(`${V1}/designs/:designId/suggestions`, ({ params }) =>
    guarded(() => jsonBody(store().suggestions(params.designId as string))),
  ),

  http.get(`${V1}/designs/:designId/versions`, ({ params }) =>
    guarded(() => {
      const mock = store()
      const detail = mock.designDetail(params.designId as string)
      return jsonBody(detail.versions)
    }),
  ),

  http.get(`${V1}/designs/:designId/versions/:versionId/file`, ({ params }) =>
    guarded(() =>
      versionAsset(params.designId as string, params.versionId as string, 'file'),
    ),
  ),

  http.get(`${V1}/designs/:designId/versions/:versionId/mask`, ({ params }) =>
    guarded(() =>
      versionAsset(params.designId as string, params.versionId as string, 'mask'),
    ),
  ),

  http.get(`${V1}/designs/:designId/versions/:versionId/svg`, ({ params }) =>
    guarded(() =>
      versionAsset(params.designId as string, params.versionId as string, 'svg'),
    ),
  ),

  http.post(`${V1}/designs/:designId/versions/:versionId/approve`, ({ params }) =>
    guarded(() =>
      jsonBody(store().approveVersion(params.designId as string, params.versionId as string)),
    ),
  ),

  http.post(`${V1}/designs/:designId/versions/:versionId/reject`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      return jsonBody(
        store().rejectVersion(
          params.designId as string,
          params.versionId as string,
          typeof body.reason === 'string' ? body.reason : null,
        ),
      )
    }),
  ),

  http.post(`${V1}/designs/:designId/revert`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      const versionId = body.versionId
      if (typeof versionId !== 'string') {
        throw new MockProblem(422, 'invalid-target-size', 'versionId is required')
      }
      return jsonBody(store().revert(params.designId as string, versionId))
    }),
  ),

  http.post(`${V1}/designs/:designId/undo`, ({ params }) =>
    guarded(() => jsonBody(store().undo(params.designId as string))),
  ),

  http.post(`${V1}/designs/:designId/exclude`, ({ params }) =>
    guarded(() => jsonBody(store().setExcluded(params.designId as string, true))),
  ),

  http.post(`${V1}/designs/:designId/include`, ({ params }) =>
    guarded(() => jsonBody(store().setExcluded(params.designId as string, false))),
  ),

  http.post(`${V1}/designs/:designId/request-better-source`, ({ params }) =>
    guarded(() => jsonBody(store().requestBetterSource(params.designId as string))),
  ),

  http.post(`${V1}/designs/:designId/resume`, ({ params }) =>
    guarded(() => jsonBody(store().resumeDesign(params.designId as string))),
  ),

  http.post(`${V1}/designs/:designId/steps/trim`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      return jsonBody(
        store().proposeStep(params.designId as string, 'trim', body),
        202,
      )
    }),
  ),

  http.post(`${V1}/designs/:designId/steps/crop`, async ({ request, params }) =>
    guarded(async () => {
      const body = await readJson(request)
      const rect = body.rect as import('../api/client').CropRect | undefined
      if (!rect) throw new MockProblem(422, 'invalid-target-size', 'rect is required for a crop')
      return jsonBody(
        store().proposeStep(params.designId as string, 'trim', { ...body, mode: 'manual', cropRect: rect }),
        202,
      )
    }),
  ),

  http.post(`${V1}/designs/:designId/steps/upscale`, async ({ request, params }) =>
    guarded(async () =>
      jsonBody(store().proposeStep(params.designId as string, 'upscale', await readJson(request)), 202),
    ),
  ),

  http.post(`${V1}/designs/:designId/steps/resize`, async ({ request, params }) =>
    guarded(async () =>
      jsonBody(store().proposeStep(params.designId as string, 'resize', await readJson(request)), 202),
    ),
  ),

  http.get(`${V1}/jobs/:jobId`, ({ params }) => guarded(() => jsonBody(store().getJob(params.jobId as string)))),

  http.post(`${V1}/jobs/:jobId/cancel`, ({ params }) =>
    guarded(() => jsonBody(store().cancelJob(params.jobId as string))),
  ),

  http.get(`${V1}/exports/:exportId`, ({ params }) =>
    guarded(() => jsonBody(store().getExport(params.exportId as string))),
  ),

  http.get(`${V1}/exports/:exportId/download`, ({ request, params }) =>
    guarded(() => {
      const mock = store()
      const record = mock.exports.get(params.exportId as string)
      if (!record) throw new MockProblem(404, 'export-not-found', 'Export not found')
      const url = new URL(request.url)
      const name = (url.searchParams.get('artifact') ?? 'manifest') as ExportArtifactName
      const artifact = record.artifacts.find((item) => item.name === name)
      if (!artifact) throw new MockProblem(404, 'export-not-found', `Artifact "${name}" is not part of this export`)
      const { body, contentType } = mock.exportArtifactBody(record, name)
      return new HttpResponse(body, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="printsheet-${record.id}-${name}.${extensionFor(name)}"`,
        },
      })
    }),
  ),

  // Internal worker endpoints are never called from the browser. Answer honestly
  // instead of falling through to the Vite proxy.
  ...['claim', 'heartbeat', 'complete', 'fail'].map((suffix) =>
    http.post(`${V1}/internal/jobs/${suffix === 'claim' ? 'claim' : ':jobId/' + suffix}`, () =>
      HttpResponse.json(
        new MockProblem(401, 'worker-key-invalid', 'Worker key required').toProblemBody(),
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
      ),
    ),
  ),
]

function extensionFor(name: ExportArtifactName): string {
  switch (name) {
    case 'manifest':
      return 'json'
    case 'jsx':
      return 'jsx'
    case 'layered':
      return 'psd'
    case 'preview':
    case 'flat':
      return 'png'
  }
}
