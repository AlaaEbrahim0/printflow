import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  api,
  versionThumbnailUrl,
  type CropRect,
  type DesignDetail,
  type DesignVersion,
  type LevelsAdjustment,
} from '../api/client'
import { AlphaPreview } from '../components/preview/AlphaPreview'
import { BackgroundPicker } from '../components/preview/BackgroundPicker'
import { PhotopeaIcon } from '../components/photopea/PhotopeaIcon'
import { ErrorBanner } from '../components/ui/Banner'
import { Chip, StatusChip } from '../components/ui/Chip'
import { CheckboxField, ColorField, NumberField, SelectField } from '../components/ui/Field'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { ImageComparisonSlider } from '../components/compare'
import CropTool from '../components/crop/CropTool'
import { LevelsControl, MaskGrowControl } from '../components/cutout/MaskControls'
import { useAsync, useJobPoller } from '../hooks/useAsync'
import { formatPixels, shortId, statusLabel, stepLabel } from '../lib/format'
import { reviewReadiness } from '../components/batch/reviewReadiness'
import { pipelineStatus } from '../components/batch/pipelineStatus'
import { WORKBENCH_DEFAULTS } from '../lib/defaults'
import { LEVELS_DEFAULTS, isIdentityLevels } from '../lib/levels'
import { photopeaEditorPath } from '../lib/photopea'
import { DEFAULT_PREVIEW_BACKGROUND, previewBackgroundFor, type PreviewBackground } from '../lib/preview'
import {
  aspectRatioOf,
  heightForWidth,
  matchesAspectRatio,
  roundCentimeters,
  sizeInCentimeters,
  targetPixels,
  widthForHeight,
} from '../lib/units'
import { useSettings } from '../state/SettingsContext'
import './design-review.css'

const UPSCALE_MODELS = [
  { value: 'realesrgan-x4plus', label: 'Real-ESRGAN · photos / general artwork' },
  { value: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN · anime-style artwork' },
] as const

/**
 * Processing profiles are operator presets. Each one applies a sane default for
 * the machines' steps so a designer can choose a job type without configuring
 * every slider. Selecting a profile never deletes a version: it only rewrites the
 * *proposal* values in the advanced panel. When it differs from what is already
 * configured, the panel shows an overwrite notice rather than applying silently.
 *
 * The cutout defaults are all colour-key based. The BiRefNet AI cutout is
 * archived (it ate the whole memory budget for minutes and still produced
 * unreliable edges), so no profile may select it.
 */
export type ProcessingProfileId = 'logo-text' | 'illustration' | 'soft-artwork' | 'manual'

/**
 * The four editing tools, in the order the shop works. The ids are stable
 * because the tool list derives which one to open from `pipelineStatus`.
 */
export type ToolId = 'prepare' | 'enhance' | 'cutout' | 'size'

export interface ProcessingProfile {
  id: ProcessingProfileId
  label: string
  description: string
  defaults: {
    cutoutKeyColor: string
    cutoutTolerance: number
    cutoutEdgeSoftness: number
    maskGrowPx: number
    upscaleModel: (typeof UPSCALE_MODELS)[number]['value']
    upscaleScale: 2 | 4
  }
}

/**
 * The four editor profiles. The exact order is deliberate: the shop runs logos,
 * text and line-art first, then illustrations, then soft artwork, and Manual
 * only as a fallback so the defaults never fight a real image.
 */
export const PROCESSING_PROFILES: ProcessingProfile[] = [
  {
    id: 'logo-text',
    label: 'Logo / text',
    description: 'Flat black-and-white mark on a clear background.',
    defaults: {
      cutoutKeyColor: '#ffffff',
      cutoutTolerance: 10,
      cutoutEdgeSoftness: 0,
      maskGrowPx: 0,
      upscaleModel: 'realesrgan-x4plus-anime',
      upscaleScale: 2,
    },
  },
  {
    id: 'illustration',
    label: 'Illustration',
    description: 'Flat colour art with hard edges.',
    defaults: {
      cutoutKeyColor: '#ffffff',
      cutoutTolerance: 14,
      cutoutEdgeSoftness: 0.5,
      maskGrowPx: 1,
      upscaleModel: 'realesrgan-x4plus-anime',
      upscaleScale: 2,
    },
  },
  {
    id: 'soft-artwork',
    label: 'Soft artwork',
    description: 'Photographic or blended colour art.',
    defaults: {
      cutoutKeyColor: '#ffffff',
      cutoutTolerance: 20,
      cutoutEdgeSoftness: 1.0,
      maskGrowPx: 2,
      upscaleModel: 'realesrgan-x4plus',
      upscaleScale: 2,
    },
  },
  {
    id: 'manual',
    label: 'Manual',
    description: 'No preset; you configure every control.',
    defaults: {
      cutoutKeyColor: '#ffffff',
      cutoutTolerance: 12,
      cutoutEdgeSoftness: 0,
      maskGrowPx: 0,
      upscaleModel: 'realesrgan-x4plus',
      upscaleScale: 2,
    },
  },
] as const

function proposedVersion(design: DesignDetail): DesignVersion | undefined {
  return design.versions.find((version) => version.status === 'proposed')
}

function versionFor(design: DesignDetail, versionId: string): DesignVersion | undefined {
  return design.versions.find((version) => version.id === versionId)
}

/**
 * Layer visibility glyph. A hidden layer is drawn with the eye struck through,
 * so the state reads at a glance without relying on colour alone.
 */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
      {open ? null : <path d="M4 20 20 4" strokeLinecap="round" />}
    </svg>
  )
}

