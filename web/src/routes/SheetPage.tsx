import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  api,
  exportArtifactUrl,
  sheetPreviewUrl,
  type BatchDetail,
  type Export,
  type Placement,
  type Sheet,
} from '../api/client'
import { ApiError } from '../api/problem'
import { evaluatePackReadiness } from '../components/batch/packReadiness'
import { WorkflowStepper } from '../components/batch/WorkflowStepper'
import { workflowProgress } from '../components/batch/workflowProgress'
import { Banner, ErrorBanner } from '../components/ui/Banner'
import { Chip, StatusChip, StaleChip } from '../components/ui/Chip'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { useAsync, useJobPoller } from '../hooks/useAsync'
import {
  canExport,
  clampPlacement,
  collidingDesignIds,
  INTEGRITY_CHECK_IDS,
  integrityCheckDescription,
  integrityCheckLabel,
  integritySummary,
  rotateBy90,
  toManualPlacements,
} from '../lib/sheet'
import {
  artifactLabel,
  describeUnplacedReason,
  formatCentimeters,
  formatMoney,
  statusLabel,
} from '../lib/format'

interface PlacementDraft {
  xCm: number
  yCm: number
  widthCm: number
  heightCm: number
  rotationDeg: Placement['rotationDeg']
}

interface SheetPageData {
  batch: BatchDetail
  sheet: Sheet | null
  exports: Export[]
}

function isSheetNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'sheet-not-found'
}

async function loadSheetPage(batchId: string, signal: AbortSignal): Promise<SheetPageData> {
  const [batch, sheetResult, exports] = await Promise.all([
    api.batches.get(batchId, { signal }),
    api.sheets.get(batchId, { signal }).then(
      (sheet) => ({ sheet, error: null }),
      (error: unknown) => ({ sheet: null, error }),
    ),
    api.exports.list(batchId, { signal }),
  ])
  if (sheetResult.error && !isSheetNotFound(sheetResult.error)) throw sheetResult.error
  return { batch, sheet: sheetResult.sheet, exports: exports.items }
}

function displayJobName(type: string): string {
  return type.replaceAll('-', ' ')
}

