import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type CropRect, type DesignDetail, type DesignVersion } from '../api/client'
import { AlphaPreview } from '../components/preview/AlphaPreview'
import { BackgroundPicker } from '../components/preview/BackgroundPicker'
import { ErrorBanner } from '../components/ui/Banner'
import { Chip, StatusChip } from '../components/ui/Chip'
import { CheckboxField, NumberField, SelectField } from '../components/ui/Field'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import CropTool from '../components/crop/CropTool'
import { useAsync, useJobPoller } from '../hooks/useAsync'
import { formatPixels, shortId, stepLabel } from '../lib/format'
import { DEFAULT_PREVIEW_BACKGROUND, previewBackgroundFor, type PreviewBackground } from '../lib/preview'
import { useSettings } from '../state/SettingsContext'
import './design-review.css'

const UPSCALE_MODELS = [
  { value: 'realesrgan-x4plus', label: 'Real-ESRGAN · photos / general artwork' },
  { value: 'realesrgan-x4plus-anime', label: 'Real-ESRGAN · anime-style artwork' },
] as const

function proposedVersion(design: DesignDetail): DesignVersion | undefined {
  return design.versions.find((version) => version.status === 'proposed')
}

function versionFor(design: DesignDetail, versionId: string): DesignVersion | undefined {
  return design.versions.find((version) => version.id === versionId)
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
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
  const [targetWidthCm, setTargetWidthCm] = useState<number | null>(null)
  const [targetHeightCm, setTargetHeightCm] = useState<number | null>(null)
  const [allowRotation, setAllowRotation] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [rejectedActions, setRejectedActions] = useState<string[]>([])
  const { dpiThresholds } = useSettings()
  const { state, reload } = useAsync(
    async (signal) => {
      const [design, suggestions, jobs] = await Promise.all([
        api.designs.get(designId, { signal }),
        api.designs.suggestions(designId, { signal }),
        api.batches.jobs(batchId, { limit: 200 }, { signal }),
      ])
      return { design, suggestions, jobs }
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

  const design = data?.design ?? null
  const proposal = design ? proposedVersion(design) : undefined
  const current = design?.currentVersion ?? null

  useEffect(() => {
    if (!design) return
    setBackground(previewBackgroundFor(design.garmentColor))
    setTargetWidthCm(design.targetWidthCm ?? null)
    setTargetHeightCm(design.targetHeightCm ?? null)
    setAllowRotation(design.allowRotation)
  }, [design?.id])

  useEffect(() => {
    if (job?.status === 'succeeded') {
      setNotice('Processing completed. Review the proposed version below; it is not current until approved.')
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

  async function rejectProposal() {
    if (!proposal) return
    setBusy(true)
    setError(null)
    try {
      const response = await api.designs.reject(designId, proposal.id)
      setRejectedActions(response.nextActions)
      setNotice('Proposal rejected. The previously approved version remains current.')
      reload()
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') return <Loading label="Loading design…" />
  if (state.kind === 'error') {
    return <ErrorState error={state.error} onRetry={reload} title="Could not load design" />
  }
  if (!design || !current) {
    return <EmptyState title="Design has no current version">Ask for a better source or contact support.</EmptyState>
  }

  const canPropose = !proposal && !busy && job?.status !== 'queued' && job?.status !== 'running'
  const currentDetails = versionFor(design, current.id)
  const sourceDpi = data?.suggestions.status === 'ready'
    ? data.suggestions.source?.effectiveDpiAtTarget
    : null
  const jobStartedAt = job ? Date.parse(job.startedAt ?? job.createdAt) : Number.NaN
  const elapsedMs = Number.isFinite(jobStartedAt) ? Math.max(0, observedAt - jobStartedAt) : null
  const elapsedText = elapsedMs === null ? null : formatElapsed(elapsedMs)
  const isGpuUpscale = job?.type === 'upscale' && job.parameters.gpu === true

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <p className="breadcrumb">
            <Link to="/">Batches</Link> / <Link to={`/batches/${batchId}`}>{batchId.slice(0, 8)}</Link> / Review
          </p>
          <h1 className="page-title">{design.name}</h1>
          <p className="page-subtitle">
            {design.status} · {design.versionCount} immutable versions · current {stepLabel(current.stepType)}
          </p>
        </div>
        <div className="row">
          <Link className="btn" to={`/batches/${batchId}`}>Back to batch</Link>
          {design.status === 'excluded' ? <StatusChip status="excluded" /> : null}
        </div>
      </header>

      {error ? <ErrorBanner error={error} title="Design action failed" /> : null}
      {jobPollError ? <ErrorBanner error={jobPollError} title="Could not check processing job" /> : null}
      {notice ? <p className="banner info" role="status">{notice}</p> : null}
      {job ? (
        <section className={`card job-progress ${jobActive ? 'is-active' : ''}`} aria-label="Job progress">
          <div className="card-heading">
            <div className="row">
              <strong>{job.type === 'upscale' ? 'Image enhancement' : job.type.replaceAll('-', ' ')}</strong>
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
                  ? `Finished${job.durationMs == null ? '' : ` in ${formatElapsed(job.durationMs)}`}. Review the proposal before approving.`
                  : `Job ${job.status}.`)}
            </p>
          )}
        </section>
      ) : null}
      {state.kind === 'reloading' ? <p className="mono muted">Refreshing design state…</p> : null}

      <BackgroundPicker
        value={background}
        onChange={setBackground}
        garmentHex={design.garmentColor.hex}
      />

      <div className="split">
        <section className="card">
          <div className="card-heading">
            <h2 className="card-title">Current approved version</h2>
            <StatusChip status="approved" />
          </div>
          <AlphaPreview
            fileUrl={current.fileUrl}
            alt={`${design.name}, current approved artwork`}
            background={background}
            widthPx={current.widthPx}
            heightPx={current.heightPx}
            testId="current-design-preview"
          />
          <p className="mono muted">
            {stepLabel(current.stepType)} · {formatPixels(current.widthPx)} × {formatPixels(current.heightPx)} · {shortId(current.id)}
          </p>
          {currentDetails?.artifacts?.svgUrl ? (
            <a href={currentDetails.artifacts.svgUrl} target="_blank" rel="noreferrer">View vector artifact</a>
          ) : null}
        </section>

        <section className="card">
          <div className="card-heading">
            <h2 className="card-title">Proposal review</h2>
            {proposal ? <StatusChip status="proposed" /> : <Chip>no pending proposal</Chip>}
          </div>
          {proposal ? (
            <>
              <AlphaPreview
                fileUrl={proposal.fileUrl}
                alt={`${design.name}, proposed ${stepLabel(proposal.stepType)} version`}
                background={background}
                widthPx={proposal.widthPx}
                heightPx={proposal.heightPx}
                testId="proposed-design-preview"
              />
              <p className="mono muted">
                {stepLabel(proposal.stepType)} · {formatPixels(proposal.widthPx)} × {formatPixels(proposal.heightPx)} · {shortId(proposal.id)}
              </p>
              <div className="row">
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void mutate(() => api.designs.approve(designId, proposal.id), 'Proposal approved and made current.')}
                >
                  Approve proposal
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => void rejectProposal()}>
                  Reject proposal
                </button>
              </div>
            </>
          ) : (
            <EmptyState title="No proposal awaiting review">
              Choose an optional processing step. Its result will be a new version and will not replace
              the current image unless you approve it.
            </EmptyState>
          )}
          {rejectedActions.length > 0 ? (
            <div className="stack-sm" role="group" aria-label="Next actions after rejection">
              <strong>What next?</strong>
              {rejectedActions.includes('adjust-parameters') ? (
                <button type="button" className="btn" onClick={() => setNotice('Adjust the step controls below, then submit a new proposal.')}>
                  Adjust parameters
                </button>
              ) : null}
              {rejectedActions.includes('manual-tool') ? (
                <button type="button" className="btn" onClick={() => setCropOpen(true)}>
                  Use manual crop tool
                </button>
              ) : null}
              {rejectedActions.includes('skip') ? (
                <button type="button" className="btn ghost" onClick={() => setRejectedActions([])}>
                  Skip this step
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>

      <section className="card stack" aria-labelledby="pipeline-title">
        <div>
          <h2 className="card-title" id="pipeline-title">Artwork pipeline</h2>
          <p className="hint">Choose a step, review its proposal, then continue. Every step is optional and keeps the original safe.</p>
        </div>
        <ol className="pipeline">
          <li className="pipeline-step">
            <details>
              <summary>
                <span className="pipeline-number">1</span>
                <span><strong>Prepare artwork</strong><small>Crop unwanted edges</small></span>
              </summary>
              <div className="pipeline-content row">
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
          </li>

          <li className="pipeline-step">
            <details open>
              <summary>
                <span className="pipeline-number">2</span>
                <span><strong>Enhance resolution</strong><small>Real-ESRGAN · usually seconds on GPU</small></span>
              </summary>
              <div className="pipeline-content stack-sm">
                {sourceDpi != null ? (
                  <p className={`hint ${sourceDpi < dpiThresholds.strongWarnBelow ? 'warn-text' : ''}`} role="note">
                    Source: about {Math.round(sourceDpi)} DPI at target size.
                    {sourceDpi < dpiThresholds.strongWarnBelow
                      ? ' Ask for a better original if possible; AI enlargement cannot recover missing detail.'
                      : ' Enlargement adds pixels, not original detail.'}
                  </p>
                ) : null}
                <p className="hint">
                  AI can invent texture or edges. Compare the result with the original before approval.
                </p>
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
                  <button
                    type="button"
                    className="btn primary"
                    disabled={!canPropose}
                    onClick={() => void submitJob(() => api.steps.upscale(designId, { model: upscaleModel, scale: upscaleScale }))}
                  >
                    Enhance image
                  </button>
                </div>
              </div>
            </details>
          </li>

          <li className="pipeline-step">
            <details>
              <summary>
                <span className="pipeline-number">3</span>
                <span><strong>Set print size</strong><small>Final physical dimensions and resolution</small></span>
              </summary>
              <div className="pipeline-content stack-sm">
                <div className="row">
                  <NumberField label="Width" suffix="cm" value={targetWidthCm} min={0.1} step={0.1} onValueChange={setTargetWidthCm} />
                  <NumberField label="Height" suffix="cm" value={targetHeightCm} min={0.1} step={0.1} onValueChange={setTargetHeightCm} />
                  <CheckboxField label="Allow 90° rotation when packing" checked={allowRotation} onChange={setAllowRotation} />
                  <button
                    type="button"
                    className="btn"
                    disabled={!canPropose || targetWidthCm === null || targetHeightCm === null}
                    onClick={() => {
                      if (targetWidthCm === null || targetHeightCm === null) return
                      const widthCm = targetWidthCm
                      const heightCm = targetHeightCm
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
                    Save size &amp; create proposal
                  </button>
                </div>
                <p className="mono muted">
                  Current effective DPI: {design.effectiveDpi == null ? 'not available' : `${Math.round(design.effectiveDpi)} DPI`}
                  {design.effectiveDpi != null && design.effectiveDpi < dpiThresholds.warnBelow
                    ? ` · ${design.effectiveDpi < dpiThresholds.strongWarnBelow ? 'strong warning' : 'warning'}`
                    : ''}
                </p>
              </div>
            </details>
          </li>
        </ol>
      </section>

      {data?.suggestions.status === 'ready' ? (
        <details className="card compact-details">
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

      <details className="card compact-details">
        <summary>Version history ({design.versionCount})</summary>
        <ul className="version-list">
          {design.versions.map((version) => (
            <li key={version.id} className="version-row">
              <div>
                <strong>{stepLabel(version.stepType)}</strong>
                <span className="mono muted"> · {shortId(version.id)} · {formatPixels(version.widthPx)} × {formatPixels(version.heightPx)}</span>
              </div>
              <div className="row">
                <StatusChip status={version.status} />
                {version.status === 'approved' && version.id !== design.currentVersionId ? (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api.designs.revert(designId, version.id), 'Current version reverted.')}
                  >
                    Revert to this version
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </details>

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
