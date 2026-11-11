import type { components } from './schema'
import { ApiError, toProblem } from './problem'
import { validateUploadFile } from '../lib/upload'

export type { ApiError } from './problem'

/**
 * Every request is relative: the Vite dev proxy or the mock service worker
 * decides where `/api` and `/healthz` land. Never hard-code a host here.
 */
const API_ROOT = '/api/v1'

export type HealthResponse = components['schemas']['HealthResponse']
export type InfoResponse = components['schemas']['InfoResponse']
export type AppSettings = components['schemas']['AppSettings']
export type UpdateSettingsRequest = components['schemas']['UpdateSettingsRequest']
export type BatchStatus = components['schemas']['BatchStatus']
export type BatchList = components['schemas']['BatchList']
export type BatchSummary = components['schemas']['BatchSummary']
export type BatchDetail = components['schemas']['BatchDetail']
export type CreateBatchRequest = components['schemas']['CreateBatchRequest']
export type UpdateBatchRequest = components['schemas']['UpdateBatchRequest']
export type DesignStatus = components['schemas']['DesignStatus']
export type DesignSummary = components['schemas']['DesignSummary']
export type DesignDetail = components['schemas']['DesignDetail']
export type DesignVersion = components['schemas']['DesignVersion']
export type VersionSummary = components['schemas']['VersionSummary']
export type UpdateDesignRequest = components['schemas']['UpdateDesignRequest']
export type ClassifierSuggestions = components['schemas']['ClassifierSuggestions']
export type GarmentColor = components['schemas']['GarmentColor']
export type GarmentColorKind = components['schemas']['GarmentColorKind']
export type CropRect = components['schemas']['CropRect']
export type StepType = components['schemas']['StepType']
export type VersionStatus = components['schemas']['VersionStatus']
export type JobAccepted = components['schemas']['JobAccepted']
export type Job = components['schemas']['Job']
export type JobList = components['schemas']['JobList']
export type JobStatus = components['schemas']['JobStatus']
export type JobType = components['schemas']['JobType']
export type Sheet = components['schemas']['Sheet']
export type SheetState = components['schemas']['SheetState']
export type Placement = components['schemas']['Placement']
export type ManualPlacement = components['schemas']['ManualPlacement']
export type PackSheetRequest = components['schemas']['PackSheetRequest']
export type PlacementsUpdateRequest = components['schemas']['PlacementsUpdateRequest']
export type IntegrityReport = components['schemas']['IntegrityReport']
export type IntegrityCheck = components['schemas']['IntegrityCheck']
export type IntegrityCheckResult = components['schemas']['IntegrityCheckResult']
export type ExportFormat = components['schemas']['ExportFormat']
export type ExportStatus = components['schemas']['ExportStatus']
export type ExportArtifactName = components['schemas']['ExportArtifactName']
export type Export = components['schemas']['Export']
export type ExportList = components['schemas']['ExportList']
export type ExportArtifact = components['schemas']['ExportArtifact']
export type Money = components['schemas']['Money']
export type PackerSettings = components['schemas']['PackerSettings']
export type IntegrityFailure = components['schemas']['IntegrityFailure']
export type JobError = components['schemas']['JobError']
export type ManualPlacementInput = components['schemas']['ManualPlacement']
export type ExportRequest = components['schemas']['ExportRequest']
export type TrimStepRequest = components['schemas']['TrimStepRequest']
export type CropStepRequest = components['schemas']['CropStepRequest']
export type UpscaleStepRequest = components['schemas']['UpscaleStepRequest']
export type ResizeStepRequest = components['schemas']['ResizeStepRequest']
export type BackgroundRemovalStepRequest = components['schemas']['BackgroundRemovalStepRequest']
export type BrushOp = components['schemas']['BrushOp']
export type LevelsAdjustment = components['schemas']['LevelsAdjustment']
export type RejectVersionRequest = components['schemas']['RejectVersionRequest']
export type RejectVersionResponse = components['schemas']['RejectVersionResponse']
export type RejectNextAction = components['schemas']['RejectNextAction']
export type RevertVersionRequest = components['schemas']['RevertVersionRequest']

export type PackInput = Partial<PackSheetRequest>
export type UpscaleInput = Pick<UpscaleStepRequest, 'model' | 'scale'> & Partial<UpscaleStepRequest>
export type ExportInput = Pick<ExportRequest, 'format'> & Partial<ExportRequest>

export interface RequestOptions {
  signal?: AbortSignal
}

