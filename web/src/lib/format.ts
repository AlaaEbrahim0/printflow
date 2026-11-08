import type { Money, StepType } from '../api/client'

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${dateFormatter.format(date)} ${timeFormatter.format(date)}`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return dateFormatter.format(date)
}

export function formatMoney(money: Money | null | undefined): string {
  if (!money) return '—'
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: money.currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(money.amount)
  } catch {
    return `${money.amount.toFixed(2)} ${money.currency.toUpperCase()}`
  }
}

export function formatCentimeters(cm: number | null | undefined, digits = 1): string {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return '—'
  return `${cm.toFixed(digits)} cm`
}

export function centimetersForPixels(pixels: number, dpi: number): number {
  return (pixels * 2.54) / dpi
}

export function formatPixels(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${Math.round(value)} px`
}

export function formatNumber(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

const STEP_LABELS: Record<StepType, string> = {
  original: 'Original upload',
  trim: 'Auto trim',
  crop: 'Manual crop',
  upscale: 'Upscale',
  vectorize: 'Vectorize',
  'background-removal': 'Background removal',
  resize: 'Final resize',
}

export function stepLabel(stepType: StepType): string {
  return STEP_LABELS[stepType] ?? stepType
}

export function statusLabel(status: string): string {
  return status
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/**
 * Why the packer left a design off the sheet, in words an operator can act on.
 *
 * The packer reports machine codes (`exceeds-roll`, `no-legal-placement`) and
 * the API adds `not-selected` for designs the operator left out of the layout.
 * Showing the raw code is technically accurate and practically useless, so
 * every known code gets an actionable sentence. Unknown codes fall back to the
 * de-hyphenated text rather than being hidden.
 */
const UNPLACED_REASONS: Record<string, string> = {
  'not-selected': 'Not selected for this layout.',
  'exceeds-roll':
    'Wider than the roll in every allowed rotation. Reduce the target width or turn rotation on.',
  'no-legal-placement':
    'No clear spot was found. Repack, or exclude another design to free up space.',
  'no-visible-pixels':
    'The approved file is fully transparent, so there is nothing to print.',
  'no-feasible-rotation': 'No allowed rotation fits inside the roll.',
}

export function describeUnplacedReason(reason: string | null | undefined): string {
  if (!reason) return 'The packer did not report a reason.'
  return UNPLACED_REASONS[reason] ?? statusLabel(reason)
}

/**
 * Human names for export artifacts.
 *
 * The API names artifacts by role (`flat`, `layered`, `manifest`). "Download
 * flat" tells an operator nothing about what they are getting, and the flat PNG
 * is the file they actually print, so it is named for its purpose.
 */
const ARTIFACT_LABELS: Record<string, string> = {
  flat: 'Print sheet PNG',
  layered: 'Layered file',
  preview: 'Preview image',
  manifest: 'Placement manifest',
  jsx: 'Photoshop script',
}

export function artifactLabel(name: string): string {
  return ARTIFACT_LABELS[name] ?? statusLabel(name)
}

/** Short, stable id chip for audit trails without dumping whole UUIDs. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.slice(0, 8)
}
