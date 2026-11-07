import { Link } from 'react-router-dom'
import type { DesignSummary } from '../../api/client'
import { AlphaPreview } from '../preview/AlphaPreview'
import { Chip, StatusChip } from '../ui/Chip'
import { DEFAULT_PREVIEW_BACKGROUND } from '../../lib/preview'
import { formatCentimeters, formatPixels, stepLabel } from '../../lib/format'
import { dpiWarningLevel, dpiWarningMessage, targetPixels, type DpiThresholds } from '../../lib/units'
import './batch.css'

export interface DesignGridCardProps {
  design: DesignSummary
  /** The batch's snapshotted working DPI — never the global default. */
  workingDpi: number
  thresholds: DpiThresholds
  /** Roll width minus both edge margins, in cm. */
  usableWidthCm: number
  busy?: boolean
  onToggleInclude: (design: DesignSummary) => void
  onResume: (design: DesignSummary) => void
  onRequestBetterSource: (design: DesignSummary) => void
}

export function DesignGridCard({
  design,
  workingDpi,
  thresholds,
  usableWidthCm,
  busy = false,
  onToggleInclude,
  onResume,
  onRequestBetterSource,
}: DesignGridCardProps) {
  const excluded = design.status === 'excluded'
  const current = design.currentVersion
  const target =
    design.targetWidthCm && design.targetHeightCm
      ? { widthCm: design.targetWidthCm, heightCm: design.targetHeightCm }
      : null
  const pixels = target ? targetPixels(target, workingDpi) : null
  const dpiLevel = dpiWarningLevel(design.effectiveDpi, thresholds)
  const dpiMessage = dpiWarningMessage(design.effectiveDpi, thresholds)
  const overWide =
    design.targetWidthCm !== null &&
    design.targetWidthCm !== undefined &&
    design.targetWidthCm > usableWidthCm

  return (
    <article
      className={`card design-card${excluded ? ' is-excluded' : ''}`}
      data-testid={`design-card-${design.id}`}
      data-status={design.status}
    >
      <div className="card-heading">
        <h3 className="design-name">{design.name}</h3>
        <StatusChip status={design.status} />
      </div>

      {/* Preview honesty: the current version always composites over the
          checkerboard here. A solid garment colour is an explicit choice made
          on the review screen, never a hidden default on a thumbnail. */}
      <div className="design-thumb">
        <AlphaPreview
          fileUrl={current?.fileUrl ?? null}
          alt={`${design.name} — current version over checkerboard`}
          background={DEFAULT_PREVIEW_BACKGROUND}
          widthPx={current?.widthPx}
          heightPx={current?.heightPx}
          cellPx={8}
          testId={`design-preview-${design.id}`}
        />
      </div>

      <div className="design-facts">
        <div className="row">
          <span className="pill" data-testid={`target-${design.id}`}>
            {target
              ? `${formatCentimeters(target.widthCm)} × ${formatCentimeters(target.heightCm)}`
              : 'no target size'}
          </span>
          {pixels ? (
            <span className="pill mono dim">
              {formatPixels(pixels.widthPx)} × {formatPixels(pixels.heightPx)} @ {workingDpi} DPI
            </span>
          ) : null}
        </div>
        {target && design.effectiveDpi !== null && design.effectiveDpi !== undefined ? (
          <div className="row">
            <span className="pill mono dim">
              effective {Math.round(design.effectiveDpi)} DPI
            </span>
          </div>
        ) : null}
        {dpiLevel !== 'ok' && dpiMessage ? (
          <div className="row">
            <Chip tone={dpiLevel === 'strong' ? 'bad' : 'warn'}>
              <span data-testid={`dpi-warning-${design.id}`}>
                {dpiLevel === 'strong' ? '‼' : '▲'} {Math.round(design.effectiveDpi ?? 0)} DPI
              </span>
            </Chip>
          </div>
        ) : null}
        {dpiLevel !== 'ok' && dpiMessage ? (
          <p className={`dpi-note${dpiLevel === 'strong' ? ' strong' : ''}`}>{dpiMessage}</p>
        ) : null}

        <div className="row">
          <span className="pill">{design.versionCount} versions</span>
          {design.pendingVersion ? (
            <Chip tone="info">
              <span data-testid={`pending-proposal-${design.id}`}>
                awaiting review: {stepLabel(design.pendingVersion.stepType)}
              </span>
            </Chip>
          ) : null}
          {overWide ? (
            <Chip tone="bad">
              <span data-testid={`over-wide-${design.id}`}>
                {formatCentimeters(design.targetWidthCm)} is wider than {formatCentimeters(usableWidthCm)} usable
              </span>
            </Chip>
          ) : null}
          {!design.allowRotation ? <span className="pill">no rotation</span> : null}
        </div>
      </div>

      <div className="row row-end design-actions">
        <Link
          className="btn sm primary"
          to={`/batches/${design.batchId}/designs/${design.id}`}
          data-testid={`review-link-${design.id}`}
        >
          Review
        </Link>
        {design.status === 'needs-better-source' ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => onResume(design)}
            disabled={busy}
            data-testid={`resume-${design.id}`}
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => onRequestBetterSource(design)}
            disabled={busy || excluded}
            data-testid={`better-source-${design.id}`}
          >
            Request better source
          </button>
        )}
        <button
          type="button"
          className={`btn sm${excluded ? '' : ' ghost'}`}
          onClick={() => onToggleInclude(design)}
          disabled={busy}
          data-testid={`toggle-${design.id}`}
        >
          {excluded ? 'Include in sheet' : 'Exclude from sheet'}
        </button>
      </div>
      <p className="dim mono">
        current version {current ? stepLabel(current.stepType) : '—'} ·{' '}
        {current ? current.id.slice(0, 8) : 'no file'}
      </p>
    </article>
  )
}