export interface QueryParams {
  [key: string]: string | number | boolean | null | undefined
}

function withQuery(path: string, query?: QueryParams): string {
  if (!query) return path
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const serialized = search.toString()
  return serialized ? `${path}?${serialized}` : path
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  return text
}

/**
 * Single place where HTTP becomes domain errors: `application/problem+json`
 * is parsed into `ProblemDetails` and surfaced as an `ApiError` with its stable
 * `code`.
 */
export async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError({
      title: 'Network request failed',
      status: 0,
      detail: `${path} is unreachable. Is the API running?`,
      code: null,
    })
  }

  if (response.status === 204) {
    return undefined as T
  }

  const body = await readBody(response)

  if (!response.ok) {
    throw new ApiError(toProblem(body, response.status))
  }

  if (typeof body === 'string' && !response.headers.get('content-type')?.includes('json')) {
    throw new ApiError({
      title: 'Unexpected response',
      status: response.status,
      detail: `Expected JSON from ${path}.`,
      code: null,
    })
  }

  return body as T
}

function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: 'GET', signal: options.signal })
}

function post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
  })
}

function put<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body), signal: options.signal })
}

function patch<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body), signal: options.signal })
}

function deleteMethod<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return request<T>(path, { method: 'DELETE', signal: options.signal })
}

export interface UploadProgress {
  loadedBytes: number
  totalBytes: number
  /** -1 when the environment does not report a total. */
  percent: number
}

export interface UploadDesignInput {
  file: File | Blob
  name?: string
  garmentColorKind?: GarmentColorKind
  garmentColorHex?: string | null
  targetWidthCm?: number | null
  targetHeightCm?: number | null
  /** Operator-prepared PNG: background removed, exported at the exact print size. */
  readyToPack?: boolean
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void
  signal?: AbortSignal
}

/**
 * Multipart intake is the only endpoint that carries bytes over HTTP. `fetch`
 * cannot report upload progress, so this uses XHR and maps failures back into
 * the same `ProblemDetails` pipeline.
 */
export function uploadDesign(
  batchId: string,
  input: UploadDesignInput,
  options: UploadOptions = {},
): Promise<DesignDetail> {
  // Fail before sending bytes the API would reject anyway.
  const rejection =
    'name' in input.file && typeof (input.file as File).name === 'string'
      ? validateUploadFile(input.file as File)
      : null
  if (rejection) {
    return Promise.reject(
      new ApiError({
        title: rejection.code === 'upload-too-large' ? 'Upload exceeds the intake limit' : 'Unsupported image',
        status: rejection.code === 'upload-too-large' ? 413 : 422,
        detail: rejection.message,
        code: rejection.code,
      }),
    )
  }

  const form = new FormData()
  const fileName = input.file instanceof File ? input.file.name : 'upload.png'
  form.append('file', input.file, fileName)
  if (input.name) form.append('name', input.name)
  if (input.garmentColorKind) form.append('garmentColorKind', input.garmentColorKind)
  if (input.garmentColorHex) form.append('garmentColorHex', input.garmentColorHex)
  if (input.targetWidthCm != null) form.append('targetWidthCm', String(input.targetWidthCm))
  if (input.targetHeightCm != null) form.append('targetHeightCm', String(input.targetHeightCm))
  if (input.readyToPack) form.append('readyToPack', 'true')

  const path = `${API_ROOT}/batches/${encodeURIComponent(batchId)}/designs`

  return new Promise<DesignDetail>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', path)
    xhr.responseType = 'text'

    const abort = () => xhr.abort()
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      options.signal.addEventListener('abort', abort, { once: true })
    }

    xhr.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable ? event.total : 0
      options.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes: total,
        percent: total > 0 ? Math.round((event.loaded / total) * 100) : -1,
      })
    })

    const finish = () => {
      if (options.signal) options.signal.removeEventListener('abort', abort)
      const status = xhr.status
      if (status === 0) {
        reject(
          new ApiError({
            title: 'Network request failed',
            status: 0,
            detail: `${path} is unreachable. Is the API running?`,
            code: null,
          }),
        )
        return
      }
      let parsed: unknown = null
      const text = xhr.responseText
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          parsed = text
        }
      }
      if (status < 200 || status >= 300) {
        reject(new ApiError(toProblem(parsed, status)))
        return
      }
      resolve(parsed as DesignDetail)
    }

    xhr.addEventListener('load', finish)
    xhr.addEventListener('error', finish)
    xhr.addEventListener('abort', () => {
      if (options.signal) options.signal.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    })
    xhr.addEventListener('progress', (event) => options.onProgress?.({
      loadedBytes: event.loaded,
      totalBytes: event.lengthComputable ? event.total : 0,
      percent: event.lengthComputable && event.total > 0 ? Math.round((event.loaded / event.total) * 100) : -1,
    }))

    xhr.send(form)
  })
}

