import { Link } from 'react-router-dom'
import type { BatchSummary } from '../../api/client'
import { StatusChip } from '../ui/Chip'
import { ProgressBar } from '../ui/States'
import { formatCentimeters, formatDate } from '../../lib/format'
import { nextStepFor } from './batchNextStep'
import './batch.css'

export function BatchCard({ batch }: { batch: BatchSummary }) {
  const included = batch.designCount - batch.excludedCount
  const percent = included > 0 ? Math.round((batch.readyCount / included) * 100) : 0
  const href = `/batches/${batch.id}`
  const next = nextStepFor(batch)

  return (
    <article className="card batch-card" data-testid={`batch-card-${batch.name}`}>
      <div className="card-heading">
        <h2 className="card-title">
          <Link to={href} data-testid={`batch-link-${batch.name}`}>
            {batch.name}
          </Link>
        </h2>
        <StatusChip status={batch.status} />
      </div>

      <div className={`batch-next ${next.tone}`}>
        <strong>{next.label}</strong>
        <span>{next.detail}</span>
      </div>

      <dl className="kv">
        <dt>Designs</dt>
        <dd>
          {included} included · {batch.readyCount} ready
          {batch.excludedCount > 0 ? ` · ${batch.excludedCount} excluded` : ''}
        </dd>
        <dt>Roll width</dt>
        <dd>{formatCentimeters(batch.rollWidthCm)}</dd>
        <dt>Working DPI</dt>
        <dd>{batch.workingDpi} DPI</dd>
        <dt>Margins</dt>
        <dd>
          {batch.marginMm} mm gap · {batch.edgeMarginMm} mm edge
        </dd>
        {batch.sheetHeightCm !== null && batch.sheetHeightCm !== undefined ? (
          <>
            <dt>Sheet height</dt>
            <dd>{formatCentimeters(batch.sheetHeightCm, 2)}</dd>
          </>
        ) : null}
        <dt>Created</dt>
        <dd>{formatDate(batch.createdAt)}</dd>
      </dl>

      <ProgressBar percent={percent} label={`${batch.readyCount}/${included} designs ready`} />

      <div className="row row-end">
        <Link className="btn sm primary" to={href}>
          Open batch
        </Link>
      </div>
    </article>
  )
}
