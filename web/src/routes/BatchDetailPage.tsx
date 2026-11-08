import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type DesignSummary, type GarmentColorKind, type UploadProgress } from '../api/client'
import { ApiError } from '../api/problem'
import { DesignGridCard } from '../components/batch/DesignGridCard'
import {
  designFilterLabel,
  filterDesigns,
  prepareDesignGrid,
  type DesignFilter,
} from '../components/batch/designGrid'
import { evaluatePackReadiness } from '../components/batch/packReadiness'
import { WorkflowStepper } from '../components/batch/WorkflowStepper'
import { workflowProgress } from '../components/batch/workflowProgress'
import { Banner, ErrorBanner } from '../components/ui/Banner'
import { Chip } from '../components/ui/Chip'
import { EmptyState, ErrorState, Loading } from '../components/ui/States'
import { useAsync, useJobPoller } from '../hooks/useAsync'
import { centimetersForPixels, formatCentimeters, formatPixels, statusLabel } from '../lib/format'
import { defaultDesignName, readImageSize } from '../lib/upload'
import { useSettings } from '../state/SettingsContext'

interface ReadyImportFile {
  file: File
  widthPx: number | null
  heightPx: number | null
}

const DESIGN_FILTERS: DesignFilter[] = ['all', 'needs-work', 'ready', 'excluded']

function isBatchNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'batch-not-found'
}

