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

/** Short, stable id chip for audit trails without dumping whole UUIDs. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.slice(0, 8)
}
