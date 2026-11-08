import type { ReactNode } from 'react'
import { statusLabel } from '../../lib/format'

export type ChipTone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent'

export function Chip({ tone = 'neutral', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>
}

const TONES: Record<string, ChipTone> = {
  // batch
  collecting: 'neutral',
  'ready-to-pack': 'info',
  packed: 'good',
  exported: 'good',
  // design
  received: 'neutral',
  'in-progress': 'accent',
  ready: 'good',
  'needs-better-source': 'warn',
  excluded: 'neutral',
  // version
  proposed: 'info',
  approved: 'good',
  rejected: 'bad',
  // sheet
  unchecked: 'warn',
  valid: 'good',
  invalid: 'bad',
  // integrity check results
  passed: 'good',
  // `failed` is shared by integrity checks and jobs; both are blocking, so one
  // entry covers both rather than a duplicate key.
  failed: 'bad',
  skipped: 'warn',
  // job / export
  queued: 'neutral',
  running: 'info',
  succeeded: 'good',
  cancelled: 'neutral',
  blocked: 'bad',
  // classifier
  pending: 'neutral',
}

/**
 * Chip text for states whose raw value is API vocabulary rather than English.
 * Anything not listed falls through to `statusLabel`, which de-hyphenates and
 * capitalises, so an unknown future state still renders something readable
 * instead of a blank chip.
 */
const STATUS_LABELS: Record<string, string> = {
  collecting: 'Collecting artwork',
  'ready-to-pack': 'Ready to pack',
  packed: 'Packed',
  exported: 'Exported',
  received: 'Received',
  'in-progress': 'In review',
  ready: 'Ready',
  'needs-better-source': 'Needs better source',
  excluded: 'Excluded',
  proposed: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  unchecked: 'Not checked',
  valid: 'Valid',
  invalid: 'Invalid',
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  pending: 'Pending',
}

export function statusTone(status: string): ChipTone {
  return TONES[status] ?? 'neutral'
}

export function StatusChip({ status, label }: { status: string; label?: string }) {
  return (
    <Chip tone={statusTone(status)}>
      <span data-testid={`status-${status}`}>{label ?? STATUS_LABELS[status] ?? statusLabel(status)}</span>
    </Chip>
  )
}

/** `stale` is a flag next to a state, not a state of its own. */
export function StaleChip() {
  return <Chip tone="bad">stale</Chip>
}