export function versionFileUrl(designId: string, versionId: string): string {
  return `${API_ROOT}/designs/${encodeURIComponent(designId)}/versions/${encodeURIComponent(versionId)}/file`
}

/**
 * Derived, server-rendered preview of an immutable version. The full-resolution
 * file is untouched; the browser gets a small PNG whose longest side is at most
 * `maxPx`.
 */
export function versionThumbnailUrl(
  designId: string,
  versionId: string,
  maxPx = 640,
): string {
  return withQuery(versionFileUrl(designId, versionId), { maxPx })
}

export function sheetPreviewUrl(batchId: string): string {
  return `${API_ROOT}/batches/${encodeURIComponent(batchId)}/sheet/preview`
}

export function exportArtifactUrl(exportId: string, artifact: ExportArtifactName): string {
  return `${API_ROOT}/exports/${encodeURIComponent(exportId)}/download?artifact=${encodeURIComponent(artifact)}`
}

const encoded = encodeURIComponent

export const api = {
  apiRoot: API_ROOT,
  system: {
    health: (options?: RequestOptions) => get<HealthResponse>('/healthz', options),
    info: (options?: RequestOptions) => get<InfoResponse>(`${API_ROOT}/info`, options),
  },
  settings: {
    get: (options?: RequestOptions) => get<AppSettings>(`${API_ROOT}/settings`, options),
    update: (next: UpdateSettingsRequest, options?: RequestOptions) =>
      put<AppSettings>(`${API_ROOT}/settings`, next, options),
  },
  batches: {
    list: (
      query?: { status?: BatchStatus; limit?: number; offset?: number },
      options?: RequestOptions,
    ) => get<BatchList>(withQuery(`${API_ROOT}/batches`, query), options),
    create: (body: CreateBatchRequest, options?: RequestOptions) =>
      post<BatchSummary>(`${API_ROOT}/batches`, body, options),
    get: (batchId: string, options?: RequestOptions) =>
      get<BatchDetail>(`${API_ROOT}/batches/${encoded(batchId)}`, options),
    update: (batchId: string, body: UpdateBatchRequest, options?: RequestOptions) =>
      patch<BatchSummary>(`${API_ROOT}/batches/${encoded(batchId)}`, body, options),
    jobs: (
      batchId: string,
      query?: { status?: JobStatus; type?: JobType; limit?: number },
      options?: RequestOptions,
    ) => get<JobList>(withQuery(`${API_ROOT}/batches/${encoded(batchId)}/jobs`, query), options),
    delete: (batchId: string, options?: RequestOptions) =>
      deleteMethod<void>(`${API_ROOT}/batches/${encoded(batchId)}`, options),
    deleteDesignImages: (
      batchId: string,
      designId: string,
      options?: RequestOptions,
    ) =>
      deleteMethod<void>(
        `${API_ROOT}/batches/${encoded(batchId)}/designs/${encoded(designId)}`,
        options,
      ),
  },
  designs: {
    get: (designId: string, options?: RequestOptions) =>
      get<DesignDetail>(`${API_ROOT}/designs/${encoded(designId)}`, options),
    update: (designId: string, body: UpdateDesignRequest, options?: RequestOptions) =>
      patch<DesignDetail>(`${API_ROOT}/designs/${encoded(designId)}`, body, options),
    suggestions: (designId: string, options?: RequestOptions) =>
      get<ClassifierSuggestions>(`${API_ROOT}/designs/${encoded(designId)}/suggestions`, options),
    versions: (designId: string, options?: RequestOptions) =>
      get<DesignVersion[]>(`${API_ROOT}/designs/${encoded(designId)}/versions`, options),
    approve: (designId: string, versionId: string, options?: RequestOptions) =>
      post<DesignDetail>(
        `${API_ROOT}/designs/${encoded(designId)}/versions/${encoded(versionId)}/approve`,
        undefined,
        options,
      ),
    reject: (
      designId: string,
      versionId: string,
      body?: RejectVersionRequest,
      options?: RequestOptions,
    ) =>
      post<RejectVersionResponse>(
        `${API_ROOT}/designs/${encoded(designId)}/versions/${encoded(versionId)}/reject`,
        body ?? {},
        options,
      ),
    revert: (designId: string, versionId: string, options?: RequestOptions) =>
      post<DesignDetail>(
        `${API_ROOT}/designs/${encoded(designId)}/revert`,
        { versionId } satisfies RevertVersionRequest,
        options,
      ),
    exclude: (designId: string, options?: RequestOptions) =>
      post<DesignDetail>(`${API_ROOT}/designs/${encoded(designId)}/exclude`, undefined, options),
    include: (designId: string, options?: RequestOptions) =>
      post<DesignDetail>(`${API_ROOT}/designs/${encoded(designId)}/include`, undefined, options),
    requestBetterSource: (designId: string, options?: RequestOptions) =>
      post<DesignDetail>(
        `${API_ROOT}/designs/${encoded(designId)}/request-better-source`,
        undefined,
        options,
      ),
    resume: (designId: string, options?: RequestOptions) =>
      post<DesignDetail>(`${API_ROOT}/designs/${encoded(designId)}/resume`, undefined, options),
    upload: uploadDesign,
  },
  steps: {
    trim: (designId: string, body: TrimStepRequest, options?: RequestOptions) =>
      post<JobAccepted>(`${API_ROOT}/designs/${encoded(designId)}/steps/trim`, body, options),
    crop: (designId: string, body: CropStepRequest, options?: RequestOptions) =>
      post<JobAccepted>(`${API_ROOT}/designs/${encoded(designId)}/steps/crop`, body, options),
    upscale: (designId: string, body: UpscaleInput, options?: RequestOptions) =>
      post<JobAccepted>(
        `${API_ROOT}/designs/${encoded(designId)}/steps/upscale`,
        { gpu: true, ...body },
        options,
      ),
    resize: (designId: string, body: ResizeStepRequest, options?: RequestOptions) =>
      post<JobAccepted>(`${API_ROOT}/designs/${encoded(designId)}/steps/resize`, body, options),
    backgroundRemoval: (
      designId: string,
      body: BackgroundRemovalStepRequest,
      options?: RequestOptions,
    ) =>
      post<JobAccepted>(
        `${API_ROOT}/designs/${encoded(designId)}/steps/background-removal`,
        body,
        options,
      ),
  },
  jobs: {
    list: (
      query?: { status?: JobStatus; type?: JobType; limit?: number },
      options?: RequestOptions,
    ) => get<JobList>(withQuery(`${API_ROOT}/jobs`, query), options),
    get: (jobId: string, options?: RequestOptions) =>
      get<Job>(`${API_ROOT}/jobs/${encoded(jobId)}`, options),
    cancel: (jobId: string, options?: RequestOptions) =>
      post<Job>(`${API_ROOT}/jobs/${encoded(jobId)}/cancel`, undefined, options),
  },
  sheets: {
    get: (batchId: string, options?: RequestOptions) =>
      get<Sheet>(`${API_ROOT}/batches/${encoded(batchId)}/sheet`, options),
    // Fields with contract defaults are filled here: `openapi-typescript` marks
    // defaulted properties as required, so `{}` is not assignable.
    pack: (batchId: string, body: PackInput = {}, options?: RequestOptions) =>
      post<JobAccepted>(
        `${API_ROOT}/batches/${encoded(batchId)}/sheet/pack`,
        { noInterlocking: false, ...body },
        options,
      ),
    updatePlacements: (batchId: string, body: PlacementsUpdateRequest, options?: RequestOptions) =>
      put<Sheet>(`${API_ROOT}/batches/${encoded(batchId)}/sheet/placements`, body, options),
    runIntegrityCheck: (batchId: string, options?: RequestOptions) =>
      post<JobAccepted>(
        `${API_ROOT}/batches/${encoded(batchId)}/sheet/integrity-check`,
        undefined,
        options,
      ),
  },
  exports: {
    list: (batchId: string, options?: RequestOptions) =>
      get<ExportList>(`${API_ROOT}/batches/${encoded(batchId)}/exports`, options),
    create: (batchId: string, body: ExportInput, options?: RequestOptions) =>
      post<JobAccepted>(
        `${API_ROOT}/batches/${encoded(batchId)}/exports`,
        { includePreview: true, ...body },
        options,
      ),
    get: (exportId: string, options?: RequestOptions) =>
      get<Export>(`${API_ROOT}/exports/${encoded(exportId)}`, options),
  },
} as const
