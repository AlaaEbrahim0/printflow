import type { BatchDetail, Sheet } from '../../api/client'

/**
 * The five stages every batch moves through, in order.
 *
 * The workbench is split across three routes (batch, sheet, design review) and
 * each route only shows its own corner. Without a shared spine an operator has
 * to remember the sequence, and the most common failure is exporting before
 * checking or packing before every design is approved. This module derives the
 * stage list from data the pages already have, so the stepper never issues a
 * request of its own.
 */
export type StageId = 'artwork' | 'review' | 'pack' | 'check' | 'export'

export interface Stage {
  id: StageId
  label: string
  /** One line on what this stage means, shown under the label. */
  detail: string
  state: 'done' | 'current' | 'todo' | 'blocked'
}

export interface WorkflowProgress {
  stages: Stage[]
  /** The stage the operator should be working on right now. */
  current: StageId
}

export interface WorkflowInput {
  batch: BatchDetail
  /** Null when the batch has never been packed. */
  sheet: Sheet | null
  /** True once an export exists for the current sheet revision. */
  exported: boolean
}

export function workflowProgress({ batch, sheet, exported }: WorkflowInput): WorkflowProgress {
  const included = batch.designs.filter((design) => design.status !== 'excluded')
  const ready = included.filter((design) => design.status === 'ready')
  const hasArtwork = batch.designs.length > 0
  const allReady = included.length > 0 && ready.length === included.length
  const integrityPassed = sheet !== null && sheet.state === 'valid' && !sheet.stale

  const artwork: Stage = {
    id: 'artwork',
    label: 'Add artwork',
    detail: 'Upload customer files or import ready-to-pack PNGs.',
    state: hasArtwork ? 'done' : 'current',
  }

  const review: Stage = {
    id: 'review',
    label: 'Review designs',
    detail: 'Approve a final size for every included design.',
    state: !hasArtwork
      ? 'todo'
      : allReady
        ? 'done'
        : 'current',
  }

  const pack: Stage = {
    id: 'pack',
    label: 'Pack sheet',
    detail: 'Let the packer propose placements, then adjust if needed.',
    state: sheet !== null ? 'done' : allReady ? 'current' : 'todo',
  }

  const check: Stage = {
    id: 'check',
    label: 'Check integrity',
    detail: 'All five blocking checks must pass on this exact revision.',
    state:
      sheet === null
        ? 'todo'
        : integrityPassed
          ? 'done'
          : sheet.stale
            ? 'blocked'
            : 'current',
  }

  const exportStage: Stage = {
    id: 'export',
    label: 'Export',
    detail: 'Download the flat PNG at the exact final size.',
    // An export only finishes the run while the sheet it came from is still the
    // valid current one. Repacking or editing placements invalidates the check,
    // so a stale export must not tick the last box.
    state: exported && integrityPassed ? 'done' : integrityPassed ? 'current' : 'todo',
  }

  const stages = [artwork, review, pack, check, exportStage]
  const current = stages.find((stage) => stage.state === 'current')?.id ?? 'export'

  return { stages, current }
}