function photoshopFileName(
  design: DesignDetail,
  version: Pick<DesignVersion, 'id' | 'stepType'>,
): string {
  const safeName =
    design.name
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'design'
  return `${safeName}-${version.stepType}-${version.id.slice(0, 8)}.png`
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Job type in words.
 *
 * The raw type is API vocabulary (`background-removal`), and the old
 * `replaceAll` fallback produced lowercase fragments like "resize". These are
 * the types an operator can still queue; retired ones stay readable.
 */
const JOB_LABELS: Record<string, string> = {
  classify: 'Artwork analysis',
  trim: 'Auto crop',
  crop: 'Manual crop',
  upscale: 'Image enhancement',
  resize: 'Final resize',
  'background-removal': 'Background removal',
  vectorize: 'Vectorize (retired)',
  'pack-sheet': 'Packing sheet',
  'integrity-check': 'Integrity check',
  export: 'Export',
}

function jobLabel(type: string): string {
  return JOB_LABELS[type] ?? statusLabel(type)
}

/**
 * One sentence on what approving a proposal of this type actually does.
 *
 * Approval is the irreversible-feeling action on this page (the version becomes
 * current and feeds the sheet), so the consequence is spelled out instead of
 * left to be inferred from the step name.
 */
const PROPOSAL_EFFECTS: Record<string, string> = {
  trim: 'Removes the cropped edge from the printable artwork. The original stays available in version history.',
  crop: 'Replaces the printable area with the rectangle you drew. The original stays available in version history.',
  upscale: 'Replaces the current image with the enlarged one. AI enlargement adds pixels, not original detail, so compare it with the original first.',
  resize: 'Sets the final pixel size that the packer will place. This is the version that gets printed.',
  'background-removal': 'Replaces the current image with the cut-out. The transparent version becomes what the packer places, so check the mask before approving.',
  vectorize: 'Retired step. This historical version stays readable but cannot be produced again.',
}

function proposalEffect(stepType: string): string {
  return (
    PROPOSAL_EFFECTS[stepType] ??
    'Makes this version current, so it becomes the artwork that gets packed and printed.'
  )
}

export default function DesignReviewPage() {
  const { designId = '', batchId = '' } = useParams()
  const [background, setBackground] = useState<PreviewBackground>(DEFAULT_PREVIEW_BACKGROUND)
  const [cropOpen, setCropOpen] = useState(false)
  const [cropInitial, setCropInitial] = useState<CropRect | null>(null)
  const [cropAspect, setCropAspect] = useState<number | null>(null)
  const [upscaleModel, setUpscaleModel] = useState<(typeof UPSCALE_MODELS)[number]['value']>(
    'realesrgan-x4plus',
  )
  const [upscaleScale, setUpscaleScale] = useState<2 | 4>(4)
  const [cutoutKeyColor, setCutoutKeyColor] = useState('#ffffff')
  const [cutoutTolerance, setCutoutTolerance] = useState(12)
  const [cutoutEdgeSoftness, setCutoutEdgeSoftness] = useState(0)
  const [maskGrowPx, setMaskGrowPx] = useState(0)
  const [maskLevels, setMaskLevels] = useState<LevelsAdjustment>({ ...LEVELS_DEFAULTS })
  const [imageLevels, setImageLevels] = useState<LevelsAdjustment>({ ...LEVELS_DEFAULTS })
  const [targetWidthCm, setTargetWidthCm] = useState<number | null>(null)
  const [targetHeightCm, setTargetHeightCm] = useState<number | null>(null)
  const [aspectLinked, setAspectLinked] = useState(true)
  const [allowRotation, setAllowRotation] = useState(true)
  const [activeProfile, setActiveProfile] = useState<ProcessingProfileId>('manual')
  const [profileNotice, setProfileNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalIntent, setModalIntent] = useState<'approve' | 'reject'>('approve')
  // Editor state. `pickedLayerId` is the layer under the cursor, not the
  // current approved version: the operator can inspect any layer in the stack
  // without changing what the packer will use.
  const [pickedLayerId, setPickedLayerId] = useState<string | null>(null)
  const [hiddenLayerIds, setHiddenLayerIds] = useState<string[]>([])
  const [compareChoice, setCompareChoice] = useState<Record<string, boolean>>({})
  const [openTool, setOpenTool] = useState<ToolId | 'none' | null>(null)
  const { dpiThresholds } = useSettings()
  const profile = PROCESSING_PROFILES.find((item) => item.id === activeProfile) ?? PROCESSING_PROFILES[3]

  // Switching a profile rewrites the proposal values for the machine steps. It
  // never deletes a version. We only show the overwrite notice when the profile
  // moves a control away from what the operator already typed.
  useEffect(() => {
    const next = profile.defaults
    const changed =
      next.cutoutKeyColor !== cutoutKeyColor ||
      next.cutoutTolerance !== cutoutTolerance ||
      next.cutoutEdgeSoftness !== cutoutEdgeSoftness ||
      next.maskGrowPx !== maskGrowPx ||
      next.upscaleModel !== upscaleModel ||
      next.upscaleScale !== upscaleScale
    if (changed) {
      setCutoutKeyColor(next.cutoutKeyColor)
      setCutoutTolerance(next.cutoutTolerance)
      setCutoutEdgeSoftness(next.cutoutEdgeSoftness)
      setMaskGrowPx(next.maskGrowPx)
      setUpscaleModel(next.upscaleModel)
      setUpscaleScale(next.upscaleScale)
      setProfileNotice(
        'This profile applies colour-key and mask defaults over your current advanced settings. Levels are left as you set them.',
      )
    } else {
      setProfileNotice(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile])
  const { state, reload } = useAsync(
    async (signal) => {
      const [design, suggestions, jobs, batch] = await Promise.all([
        api.designs.get(designId, { signal }),
        api.designs.suggestions(designId, { signal }),
        api.batches.jobs(batchId, { limit: 200 }, { signal }),
        api.batches.get(batchId, { signal }),
      ])
      return { design, suggestions, jobs, batch }
    },
    [batchId, designId],
  )
  const data = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  const designJobs = (data?.jobs.items ?? []).filter(
    (candidate) =>
      candidate.designId === designId &&
      ['trim', 'upscale', 'vectorize', 'background-removal', 'resize'].includes(candidate.type),
  )
  const activeJobId = designJobs.find((candidate) =>
    candidate.status === 'queued' || candidate.status === 'running',
  )?.id
  const latestStepJobId = designJobs[0]?.id
  const trackedJobId = jobId ?? activeJobId ?? latestStepJobId ?? null
  const { job, error: jobPollError, observedAt } = useJobPoller(trackedJobId)
  const jobActive = job?.status === 'queued' || job?.status === 'running'

  useEffect(() => {
    setJobId(null)
  }, [designId])

  // A different design is a different stack, so a layer picked on the previous
  // one must not carry over and silently select a foreign version.
  useEffect(() => {
    setPickedLayerId(null)
    setHiddenLayerIds([])
    setCompareChoice({})
    setOpenTool(null)
  }, [designId])

  const design = data?.design ?? null
  const proposal = design ? proposedVersion(design) : undefined
  const current = design?.currentVersion ?? null
  const workingDpi = data?.batch.workingDpi ?? WORKBENCH_DEFAULTS.workingDpi
  const artworkAspect = current
    ? aspectRatioOf({ widthPx: current.widthPx, heightPx: current.heightPx })
    : null

  // While linked, height is derived during render rather than copied into
  // state: a crop or upscale that changes the artwork ratio relinks the size
  // immediately, with no effect and no cascading render.
  const linkedHeightCm =
    aspectLinked && artworkAspect !== null && targetWidthCm !== null && targetWidthCm > 0
      ? heightForWidth(targetWidthCm, artworkAspect)
      : null
  const effectiveWidthCm = targetWidthCm
  const effectiveHeightCm = linkedHeightCm ?? targetHeightCm

  useEffect(() => {
    if (!design) return
    setBackground(previewBackgroundFor(design.garmentColor))
    const savedWidth = design.targetWidthCm ?? null
    const savedHeight = design.targetHeightCm ?? null
    setTargetWidthCm(savedWidth)
    setTargetHeightCm(savedHeight)
    setAllowRotation(design.allowRotation)
    const ratio = design.currentVersion
      ? aspectRatioOf({
          widthPx: design.currentVersion.widthPx,
          heightPx: design.currentVersion.heightPx,
        })
      : null
    // An intentionally non-ratio size that was already saved must not be
    // silently rewritten on load; the operator can still relink explicitly.
    setAspectLinked(
      savedWidth === null || savedHeight === null || ratio === null
        ? true
        : matchesAspectRatio({ widthCm: savedWidth, heightCm: savedHeight }, ratio),
    )
  }, [design?.id])

  useEffect(() => {
    if (job?.status === 'succeeded') {
      setNotice('Processing completed. The result is a new layer in the stack; it is not current until you approve it.')
      reload()
    }
    if (job?.status === 'failed') {
      setError(job.error ?? new Error('The processing job failed.'))
    }
  }, [job?.id, job?.status, reload])

  async function mutate(action: () => Promise<unknown>, successMessage?: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (successMessage) setNotice(successMessage)
      reload()
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  async function submitJob(action: () => Promise<{ jobId: string }>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const accepted = await action()
      setJobId(accepted.jobId)
      setNotice('Job queued. The original and current version remain unchanged until you approve the result.')
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  async function applyCrop(rect: CropRect) {
    setCropOpen(false)
    await submitJob(() => api.steps.crop(designId, { rect }))
  }

  function updateTargetWidth(value: number | null) {
    // While linked, the height follows from this width during render.
    setTargetWidthCm(value)
  }

  function updateTargetHeight(value: number | null) {
    setTargetHeightCm(value)
    // While linked, height is derived from width, so typing a height drives the
    // width instead of fighting the derived value.
    if (aspectLinked && value !== null && value > 0 && artworkAspect !== null) {
      setTargetWidthCm(widthForHeight(value, artworkAspect))
    }
  }

  function toggleAspectLink(linked: boolean) {
    if (!linked) {
      // Freeze the currently displayed height so the field does not jump when
      // the operator takes manual control.
      if (linkedHeightCm !== null) setTargetHeightCm(linkedHeightCm)
      setAspectLinked(false)
      return
    }

    if (artworkAspect !== null) {
      if (targetWidthCm !== null && targetWidthCm > 0) {
        setTargetHeightCm(heightForWidth(targetWidthCm, artworkAspect))
      } else if (targetHeightCm !== null && targetHeightCm > 0) {
        setTargetWidthCm(widthForHeight(targetHeightCm, artworkAspect))
      }
    }
    setAspectLinked(true)
  }

  function useArtworkSize() {
    if (!current) return
    const artwork = sizeInCentimeters(
      { widthPx: current.widthPx, heightPx: current.heightPx },
      workingDpi,
    )
    setTargetWidthCm(roundCentimeters(artwork.widthCm))
    setTargetHeightCm(roundCentimeters(artwork.heightCm))
    setAspectLinked(true)
  }

  async function rejectProposal() {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      await api.designs.reject(designId, proposal.id)
      setNotice('Proposal rejected. The previously approved version remains current.')
      setModalOpen(false)
      reload()
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  async function approveProposal() {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      await api.designs.approve(designId, proposal.id)
      setNotice('Proposal approved and made current.')
      setModalOpen(false)
      reload()
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  // The proposal modal closes on Escape or by clicking outside the panel.
  useEffect(() => {
    if (!modalOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModalOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen])

  if (state.kind === 'loading') return <Loading label="Loading design…" />
  if (state.kind === 'error') {
    return <ErrorState error={state.error} onRetry={reload} title="Could not load design" />
  }
  if (!design || !current) {
    return <EmptyState title="Design has no current version">Ask for a better source or contact support.</EmptyState>
  }

  const canPropose = !proposal && !busy && job?.status !== 'queued' && job?.status !== 'running'
  // Why the tools are disabled, in the operator's terms. Saying "finish the job"
  // while a proposal is what blocks the tools sends them hunting for a job.
  const toolsBlockedReason = proposal
    ? 'approve or reject the pending proposal first'
    : job?.status === 'queued' || job?.status === 'running'
      ? 'wait for the current job to finish'
      : busy
        ? 'saving…'
        : null
  const currentDetails = versionFor(design, current.id)
  const proposalDetails = proposal ? versionFor(design, proposal.id) : undefined
  const targetSize =
    effectiveWidthCm !== null && effectiveHeightCm !== null
      ? { widthCm: effectiveWidthCm, heightCm: effectiveHeightCm }
      : null
  const outputPixels = targetSize ? targetPixels(targetSize, workingDpi) : null
  const canSubmitSize =
    effectiveWidthCm !== null &&
    effectiveHeightCm !== null &&
    effectiveWidthCm > 0 &&
    effectiveHeightCm > 0
  const readiness = reviewReadiness(design, workingDpi)
  const pipeline = pipelineStatus(design.versions, design.currentVersionId)
  const sourceDpi = data?.suggestions.status === 'ready'
    ? data.suggestions.source?.effectiveDpiAtTarget
    : null
  const jobStartedAt = job ? Date.parse(job.startedAt ?? job.createdAt) : Number.NaN
  const elapsedMs = Number.isFinite(jobStartedAt) ? Math.max(0, observedAt - jobStartedAt) : null
  const elapsedText = elapsedMs === null ? null : formatElapsed(elapsedMs)
  const isGpuUpscale = job?.type === 'upscale' && job.parameters.gpu === true

  // The layer stack is the version chain, newest first. Selecting a layer is
  // the editor's core gesture: the canvas shows that layer, and the decision
  // buttons act on it.
  const fallbackLayerId = proposal?.id ?? current.id
  const pickedLayer =
    pickedLayerId && versionFor(design, pickedLayerId) ? pickedLayerId : fallbackLayerId
  const activeLayer = versionFor(design, pickedLayer) ?? current
  const activeIndex = design.versions.findIndex((version) => version.id === activeLayer.id)
  // "Below" is one step older, because the API returns newest first. Hidden
  // layers are skipped so the eye toggle actually changes what you compare.
  const belowLayer =
    activeIndex === -1
      ? null
      : (design.versions
          .slice(activeIndex + 1)
          .find((version) => !hiddenLayerIds.includes(version.id)) ?? null)
  const activeHidden = hiddenLayerIds.includes(activeLayer.id)
  const showCompare = compareChoice[activeLayer.id] ?? activeLayer.status === 'proposed'
  const suggestedTool: ToolId = !pipeline.prepared
    ? 'prepare'
    : !pipeline.enhanced
      ? 'enhance'
      : !pipeline.cutout
        ? 'cutout'
        : 'size'
  const shownTool = openTool ?? suggestedTool
  const toolDone: Record<ToolId, boolean> = {
    prepare: pipeline.prepared,
    enhance: pipeline.enhanced,
    cutout: pipeline.cutout,
    size: pipeline.sized,
  }

  function toggleCompare() {
    setCompareChoice((previous) => ({ ...previous, [activeLayer.id]: !showCompare }))
  }

  function toggleLayerVisibility(versionId: string) {
    setHiddenLayerIds((previous) =>
      previous.includes(versionId)
        ? previous.filter((id) => id !== versionId)
        : [...previous, versionId],
    )
  }

  return (
    <section className="design-view">
      <header className="page-head editor-head">
        <div>
          <p className="breadcrumb">
            <Link to="/">Batches</Link> / <Link to={`/batches/${batchId}`}>{batchId.slice(0, 8)}</Link> / Review
          </p>
          <h1 className="page-title">{design.name}</h1>
          <p className="page-subtitle">
            {statusLabel(design.status)} · {design.versionCount} immutable{' '}
            {design.versionCount === 1 ? 'version' : 'versions'} · current layer is{' '}
            {stepLabel(current.stepType).toLowerCase()}
          </p>
        </div>
        <div className="row">
          <Chip tone={readiness.packable ? 'good' : 'warn'}>{readiness.headline}</Chip>
          {design.status === 'excluded' ? <StatusChip status="excluded" /> : null}
          <Link className="btn" to={`/batches/${batchId}`}>Back to batch</Link>
        </div>
      </header>

      {error ? <ErrorBanner error={error} title="Design action failed" /> : null}
      {jobPollError ? <ErrorBanner error={jobPollError} title="Could not check processing job" /> : null}
      {notice ? <p className="banner info" role="status">{notice}</p> : null}

      <div className="editor">
        <div className="editor-stage">
          <div className="editor-stage-bar">
            <BackgroundPicker
              value={background}
              onChange={setBackground}
              garmentHex={design.garmentColor.hex}
            />
            {state.kind === 'reloading' ? (
              <span className="pill" role="status">Refreshing…</span>
            ) : null}
          </div>

          <div className={`editor-canvas${activeHidden ? ' is-hidden' : ''}`}>
            {activeHidden ? (
              <div className="editor-canvas-empty">
                <strong>This layer is hidden</strong>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => toggleLayerVisibility(activeLayer.id)}
                >
                  Show layer
                </button>
              </div>
            ) : showCompare && belowLayer ? (
              <ImageComparisonSlider
                beforeUrl={belowLayer.fileUrl}
                afterUrl={activeLayer.fileUrl}
                beforeAlt={`${design.name}, ${stepLabel(belowLayer.stepType)} layer`}
                afterAlt={`${design.name}, ${stepLabel(activeLayer.stepType)} layer`}
                beforeWidthPx={belowLayer.widthPx}
                beforeHeightPx={belowLayer.heightPx}
                afterWidthPx={activeLayer.widthPx}
                afterHeightPx={activeLayer.heightPx}
                background={background}
                beforeLabel={stepLabel(belowLayer.stepType)}
                afterLabel={stepLabel(activeLayer.stepType)}
                testId="design-comparison"
              />
            ) : (
              <AlphaPreview
                fileUrl={activeLayer.fileUrl}
                alt={`${design.name}, ${stepLabel(activeLayer.stepType)} layer`}
                background={background}
                widthPx={activeLayer.widthPx}
                heightPx={activeLayer.heightPx}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                testId={
                  activeLayer.id === current.id ? 'current-design-preview' : 'layer-preview'
                }
              />
            )}
          </div>

          <div className="editor-canvas-meta">
            <span className="mono muted" data-testid="canvas-layer-meta">
              {stepLabel(activeLayer.stepType)} · {formatPixels(activeLayer.widthPx)} ×{' '}
              {formatPixels(activeLayer.heightPx)} · {shortId(activeLayer.id)}
            </span>
            {belowLayer ? (
              <button
                type="button"
                className="btn sm"
                aria-pressed={showCompare}
                onClick={toggleCompare}
                data-testid="toggle-compare"
              >
                {showCompare ? 'Single view' : `Compare with ${stepLabel(belowLayer.stepType)}`}
              </button>
            ) : null}
          </div>

          {job ? (
            <section className={`panel job-progress ${jobActive ? 'is-active' : ''}`} aria-label="Job progress">
              <div className="card-heading">
                <div className="row">
                  <strong>{jobLabel(job.type)}</strong>
                  <StatusChip status={job.status} />
                </div>
                {job.status === 'queued' ? (
                  <button type="button" className="btn sm" onClick={() => void mutate(() => api.jobs.cancel(job.id))}>
                    Cancel
                  </button>
                ) : null}
              </div>
              {jobActive ? (
                <>
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-label="Image processing progress"
                    aria-valuetext={`Progress percentage is not reported by the image engine${elapsedText ? `; ${elapsedText} elapsed` : ''}`}
                  >
                    <span className="progress-indicator" />
                  </div>
                  <p className="job-progress-message">
                    {job.status === 'queued'
                      ? isGpuUpscale
                        ? 'Waiting for a GPU worker. On this workstation, start the native worker with make worker-gpu; the Compose worker does not claim GPU jobs.'
                        : 'Waiting for an image worker to become available.'
                      : `Processing${elapsedText ? ` · ${elapsedText} elapsed` : ''}. The engine does not report a reliable percentage, so this indicator shows activity rather than a made-up percent.`}
                  </p>
                  {job.status === 'running' && isGpuUpscale ? (
                    <p className="hint">
                      Small-image GTX tests took about 5–16 seconds. Larger images and 4× enhancement can take longer; this is a reference, not an ETA.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className={`job-progress-message ${job.status === 'failed' ? 'error-text' : ''}`}>
                  {job.error?.message
                    ?? (job.status === 'succeeded'
                      ? `Finished${job.durationMs == null ? '' : ` in ${formatElapsed(job.durationMs)}`}. The result is a new layer; it is not current until you approve it.`
                      : `${statusLabel(job.status)}.`)}
                </p>
              )}
            </section>
          ) : null}

          <div className="editor-actions">
            {proposal ? (
              <>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    setModalIntent('approve')
                    setModalOpen(true)
                  }}
                >
                  Approve proposal
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setModalIntent('reject')
                    setModalOpen(true)
                  }}
                >
                  Reject proposal
                </button>
                <a
                  className="btn"
                  href={proposal.fileUrl}
                  download={photoshopFileName(design, proposal)}
                >
                  Download proposal for Photoshop
                </a>
                <Link
                  className="btn"
                  to={photopeaEditorPath(batchId, designId, proposal.id)}
                  title="Edit this exact proposal in Photopea, then save a new ready-to-pack design"
                  data-testid="open-photopea-proposal"
                >
                  <PhotopeaIcon />
                  Open proposal in Photopea
                </Link>
                <Link
                  className="btn"
                  to={photopeaEditorPath(batchId, designId, current.id)}
                  title="Edit the current approved version in Photopea, then save a new ready-to-pack design"
                  data-testid="open-photopea-current"
                >
                  <PhotopeaIcon />
                  Open current in Photopea
                </Link>
                {proposalDetails?.artifacts?.maskUrl ? (
                  <a
                    className="btn"
                    href={proposalDetails.artifacts.maskUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View mask artifact
                  </a>
                ) : null}
                {currentDetails?.artifacts?.maskUrl ? (
                  <a
                    className="btn"
                    href={currentDetails.artifacts.maskUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View current mask artifact
                  </a>
                ) : null}
                {proposalDetails?.artifacts?.svgUrl ? (
                  <a
                    className="btn"
                    href={proposalDetails.artifacts.svgUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View vector artifact
                  </a>
                ) : null}
              </>
            ) : (
              <>
                <a
                  className="btn"
                  href={current.fileUrl}
                  download={photoshopFileName(design, current)}
                >
                  Download for Photoshop
                </a>
                <Link
                  className="btn"
                  to={photopeaEditorPath(batchId, designId, current.id)}
                  title="Edit this exact version in Photopea, then save a new ready-to-pack design"
                  data-testid="open-photopea-current"
                >
                  <PhotopeaIcon />
                  Open in Photopea
                </Link>
                {currentDetails?.artifacts?.maskUrl ? (
                  <a
                    className="btn"
                    href={currentDetails.artifacts.maskUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View mask artifact
                  </a>
                ) : null}
                {currentDetails?.artifacts?.svgUrl ? (
                  <a
                    className="btn"
                    href={currentDetails.artifacts.svgUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View vector artifact
                  </a>
                ) : null}
              </>
            )}
          </div>
          <p className="hint">
            {proposal
              ? `Nothing is replaced until you approve. The proposal is a new layer above ${stepLabel(current.stepType).toLowerCase()}, which stays in the stack.`
              : 'No proposal waiting. Pick a tool on the right and its result arrives as a new layer above the current one.'}
          </p>
        </div>

        <aside className="editor-side">
          <section className="panel" aria-labelledby="layers-title">
            <div className="panel-head">
              <h2 className="panel-title" id="layers-title">Layers</h2>
              <span className="pill">{design.versionCount}</span>
            </div>
            <ul className="layer-list">
              {design.versions.map((version) => {
                const isCurrent = version.id === design.currentVersionId
                const isActive = version.id === activeLayer.id
                const isHidden = hiddenLayerIds.includes(version.id)
                return (
                  <li
                    key={version.id}
                    className={`layer${isActive ? ' is-active' : ''}${isHidden ? ' is-hidden' : ''}`}
                    data-layer={version.id}
                    data-status={version.status}
                  >
                    <button
                      type="button"
                      className="layer-eye"
                      aria-pressed={!isHidden}
                      aria-label={`${isHidden ? 'Show' : 'Hide'} ${stepLabel(version.stepType)} layer`}
                      onClick={() => toggleLayerVisibility(version.id)}
                    >
                      <EyeIcon open={!isHidden} />
                    </button>
                    <button
                      type="button"
                      className="layer-main"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => setPickedLayerId(version.id)}
                    >
                      <img
                        className="layer-thumb"
                        src={versionThumbnailUrl(designId, version.id, 96)}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        width={36}
                        height={36}
                      />
                      <span className="layer-text">
                        <strong>{stepLabel(version.stepType)}</strong>
                        <small className="mono">
                          {formatPixels(version.widthPx)} × {formatPixels(version.heightPx)}
                        </small>
                      </span>
                    </button>
                    <span className="layer-flags">
                      {isCurrent ? <Chip tone="good">current</Chip> : null}
                      {version.status === 'proposed' ? <Chip tone="info">proposal</Chip> : null}
                      {version.status === 'rejected' ? <Chip tone="bad">rejected</Chip> : null}
                      {version.status === 'approved' && !isCurrent ? (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() =>
                            void mutate(
                              () => api.designs.revert(designId, version.id),
                              'Current version reverted.',
                            )
                          }
                        >
                          Revert
                        </button>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="hint">
              Each tool adds one layer on top. Approval makes a layer current; the ones below it
              stay in the stack, so nothing is ever overwritten.
            </p>
          </section>

          <section className="panel" aria-labelledby="readiness-title">
            <div className="panel-head">
              <h2 className="panel-title" id="readiness-title">Packing readiness</h2>
              <Chip tone={readiness.packable ? 'good' : 'warn'}>{readiness.headline}</Chip>
            </div>
            <p className="hint">{readiness.detail}</p>
            <details className="compact-details">
              <summary>All checks</summary>
              <ul className="readiness-steps">
                {readiness.steps.map((step) => (
                  <li key={step.id} className={step.done ? 'is-done' : 'is-open'} data-step={step.id}>
                    <span className="readiness-mark" aria-hidden="true">
                      {step.done ? '✓' : '○'}
                    </span>
                    <div>
                      <strong>{step.label}</strong>
                      {step.blockedBy ? <span>{step.blockedBy}</span> : null}
                    </div>
                    <span className="sr-only">{step.done ? 'done' : 'not done'}</span>
                  </li>
                ))}
              </ul>
            </details>
          </section>

          <section className="panel" aria-labelledby="tools-title">
            <div className="panel-head">
              <h2 className="panel-title" id="tools-title">Tools</h2>
              {toolsBlockedReason ? <span className="pill">{toolsBlockedReason}</span> : null}
            </div>
            <SelectField
              label="Preset"
              options={PROCESSING_PROFILES.map((item) => ({ value: item.id, label: item.label }))}
              value={activeProfile}
              onChange={(event) => {
                const next = PROCESSING_PROFILES.find((item) => item.id === event.target.value)
                if (next) setActiveProfile(next.id)
              }}
              hint={profile.description}
            />
            {profileNotice ? <p className="banner warn" role="status">{profileNotice}</p> : null}

            <div className="tool-list">
              <details
                className={`tool${toolDone.prepare ? ' is-done' : ''}`}
                open={shownTool === 'prepare'}
                onToggle={(event) =>
                  setOpenTool(event.currentTarget.open ? 'prepare' : 'none')
                }
              >
                <summary>
                  <span className="tool-index">1</span>
                  <span className="tool-text">
                    <strong>Crop</strong>
                    <small>
                      {toolDone.prepare ? 'Already cropped in this stack' : 'Trim unwanted edges'}
                    </small>
                  </span>
                  {toolDone.prepare ? <Chip tone="good">done</Chip> : null}
                </summary>
                <div className="tool-body row">
                  <button
                    type="button"
                    className="btn"
                    disabled={!canPropose}
                    onClick={() => void submitJob(() => api.steps.trim(designId, { mode: 'auto' }))}
                  >
                    Suggest auto-crop
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={!canPropose}
                    onClick={() => {
                      setCropInitial(null)
                      setCropAspect(null)
                      setCropOpen(true)
                    }}
                  >
                    Crop manually
                  </button>
                </div>
              </details>

              <details
                className={`tool${toolDone.enhance ? ' is-done' : ''}`}
                open={shownTool === 'enhance'}
                onToggle={(event) =>
                  setOpenTool(event.currentTarget.open ? 'enhance' : 'none')
                }
              >
                <summary>
                  <span className="tool-index">2</span>
                  <span className="tool-text">
                    <strong>Enhance</strong>
                    <small>
                      {toolDone.enhance
                        ? 'Upscaled — compare with the layer below before approving'
                        : 'Real-ESRGAN · usually seconds on GPU'}
                    </small>
                  </span>
                  {toolDone.enhance ? <Chip tone="good">done</Chip> : null}
                </summary>
                <div className="tool-body stack-sm">
                  {sourceDpi != null ? (
                    <p className={`hint ${sourceDpi < dpiThresholds.strongWarnBelow ? 'warn-text' : ''}`} role="note">
                      Source: about {Math.round(sourceDpi)} DPI at target size.
                      {sourceDpi < dpiThresholds.strongWarnBelow
                        ? ' Ask for a better original if possible; AI enlargement cannot recover missing detail.'
                        : ' Enlargement adds pixels, not original detail.'}
                    </p>
                  ) : null}
                  <div className="row">
                    <SelectField
                      label="Model"
                      options={UPSCALE_MODELS}
                      value={upscaleModel}
                      onChange={(event) => {
                        if (event.target.value === 'realesrgan-x4plus' || event.target.value === 'realesrgan-x4plus-anime') {
                          setUpscaleModel(event.target.value)
                        }
                      }}
                    />
                    <SelectField
                      label="Scale"
                      options={[{ value: '2', label: '2×' }, { value: '4', label: '4×' }]}
                      value={String(upscaleScale)}
                      onChange={(event) => setUpscaleScale(event.target.value === '2' ? 2 : 4)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canPropose}
                    onClick={() => void submitJob(() => api.steps.upscale(designId, { model: upscaleModel, scale: upscaleScale }))}
                  >
                    Enhance image
                  </button>
                  <p className="hint">
                    AI can invent texture or edges. Compare with the layer below before approving.
                  </p>
                </div>
              </details>

              <details
                className={`tool${toolDone.cutout ? ' is-done' : ''}`}
                open={shownTool === 'cutout'}
                onToggle={(event) =>
                  setOpenTool(event.currentTarget.open ? 'cutout' : 'none')
                }
              >
                <summary>
                  <span className="tool-index">3</span>
                  <span className="tool-text">
                    <strong>Cut out</strong>
                    <small>
                      {toolDone.cutout
                        ? 'Background removed — check the transparent edges'
                        : 'Colour-key cutout · mask shaping'}
                    </small>
                  </span>
                  {toolDone.cutout ? <Chip tone="good">done</Chip> : null}
                </summary>
                <div className="tool-body stack-sm">
                  <div className="row">
                    <ColorField
                      label="Key color"
                      value={cutoutKeyColor}
                      onChange={(event) => setCutoutKeyColor(event.target.value)}
                    />
                    <NumberField
                      label="Tolerance"
                      value={cutoutTolerance}
                      min={0}
                      max={255}
                      step={1}
                      onValueChange={(val) => setCutoutTolerance(val ?? 12)}
                      hint="How far from the key colour still counts as background."
                    />
                    <NumberField
                      label="Edge softness"
                      suffix="px"
                      value={cutoutEdgeSoftness}
                      min={0}
                      max={10}
                      step={0.5}
                      onValueChange={(val) => setCutoutEdgeSoftness(val ?? 0)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canPropose}
                    onClick={() =>
                      void submitJob(() =>
                        api.steps.backgroundRemoval(designId, {
                          mode: 'color-to-alpha',
                          keyColor: cutoutKeyColor,
                          tolerance: cutoutTolerance,
                          edgeSoftness: cutoutEdgeSoftness > 0 ? cutoutEdgeSoftness : undefined,
                          maskGrowPx: maskGrowPx !== 0 ? maskGrowPx : undefined,
                          maskLevels: isIdentityLevels(maskLevels) ? undefined : maskLevels,
                          imageLevels: isIdentityLevels(imageLevels) ? undefined : imageLevels,
                        }),
                      )
                    }
                  >
                    Remove background
                  </button>
                  <p className="hint">
                    Keys out one flat background colour — built for logos, text and flat
                    illustrations. Busy backgrounds should be cut in Photopea and imported.
                  </p>
                  <MaskGrowControl value={maskGrowPx} onChange={setMaskGrowPx} disabled={!canPropose} />
                  <details className="compact-details advanced">
                    <summary>Levels adjustments</summary>
                    <div className="stack-sm">
                      <LevelsControl
                        label="Mask levels"
                        curveCaption="alpha"
                        value={maskLevels}
                        onChange={setMaskLevels}
                        disabled={!canPropose}
                        hint="Reshapes the transparency itself: raise the black point to drop a faint halo, lower the white point to make a soft edge solid."
                      />
                      <LevelsControl
                        label="Image levels"
                        curveCaption="colour"
                        value={imageLevels}
                        onChange={setImageLevels}
                        disabled={!canPropose}
                        hint="Moves the colour of the pixels that survive the cut-out. Independent of the mask."
                      />
                    </div>
                  </details>
                </div>
              </details>

              <details
                className={`tool${toolDone.size ? ' is-done' : ''}`}
                open={shownTool === 'size'}
                onToggle={(event) =>
                  setOpenTool(event.currentTarget.open ? 'size' : 'none')
                }
              >
                <summary>
                  <span className="tool-index">4</span>
                  <span className="tool-text">
                    <strong>Print size</strong>
                    <small>
                      {toolDone.size
                        ? 'Final size set — this is what the packer uses'
                        : 'Final physical dimensions and resolution'}
                    </small>
                  </span>
                  {toolDone.size ? <Chip tone="good">done</Chip> : null}
                </summary>
                <div className="tool-body stack-sm">
                  <div className="row">
                    <NumberField
                      label="Width"
                      suffix="cm"
                      value={targetWidthCm}
                      min={0.1}
                      step={0.1}
                      onValueChange={updateTargetWidth}
                    />
                    <NumberField
                      label="Height"
                      suffix="cm"
                      value={effectiveHeightCm}
                      min={0.1}
                      step={0.1}
                      onValueChange={updateTargetHeight}
                    />
                    <button
                      type="button"
                      className="btn"
                      onClick={useArtworkSize}
                      disabled={busy}
                      data-testid="use-artwork-size"
                    >
                      Use artwork size
                    </button>
                  </div>
                  <CheckboxField
                    label={
                      artworkAspect === null
                        ? 'Keep width and height at the artwork ratio'
                        : `Keep width and height at the artwork ratio (${artworkAspect.toFixed(3)} : 1)`
                    }
                    checked={aspectLinked}
                    onChange={toggleAspectLink}
                  />
                  <CheckboxField
                    label="Allow 90° rotation when packing"
                    checked={allowRotation}
                    onChange={setAllowRotation}
                  />
                  <p className="mono muted" data-testid="print-resolution">
                    Resolution: {workingDpi} DPI — the batch's snapshotted working
                    resolution, used for every pixel calculation below.
                  </p>
                  {outputPixels ? (
                    <p className="mono muted" data-testid="resize-output-pixels">
                      Output at this size: {formatPixels(outputPixels.widthPx)} ×{' '}
                      {formatPixels(outputPixels.heightPx)} px · current file{' '}
                      {formatPixels(current.widthPx)} × {formatPixels(current.heightPx)} px
                    </p>
                  ) : null}
                  <p className="hint">
                    {aspectLinked
                      ? 'Changing either side updates the other so the printed artwork keeps its shape. The packer never stretches a design.'
                      : 'Free size. The resize step will contain the artwork inside this box and pad the remainder, never stretch it.'}
                  </p>
                  <p className="mono muted">
                    Current effective DPI: {design.effectiveDpi == null ? 'not available' : `${Math.round(design.effectiveDpi)} DPI`}
                    {design.effectiveDpi != null && design.effectiveDpi < dpiThresholds.warnBelow
                      ? ` · ${design.effectiveDpi < dpiThresholds.strongWarnBelow ? 'strong warning' : 'warning'}`
                      : ''}
                  </p>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canPropose || !canSubmitSize}
                    onClick={() => {
                      if (effectiveWidthCm === null || effectiveHeightCm === null) return
                      const widthCm = effectiveWidthCm
                      const heightCm = effectiveHeightCm
                      void (async () => {
                        await mutate(
                          async () => {
                            await api.designs.update(designId, {
                              targetWidthCm: widthCm,
                              targetHeightCm: heightCm,
                              allowRotation,
                            })
                            const accepted = await api.steps.resize(designId, {
                              targetWidthCm: widthCm,
                              targetHeightCm: heightCm,
                              fitMode: 'contain',
                            })
                            setJobId(accepted.jobId)
                          },
                          'Resize proposal queued.',
                        )
                      })()
                    }}
                  >
                    Save size &amp; create layer
                  </button>
                </div>
              </details>
            </div>
          </section>

          {data?.suggestions.status === 'ready' ? (
            <details className="panel compact-details">
              <summary>Image analysis and suggestions</summary>
              <p className="hint">
                Advisory only. Source effective DPI:{' '}
                {data.suggestions.source?.effectiveDpiAtTarget == null
                  ? 'not available'
                  : `${Math.round(data.suggestions.source.effectiveDpiAtTarget)} DPI`}
                .
              </p>
              <pre className="mono">{JSON.stringify(data.suggestions.suggestions ?? {}, null, 2)}</pre>
            </details>
          ) : null}
        </aside>
      </div>

      {modalOpen && proposal ? (
        <div
          className="review-modal-backdrop is-open"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-modal-title"
            onClick={(event) => event.stopPropagation()}
            data-testid="proposal-modal"
          >
            <div className="review-modal-head">
              <h2 id="review-modal-title" className="review-modal-title">
                Proposal summary
              </h2>
              <button
                type="button"
                className="close"
                onClick={() => setModalOpen(false)}
                aria-label="Close proposal summary"
              >
                ×
              </button>
            </div>
            <div className="review-modal-body">
              <div className="row" style={{ gap: 10 }}>
                <StatusChip status="approved" label="Current" />
                <StatusChip status="proposed" label="Proposal" />
              </div>
              <dl className="proposal-diff">
                <dt>Pixels</dt>
                <dd>
                  {proposal.widthPx === current.widthPx &&
                  proposal.heightPx === current.heightPx
                    ? `${formatPixels(current.widthPx)} × ${formatPixels(current.heightPx)} — unchanged`
                    : `${formatPixels(current.widthPx)} × ${formatPixels(current.heightPx)} → ${formatPixels(proposal.widthPx)} × ${formatPixels(proposal.heightPx)}`}
                </dd>
                <dt>Step</dt>
                <dd>
                  {stepLabel(current.stepType)} → {stepLabel(proposal.stepType)}
                </dd>
                <dt>If approved</dt>
                <dd>{proposalEffect(proposal.stepType)}</dd>
              </dl>
              <p className="hint">
                Approving makes this layer current and it becomes the artwork the packer
                places. Every layer below it stays in the stack.
              </p>
            </div>
            <div className="review-modal-foot">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                data-testid="proposal-modal-approve"
                onClick={modalIntent === 'approve' ? approveProposal : rejectProposal}
              >
                {modalIntent === 'approve' ? 'Approve proposal' : 'Reject proposal'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cropOpen ? (
        <CropTool
          fileUrl={current.fileUrl}
          widthPx={current.widthPx}
          heightPx={current.heightPx}
          initialRect={cropInitial}
          aspectLock={cropAspect}
          onCancel={() => setCropOpen(false)}
          onApply={(rect) => void applyCrop(rect)}
        />
      ) : null}
    </section>
  )
}
