import type { components } from './schema'

export type ApiProblem = components['schemas']['ProblemDetails']

/**
 * Stable `ProblemDetails.code` values from `docs/domain-model.md` §9. Unknown
 * codes are still representable, so a newer API never breaks the client.
 */
export const KNOWN_ERROR_CODES = [
  'batch-not-found',
  'design-not-found',
  'version-not-found',
  'proposal-in-flight',
  'stale-proposal',
  'invalid-transition',
  'version-not-approved',
  'design-not-ready',
  'design-exceeds-roll',
  'batch-not-ready',
  'sheet-not-found',
  'sheet-stale',
  'sheet-integrity-failed',
  'stale-revision',
  'stale-source',
  'invalid-target-size',
  'export-format-unavailable',
  'worker-key-invalid',
  'upload-too-large',
  'unsupported-image',
] as const

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number]

const HUMAN_READABLE: Record<KnownErrorCode, string> = {
  'batch-not-found': 'This batch no longer exists.',
  'design-not-found': 'This design no longer exists in the batch.',
  'version-not-found': 'This version no longer exists.',
  'proposal-in-flight':
    'Another proposal is already waiting for review. Approve or reject it before running a new step.',
  'stale-proposal':
    'This proposal is stale: it was made against a version that is no longer current. It was rejected, never rebased — run the step again from the current version.',
  'invalid-transition': 'That action is not allowed in the current state.',
  'version-not-approved': 'Only an approved version can become current.',
  'design-not-ready':
    'A design still needs an approved resize at its target size before the batch can be packed.',
  'design-exceeds-roll':
    'A design is wider than the roll. Scale its target size or exclude it — the packer never scales artwork silently.',
  'batch-not-ready': 'Not every included design is ready yet.',
  'sheet-not-found': 'This batch has no sheet yet. Pack it first.',
  'sheet-stale':
    'The sheet is stale because a design, target size or batch geometry changed after packing. Pack again.',
  'sheet-integrity-failed':
    'Export is blocked: this sheet revision has no passing integrity report. Run the integrity check.',
  'stale-revision':
    'This result belongs to an older sheet revision and was discarded. Reload the sheet.',
  'stale-source':
    'The worker result referenced a version that is no longer current, so it was not applied.',
  'invalid-target-size': 'The target size is missing or does not match the resized pixels.',
  'export-format-unavailable': 'This export format is not available for a sheet of this size.',
  'worker-key-invalid': 'The worker key was rejected. Staff do not use this endpoint.',
  'upload-too-large': 'The file is larger than the intake limit.',
  'unsupported-image': 'The file could not be decoded as an supported image.',
}

export function describeErrorCode(code: string | null | undefined): string | null {
  if (!code) return null
  const known = (KNOWN_ERROR_CODES as readonly string[]).includes(code)
    ? HUMAN_READABLE[code as KnownErrorCode]
    : undefined
  return known ?? null
}

export function isProblemDetails(value: unknown): value is ApiProblem {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['title'] === 'string' && typeof candidate['status'] === 'number'
}

/** Never trust a body: fill in whatever the server omitted. */
export function toProblem(value: unknown, status: number, detailFallback?: string): ApiProblem {
  if (isProblemDetails(value)) {
    return {
      ...value,
      status: typeof value.status === 'number' ? value.status : status,
      code: value.code ?? null,
      detail: value.detail ?? detailFallback ?? null,
    }
  }
  return {
    title: `Request failed with status ${status}`,
    status,
    detail: detailFallback ?? (typeof value === 'string' && value ? value : null),
    code: null,
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly problem: ApiProblem

  constructor(problem: ApiProblem) {
    super(ApiError.messageFor(problem))
    this.name = 'ApiError'
    this.problem = problem
    this.status = problem.status
    this.code = problem.code ?? null
  }

  static messageFor(problem: ApiProblem): string {
    const human = describeErrorCode(problem.code)
    if (human) return problem.detail ? `${human} (${problem.detail})` : human
    if (problem.detail) return problem.detail
    return `${problem.title} (${problem.status})`
  }

  /** Field-level validation messages, when the API sends them. */
  get fieldErrors(): Record<string, string[]> {
    return this.problem.errors ?? {}
  }

  get isNotFound(): boolean {
    return this.status === 404
  }

  get isConflict(): boolean {
    return this.status === 409
  }
}

export function toDisplayMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong. Please try again.'
}
