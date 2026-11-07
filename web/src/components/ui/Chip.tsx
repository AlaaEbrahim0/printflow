import type { ReactNode } from 'react'

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
  // job / export
  queued: 'neutral',
  running: 'info',
  succeeded: 'good',
  failed: 'bad',
  cancelled: 'neutral',
  blocked: 'bad',
  // classifier
  pending: 'neutral',
}

export function statusTone(status: string): ChipTone {
  return TONES[status] ?? 'neutral'
}

export function StatusChip({ status, label }: { status: string; label?: string }) {
  return (
    <Chip tone={statusTone(status)}>
      <span data-testid={`status-${status}`}>{label ?? status}</span>
    </Chip>
  )
}

/** `stale` is a flag next to a state, not a state of its own. */
export function StaleChip() {
  return <Chip tone="bad">stale</Chip>
}