export default function SheetPage() {
  const { batchId = '' } = useParams()
  const [drafts, setDrafts] = useState<Record<string, PlacementDraft>>({})
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobKind, setJobKind] = useState<'pack' | 'integrity' | 'export' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [latestExport, setLatestExport] = useState<Export | null>(null)
  const [selectedDesignIds, setSelectedDesignIds] = useState<string[] | null>(null)
  const { state, reload } = useAsync(
    (signal) => loadSheetPage(batchId, signal),
    [batchId],
  )
  const { job, error: jobPollError } = useJobPoller(jobId)

  const data = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  const batch = data?.batch ?? null
  const sheet = data?.sheet ?? null
  const readiness = batch ? evaluatePackReadiness(batch) : null
  const selectedIds = useMemo(() => {
    if (!readiness) return []
    return selectedDesignIds ?? readiness.included.map((design) => design.id)
  }, [readiness, selectedDesignIds])

  useEffect(() => {
    if (!sheet) {
      setDrafts({})
      return
    }
    setDrafts(
      Object.fromEntries(
        sheet.placements.map((placement) => [
          placement.designId,
          {
            xCm: placement.xCm,
            yCm: placement.yCm,
            widthCm: placement.widthCm,
            heightCm: placement.heightCm,
            rotationDeg: placement.rotationDeg,
          },
        ]),
      ),
    )
  }, [sheet?.id, sheet?.revision])

  useEffect(() => {
    if (job?.status !== 'succeeded') {
      if (job?.status === 'failed') setError(job.error ?? new Error(`${displayJobName(job.type)} job failed.`))
      return
    }
    reload()
    if (jobKind === 'export' && job.result?.exportId) {
      api.exports
        .get(job.result.exportId)
        .then(setLatestExport)
        .catch((caught: unknown) => setError(caught))
    }
  }, [job?.id, job?.status, job?.type, job?.error, job?.result?.exportId, jobKind, reload])

  const placements = sheet?.placements.map((placement) => ({
    ...placement,
    ...(drafts[placement.designId] ?? {}),
  })) ?? []
  const collidingIds = collidingDesignIds(placements)
  const exportGate = canExport(sheet)
  const integrity = integritySummary(sheet?.integrityReport)
  const unplacedDesigns = (() => {
    const raw = sheet?.integrityReport?.checks.find(
      (check) => check.id === 'all-designs-placed',
    )?.details?.unplacedDesigns
    return Array.isArray(raw) ? (raw as Array<{ designId: string; reason: string }>) : []
  })()
  // Reports identify designs by id; operators know them by name. Fall back to
  // the id only when the design is no longer part of the batch.
  const designNameById = new Map((batch?.designs ?? []).map((design) => [design.id, design.name]))
  const unplacedLabel = (designId: string) => designNameById.get(designId) ?? designId
  // An export only counts as done when it is for *this* revision; an older
  // export of a repacked sheet must not tick the final stage.
  const exported =
    sheet !== null &&
    [...(data?.exports ?? []), ...(latestExport ? [latestExport] : [])].some(
      (item) => item.sheetRevision === sheet.revision && item.status === 'succeeded',    )
  const progress = batch ? workflowProgress({ batch, sheet, exported }) : null

  async function queueJob(kind: 'pack' | 'integrity' | 'export', start: () => Promise<{ jobId: string }>) {
    setBusy(true)
    setError(null)
    setLatestExport(null)
    try {
      const accepted = await start()
      setJobKind(kind)
      setJobId(accepted.jobId)
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  function setCoordinate(
    designId: string,
    field: 'xCm' | 'yCm',
    value: number,
  ) {
    if (!sheet) return
    const placement = placements.find((item) => item.designId === designId)
    if (!placement) return
    const next = clampPlacement(
      { ...placement, [field]: value },
      { widthCm: sheet.widthCm, heightCm: sheet.heightCm },
    )
    setDrafts((previous) => ({
      ...previous,
      [designId]: { ...previous[designId], ...next.placement },
    }))
  }

  function rotate(designId: string) {
    const placement = placements.find((item) => item.designId === designId)
    if (!placement) return
    const next = rotateBy90(placement)
    if (!next) return
    setDrafts((previous) => ({
      ...previous,
      [designId]: {
        ...previous[designId],
        widthCm: next.widthCm,
        heightCm: next.heightCm,
        rotationDeg: next.rotationDeg,
      },
    }))
  }

  async function savePlacements() {
    if (!sheet) return
    setBusy(true)
    setError(null)
    try {
      await api.sheets.updatePlacements(batchId, {
        revision: sheet.revision,
        placements: toManualPlacements(placements),
      })
      reload()
    } catch (caught: unknown) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  if (state.kind === 'loading') return <Loading label="Loading packing sheet…" />
  if (state.kind === 'error') {
    return <ErrorState error={state.error} onRetry={reload} title="Could not load packing sheet" />
  }
  if (!data || !batch || !readiness) return null

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <p className="breadcrumb"><Link to="/">Batches</Link> / <Link to={`/batches/${batchId}`}>{batch.name}</Link></p>
          <h1 className="page-title">Packing sheet</h1>
          <p className="page-subtitle">
            {formatCentimeters(batch.rollWidthCm)} wide · {batch.workingDpi} DPI · target boxes preserve aspect ratio; source artwork stays unchanged
          </p>
        </div>
        <div className="row">
          <Link className="btn" to={`/batches/${batchId}`}>Back to designs</Link>
          <button
            type="button"
            className="btn primary"
            disabled={!readiness.canPack || selectedIds.length === 0 || busy}
            onClick={() => void queueJob('pack', () => api.sheets.pack(batchId, { designIds: selectedIds }))}
          >
            {sheet ? 'Repack selection' : 'Pack selection'}
          </button>
        </div>
      </header>

      {progress ? <WorkflowStepper progress={progress} /> : null}

      {readiness.blockingReason ? (
        <Banner kind="warn" title="Packing is blocked">{readiness.blockingReason}</Banner>
      ) : null}
      {error ? <ErrorBanner error={error} title="Sheet action failed" /> : null}
      {jobPollError ? <ErrorBanner error={jobPollError} title="Could not check sheet job" /> : null}
      {job ? (
        <Banner
          kind={job.status === 'failed' ? 'error' : 'info'}
          title={`${displayJobName(job.type)}: ${statusLabel(job.status).toLowerCase()}`}
        >
          {job.error
            ? job.error.message
            : job.status === 'succeeded'
              ? 'Finished. Review the result below before continuing.'
              : 'This runs in the background; the page updates when it finishes.'}
        </Banner>
      ) : null}
      {state.kind === 'reloading' ? <p className="mono muted">Refreshing sheet state…</p> : null}

      <section className="card stack-sm">
        <div className="card-heading">
          <h2 className="card-title">Designs in this layout</h2>
          <span className="mono muted">{selectedIds.length} of {readiness.included.length} selected</span>
        </div>
        <p className="hint">
          Every non-excluded design must be ready before packing. Select a subset to preview a partial layout; omitted designs are not included in this sheet.
        </p>
        <div className="layout-design-list">
          {readiness.included.map((design) => {
            const checked = selectedIds.includes(design.id)
            return (
              <label className="layout-design-row" key={design.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!readiness.canPack || busy}
                  onChange={(event) => {
                    setSelectedDesignIds((previous) => {
                      const current = previous ?? readiness.included.map((item) => item.id)
                      return event.target.checked
                        ? [...current, design.id]
                        : current.filter((id) => id !== design.id)
                    })
                  }}
                />
                <span className="placement-name">
                  <strong>{design.name}</strong>
                  <span className="mono muted">
                    {design.targetWidthCm && design.targetHeightCm
                      ? `${design.targetWidthCm} × ${design.targetHeightCm} cm target`
                      : 'No explicit target box'}
                    {' · '}
                    {statusLabel(design.status)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      </section>

      {!sheet ? (
        <EmptyState title="No packing sheet yet">
          {readiness.canPack
            ? 'Run the packer to create a proposed arrangement. No design pixels are changed.'
            : 'Finish reviewing every included design before packing.'}
        </EmptyState>
      ) : (
        <>
          <div className="split">
            <section className="card">
              <div className="card-heading">
                <h2 className="card-title">Sheet preview · revision {sheet.revision}</h2>
                <div className="row">
                  <StatusChip status={sheet.state} />
                  {sheet.stale ? <StaleChip /> : null}
                </div>
              </div>
              <img
                key={`${sheet.id}-${sheet.revision}`}
                className="sheet-preview"
                src={`${sheetPreviewUrl(batchId)}?revision=${sheet.revision}`}
                alt={`Packing sheet preview, ${sheet.placements.length} designs`}
              />
              <dl className="kv">
                <dt>Geometry</dt>
                <dd>{sheet.widthPx} × {sheet.heightPx} px</dd>
                <dt>Physical</dt>
                <dd>{formatCentimeters(sheet.widthCm, 2)} × {formatCentimeters(sheet.heightCm, 2)}</dd>
                <dt>Designs</dt>
                <dd>{sheet.placements.length} placed</dd>
                <dt>Cut gap</dt>
                <dd>{batch.marginMm} mm between designs · {batch.edgeMarginMm} mm to the edge</dd>
                <dt>Estimate</dt>
                <dd>{formatMoney(sheet.estimatedCost)}</dd>
              </dl>
            </section>

            <section className="card stack-sm">
              <div className="card-heading">
                <h2 className="card-title">Integrity gate</h2>
                <Chip tone={integrity.passed && !sheet.stale ? 'good' : 'warn'}>
                  {sheet.stale ? 'stale' : integrity.status}
                </Chip>
              </div>
              <p className="hint">
                All five blocking checks must pass for this exact revision before any export.
              </p>
              <ul className="integrity-checks">
                {INTEGRITY_CHECK_IDS.map((checkId) => {
                  const result = integrity.checks[checkId]
                  const failure = sheet.integrityReport?.failures.find(
                    (item) => item.checkId === checkId,
                  )
                  return (
                    <li key={checkId} data-check={checkId}>
                      <div className="integrity-check-text">
                        <span className="integrity-check-label">
                          {integrityCheckLabel(checkId)}
                        </span>
                        <span className="integrity-check-detail" title={checkId}>
                          {failure?.message ?? integrityCheckDescription(checkId)}
                        </span>
                      </div>
                      <StatusChip status={result} />
                    </li>
                  )
                })}
              </ul>
              {sheet.integrityReport && !sheet.integrityReport.passed ? (
                <Banner kind="error" title="Integrity failed" strong>
                  {/* Each failing check already shows its own message in the list
                      above, so this banner only summarises which ones failed
                      rather than repeating the sentences twice. */}
                  {sheet.integrityReport.failures
                    .map((failure) => integrityCheckLabel(failure.checkId))
                    .join(' · ')}
                </Banner>
              ) : null}
              {unplacedDesigns.length > 0 ? (
                <Banner kind="warn" title="Some designs were not placed">
                  <ul>
                    {unplacedDesigns.map((item) => (
                      <li key={item.designId}>
                        {unplacedLabel(item.designId)}: {describeUnplacedReason(item.reason)}
                      </li>
                    ))}
                  </ul>
                  Select a smaller subset, update explicit target sizes, or exclude designs before repacking.
                </Banner>
              ) : null}
              <button
                type="button"
                className="btn"
                disabled={busy || sheet.stale}
                onClick={() => void queueJob('integrity', () => api.sheets.runIntegrityCheck(batchId))}
              >
                Run blocking integrity check
              </button>
              <p className="hint">{exportGate.message}</p>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !exportGate.can}
                onClick={() => void queueJob('export', () => api.exports.create(batchId, { format: 'flat-png' }))}
              >
                Export flat PNG
              </button>
            </section>
          </div>

          <section className="card">
            <div className="card-heading">
              <h2 className="card-title">Review placements</h2>
              <span className="mono muted">Move by coordinates or rotate 90°; saving invalidates integrity.</span>
            </div>
            {collidingIds.size > 0 ? (
              <Banner kind="warn" title="Bounding-box overlap">
                These rectangles overlap: {placements.filter((item) => collidingIds.has(item.designId)).map((item) => item.designName ?? item.designId).join(', ')}.
                This is only a conservative visual warning; the packer’s mask-based integrity check is authoritative.
              </Banner>
            ) : null}
            {sheet.placements.length === 0 ? (
              <EmptyState title="No placements in this sheet" />
            ) : (
              <div className="placement-list">
                {placements.map((placement) => (
                  <div className="placement-row" key={placement.designId}>
                    <div className="placement-name">
                      <strong>{placement.designName ?? placement.designId}</strong>
                      <span className="mono muted">{placement.widthCm.toFixed(1)} × {placement.heightCm.toFixed(1)} cm</span>
                    </div>
                    <label className="field">
                      X (cm)
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={drafts[placement.designId]?.xCm ?? placement.xCm}
                        aria-label={`X position for ${placement.designName ?? placement.designId}`}
                        onChange={(event) => {
                          const value = Number(event.target.value)
                          if (Number.isFinite(value)) setCoordinate(placement.designId, 'xCm', value)
                        }}
                      />
                    </label>
                    <label className="field">
                      Y (cm)
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        value={drafts[placement.designId]?.yCm ?? placement.yCm}
                        aria-label={`Y position for ${placement.designName ?? placement.designId}`}
                        onChange={(event) => {
                          const value = Number(event.target.value)
                          if (Number.isFinite(value)) setCoordinate(placement.designId, 'yCm', value)
                        }}
                      />
                    </label>
                    <span className="pill">rotation {drafts[placement.designId]?.rotationDeg ?? placement.rotationDeg}°</span>
                    <button
                      type="button"
                      className="btn sm"
                      aria-label={`Rotate ${placement.designName ?? placement.designId} by 90 degrees`}
                      onClick={() => rotate(placement.designId)}
                    >
                      Rotate 90°
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="row row-end">
              <button type="button" className="btn" onClick={reload}>Discard local edits</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void savePlacements()}>
                Save placements
              </button>
            </div>
          </section>
        </>
      )}

      {latestExport ? (
        <section className="card">
          <div className="card-heading">
            <h2 className="card-title">Latest export</h2>
            <StatusChip status={latestExport.status} />
          </div>
          <dl className="kv">
            <dt>Revision</dt>
            <dd>{latestExport.sheetRevision}</dd>
            <dt>Resolution</dt>
            <dd>{latestExport.dpi} DPI</dd>
            {sheet ? (
              <>
                <dt>Pixel size</dt>
                <dd>
                  {sheet.widthPx} × {sheet.heightPx} px ·{' '}
                  {formatCentimeters(sheet.widthCm, 2)} × {formatCentimeters(sheet.heightCm, 2)}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="artifact-list">
            {latestExport.artifacts.map((artifact) => (
              <a
                key={artifact.name}
                className="artifact-link"
                href={exportArtifactUrl(latestExport.id, artifact.name)}
                download
              >
                <strong>{artifactLabel(artifact.name)}</strong>
                <span className="mono muted">{Math.ceil(artifact.sizeBytes / 1024)} KB</span>
              </a>
            ))}
          </div>
          <p className="hint">
            Files are downloaded as exported — nothing is resized or re-encoded on the way out.
          </p>
        </section>
      ) : null}

      {data.exports.length > 0 ? (
        <section className="card">
          <h2 className="card-title">Export history</h2>
          <ul className="version-list">
            {data.exports.map((exportItem) => (
              <li key={exportItem.id} className="version-row">
                <span>{exportItem.format} · revision {exportItem.sheetRevision} · {exportItem.dpi} DPI</span>
                <div className="row">
                  <StatusChip status={exportItem.status} />
                  {exportItem.artifacts.map((artifact) => (
                    <a key={artifact.name} href={exportArtifactUrl(exportItem.id, artifact.name)} download>
                      {artifactLabel(artifact.name)}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  )
}
