import type {
  AppSettings,
  BatchDetail,
  BatchStatus,
  BatchSummary,
  ClassifierSuggestions,
  CropRect,
  DesignDetail,
  DesignStatus,
  DesignSummary,
  DesignVersion,
  Export,
  ExportArtifact,
  ExportFormat,
  GarmentColor,
  IntegrityCheck,
  ManualPlacement,
  IntegrityReport,
  Job,
  JobAccepted,
  Placement,
  Sheet,
  SheetState,
  StepType,
  VersionStatus,
  VersionSummary,
} from '../api/client'
import { WORKBENCH_DEFAULTS } from '../lib/defaults'
import { MOCK_ASSETS, renderAssetSvg, type MockAssetVariant } from './assets'
import {
  centimetersForPixels,
  effectiveDpi,
  matchesTargetPixels,
  mmToCm,
  pixelsForCentimeters,
  resizeOutputPixels,
  targetPixels,
  usableRollWidthCm,
} from '../lib/units'

/** Thrown by the mock store and translated into `application/problem+json`. */
export class MockProblem extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string | null

  constructor(status: number, code: string, title: string, detail?: string) {
    super(title)
    this.name = 'MockProblem'
    this.status = status
    this.code = code
    this.detail = detail ?? null
  }

  toProblemBody() {
    return {
      type: `https://printsheet.local/errors/${this.code}`,
      title: this.message,
      status: this.status,
      detail: this.detail,
      code: this.code,
    }
  }
}

export interface MockVersionRecord {
  id: string
  designId: string
  parentId: string | null
  stepType: StepType
  status: VersionStatus
  widthPx: number
  heightPx: number
  hasAlpha: boolean
  parameters: Record<string, unknown>
  createdAt: string
  approvedAt: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  jobId: string | null
  assetKey: string
  variant: MockAssetVariant
  viewBox: { x: number; y: number; width: number; height: number } | null
  hasMask: boolean
  hasSvg: boolean
}

export interface MockDesignRecord {
  id: string
  batchId: string
  name: string
  status: DesignStatus
  garmentColor: GarmentColor
  allowRotation: boolean
  targetWidthCm: number | null
  targetHeightCm: number | null
  originalVersionId: string
  currentVersionId: string
  pendingVersionId: string | null
  betterSourceRequested: boolean
  notes: string | null
  versionIds: string[]
  createdAt: string
  updatedAt: string
  suggestions: ClassifierSuggestions | null
}

export interface MockBatchRecord {
  id: string
  name: string
  status: BatchStatus
  rollWidthCm: number
  marginMm: number
  edgeMarginMm: number
  workingDpi: number
  designIds: string[]
  sheet: Sheet | null
  createdAt: string
  updatedAt: string
}

export interface MockJobRecord {
  id: string
  batchId: string
  designId: string | null
  type: Job['type']
  status: Job['status']
  parameters: Record<string, unknown>
  attempts: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  result: Job['result']
  error: Job['error']
}

export interface MockExportRecord {
  id: string
  batchId: string
  sheetRevision: number
  format: ExportFormat
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked'
  dpi: number
  artifacts: ExportArtifact[]
  integrityReport: IntegrityReport | null
  blockedReason: string | null
  error: Export['error']
  createdAt: string
  completedAt: string | null
}

export interface SeedStep {
  stepType: StepType
  parameters?: Record<string, unknown>
  status?: Exclude<VersionStatus, 'proposed'> | 'proposed'
}

export interface SeedDesign {
  assetKey: string
  name: string
  targetCm?: [number, number]
  garmentColor?: GarmentColor
  allowRotation?: boolean
  excluded?: boolean
  betterSourceRequested?: boolean
  notes?: string | null
  chain?: SeedStep[]
}

export interface SeedBatch {
  id?: string
  name: string
  rollWidthCm?: number
  marginMm?: number
  edgeMarginMm?: number
  workingDpi?: number
  createdAtOffsetMs?: number
  designs: SeedDesign[]
  pack?: boolean
  integrity?: 'pass' | 'fail' | 'none'
  exportFormats?: ExportFormat[]
}

export const LAYERED_PSD_LIMIT_PX = 30_000

export const DEFAULT_SETTINGS: AppSettings = WORKBENCH_DEFAULTS

function uuid(): string {
  return crypto.randomUUID()
}

