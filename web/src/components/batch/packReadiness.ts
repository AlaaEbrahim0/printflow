import type { BatchDetail, DesignSummary } from '../../api/client'
import { usableRollWidthCm } from '../../lib/units'

/** How many blocking names we list before collapsing to a count. */
export const MAX_LISTED_NAMES = 6

export interface PackReadiness {
  /** Non-excluded designs: exactly the set the API requires to be `ready`. */
  included: DesignSummary[]
  ready: DesignSummary[]
  notReady: DesignSummary[]
  /** Included designs whose target width exceeds the usable roll width. */
  overWide: DesignSummary[]
  usableWidthCm: number
  /** `null` only when the client can see nothing that blocks packing. */
  blockingReason: string | null
  canPack: boolean
}

function names(list: DesignSummary[]): string {
  const head = list
    .slice(0, MAX_LISTED_NAMES)
    .map((design) => design.name)
    .join(', ')
  const rest = list.length - Math.min(list.length, MAX_LISTED_NAMES)
  return rest > 0 ? `${head}, +${rest} more` : head
}

/**
 * The client computes the blocking reason so the operator sees it before the
 * server refuses, but it never *permits* anything the API would refuse: the
 * server keeps the authority and `design-exceeds-roll` / `design-not-ready`
 * are still surfaced verbatim when they arrive.
 */
export function evaluatePackReadiness(batch: BatchDetail): PackReadiness {
  const included = batch.designs.filter((design) => design.status !== 'excluded')
  const ready = included.filter((design) => design.status === 'ready')
  const notReady = included.filter((design) => design.status !== 'ready')
  const usable = usableRollWidthCm(batch.rollWidthCm, batch.edgeMarginMm)
  const overWide = included.filter(
    (design) => design.targetWidthCm !== null && design.targetWidthCm !== undefined && design.targetWidthCm > usable,
  )

  let blockingReason: string | null = null
  if (included.length === 0) {
    blockingReason =
      batch.designCount === 0
        ? 'No included designs — upload the customer artwork first.'
        : 'No included designs — every design in this batch is excluded.'
  } else if (notReady.length > 0) {
    blockingReason = `${notReady.length} design${notReady.length === 1 ? '' : 's'} ${
      notReady.length === 1 ? 'is' : 'are'
    } not ready: ${names(notReady)}. A batch can be packed only when every non-excluded design has an approved final resize at its target size.`
  }

  return {
    included,
    ready,
    notReady,
    overWide,
    usableWidthCm: usable,
    blockingReason,
    canPack: blockingReason === null,
  }
}