export default function BatchDetailPage() {
  const { batchId = '' } = useParams()
  const fileInput = useRef<HTMLInputElement>(null)
  const readyInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [readyFiles, setReadyFiles] = useState<ReadyImportFile[]>([])
  const [importingReady, setImportingReady] = useState(false)
  const [readyProgress, setReadyProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [readyError, setReadyError] = useState<unknown>(null)
  const [readyNotice, setReadyNotice] = useState<string | null>(null)
  const [garmentColorKind, setGarmentColorKind] = useState<GarmentColorKind>('light')
  const [garmentColorHex, setGarmentColorHex] = useState('#ffffff')
  const [intakeChoice, setIntakeChoice] = useState<'raw' | 'ready' | null>(null)
  const [designFilter, setDesignFilter] = useState<DesignFilter>('all')
  const [designQuery, setDesignQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [uploadError, setUploadError] = useState<unknown>(null)
  const [mutationError, setMutationError] = useState<unknown>(null)
  const [busyDesignId, setBusyDesignId] = useState<string | null>(null)
  const [packing, setPacking] = useState(false)
  const [packJobId, setPackJobId] = useState<string | null>(null)
  const { job: packJob, error: packPollError } = useJobPoller(packJobId)
  const { dpiThresholds } = useSettings()
  const { state, reload } = useAsync(
    (signal) => api.batches.get(batchId, { signal }),
    [batchId],
  )

  const batch = state.kind === 'ready' || state.kind === 'reloading' ? state.value : null
  const readiness = batch ? evaluatePackReadiness(batch) : null
  // Two intake paths exist and they are not interchangeable, so the operator
  // picks one explicitly instead of facing two competing upload forms. An
  // empty batch starts on the raw path; a batch whose designs are all already
  // ready starts on the ready path, since that is what is being topped up.
  const intakePath: 'raw' | 'ready' =
    intakeChoice ?? (batch && batch.designCount > 0 && batch.readyCount === batch.designCount ? 'ready' : 'raw')
  const progress = batch ? workflowProgress({ batch, sheet: batch.sheet ?? null, exported: false }) : null
  const designGrid = prepareDesignGrid(batch?.designs ?? [], {
    filter: designFilter,
    query: designQuery,
  })

  useEffect(() => {
    if (packJob?.status === 'succeeded') reload()
  }, [packJob?.status, reload])

  async function upload(event: FormEvent) {
    event.preventDefault()
    if (!file) {
      setUploadError(new Error('Choose an image file before uploading.'))
      return
    }

    setUploading(true)
    setUploadError(null)
    setUploadProgress(null)
    try {
      await api.designs.upload(
        batchId,
        {
          file,
          name: file.name.replace(/\.[^.]+$/, ''),
          garmentColorKind,
          garmentColorHex: garmentColorKind === 'custom' ? garmentColorHex : null,
        },
        { onProgress: setUploadProgress },
      )
      setFile(null)
      setUploadProgress(null)
      if (fileInput.current) fileInput.current.value = ''
      reload()
    } catch (error: unknown) {
      setUploadError(error)
    } finally {
      setUploading(false)
    }
  }

  async function selectReadyFiles(files: FileList | null) {
    setReadyError(null)
    setReadyNotice(null)
    const selected = Array.from(files ?? [])
    if (selected.length === 0) {
      setReadyFiles([])
      return
    }
    const entries = await Promise.all(
      selected.map(async (readyFile) => {
        const size = await readImageSize(readyFile)
        return {
          file: readyFile,
          widthPx: size?.widthPx ?? null,
          heightPx: size?.heightPx ?? null,
        }
      }),
    )
    setReadyFiles(entries)
  }

  async function importReady(event: FormEvent) {
    event.preventDefault()
    if (readyFiles.length === 0) {
      setReadyError(new Error('Choose the ready-to-pack PNGs exported from Photoshop.'))
      return
    }

    setImportingReady(true)
    setReadyError(null)
    setReadyNotice(null)
    const failures: string[] = []
    let imported = 0
    try {
      for (const [index, entry] of readyFiles.entries()) {
        setReadyProgress({
          done: index,
          total: readyFiles.length,
          current: entry.file.name,
        })
        try {
          await api.designs.upload(batchId, {
            file: entry.file,
            name: defaultDesignName(entry.file),
            readyToPack: true,
          })
          imported += 1
        } catch (error: unknown) {
          failures.push(`${entry.file.name}: ${error instanceof Error ? error.message : 'import failed'}`)
        }
      }

      if (imported > 0) {
        setReadyNotice(
          `${imported} ready-to-pack ${imported === 1 ? 'design' : 'designs'} imported. Print size was derived from the exported pixels at ${batch?.workingDpi ?? 300} DPI.`,
        )
      }
      setReadyFiles([])
      if (readyInput.current) readyInput.current.value = ''
      if (failures.length > 0) {
        setReadyError(new Error(failures.join('; ')))
      }
      reload()
    } finally {
      setImportingReady(false)
      setReadyProgress(null)
    }
  }

  async function runDesignAction(design: DesignSummary, action: () => Promise<unknown>) {
    setBusyDesignId(design.id)
    setMutationError(null)
    try {
      await action()
      reload()
    } catch (error: unknown) {
      setMutationError(error)
    } finally {
      setBusyDesignId(null)
    }
  }

  async function pack() {
    setPacking(true)
    setMutationError(null)
    try {
      const accepted = await api.sheets.pack(batchId)
      setPackJobId(accepted.jobId)
    } catch (error: unknown) {
      setMutationError(error)
    } finally {
      setPacking(false)
    }
  }

  if (state.kind === 'loading') return <Loading label="Loading batch…" />
  if (state.kind === 'error') {
    return isBatchNotFound(state.error) ? (
      <ErrorState error={state.error} title="Batch not found" />
    ) : (
      <ErrorState error={state.error} onRetry={reload} title="Could not load batch" />
    )
  }
  if (!batch || !readiness) return null

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <p className="breadcrumb"><Link to="/">Batches</Link> / {batch.name}</p>
          <h1 className="page-title">{batch.name}</h1>
          <p className="page-subtitle">
            {formatCentimeters(batch.rollWidthCm)} roll · {batch.marginMm} mm design gap ·{' '}
            {batch.edgeMarginMm} mm edge margin · {batch.workingDpi} DPI
          </p>
        </div>
        <div className="row">
          <Chip tone="info">{batch.readyCount}/{readiness.included.length} ready</Chip>
          <Link className="btn" to={`/batches/${batch.id}/sheet`}>Packing sheet</Link>
        </div>
      </header>

      {progress ? <WorkflowStepper progress={progress} /> : null}

      {mutationError ? <ErrorBanner error={mutationError} title="Batch action failed" /> : null}
      {packPollError ? <ErrorBanner error={packPollError} title="Could not check packing job" /> : null}
      {packJob ? (
        <Banner kind={packJob.status === 'failed' ? 'error' : 'info'} title="Packing job">
          {packJob.status}
          {packJob.error ? `: ${packJob.error.message}` : ''}
        </Banner>
      ) : null}
      {state.kind === 'reloading' ? <p className="mono muted">Refreshing batch state…</p> : null}

      <div className="split">
        <section className="card intake-card">
          <div className="card-heading">
            <h2 className="card-title">Add artwork</h2>
            <span className="mono muted">originals are never modified</span>
          </div>
          <p className="hint">
            Pick the path that matches what you have. Both keep the uploaded file as an immutable
            original; neither resamples anything.
          </p>
          <div className="intake-paths" role="group" aria-label="Artwork source">
            <button
              type="button"
              className={`intake-path${intakePath === 'raw' ? ' is-active' : ''}`}
              aria-pressed={intakePath === 'raw'}
              onClick={() => setIntakeChoice('raw')}
            >
              <strong>Raw customer artwork</strong>
              <span>
                Straight from the customer. Each design needs review: crop, enhance, and an explicit
                print size before it can be packed.
              </span>
            </button>
            <button
              type="button"
              className={`intake-path${intakePath === 'ready' ? ' is-active' : ''}`}
              aria-pressed={intakePath === 'ready'}
              onClick={() => setIntakeChoice('ready')}
            >
              <strong>Ready-to-pack PNGs</strong>
              <span>
                Already finished in Photoshop. Background removed and sized by you, so each import
                becomes ready immediately.
              </span>
            </button>
          </div>

          {intakePath === 'raw' ? (
            <div className="intake-panel">
              <h3 className="card-title intake-panel-title">Add customer artwork</h3>
              <form className="stack-sm" onSubmit={upload}>
                <div className="row">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/tiff"
                    aria-label="Artwork image"
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null)
                      setUploadError(null)
                    }}
                    disabled={uploading}
                  />
                  <select
                    aria-label="Garment color"
                    value={garmentColorKind}
                    onChange={(event) => {
                      const value = event.target.value
                      if (value === 'light' || value === 'dark' || value === 'custom') {
                        setGarmentColorKind(value)
                      }
                    }}
                    disabled={uploading}
                  >
                    <option value="light">Light garment</option>
                    <option value="dark">Dark garment</option>
                    <option value="custom">Custom garment</option>
                  </select>
                  {garmentColorKind === 'custom' ? (
                    <input
                      type="color"
                      aria-label="Custom garment color"
                      value={garmentColorHex}
                      onChange={(event) => setGarmentColorHex(event.target.value)}
                      disabled={uploading}
                    />
                  ) : null}
                  <button type="submit" className="btn primary" disabled={!file || uploading}>
                    {uploading ? 'Uploading…' : 'Upload design'}
                  </button>
                </div>
                <p className="hint">
                  Garment colour only affects previews. It never changes the artwork pixels.
                </p>
                {uploadProgress ? (
                  <p className="mono muted" aria-live="polite">
                    {uploadProgress.percent >= 0
                      ? `${uploadProgress.percent}% uploaded`
                      : `${uploadProgress.loadedBytes} bytes uploaded`}
                  </p>
                ) : null}
                {uploadError ? <ErrorBanner error={uploadError} title="Upload failed" /> : null}
              </form>
            </div>
          ) : (
            <div className="intake-panel">
              <h3 className="card-title intake-panel-title">Import ready-to-pack PNGs</h3>
              <p className="hint">
                These are treated as final artwork. Print size is derived from the exported pixels at{' '}
                {batch.workingDpi} DPI, so export from Photoshop at the exact size you want printed.
              </p>
              <form className="stack-sm" onSubmit={importReady}>
                <div className="row">
                  <input
                    ref={readyInput}
                    type="file"
                    multiple
                    accept="image/png,.png"
                    aria-label="Ready-to-pack PNG files"
                    onChange={(event) => void selectReadyFiles(event.target.files)}
                    disabled={importingReady}
                  />
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={readyFiles.length === 0 || importingReady}
                  >
                    {importingReady
                      ? `Importing ${readyProgress?.done ?? 0}/${readyProgress?.total ?? readyFiles.length}…`
                      : readyFiles.length === 0
                        ? 'Import ready designs'
                        : `Import ${readyFiles.length} ready ${readyFiles.length === 1 ? 'design' : 'designs'}`}
                  </button>
                </div>
                {readyProgress ? (
                  <p className="mono muted" aria-live="polite">
                    Importing {readyProgress.current} ({readyProgress.done + 1}/
                    {readyProgress.total})
                  </p>
                ) : null}
                {readyFiles.length > 0 ? (
                  <ul className="ready-import-list">
                    {readyFiles.map((entry) => (
                      <li key={`${entry.file.name}-${entry.file.lastModified}-${entry.file.size}`}>
                        <span>{entry.file.name}</span>
                        <span className="mono muted">
                          {entry.widthPx != null && entry.heightPx != null
                            ? `${formatPixels(entry.widthPx)} × ${formatPixels(entry.heightPx)} · ${formatCentimeters(centimetersForPixels(entry.widthPx, batch.workingDpi), 2)} × ${formatCentimeters(centimetersForPixels(entry.heightPx, batch.workingDpi), 2)}`
                            : 'print size will be derived by the API'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {readyError ? (
                  <ErrorBanner error={readyError} title="Ready-to-pack import failed" />
                ) : null}
                {readyNotice ? <Banner kind="good" title="Ready-to-pack import">{readyNotice}</Banner> : null}
              </form>
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-heading">
            <h2 className="card-title">Packing readiness</h2>
            <Chip tone={readiness.canPack ? 'good' : 'warn'}>
              {readiness.canPack ? 'ready to pack' : 'review required'}
            </Chip>
          </div>
          {readiness.blockingReason ? (
            <p className="hint" role="status">{readiness.blockingReason}</p>
          ) : (
            <p className="hint">
              All included designs are ready. The packer proposes placements; you can review and
              edit them before export.
            </p>
          )}
          {readiness.notReady.length > 0 ? (
            <ul className="readiness-list">
              {readiness.notReady.slice(0, 8).map((design) => (
                <li key={design.id}>
                  <Link to={`/batches/${batch.id}/designs/${design.id}`}>
                    {design.name}
                  </Link>
                  <span className="mono muted">{statusLabel(design.status)}</span>
                </li>
              ))}
              {readiness.notReady.length > 8 ? (
                <li className="dim">+{readiness.notReady.length - 8} more</li>
              ) : null}
            </ul>
          ) : null}
          {readiness.overWide.length > 0 ? (
            <Banner kind="warn" title="Check roll width">
              {readiness.overWide.map((design) => design.name).join(', ')} exceed the usable roll
              width. Rotation or resizing must be an explicit operator choice.
            </Banner>
          ) : null}
          <div className="row row-end">
            <button type="button" className="btn primary" onClick={pack} disabled={!readiness.canPack || packing}>
              {packing ? 'Queueing pack…' : 'Pack batch'}
            </button>
          </div>
        </section>
      </div>

      <div className="card-heading">
        <h2 className="card-title">Designs ({batch.designs.length})</h2>
        <span className="mono muted">
          {readiness.included.length} included · {batch.excludedCount} excluded · estimated sheet{' '}
          {batch.sheetHeightCm == null ? '—' : formatCentimeters(batch.sheetHeightCm, 2)}
        </span>
      </div>
      {batch.designs.length === 0 ? (
        <EmptyState title="No designs uploaded">
          Add the customer artwork above. Each upload creates an immutable original version.
        </EmptyState>
      ) : (
        <>
          <div className="batch-toolbar">
            <div className="batch-filters" role="group" aria-label="Filter designs">
              {DESIGN_FILTERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`batch-filter${designFilter === option ? ' is-active' : ''}`}
                  aria-pressed={designFilter === option}
                  onClick={() => setDesignFilter(option)}
                >
                  {designFilterLabel(option)}
                  <span className="batch-filter-count">
                    {filterDesigns(batch.designs, option).length}
                  </span>
                </button>
              ))}
            </div>
            <input
              className="batch-search"
              type="search"
              placeholder="Search by design name"
              aria-label="Search designs by name"
              value={designQuery}
              onChange={(event) => setDesignQuery(event.target.value)}
            />
          </div>

          {designGrid.narrowed ? (
            <p className="mono muted" aria-live="polite">
              Showing {designGrid.shown} of {designGrid.total} designs
            </p>
          ) : null}

          {designGrid.groups.length === 0 ? (
            <EmptyState
              title="No design matches this view"
              actions={
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDesignFilter('all')
                    setDesignQuery('')
                  }}
                >
                  Show all designs
                </button>
              }
            >
              Nothing here matches the current filter and search.
            </EmptyState>
          ) : (
            designGrid.groups.map((group) => (
              <section key={group.id} className="design-group" aria-labelledby={`group-${group.id}`}>
                <div className="card-heading">
                  <h3 className="card-title design-group-title" id={`group-${group.id}`}>
                    {group.title}
                    <span className="batch-filter-count">{group.designs.length}</span>
                  </h3>
                </div>
                <div className="grid-cards">
                  {group.designs.map((design) => (
                    <DesignGridCard
                      key={design.id}
                      design={design}
                      workingDpi={batch.workingDpi}
                      thresholds={dpiThresholds}
                      usableWidthCm={readiness.usableWidthCm}
                      busy={busyDesignId === design.id}
                      onToggleInclude={(item) =>
                        void runDesignAction(item, () =>
                          item.status === 'excluded'
                            ? api.designs.include(item.id)
                            : api.designs.exclude(item.id),
                        )
                      }
                      onResume={(item) =>
                        void runDesignAction(item, () => api.designs.resume(item.id))
                      }
                      onRequestBetterSource={(item) =>
                        void runDesignAction(item, () => api.designs.requestBetterSource(item.id))
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </section>
  )
}
