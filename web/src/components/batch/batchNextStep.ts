import type { BatchSummary } from '../../api/client'

/**
 * What the operator should do next with a batch.
 *
 * The card already shows counts and a progress bar, but those only describe
 * *state*. A shop operator scanning ten batches needs the *action*: which one
 * is waiting on a review, which one is ready to pack, which one already has a
 * sheet to check. This is a pure derivation from the summary the list endpoint
 * already returns, so it costs no extra requests.
 */
export interface BatchNextStep {
  /** Imperative phrase, short enough for a card. */
  label: string
  /** One sentence of why, shown under the label. */
  detail: string
  tone: 'neutral' | 'info' | 'good' | 'warn'
}

export function nextStepFor(batch: BatchSummary): BatchNextStep {
  const included = batch.designCount - batch.excludedCount
  const notReady = included - batch.readyCount
  const hasSheet = batch.sheetHeightCm !== null && batch.sheetHeightCm !== undefined

  if (included === 0) {
    return {
      label: 'Add artwork',
      detail:
        batch.designCount === 0
          ? 'Nothing uploaded yet. Add the customer artwork or import ready-to-pack PNGs.'
          : 'Every design is excluded, so there is nothing to pack.',
      tone: 'warn',
    }
  }

  if (notReady > 0) {
    return {
      label: `Review ${notReady} ${notReady === 1 ? 'design' : 'designs'}`,
      detail: `${batch.readyCount} of ${included} included designs are ready. Packing needs all of them approved at a final size.`,
      tone: 'info',
    }
  }

  if (batch.status === 'exported') {
    return {
      label: 'Exported',
      detail: 'The sheet has been exported. Open the batch to download the file again or repack.',
      tone: 'good',
    }
  }

  if (hasSheet) {
    return {
      label: 'Check the sheet',
      detail: 'All designs are ready and a sheet exists. Verify the integrity gate before exporting.',
      tone: 'good',
    }
  }

  return {
    label: 'Ready to pack',
    detail: 'Every included design is ready. Packing proposes placements for review; no pixels change.',
    tone: 'good',
  }
}