function isoNow(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

const NEXT_ACTIONS = ['adjust-parameters', 'manual-tool', 'skip'] as const

/**
 * In-memory stand-in for the frozen PrintSheet API. It implements the derived
 * state machine from `docs/domain-model.md` §5–6 so that approving, rejecting,
 * reverting, packing or exporting genuinely changes every later response.
 */
export class MockStore {
  readonly settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  batches = new Map<string, MockBatchRecord>()
  designs = new Map<string, MockDesignRecord>()
  versions = new Map<string, MockVersionRecord>()
  jobs = new Map<string, MockJobRecord>()
  exports = new Map<string, MockExportRecord>()

  /** Simulated worker latency. Tests set this to 0 or call `settleAllJobs()`. */
  jobDelayMs = 600
  /** Simulated network latency for the handlers; 0 keeps tests synchronous. */
  latencyMs = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()

  /** Public entry point used by the step handlers. */
  proposeStep(
    designId: string,
    type: 'trim' | 'upscale' | 'resize',
    parameters: Record<string, unknown>,
  ): JobAccepted {
    const stepType: StepType =
      type === 'trim' ? (parameters.mode === 'manual' ? 'crop' : 'trim') : type
    return this.propose(designId, type, stepType, parameters)
  }

  reset(seedBatches?: SeedBatch[]): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.batches.clear()
    this.designs.clear()
    this.versions.clear()
    this.jobs.clear()
    this.exports.clear()
    Object.assign(this.settings, structuredClone(DEFAULT_SETTINGS))
    this.seed(seedBatches ?? defaultSeed())
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  // ---------------------------------------------------------------- seeding

  private seed(batches: SeedBatch[]): void {
    for (const spec of batches) {
      const batch = this.insertBatch({
        id: spec.id,
        name: spec.name,
        rollWidthCm: spec.rollWidthCm ?? this.settings.defaultRollWidthCm,
        marginMm: spec.marginMm ?? this.settings.defaultMarginMm,
        edgeMarginMm: spec.edgeMarginMm ?? this.settings.defaultEdgeMarginMm,
        workingDpi: spec.workingDpi ?? this.settings.workingDpi,
        createdAtOffsetMs: spec.createdAtOffsetMs,
      })
      for (const designSpec of spec.designs) this.insertDesign(batch, designSpec)
      this.recomputeBatchStatus(batch)
      if (spec.pack) {
        const job = this.pack(batch.id, {})
        this.settleJob(job.jobId)
        const integrity = spec.integrity ?? 'pass'
        if (integrity !== 'none') {
          const check = this.runIntegrityCheck(batch.id)
          this.settleJob(check.jobId)
          if (integrity === 'fail') this.forceIntegrityFailure(batch.id)
        }
      }
      for (const format of spec.exportFormats ?? []) {
        const accepted = this.createExport(batch.id, format, true)
        this.settleJob(accepted.jobId)
      }
    }
  }

  private insertBatch(input: {
    id?: string
    name: string
    rollWidthCm: number
    marginMm: number
    edgeMarginMm: number
    workingDpi: number
    createdAtOffsetMs?: number
  }): MockBatchRecord {
    const created = isoNow(input.createdAtOffsetMs ?? -86_400_000)
    const record: MockBatchRecord = {
      id: input.id ?? uuid(),
      name: input.name,
      status: 'collecting',
      rollWidthCm: input.rollWidthCm,
      marginMm: input.marginMm,
      edgeMarginMm: input.edgeMarginMm,
      workingDpi: input.workingDpi,
      designIds: [],
      sheet: null,
      createdAt: created,
      updatedAt: created,
    }
    this.batches.set(record.id, record)
    return record
  }

  private insertDesign(batch: MockBatchRecord, spec: SeedDesign): MockDesignRecord {
    const asset = MOCK_ASSETS[spec.assetKey] ?? MOCK_ASSETS['sticker-fringe']
    const designId = uuid()
    const originalId = uuid()
    const created = isoNow(-7_200_000)
    const original: MockVersionRecord = {
      id: originalId,
      designId,
      parentId: null,
      stepType: 'original',
      status: 'approved',
      widthPx: asset.widthPx,
      heightPx: asset.heightPx,
      hasAlpha: asset.hasAlpha,
      parameters: { fileName: `${spec.name}.png`, source: 'upload' },
      createdAt: created,
      approvedAt: created,
      rejectedAt: null,
      rejectionReason: null,
      jobId: null,
      assetKey: asset.key,
      variant: asset.hasAlpha ? 'transparent' : 'with-bg',
      viewBox: null,
      hasMask: false,
      hasSvg: false,
    }
    const design: MockDesignRecord = {
      id: designId,
      batchId: batch.id,
      name: spec.name,
      status: 'received',
      garmentColor: spec.garmentColor ?? { kind: 'light' },
      allowRotation: spec.allowRotation ?? true,
      targetWidthCm: spec.targetCm?.[0] ?? null,
      targetHeightCm: spec.targetCm?.[1] ?? null,
      originalVersionId: originalId,
      currentVersionId: originalId,
      pendingVersionId: null,
      betterSourceRequested: spec.betterSourceRequested ?? false,
      notes: spec.notes ?? null,
      versionIds: [originalId],
      createdAt: created,
      updatedAt: created,
      suggestions: null,
    }
    this.versions.set(originalId, original)
    this.designs.set(designId, design)
    batch.designIds.push(designId)

    let parent = original
    for (const step of spec.chain ?? []) {
      const version = this.buildStepVersion(design, parent, step.stepType, step.parameters ?? {})
      version.status = step.status ?? 'approved'
      version.approvedAt = version.status === 'approved' ? isoNow(-3_600_000) : null
      version.rejectedAt = version.status === 'rejected' ? isoNow(-3_600_000) : null
      version.rejectionReason = version.status === 'rejected' ? 'operator rejected' : null
      this.versions.set(version.id, version)
      design.versionIds.push(version.id)
      if (version.status === 'proposed') {
        design.pendingVersionId = version.id
      } else if (version.status === 'approved') {
        design.currentVersionId = version.id
        parent = version
      }
    }

    design.suggestions = this.buildSuggestions(design)
    if (spec.excluded) design.status = 'excluded'
    design.status = this.deriveDesignStatus(design)
    return design
  }

  // ------------------------------------------------------------ derivation

  private deriveDesignStatus(design: MockDesignRecord): DesignStatus {
    if (design.status === 'excluded') return 'excluded'
    if (design.betterSourceRequested) return 'needs-better-source'
    const current = this.versions.get(design.currentVersionId)
    const batch = this.batches.get(design.batchId)
    if (!current || !batch) return 'received'
    const target =
      design.targetWidthCm && design.targetHeightCm
        ? { widthCm: design.targetWidthCm, heightCm: design.targetHeightCm }
        : null
    if (
      current.stepType === 'resize' &&
      current.status === 'approved' &&
      target &&
      matchesTargetPixels(current, target, batch.workingDpi)
    ) {
      return 'ready'
    }
    return current.stepType === 'original' ? 'received' : 'in-progress'
  }

  private refreshDesignStatus(design: MockDesignRecord): void {
    design.status = this.deriveDesignStatus(design)
  }

  /** A proposal whose parent is no longer current is rejected, never rebased. */
  private expireStaleProposals(design: MockDesignRecord): void {
    for (const id of design.versionIds) {
      const version = this.versions.get(id)
      if (!version || version.status !== 'proposed') continue
      if (version.parentId === design.currentVersionId) continue
      version.status = 'rejected'
      version.rejectedAt = isoNow()
      version.rejectionReason = 'stale-parent'
      if (design.pendingVersionId === version.id) design.pendingVersionId = null
    }
  }

  private recomputeBatchStatus(batch: MockBatchRecord): void {
    const included = batch.designIds
      .map((id) => this.designs.get(id))
      .filter((design): design is MockDesignRecord => Boolean(design))
      .filter((design) => design.status !== 'excluded')
    const allReady = included.length > 0 && included.every((design) => design.status === 'ready')
    const sheet = batch.sheet
    const sheetPacked =
      sheet !== null &&
      !sheet.stale &&
      sheet.state === 'valid' &&
      (sheet.integrityReport?.passed ?? false)
    if (sheetPacked) {
      const exported = [...this.exports.values()].some(
        (item) =>
          item.batchId === batch.id &&
          item.status === 'succeeded' &&
          item.sheetRevision === sheet?.revision,
      )
      batch.status = exported ? 'exported' : 'packed'
      return
    }
    batch.status = allReady ? 'ready-to-pack' : 'collecting'
  }

  private invalidateSheets(designId: string): void {
    const design = this.designs.get(designId)
    if (!design) return
    const batch = this.batches.get(design.batchId)
    if (!batch || !batch.sheet) return
    batch.sheet = { ...batch.sheet, stale: true, updatedAt: isoNow() }
    this.recomputeBatchStatus(batch)
  }

  // ---------------------------------------------------------------- steps

  private buildStepVersion(
    design: MockDesignRecord,
    parent: MockVersionRecord,
    stepType: StepType,
    parameters: Record<string, unknown>,
  ): MockVersionRecord {
    const batch = this.batches.get(design.batchId)!
    const dpi = batch.workingDpi
    const version: MockVersionRecord = {
      id: uuid(),
      designId: design.id,
      parentId: parent.id,
      stepType,
      status: 'proposed',
      widthPx: parent.widthPx,
      heightPx: parent.heightPx,
      hasAlpha: parent.hasAlpha,
      parameters: { ...parameters },
      createdAt: isoNow(),
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      jobId: null,
      assetKey: parent.assetKey,
      variant: parent.variant,
      viewBox: parent.viewBox ? { ...parent.viewBox } : null,
      hasMask: parent.hasMask,
      hasSvg: parent.hasSvg,
    }
    const box = version.viewBox ?? fullBox(parent.assetKey)

    switch (stepType) {
      case 'trim':
      case 'crop': {
        const rect = (parameters.cropRect as CropRect | undefined) ?? insetRect(box, 0.06)
        version.viewBox = { ...rect }
        version.widthPx = Math.max(1, Math.round(rect.width))
        version.heightPx = Math.max(1, Math.round(rect.height))
        break
      }
      case 'upscale': {
        const scale = Number(parameters.scale ?? 2)
        version.widthPx = Math.round(box.width * scale)
        version.heightPx = Math.round(box.height * scale)
        break
      }
      case 'vectorize': {
        version.hasSvg = true
        break
      }
      case 'background-removal': {
        const mode = String(parameters.mode ?? 'ai')
        const reusesMask = typeof parameters.maskFromVersionId === 'string'
        version.variant = mode === 'none' && !reusesMask ? 'with-bg' : 'transparent'
        version.hasAlpha = mode !== 'none' || reusesMask
        version.hasMask = mode !== 'none' || reusesMask
        break
      }
      case 'resize': {
        const target =
          (parameters.targetWidthCm as number | undefined) ?? design.targetWidthCm ?? 10
        const targetHeight =
          (parameters.targetHeightCm as number | undefined) ?? design.targetHeightCm ?? 10
        const fitMode = (parameters.fitMode as 'width' | 'height' | 'contain' | undefined) ?? 'contain'
        const usedDpi = Number(parameters.dpi ?? dpi)
        const out = resizeOutputPixels({ widthCm: target, heightCm: targetHeight }, usedDpi, fitMode)
        version.widthPx = out.widthPx
        version.heightPx = out.heightPx
        version.parameters = {
          ...version.parameters,
          targetWidthCm: target,
          targetHeightCm: targetHeight,
          dpi: usedDpi,
        }
        break
      }
      case 'original':
        break
    }
    return version
  }

  private requireProposable(designId: string): { design: MockDesignRecord; current: MockVersionRecord } {
    const design = this.designs.get(designId)
    if (!design) throw new MockProblem(404, 'design-not-found', 'Design not found')
    if (design.status === 'excluded') {
      throw new MockProblem(409, 'invalid-transition', 'Excluded designs cannot be processed')
    }
    if (design.betterSourceRequested) {
      throw new MockProblem(
        409,
        'invalid-transition',
        'This design is flagged as needing a better source',
        'Resume the design or upload a better original first.',
      )
    }
    if (design.pendingVersionId) {
      throw new MockProblem(
        409,
        'proposal-in-flight',
        'A proposal is already waiting for review',
        'Approve or reject the pending proposal before running another step.',
      )
    }
    const current = this.versions.get(design.currentVersionId)
    if (!current) throw new MockProblem(409, 'invalid-transition', 'Design has no current version')
    return { design, current }
  }

  private propose(
    designId: string,
    jobType: Job['type'],
    stepType: StepType,
    parameters: Record<string, unknown>,
  ): JobAccepted {
    const { design, current } = this.requireProposable(designId)
    const batch = this.batches.get(design.batchId)!
    if (stepType === 'resize' && (!design.targetWidthCm || !design.targetHeightCm)) {
      throw new MockProblem(
        422,
        'invalid-target-size',
        'Target size is required',
        'Set the target width and height in cm before proposing the final resize.',
      )
    }
    const versionId = uuid()
    const job = this.enqueueJob({
      batchId: batch.id,
      designId: design.id,
      type: jobType,
      parameters: {
        ...parameters,
        parentVersionId: current.id,
        parentPath: `${batch.id}/designs/${design.id}/versions/${current.id}.png`,
        proposedVersionId: versionId,
        workingDpi: batch.workingDpi,
      },
    })
    return { jobId: job.id, status: job.status, pollUrl: `/api/v1/jobs/${job.id}` }
  }

  // ---------------------------------------------------------------- jobs

  private enqueueJob(input: {
    batchId: string
    designId: string | null
    type: Job['type']
    parameters: Record<string, unknown>
  }): MockJobRecord {
    const job: MockJobRecord = {
      id: uuid(),
      batchId: input.batchId,
      designId: input.designId,
      type: input.type,
      status: 'queued',
      parameters: input.parameters,
      attempts: 0,
      createdAt: isoNow(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      result: null,
      error: null,
    }
    this.jobs.set(job.id, job)
    if (this.jobDelayMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        this.settleJob(job.id)
      }, this.jobDelayMs)
      this.timers.add(timer)
    } else {
      // Tests disable the simulated worker latency entirely.
      this.settleJob(job.id)
    }
    return job
  }

  /** Completes a job now, as the worker would after its simulated delay. */
  settleJob(jobId: string): MockJobRecord | null {
    const job = this.jobs.get(jobId)
    if (!job || job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return job ?? null
    }
    job.status = 'running'
    job.startedAt = isoNow()
    job.attempts += 1

    try {
      switch (job.type) {
        case 'classify':
          this.finishClassify(job)
          break
        case 'pack-sheet':
          this.finishPack(job)
          break
        case 'integrity-check':
          this.finishIntegrityCheck(job)
          break
        case 'export':
          this.finishExport(job)
          break
        default:
          this.finishImageStep(job)
      }
      job.status = 'succeeded'
      job.durationMs = 180 + Math.round(Math.random() * 240)
      job.completedAt = isoNow()
    } catch (error) {
      if (error instanceof MockProblem) {
        job.status = 'failed'
        job.completedAt = isoNow()
        job.durationMs = 90
        job.error = {
          code: error.code,
          message: error.message,
          retryable: error.status < 500 ? error.code === 'stale-revision' : false,
          details: error.detail ? { detail: error.detail } : {},
        }
        if (error.code === 'stale-source') {
          const design = job.designId ? this.designs.get(job.designId) : undefined
          if (design) design.pendingVersionId = null
        }
        return job
      }
      throw error
    } finally {
      const design = job.designId ? this.designs.get(job.designId) : undefined
      if (design) design.updatedAt = isoNow()
    }
    return job
  }

  settleAllJobs(): void {
    for (const job of [...this.jobs.values()]) {
      if (job.status === 'queued' || job.status === 'running') this.settleJob(job.id)
    }
  }

  private fail(code: string, message: string, detail?: string): never {
    throw new MockProblem(409, code, message, detail)
  }

  private finishImageStep(job: MockJobRecord): void {
    const design = job.designId ? this.designs.get(job.designId) : null
    if (!design) this.fail('design-not-found', 'Design no longer exists')
    const parent = this.versions.get(String(job.parameters.parentVersionId))
    if (!parent) this.fail('version-not-found', 'Source version no longer exists')
    // §6.2: a result whose parent is no longer current is discarded, not applied.
    if (parent.id !== design.currentVersionId) {
      this.fail('stale-source', 'Worker result references a stale source version')
    }

    const stepType = stepTypeForJob(job.type, job.parameters)
    if (stepType === 'trim' && job.parameters.mode === 'auto') {
      const asset = MOCK_ASSETS[parent.assetKey]
      const isFullBleed =
        asset?.fullBleed === true && parent.viewBox === null && parent.stepType === 'original'
      if (isFullBleed) {
        throw new MockProblem(
          422,
          'nothing-to-trim',
          'Auto-trim refused on a full-bleed design',
          'All four edges carry content. Use the manual crop tool if you really want to trim.',
        )
      }
    }

    const version = this.buildStepVersion(design, parent, stepType, parametersForVersion(job, stepType))
    version.jobId = job.id
    version.status = 'proposed'
    this.versions.set(version.id, version)
    design.versionIds.push(version.id)
    design.pendingVersionId = version.id
    design.updatedAt = isoNow()

    job.result = {
      outputVersionId: version.id,
      outputPath: `${design.batchId}/designs/${design.id}/versions/${version.id}.png`,
      outputArtifacts: outputArtifactsFor(version),
      metadata: { widthPx: version.widthPx, heightPx: version.heightPx, hasAlpha: version.hasAlpha },
    }
  }

  private finishClassify(job: MockJobRecord): void {
    const design = job.designId ? this.designs.get(job.designId) : null
    if (!design) this.fail('design-not-found', 'Design no longer exists')
    design.suggestions = this.buildSuggestions(design)
    job.result = { suggestions: design.suggestions, metadata: { classifier: 'mock-v1' } }
  }

  private buildSuggestions(design: MockDesignRecord): ClassifierSuggestions {
    const current = this.versions.get(design.currentVersionId)!
    const asset = MOCK_ASSETS[current.assetKey]
    const target =
      design.targetWidthCm && design.targetHeightCm
        ? { widthCm: design.targetWidthCm, heightCm: design.targetHeightCm }
        : { widthCm: 20, heightCm: 20 }
    const dpi = effectiveDpi({ widthPx: current.widthPx, heightPx: current.heightPx }, target)
    const flat = asset?.key === 'flat-logo-black' || asset?.key === 'wide-lockup'
    const box = current.viewBox ?? fullBox(current.assetKey)
    return {
      designId: design.id,
      status: 'ready',
      analyzedAt: current.createdAt,
      source: {
        widthPx: current.widthPx,
        heightPx: current.heightPx,
        effectiveDpiAtTarget: dpi,
      },
      features: {
        flatColorRatio: flat ? 0.82 : asset?.fullBleed ? 0.24 : 0.46,
        edgeDensity: asset?.fullBleed ? 0.61 : 0.28,
        uniqueColorCount: flat ? 6 : 214,
        sampledBackground: {
          kind: current.hasAlpha ? 'transparent' : asset?.key === 'thin-signature' ? 'gray' : 'white',
          hex: asset?.key === 'thin-signature' ? '#8f8a80' : null,
          confidence: 0.86,
        },
        fullBleed: asset?.fullBleed === true,
      },
      suggestions: {
        trim: {
          recommended: !asset?.fullBleed,
          reason: asset?.fullBleed
            ? 'All four edges carry content — an automatic trim would cut artwork.'
            : 'Uniform margins detected around the artwork.',
          box: asset?.fullBleed ? null : insetRect(box, 0.06),
          paddingPx: 12,
          tolerance: 24,
        },
        upscale: {
          model: flat ? 'realesrgan-x4plus-anime' : 'realesrgan-x4plus',
          scale: (dpi ?? 300) < 120 ? 4 : 2,
          reason:
            dpi !== null && dpi < 150
              ? `Effective DPI at the target size is ${Math.round(dpi)}.`
              : 'Resolution already meets the working DPI.',
          confidence: dpi !== null && dpi < 150 ? 0.9 : 0.35,
        },
      },
    }
  }

  // ------------------------------------------------------------ versions

  approveVersion(designId: string, versionId: string): DesignDetail {
    const design = this.requireDesign(designId)
    const version = this.requireVersion(design, versionId)
    if (version.parentId !== design.currentVersionId) {
      const becameStale = version.status === 'proposed' || version.rejectionReason === 'stale-parent'
      this.expireStaleProposals(design)
      if (becameStale) {
        throw new MockProblem(
          409,
          'stale-proposal',
          'This proposal is no longer valid',
          'Its parent is not the current version, so it was rejected instead of rebased.',
        )
      }
      throw new MockProblem(409, 'invalid-transition', 'Only a proposed version can be approved')
    }
    if (version.status !== 'proposed') {
      throw new MockProblem(409, 'invalid-transition', 'Only a proposed version can be approved')
    }
    const batch = this.batches.get(design.batchId)!
    if (version.stepType === 'resize') {
      const target =
        design.targetWidthCm && design.targetHeightCm
          ? { widthCm: design.targetWidthCm, heightCm: design.targetHeightCm }
          : null
      if (!target || !matchesTargetPixels(version, target, batch.workingDpi)) {
        throw new MockProblem(
          422,
          'invalid-target-size',
          'The resized pixels do not match the target size at the working DPI',
        )
      }
    }
    version.status = 'approved'
    version.approvedAt = isoNow()
    design.currentVersionId = version.id
    if (design.pendingVersionId === version.id) design.pendingVersionId = null
    this.expireStaleProposals(design)
    this.refreshDesignStatus(design)
    design.updatedAt = isoNow()
    this.invalidateSheets(design.id)
    this.recomputeBatchStatus(batch)
    return this.designDetail(design.id)
  }

  rejectVersion(
    designId: string,
    versionId: string,
    reason?: string | null,
  ): { design: DesignDetail; nextActions: (typeof NEXT_ACTIONS)[number][] } {
    const design = this.requireDesign(designId)
    const version = this.requireVersion(design, versionId)
    if (version.status !== 'proposed') {
      throw new MockProblem(409, 'invalid-transition', 'Only a proposed version can be rejected')
    }
    version.status = 'rejected'
    version.rejectedAt = isoNow()
    version.rejectionReason = reason ?? null
    if (design.pendingVersionId === version.id) design.pendingVersionId = null
    this.refreshDesignStatus(design)
    design.updatedAt = isoNow()
    return { design: this.designDetail(design.id), nextActions: [...NEXT_ACTIONS] }
  }

  revert(designId: string, targetVersionId: string): DesignDetail {
    const design = this.requireDesign(designId)
    const target = this.requireVersion(design, targetVersionId)
    if (target.status !== 'approved') {
      throw new MockProblem(409, 'version-not-approved', 'Only an approved version can become current')
    }
    if (design.currentVersionId === target.id) {
      throw new MockProblem(409, 'invalid-transition', 'That version is already current')
    }
    design.currentVersionId = target.id
    this.expireStaleProposals(design)
    this.refreshDesignStatus(design)
    design.updatedAt = isoNow()
    const batch = this.batches.get(design.batchId)!
    this.invalidateSheets(design.id)
    this.recomputeBatchStatus(batch)
    return this.designDetail(design.id)
  }

  /** Undo is sugar for reverting to the parent of the current version. */
  undo(designId: string): DesignDetail {
    const design = this.requireDesign(designId)
    const current = this.versions.get(design.currentVersionId)
    if (!current?.parentId) {
      throw new MockProblem(409, 'invalid-transition', 'There is nothing to undo')
    }
    return this.revert(designId, current.parentId)
  }

  // --------------------------------------------------------------- designs

  requireDesign(designId: string): MockDesignRecord {
    const design = this.designs.get(designId)
    if (!design) throw new MockProblem(404, 'design-not-found', 'Design not found')
    return design
  }

  requireVersion(design: MockDesignRecord, versionId: string): MockVersionRecord {
    const version = this.versions.get(versionId)
    if (!version || version.designId !== design.id) {
      throw new MockProblem(404, 'version-not-found', 'Version not found for this design')
    }
    return version
  }

  requireBatch(batchId: string): MockBatchRecord {
    const batch = this.batches.get(batchId)
    if (!batch) throw new MockProblem(404, 'batch-not-found', 'Batch not found')
    return batch
  }

  updateDesign(
    designId: string,
    patch: Partial<{
      name: string
      garmentColor: GarmentColor
      allowRotation: boolean
      targetWidthCm: number | null
      targetHeightCm: number | null
      notes: string | null
    }>,
  ): DesignDetail {
    const design = this.requireDesign(designId)
    const batch = this.batches.get(design.batchId)!
    const targetChanged =
      (patch.targetWidthCm !== undefined && patch.targetWidthCm !== design.targetWidthCm) ||
      (patch.targetHeightCm !== undefined && patch.targetHeightCm !== design.targetHeightCm)
    if (patch.targetWidthCm !== undefined) design.targetWidthCm = patch.targetWidthCm
    if (patch.targetHeightCm !== undefined) design.targetHeightCm = patch.targetHeightCm
    if (patch.name !== undefined) design.name = patch.name
    if (patch.garmentColor !== undefined) design.garmentColor = patch.garmentColor
    if (patch.allowRotation !== undefined && patch.allowRotation !== design.allowRotation) {
      design.allowRotation = patch.allowRotation
      this.invalidateSheets(design.id)
    }
    if (patch.notes !== undefined) design.notes = patch.notes
    if (targetChanged) {
      if (design.targetWidthCm !== null && design.targetHeightCm !== null) {
        if (design.targetWidthCm <= 0 || design.targetHeightCm <= 0) {
          throw new MockProblem(422, 'invalid-target-size', 'Target dimensions must be positive')
        }
      }
      this.invalidateSheets(design.id)
    }
    if (targetChanged || patch.name !== undefined) {
      this.refreshDesignStatus(design)
      this.recomputeBatchStatus(batch)
    }
    design.updatedAt = isoNow()
    return this.designDetail(design.id)
  }

  setExcluded(designId: string, excluded: boolean): DesignDetail {
    const design = this.requireDesign(designId)
    const batch = this.batches.get(design.batchId)!
    if (excluded) {
      design.status = 'excluded'
    } else {
      // Leaving `excluded` recomputes the status from the current version and
      // the sticky better-source flag.
      design.status = 'received'
      this.refreshDesignStatus(design)
    }
    design.updatedAt = isoNow()
    this.invalidateSheets(design.id)
    this.recomputeBatchStatus(batch)
    return this.designDetail(design.id)
  }

  requestBetterSource(designId: string): DesignDetail {
    const design = this.requireDesign(designId)
    const batch = this.batches.get(design.batchId)!
    design.betterSourceRequested = true
    if (design.status !== 'excluded') design.status = 'needs-better-source'
    design.updatedAt = isoNow()
    this.invalidateSheets(design.id)
    this.recomputeBatchStatus(batch)
    return this.designDetail(design.id)
  }

  resumeDesign(designId: string): DesignDetail {
    const design = this.requireDesign(designId)
    const batch = this.batches.get(design.batchId)!
    const before = design.status
    design.betterSourceRequested = false
    if (design.status !== 'excluded') this.refreshDesignStatus(design)
    design.updatedAt = isoNow()
    if (before !== design.status) this.invalidateSheets(design.id)
    this.recomputeBatchStatus(batch)
    return this.designDetail(design.id)
  }

  uploadDesign(
    batchId: string,
    input: {
      name?: string
      garmentColorKind?: GarmentColor['kind']
      garmentColorHex?: string | null
      targetWidthCm?: number | null
      targetHeightCm?: number | null
      assetKey?: string
      widthPx?: number
      heightPx?: number
      readyToPack?: boolean
    },
  ): DesignDetail {
    const batch = this.requireBatch(batchId)
    const assetKey = input.assetKey ?? pickAssetKey(input.name ?? 'upload')
    const asset = MOCK_ASSETS[assetKey] ?? MOCK_ASSETS['sticker-fringe']
    const designId = uuid()
    const versionId = uuid()
    const now = isoNow()
    const widthPx = input.widthPx ?? asset.widthPx
    const heightPx = input.heightPx ?? asset.heightPx
    const deriveCm = (pixels: number) =>
      Math.round(((pixels * 2.54) / batch.workingDpi) * 10000) / 10000
    const targetWidthCm = input.readyToPack
      ? (input.targetWidthCm ?? deriveCm(widthPx))
      : (input.targetWidthCm ?? null)
    const targetHeightCm = input.readyToPack
      ? (input.targetHeightCm ?? deriveCm(heightPx))
      : (input.targetHeightCm ?? null)
    const original: MockVersionRecord = {
      id: versionId,
      designId,
      parentId: null,
      stepType: 'original',
      status: 'approved',
      widthPx,
      heightPx,
      hasAlpha: asset.hasAlpha,
      parameters: { fileName: input.name ?? `${asset.label}.png`, source: 'upload' },
      createdAt: now,
      approvedAt: now,
      rejectedAt: null,
      rejectionReason: null,
      jobId: null,
      assetKey,
      variant: asset.hasAlpha ? 'transparent' : 'with-bg',
      viewBox: null,
      hasMask: false,
      hasSvg: false,
    }
    const readyVersionId = input.readyToPack ? uuid() : null
    const readyVersion: MockVersionRecord | null = readyVersionId
      ? {
          ...original,
          id: readyVersionId,
          parentId: versionId,
          stepType: 'resize',
          parameters: { source: 'ready-import', preparedFromVersionId: versionId },
        }
      : null

    const design: MockDesignRecord = {
      id: designId,
      batchId: batch.id,
      name: (input.name ?? asset.label).slice(0, 200),
      status: input.readyToPack ? 'ready' : 'received',
      garmentColor: garmentColorFor(input.garmentColorKind, input.garmentColorHex),
      allowRotation: true,
      targetWidthCm,
      targetHeightCm,
      originalVersionId: versionId,
      currentVersionId: readyVersionId ?? versionId,
      pendingVersionId: null,
      betterSourceRequested: false,
      notes: null,
      versionIds: readyVersionId ? [versionId, readyVersionId] : [versionId],
      createdAt: now,
      updatedAt: now,
      suggestions: null,
    }
    this.versions.set(versionId, original)
    if (readyVersion) this.versions.set(readyVersion.id, readyVersion)
    this.designs.set(designId, design)
    batch.designIds.push(designId)
    batch.updatedAt = now
    if (!input.readyToPack) {
      this.enqueueJob({ batchId: batch.id, designId, type: 'classify', parameters: {} })
    }
    if (batch.sheet) this.invalidateSheets(designId)
    this.recomputeBatchStatus(batch)
    return this.designDetail(designId)
  }

  // -------------------------------------------------------------- batches

  createBatch(input: {
    name: string
    rollWidthCm?: number | null
    marginMm?: number | null
    edgeMarginMm?: number | null
    workingDpi?: number | null
  }): BatchSummary {
    if (!input.name || input.name.trim().length === 0) {
      throw new MockProblem(422, 'invalid-target-size', 'Batch name is required')
    }
    const roll = input.rollWidthCm ?? this.settings.defaultRollWidthCm
    const margin = input.marginMm ?? this.settings.defaultMarginMm
    const edge = input.edgeMarginMm ?? this.settings.defaultEdgeMarginMm
    const dpi = input.workingDpi ?? this.settings.workingDpi
    if (roll <= 0 || margin < 0 || edge < 0 || dpi < 72 || dpi > 1200) {
      throw new MockProblem(422, 'invalid-target-size', 'Batch geometry is out of range')
    }
    const batch = this.insertBatch({
      name: input.name.trim().slice(0, 200),
      rollWidthCm: roll,
      marginMm: margin,
      edgeMarginMm: edge,
      workingDpi: dpi,
      createdAtOffsetMs: 0,
    })
    return this.batchSummary(batch)
  }

  updateBatch(
    batchId: string,
    patch: Partial<{ name: string; rollWidthCm: number; marginMm: number; edgeMarginMm: number }>,
  ): BatchSummary {
    const batch = this.requireBatch(batchId)
    if (patch.name !== undefined) batch.name = patch.name
    if (patch.rollWidthCm !== undefined) batch.rollWidthCm = patch.rollWidthCm
    if (patch.marginMm !== undefined) batch.marginMm = patch.marginMm
    if (patch.edgeMarginMm !== undefined) batch.edgeMarginMm = patch.edgeMarginMm
    batch.updatedAt = isoNow()
    // Working DPI is immutable for an existing batch; geometry invalidates the sheet.
    if (batch.sheet) {
      batch.sheet = {
        ...batch.sheet,
        stale: true,
        widthCm: batch.rollWidthCm,
        widthPx: pixelsForCentimeters(batch.rollWidthCm, batch.workingDpi),
        updatedAt: isoNow(),
      }
    }
    this.recomputeBatchStatus(batch)
    return this.batchSummary(batch)
  }

  // --------------------------------------------------------------- sheets

  pack(batchId: string, options: Record<string, unknown>): JobAccepted {
    const batch = this.requireBatch(batchId)
    const included = batch.designIds
      .map((id) => this.designs.get(id)!)
      .filter((design) => design.status !== 'excluded')
    // Precondition order follows docs/domain-model.md §6.7.
    if (included.length === 0) {
      throw new MockProblem(409, 'batch-not-ready', 'The batch has no included designs')
    }
    const notReady = included.filter((design) => design.status !== 'ready')
    if (notReady.length > 0) {
      throw new MockProblem(
        409,
        'design-not-ready',
        'Every included design must be ready before packing',
        `${notReady.length} not ready: ${notReady.map((design) => design.name).join(', ')}`,
      )
    }
    const usable = usableRollWidthCm(batch.rollWidthCm, batch.edgeMarginMm)
    const tooWide = included.find(
      (design) => design.targetWidthCm !== null && design.targetWidthCm > usable,
    )
    if (tooWide) {
      throw new MockProblem(
        422,
        'design-exceeds-roll',
        'A design is wider than the roll',
        `${tooWide.name} targets ${tooWide.targetWidthCm} cm; the maximum is ${usable.toFixed(1)} cm. Scale its target or exclude it — the packer never scales artwork.`,
      )
    }
    const job = this.enqueueJob({
      batchId: batch.id,
      designId: null,
      type: 'pack-sheet',
      parameters: {
        ...options,
        snapshot: included.map((design) => ({
          designId: design.id,
          versionId: design.currentVersionId,
          designName: design.name,
          widthCm: design.targetWidthCm,
          heightCm: design.targetHeightCm,
          allowRotation: design.allowRotation,
        })),
        geometry: {
          rollWidthCm: batch.rollWidthCm,
          marginMm: batch.marginMm,
          edgeMarginMm: batch.edgeMarginMm,
          workingDpi: batch.workingDpi,
        },
      },
    })
    return { jobId: job.id, status: job.status, pollUrl: `/api/v1/jobs/${job.id}` }
  }

  private finishPack(job: MockJobRecord): void {
    const batch = this.requireBatch(job.batchId)
    const snapshot = job.parameters.snapshot as {
      designId: string
      versionId: string
      designName: string
      widthCm: number
      heightCm: number
      allowRotation: boolean
    }[]
    const placements = shelfPlacements(snapshot, batch, this.versions)
    const heightCm = sheetHeightFor(placements, batch)
    const revision = (batch.sheet?.revision ?? 0) + 1
    const sheet: Sheet = {
      id: uuid(),
      batchId: batch.id,
      revision,
      state: 'unchecked',
      widthCm: batch.rollWidthCm,
      heightCm: round2(heightCm),
      widthPx: pixelsForCentimeters(batch.rollWidthCm, batch.workingDpi),
      heightPx: pixelsForCentimeters(heightCm, batch.workingDpi),
      dpi: batch.workingDpi,
      placements,
      integrityReport: null,
      stale: false,
      estimatedCost: {
        amount: round2(heightCm * this.settings.pricePerCm),
        currency: this.settings.currency,
      },
      createdAt: isoNow(),
      updatedAt: isoNow(),
    }
    batch.sheet = sheet
    batch.updatedAt = isoNow()
    this.recomputeBatchStatus(batch)
    job.result = {
      outputPath: `${batch.id}/sheets/${sheet.id}/${sheet.revision}/placements.json`,
      metadata: { revision: sheet.revision, placements: placements.length, heightCm: sheet.heightCm },
    }
  }

  updatePlacements(
    batchId: string,
    revision: number,
    placements: ManualPlacement[],
  ): Sheet {
    const batch = this.requireBatch(batchId)
    const sheet = batch.sheet
    if (!sheet) throw new MockProblem(404, 'sheet-not-found', 'This batch has no sheet yet')
    if (revision !== sheet.revision) {
      throw new MockProblem(
        409,
        'stale-revision',
        'The sheet changed while you were editing',
        `Expected revision ${sheet.revision}, received ${revision}.`,
      )
    }
    const next: Placement[] = placements.map((input) => {
      const design = this.requireDesign(input.designId)
      const version = this.requireVersion(design, input.versionId)
      if (version.status !== 'approved' || design.currentVersionId !== version.id) {
        throw new MockProblem(409, 'invalid-transition', 'Placements must reference current approved versions')
      }
      if (![0, 90, 180, 270].includes(input.rotationDeg)) {
        throw new MockProblem(422, 'invalid-target-size', 'Rotations must be multiples of 90 degrees')
      }
      const rotated = rotationSwapsAxis(input.rotationDeg)
      const widthPx = rotated ? version.heightPx : version.widthPx
      const heightPx = rotated ? version.widthPx : version.heightPx
      // The design's declared target stays authoritative for cm; px come from
      // the immutable approved version. Nothing is ever resampled.
      const widthCm =
        (rotated ? design.targetHeightCm : design.targetWidthCm) ??
        centimetersForPixels(widthPx, sheet.dpi)
      const heightCm =
        (rotated ? design.targetWidthCm : design.targetHeightCm) ??
        centimetersForPixels(heightPx, sheet.dpi)
      const maxX = Math.max(0, sheet.widthCm - widthCm)
      const maxY = Math.max(0, sheet.heightCm - heightCm)
      return {
        designId: design.id,
        versionId: version.id,
        designName: design.name,
        // Out-of-sheet geometry is clamped rather than silently dropped.
        xCm: round4(clamp(input.xCm, 0, maxX)),
        yCm: round4(clamp(input.yCm, 0, maxY)),
        widthCm: round4(widthCm),
        heightCm: round4(heightCm),
        widthPx,
        heightPx,
        rotationDeg: input.rotationDeg,
      }
    })
    const bottom = next.reduce((max, item) => Math.max(max, item.yCm + item.heightCm), 0)
    batch.sheet = {
      ...sheet,
      revision: sheet.revision + 1,
      state: 'unchecked',
      stale: false,
      integrityReport: null,
      // The sheet grows to fit; a manual edit never crops artwork.
      heightCm: round2(Math.max(sheet.heightCm, bottom)),
      heightPx: pixelsForCentimeters(Math.max(sheet.heightCm, bottom), sheet.dpi),
      placements: next,
      estimatedCost: {
        amount: round2(Math.max(sheet.heightCm, bottom) * this.settings.pricePerCm),
        currency: this.settings.currency,
      },
      updatedAt: isoNow(),
    }
    this.recomputeBatchStatus(batch)
    return batch.sheet
  }

  runIntegrityCheck(batchId: string): JobAccepted {
    const batch = this.requireBatch(batchId)
    if (!batch.sheet) throw new MockProblem(404, 'sheet-not-found', 'Pack the batch first')
    const job = this.enqueueJob({
      batchId: batch.id,
      designId: null,
      type: 'integrity-check',
      parameters: {
        revision: batch.sheet.revision,
        placements: batch.sheet.placements,
        geometry: {
          rollWidthCm: batch.rollWidthCm,
          marginMm: batch.marginMm,
          edgeMarginMm: batch.edgeMarginMm,
          workingDpi: batch.workingDpi,
          alphaThreshold: this.settings.packer.alphaThreshold,
        },
      },
    })
    return { jobId: job.id, status: job.status, pollUrl: `/api/v1/jobs/${job.id}` }
  }

  private finishIntegrityCheck(job: MockJobRecord): void {
    const batch = this.requireBatch(job.batchId)
    const sheet = batch.sheet
    if (!sheet) this.fail('sheet-not-found', 'There is no sheet to check')
    const revision = Number(job.parameters.revision)
    if (revision !== sheet.revision) {
      this.fail('stale-revision', 'The sheet changed before the check finished')
    }
    const geometry = job.parameters.geometry as {
      rollWidthCm: number
      marginMm: number
      edgeMarginMm: number
      workingDpi: number
    }
    const report = integrityReportFor(sheet, geometry, this.settings.currency)
    batch.sheet = {
      ...sheet,
      state: report.passed ? 'valid' : ('invalid' as SheetState),
      integrityReport: report,
      updatedAt: isoNow(),
    }
    this.recomputeBatchStatus(batch)
    job.result = { integrityReport: report, metadata: { revision } }
  }

  /** Test/inspection helper: turn the current sheet into a failing arrangement. */
  forceIntegrityFailure(batchId: string): void {
    const batch = this.requireBatch(batchId)
    if (!batch.sheet || batch.sheet.placements.length < 2) return
    const [first, second] = batch.sheet.placements
    const overlapping = batch.sheet.placements.map((placement) =>
      placement.designId === second.designId
        ? { ...placement, xCm: first.xCm + 0.5, yCm: first.yCm + 0.5 }
        : placement,
    )
    batch.sheet = {
      ...batch.sheet,
      revision: batch.sheet.revision + 1,
      state: 'unchecked',
      integrityReport: null,
      placements: overlapping,
      updatedAt: isoNow(),
    }
  }

  // -------------------------------------------------------------- exports

  createExport(batchId: string, format: ExportFormat, includePreview = true): JobAccepted {
    const batch = this.requireBatch(batchId)
    const sheet = batch.sheet
    if (!sheet) throw new MockProblem(404, 'sheet-not-found', 'Pack the batch first')
    if (sheet.stale) {
      throw new MockProblem(409, 'sheet-stale', 'The sheet is stale', 'Pack again before exporting.')
    }
    const passed =
      sheet.state === 'valid' && (sheet.integrityReport?.passed ?? false) && !sheet.stale
    if (!passed) {
      throw new MockProblem(
        409,
        'sheet-integrity-failed',
        'Export is blocked',
        'This sheet revision has no passing integrity report.',
      )
    }
    const tooTallForLayered = Math.max(sheet.widthPx, sheet.heightPx) > LAYERED_PSD_LIMIT_PX
    if (format === 'layered-psd' && tooTallForLayered) {
      throw new MockProblem(
        422,
        'export-format-unavailable',
        'Layered PSD cannot exceed 30,000 px per side',
        `This sheet is ${sheet.heightPx} px tall. Use the psd-bundle format instead.`,
      )
    }
    if (format === 'layered-psb') {
      throw new MockProblem(
        422,
        'export-format-unavailable',
        'The layered PSB writer is not validated yet',
        'ADR 0003 keeps layered PSB optional until a strip-based writer passes Photoshop smoke tests.',
      )
    }
    const job = this.enqueueJob({
      batchId: batch.id,
      designId: null,
      type: 'export',
      parameters: { format, includePreview, revision: sheet.revision, dpi: sheet.dpi },
    })
    return { jobId: job.id, status: job.status, pollUrl: `/api/v1/jobs/${job.id}` }
  }

  private finishExport(job: MockJobRecord): void {
    const batch = this.requireBatch(job.batchId)
    const sheet = batch.sheet
    if (!sheet) this.fail('sheet-not-found', 'There is no sheet to export')
    if (Number(job.parameters.revision) !== sheet.revision || sheet.stale) {
      this.fail('stale-sheet', 'The sheet changed while the export ran')
    }
    const format = job.parameters.format as ExportFormat
    const includePreview = Boolean(job.parameters.includePreview)
    const exportId = uuid()
    const artifact = (name: ExportArtifact['name'], contentType: string, sizeBytes: number): ExportArtifact => ({
      name,
      contentType,
      sizeBytes,
      downloadUrl: `/api/v1/exports/${exportId}/download?artifact=${name}`,
    })
    const artifacts: ExportArtifact[] = []
    if (format !== 'psd-bundle') artifacts.push(artifact('flat', 'image/png', 4_800_000))
    if (format === 'layered-psd' || format === 'layered-psb') {
      artifacts.push(artifact('layered', 'image/vnd.adobe.photoshop', 12_400_000))
    }
    if (format === 'psd-bundle') {
      artifacts.push(
        artifact('flat', 'image/png', 4_800_000),
        artifact('jsx', 'application/x-photoshop-script', 6_400),
      )
    }
    artifacts.push(artifact('manifest', 'application/json', 12_800))
    if (includePreview) artifacts.push(artifact('preview', 'image/png', 180_000))
    const record: MockExportRecord = {
      id: exportId,
      batchId: batch.id,
      sheetRevision: sheet.revision,
      format,
      status: 'succeeded',
      dpi: sheet.dpi,
      artifacts,
      integrityReport: sheet.integrityReport ?? null,
      blockedReason: null,
      error: null,
      createdAt: job.createdAt,
      completedAt: isoNow(),
    }
    this.exports.set(exportId, record)
    batch.updatedAt = isoNow()
    this.recomputeBatchStatus(batch)
    job.result = {
      exportId,
      outputPath: `${batch.id}/exports/${exportId}`,
      metadata: { artifacts: artifacts.map((item) => item.name) },
    }
  }

  // ------------------------------------------------------------- read side

  versionsOf(designId: string): MockVersionRecord[] {
    const design = this.designs.get(designId)
    if (!design) return []
    return design.versionIds
      .map((id) => this.versions.get(id))
      .filter((version): version is MockVersionRecord => Boolean(version))
  }

  newestFirst(designId: string): MockVersionRecord[] {
    return this.versionsOf(designId).slice().reverse()
  }

  versionSummary(version: MockVersionRecord): VersionSummary {
    return {
      id: version.id,
      designId: version.designId,
      parentId: version.parentId,
      stepType: version.stepType,
      status: version.status,
      widthPx: version.widthPx,
      heightPx: version.heightPx,
      hasAlpha: version.hasAlpha,
      createdAt: version.createdAt,
      fileUrl: `/api/v1/designs/${version.designId}/versions/${version.id}/file`,
    }
  }

  designVersion(version: MockVersionRecord): DesignVersion {
    return {
      ...this.versionSummary(version),
      parameters: version.parameters,
      artifacts: {
        maskUrl: version.hasMask
          ? `/api/v1/designs/${version.designId}/versions/${version.id}/mask`
          : null,
        svgUrl: version.hasSvg
          ? `/api/v1/designs/${version.designId}/versions/${version.id}/svg`
          : null,
      },
      approvedAt: version.approvedAt,
      rejectedAt: version.rejectedAt,
    }
  }

  designSummary(design: MockDesignRecord): DesignSummary {
    const current = this.versions.get(design.currentVersionId)
    const pending = design.pendingVersionId ? this.versions.get(design.pendingVersionId) : undefined
    const target =
      design.targetWidthCm && design.targetHeightCm
        ? { widthCm: design.targetWidthCm, heightCm: design.targetHeightCm }
        : null
    return {
      id: design.id,
      batchId: design.batchId,
      name: design.name,
      status: design.status,
      garmentColor: design.garmentColor,
      allowRotation: design.allowRotation,
      originalVersionId: design.originalVersionId,
      currentVersionId: design.currentVersionId,
      targetWidthCm: design.targetWidthCm,
      targetHeightCm: design.targetHeightCm,
      effectiveDpi: current && target
        ? round2(effectiveDpi({ widthPx: current.widthPx, heightPx: current.heightPx }, target) ?? 0)
        : null,
      versionCount: design.versionIds.length,
      currentVersion: current ? this.versionSummary(current) : null,
      pendingVersion: pending ? this.versionSummary(pending) : null,
      notes: design.notes,
      createdAt: design.createdAt,
      updatedAt: design.updatedAt,
    }
  }

  designDetail(designId: string): DesignDetail {
    const design = this.requireDesign(designId)
    return {
      ...this.designSummary(design),
      versions: this.newestFirst(designId).map((version) => this.designVersion(version)),
    }
  }

  batchSummary(batch: MockBatchRecord): BatchSummary {
    const included = batch.designIds.map((id) => this.designs.get(id)!).filter(Boolean)
    return {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      rollWidthCm: batch.rollWidthCm,
      marginMm: batch.marginMm,
      edgeMarginMm: batch.edgeMarginMm,
      workingDpi: batch.workingDpi,
      designCount: included.length,
      readyCount: included.filter((design) => design.status === 'ready').length,
      excludedCount: included.filter((design) => design.status === 'excluded').length,
      sheetHeightCm: batch.sheet?.heightCm ?? null,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    }
  }

  batchDetail(batchId: string): BatchDetail {
    const batch = this.requireBatch(batchId)
    return {
      ...this.batchSummary(batch),
      designs: batch.designIds
        .map((id) => this.designs.get(id))
        .filter((design): design is MockDesignRecord => Boolean(design))
        .map((design) => this.designSummary(design)),
      sheet: batch.sheet,
    }
  }

  listBatches(query: { status?: BatchStatus; limit?: number; offset?: number }) {
    const all = [...this.batches.values()]
      .map((batch) => this.batchSummary(batch))
      .filter((item) => !query.status || item.status === query.status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    return { items: all.slice(offset, offset + limit), total: all.length }
  }

  listJobs(batchId: string, query: { status?: Job['status']; type?: Job['type']; limit?: number }) {
    this.requireBatch(batchId)
    return this.filterJobs(
      (job) => job.batchId === batchId,
      query,
      50,
    )
  }

  listAllJobs(query: { status?: Job['status']; type?: Job['type']; limit?: number }) {
    return this.filterJobs(() => true, query, 200)
  }

  private filterJobs(
    where: (job: MockJobRecord) => boolean,
    query: { status?: Job['status']; type?: Job['type']; limit?: number },
    defaultLimit: number,
  ) {
    const matching = [...this.jobs.values()]
      .filter(where)
      .filter((job) => !query.status || job.status === query.status)
      .filter((job) => !query.type || job.type === query.type)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return {
      items: matching.slice(0, query.limit ?? defaultLimit).map((job) => this.toJob(job)),
      total: matching.length,
    }
  }

  toJob(job: MockJobRecord): Job {
    return {
      id: job.id,
      batchId: job.batchId,
      designId: job.designId,
      type: job.type,
      status: job.status,
      parameters: job.parameters,
      result: job.result,
      error: job.error,
      attempts: job.attempts,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
    }
  }

  getJob(jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new MockProblem(404, 'job-not-found', 'Job not found')
    return this.toJob(job)
  }

  cancelJob(jobId: string): Job {
    const job = this.jobs.get(jobId)
    if (!job) throw new MockProblem(404, 'job-not-found', 'Job not found')
    if (job.status !== 'queued') {
      throw new MockProblem(409, 'invalid-transition', 'Only a queued job can be cancelled')
    }
    job.status = 'cancelled'
    job.completedAt = isoNow()
    const design = job.designId ? this.designs.get(job.designId) : undefined
    if (design && design.pendingVersionId && job.parameters.proposedVersionId === design.pendingVersionId) {
      design.pendingVersionId = null
    }
    return this.toJob(job)
  }

  listExports(batchId: string) {
    this.requireBatch(batchId)
    return {
      items: [...this.exports.values()]
        .filter((item) => item.batchId === batchId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((item) => this.toExport(item)),
    }
  }

  toExport(record: MockExportRecord): Export {
    return {
      id: record.id,
      batchId: record.batchId,
      sheetRevision: record.sheetRevision,
      format: record.format,
      status: record.status,
      dpi: record.dpi,
      artifacts: record.artifacts,
      integrityReport: record.integrityReport,
      blockedReason: record.blockedReason,
      error: record.error,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
    }
  }

  getExport(exportId: string): Export {
    const record = this.exports.get(exportId)
    if (!record) throw new MockProblem(404, 'export-not-found', 'Export not found')
    return this.toExport(record)
  }

  sheet(batchId: string): Sheet {
    const batch = this.requireBatch(batchId)
    if (!batch.sheet) throw new MockProblem(404, 'sheet-not-found', 'This batch has no sheet yet')
    return batch.sheet
  }

  suggestions(designId: string): ClassifierSuggestions {
    const design = this.requireDesign(designId)
    if (design.suggestions) return design.suggestions
    return { designId, status: 'pending' }
  }

  /** Bytes for a version file, an artifact, or an export download. */
  fileFor(version: MockVersionRecord, kind: 'file' | 'mask' | 'svg'): string {
    if (kind === 'svg' && version.hasSvg) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${version.widthPx}" height="${version.heightPx}" viewBox="0 0 ${version.widthPx} ${version.heightPx}"><rect width="100%" height="100%" fill="#ff6a3d"/></svg>`
    }
    if (kind === 'mask') {
      return renderAssetSvg(version.assetKey, 'mask', version.viewBox ?? null)
    }
    return renderAssetSvg(version.assetKey, version.variant, version.viewBox ?? null)
  }

  exportArtifactBody(exportRecord: MockExportRecord, name: ExportArtifact['name']): {
    body: string
    contentType: string
  } {
    const sheet = this.batches.get(exportRecord.batchId)?.sheet
    switch (name) {
      case 'manifest':
        return {
          body: JSON.stringify(
            {
              schemaVersion: '1.0',
              exportId: exportRecord.id,
              sheetRevision: exportRecord.sheetRevision,
              dpi: exportRecord.dpi,
              placements: sheet?.placements ?? [],
            },
            null,
            2,
          ),
          contentType: 'application/json',
        }
      case 'jsx':
        return {
          body: `// PrintSheet rebuild bundle (mock)\nvar doc = app.documents.add(UnitValue(${sheet?.widthCm ?? 58}, 'cm'));\n${(sheet?.placements ?? [])
            .map(
              (placement) =>
                `// ${placement.designName} @ ${placement.xCm}cm, ${placement.yCm}cm rot=${placement.rotationDeg}`,
            )
            .join('\n')}\n`,
          contentType: 'application/x-photoshop-script',
        }
      case 'preview': {
        const width = 300
        const height = Math.max(
          40,
          Math.round(((sheet?.heightCm ?? 40) / (sheet?.widthCm ?? 58)) * width),
        )
        return {
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#181513"/><rect x="4" y="4" width="${width - 8}" height="${height - 8}" fill="none" stroke="#ff6a3d"/></svg>`,
          contentType: 'image/svg+xml',
        }
      }
      default: {
        const height = sheet?.heightPx ?? 2400
        return {
          body: `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet?.widthPx ?? 6850}" height="${height}" viewBox="0 0 ${sheet?.widthPx ?? 6850} ${height}"><rect width="100%" height="100%" fill="#181513"/></svg>`,
          contentType: 'image/svg+xml',
        }
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function parametersForVersion(
  job: MockJobRecord,
  stepType: StepType,
): Record<string, unknown> {
  const { parentVersionId, proposedVersionId, workingDpi, ...rest } = job.parameters
  void parentVersionId
  void proposedVersionId
  void workingDpi
  if (stepType === 'crop' && rest.cropRect) {
    return { ...rest, cropRect: rest.cropRect, mode: 'manual' }
  }
  return { ...rest }
}

function stepTypeForJob(type: Job['type'], parameters: Record<string, unknown>): StepType {
  if (type === 'trim') return parameters.mode === 'manual' ? 'crop' : 'trim'
  if (type === 'background-removal') return 'background-removal'
  return type as StepType
}

function outputArtifactsFor(version: MockVersionRecord): Record<string, string> {
  const artifacts: Record<string, string> = {}
  if (version.hasMask) {
    artifacts.mask = `${version.designId}/versions/${version.id}/mask.png`
  }
  if (version.hasSvg) artifacts.vector = `${version.designId}/versions/${version.id}/vector.svg`
  return artifacts
}

/** The whole asset as a pixel window. */
function fullBox(assetKey: string): { x: number; y: number; width: number; height: number } {
  const asset = MOCK_ASSETS[assetKey] ?? MOCK_ASSETS['sticker-fringe']
  return { x: 0, y: 0, width: asset.widthPx, height: asset.heightPx }
}

function insetRect(
  box: { x?: number; y?: number; width: number; height: number },
  ratio: number,
): CropRect {
  const x = Math.round((box.x ?? 0) + box.width * ratio)
  const y = Math.round((box.y ?? 0) + box.height * ratio)
  return {
    x,
    y,
    width: Math.max(1, Math.round(box.width * (1 - ratio * 2))),
    height: Math.max(1, Math.round(box.height * (1 - ratio * 2))),
  }
}

export function rotationSwapsAxis(rotationDeg: number): boolean {
  return rotationDeg === 90 || rotationDeg === 270
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function pickAssetKey(name: string): string {
  const keys = Object.keys(MOCK_ASSETS)
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 100000
  return keys[hash % keys.length]
}

function garmentColorFor(
  kind: GarmentColor['kind'] | undefined,
  hex: string | null | undefined,
): GarmentColor {
  if (!kind) return { kind: 'light' }
  if (kind === 'custom') return { kind, hex: hex ?? '#ff00ff' }
  return { kind }
}

/** Deterministic shelf packing: largest first, honouring margin and edge margin. */
export function shelfPlacements(
  snapshot: { designId: string; versionId: string; designName: string; widthCm: number; heightCm: number }[],
  batch: { rollWidthCm: number; marginMm: number; edgeMarginMm: number; workingDpi: number },
  versions: Map<string, MockVersionRecord>,
): Placement[] {
  const margin = mmToCm(batch.marginMm)
  const edge = mmToCm(batch.edgeMarginMm)
  const ordered = [...snapshot].sort((a, b) => b.heightCm * b.widthCm - a.heightCm * a.widthCm)
  const placements: Placement[] = []
  let x = edge
  let y = edge
  let rowHeight = 0
  for (const item of ordered) {
    if (!versions.has(item.versionId)) continue
    const widthCm = round4(item.widthCm)
    const heightCm = round4(item.heightCm)
    if (x + widthCm + edge > batch.rollWidthCm && x > edge) {
      x = edge
      y = round4(y + rowHeight + margin)
      rowHeight = 0
    }
    placements.push({
      designId: item.designId,
      versionId: item.versionId,
      designName: item.designName,
      xCm: round4(x),
      yCm: round4(y),
      widthCm,
      heightCm,
      widthPx: targetPixels({ widthCm, heightCm }, batch.workingDpi).widthPx,
      heightPx: targetPixels({ widthCm, heightCm }, batch.workingDpi).heightPx,
      rotationDeg: 0,
    })
    x = round4(x + widthCm + margin)
    rowHeight = Math.max(rowHeight, heightCm)
  }
  return placements
}

export function sheetHeightFor(
  placements: { yCm: number; heightCm: number }[],
  batch: { edgeMarginMm: number },
): number {
  const edge = mmToCm(batch.edgeMarginMm)
  const bottom = placements.reduce((max, item) => Math.max(max, item.yCm + item.heightCm), edge)
  return round2(bottom + edge)
}

/** The four blocking checks from ARCHITECTURE §8.2. Skipped never counts as passed. */
export function integrityReportFor(
  sheet: Sheet,
  geometry: { rollWidthCm: number; marginMm: number; edgeMarginMm: number },
  currency: string,
): IntegrityReport {
  const margin = mmToCm(geometry.marginMm)
  const edge = mmToCm(geometry.edgeMarginMm)
  const roll = geometry.rollWidthCm

  const outside = sheet.placements.filter(
    (placement) =>
      placement.xCm < edge - 1e-6 ||
      placement.yCm < edge - 1e-6 ||
      placement.xCm + placement.widthCm > roll + 1e-6 ||
      placement.yCm + placement.heightCm > sheet.heightCm + 1e-6,
  )
  const overlaps: string[] = []
  let minGap = Number.POSITIVE_INFINITY
  for (let i = 0; i < sheet.placements.length; i += 1) {
    for (let j = i + 1; j < sheet.placements.length; j += 1) {
      const a = sheet.placements[i]
      const b = sheet.placements[j]
      // Signed gaps: negative on both axes means the rectangles overlap.
      const gapX = Math.max(b.xCm - (a.xCm + a.widthCm), a.xCm - (b.xCm + b.widthCm))
      const gapY = Math.max(b.yCm - (a.yCm + a.heightCm), a.yCm - (b.yCm + b.heightCm))
      const overlapsBoth = gapX < -1e-6 && gapY < -1e-6
      if (overlapsBoth) overlaps.push(`${a.designName}/${b.designName}`)
      else minGap = Math.min(minGap, Math.hypot(Math.max(0, gapX), Math.max(0, gapY)))
    }
  }
  const gapViolations = Number.isFinite(minGap) ? minGap < margin - 1e-6 : false

  const checks: IntegrityCheck[] = [
    {
      id: 'visible-pixels-inside-sheet',
      blocking: true,
      status: outside.length === 0 ? 'passed' : 'failed',
      message:
        outside.length === 0
          ? 'All visible pixels are inside the sheet bounds.'
          : `${outside.length} placement(s) leave the sheet.`,
      details: { offenders: outside.map((item) => item.designName) },
    },
    {
      id: 'dilated-masks-no-overlap',
      blocking: true,
      status: overlaps.length === 0 ? 'passed' : 'failed',
      message:
        overlaps.length === 0
          ? 'No two dilated masks overlap.'
          : `${overlaps.length} overlapping pair(s): ${overlaps.join(', ')}`,
      details: { pairs: overlaps },
    },
    {
      id: 'minimum-gap',
      blocking: true,
      status: !gapViolations ? 'passed' : 'failed',
      message: !gapViolations
        ? `Minimum visible gap ${Number.isFinite(minGap) ? round2(minGap) : '—'} cm meets the ${round2(margin)} cm margin.`
        : `Minimum visible gap ${round2(minGap)} cm is below the ${round2(margin)} cm margin.`,
      details: { minGapCm: Number.isFinite(minGap) ? round2(minGap) : null, marginCm: round2(margin) },
    },
    {
      id: 'pixel-equality',
      blocking: true,
      status: 'passed',
      message: 'Mock packer renders each placement from the approved version file, untranslated and unresampled.',
      details: { rotations: sheet.placements.map((item) => item.rotationDeg) },
    },
    {
      id: 'all-designs-placed',
      blocking: true,
      status: 'passed',
      message: `All ${sheet.placements.length} requested design(s) are placed.`,
      details: {
        requestedDesignCount: sheet.placements.length,
        placedDesignCount: sheet.placements.length,
        unplacedDesigns: [],
      },
    },
  ]

  const passed = checks.every((check) => check.status === 'passed')
  return {
    schemaVersion: '2.0',
    reportId: uuid(),
    generatedAt: isoNow(),
    passed,
    sheet: {
      widthPx: sheet.widthPx,
      heightPx: sheet.heightPx,
      widthCm: sheet.widthCm,
      heightCm: sheet.heightCm,
      dpi: sheet.dpi,
    },
    checks,
    failures: checks
      .filter((check) => check.status !== 'passed')
      .map((check) => ({
        checkId: check.id,
        designId: null,
        message: check.message,
        details: check.details,
      })),
    metrics: {
      placements: sheet.placements.length,
      occupiedRatio: occupancyRatio(sheet.placements, sheet.widthCm, sheet.heightCm),
      estimatedCostCurrency: currency,
    },
  }
}

function occupancyRatio(
  placements: { widthCm: number; heightCm: number }[],
  widthCm: number,
  heightCm: number,
): number {
  if (widthCm <= 0 || heightCm <= 0) return 0
  const area = placements.reduce((sum, item) => sum + item.widthCm * item.heightCm, 0)
  return Math.round((area / (widthCm * heightCm)) * 1000) / 1000
}

export const SEED_BATCHES: SeedBatch[] = [
  {
    id: '7a7a0000-0000-4000-8000-000000000001',
    name: 'ACME summer drop 01',
    createdAtOffsetMs: -5 * 86_400_000,
    designs: [
      {
        assetKey: 'sticker-fringe',
        name: 'Round sticker (fringe)',
        targetCm: [12, 10],
        garmentColor: { kind: 'dark' },
        notes: 'Customer screenshot. Halo visible on black tees.',
        chain: [
          { stepType: 'background-removal', parameters: { mode: 'ai', edgeSoftness: 1.5 } },
          { stepType: 'upscale', parameters: { model: 'realesrgan-x4plus-anime', scale: 2 }, status: 'proposed' },
        ],
      },
      { assetKey: 'full-bleed-collage', name: 'Full-bleed collage', targetCm: [30, 22] },
      {
        assetKey: 'tall-banner',
        name: 'Side-seam banner',
        targetCm: [8, 30],
        allowRotation: false,
        chain: [{ stepType: 'resize' }],
      },
      {
        assetKey: 'wide-lockup',
        name: 'Back lockup (over-wide)',
        targetCm: [62, 24],
        chain: [{ stepType: 'trim', parameters: { mode: 'auto', tolerance: 24 } }, { stepType: 'resize' }],
      },
      {
        assetKey: 'thin-signature',
        name: 'Signature at 80 DPI',
        targetCm: [16, 5],
        betterSourceRequested: true,
      },
      { assetKey: 'screenshot-mock', name: 'Supplier proof (excluded)', targetCm: [10, 14], excluded: true },
      { assetKey: 'flat-logo-black', name: 'APEX logo', targetCm: [14, 14] },
      {
        assetKey: 'pale-mist',
        name: 'Mist ridge',
        targetCm: [22, 18],
        chain: [
          { stepType: 'trim', parameters: { mode: 'auto', paddingPx: 12 } },
          { stepType: 'background-removal', parameters: { mode: 'color-to-alpha', keyColor: '#ffffff' } },
          { stepType: 'resize' },
        ],
      },
    ],
  },
  {
    name: 'Riverside run club',
    createdAtOffsetMs: -2 * 86_400_000,
    designs: [
      {
        assetKey: 'flat-logo-black',
        name: 'Crest front',
        targetCm: [16, 16],
        chain: [
          { stepType: 'background-removal', parameters: { mode: 'color-to-alpha', keyColor: '#0b0b0b' } },
          { stepType: 'resize' },
        ],
      },
      {
        assetKey: 'pale-mist',
        name: 'Sunset back',
        targetCm: [24, 20],
        chain: [{ stepType: 'trim', parameters: { mode: 'auto', paddingPx: 10 } }, { stepType: 'resize' }],
      },
      { assetKey: 'sticker-fringe', name: 'Sleeve dot', targetCm: [6, 6], chain: [{ stepType: 'resize' }] },
    ],
  },
  {
    name: 'Northgate cafe merch',
    createdAtOffsetMs: -86_400_000,
    pack: true,
    integrity: 'pass',
    exportFormats: ['flat-png'],
    designs: [
      {
        assetKey: 'flat-logo-black',
        name: 'Steam cup',
        targetCm: [12, 12],
        chain: [
          { stepType: 'background-removal', parameters: { mode: 'color-to-alpha', keyColor: '#0b0b0b' } },
          { stepType: 'resize' },
        ],
      },
      {
        assetKey: 'wide-lockup',
        name: 'Wordmark',
        targetCm: [30, 12],
        chain: [{ stepType: 'trim', parameters: { mode: 'auto' } }, { stepType: 'resize' }],
      },
      { assetKey: 'sticker-fringe', name: 'Badge', targetCm: [9, 8], chain: [{ stepType: 'resize' }] },
    ],
  },
  {
    name: 'Marathon expo back print',
    createdAtOffsetMs: -6 * 86_400_000,
    designs: [
      {
        assetKey: 'wide-lockup',
        name: 'Oversized back lockup',
        targetCm: [62, 26],
        chain: [{ stepType: 'trim', parameters: { mode: 'auto' } }, { stepType: 'resize' }],
      },
    ],
  },
  { name: 'Empty intake queue', createdAtOffsetMs: -3_600_000, designs: [] },
]

function defaultSeed(): SeedBatch[] {
  return SEED_BATCHES
}

let instance: MockStore | null = null

export function store(): MockStore {
  if (!instance) {
    instance = new MockStore()
    instance.reset()
  }
  return instance
}

export function resetStore(seedBatches?: SeedBatch[]): MockStore {
  if (instance) instance.dispose()
  instance = new MockStore()
  instance.reset(seedBatches)
  return instance
}
