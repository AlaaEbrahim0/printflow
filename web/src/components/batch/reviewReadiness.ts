import type { DesignDetail } from '../../api/client'
import { matchesTargetPixels } from '../../lib/units'

/**
 * Why a design can or cannot be packed, derived from the same rules the API
 * enforces in `Design.RecomputeStatus`.
 *
 * A design is `ready` only when its current version is a final resize whose
 * pixel dimensions exactly match the target size at the batch's working DPI.
 * Everything else — no target, no resize, a resize that no longer matches, a
 * pending proposal, an excluded design — blocks packing.
 *
 * The "exactly match" part matters: changing the target size after a resize was
 * approved leaves the resize current but stale, and the API flips the design
 * back to `in-progress`. Checking only `stepType === 'resize'` would claim the
 * design is packable and the pack would then be rejected server-side.
 *
 * The review page shows this so the operator learns the *rule*, not just the
 * status word. The server stays authoritative: if this ever disagrees, the API
 * rejects the pack and the operator sees the server's error verbatim.
 */
export interface ReviewReadiness {
  /** True only when the design can be packed as-is. */
  packable: boolean
  /** Short imperative headline. */
  headline: string
  /** One sentence explaining the state, in operator language. */
  detail: string
  /** Ordered checklist of the conditions, each with its own state. */
  steps: ReviewStep[]
}

export interface ReviewStep {
  id: 'target' | 'resize' | 'approved' | 'included'
  label: string
  done: boolean
  /** Why it is not done; `null` when it is. */
  blockedBy: string | null
}

export function reviewReadiness(design: DesignDetail, workingDpi: number): ReviewReadiness {
  const hasTarget =
    design.targetWidthCm !== null &&
    design.targetWidthCm !== undefined &&
    design.targetHeightCm !== null &&
    design.targetHeightCm !== undefined
  const current = design.currentVersion
  const isFinalResize = current?.stepType === 'resize'
  // Mirror `Design.RecomputeStatus`: a resize only counts while its pixels still
  // equal the target at the batch's working DPI.
  const resizeMatchesTarget =
    current !== null &&
    current !== undefined &&
    isFinalResize &&
    hasTarget &&
    matchesTargetPixels(
      { widthPx: current.widthPx, heightPx: current.heightPx },
      { widthCm: design.targetWidthCm as number, heightCm: design.targetHeightCm as number },
      workingDpi,
    )
  const pending = design.pendingVersion
  const excluded = design.status === 'excluded'
  const betterSource = design.status === 'needs-better-source'

  const steps: ReviewStep[] = [
    {
      id: 'target',
      label: 'Print size set',
      done: hasTarget,
      blockedBy: hasTarget
        ? null
        : 'Set an explicit width and height in centimetres. Without a target there is no final size to print.',
    },
    {
      id: 'resize',
      label: 'Final resize is current',
      done: resizeMatchesTarget,
      blockedBy: resizeMatchesTarget
        ? null
        : isFinalResize
          ? 'The print size changed after this resize was made, so it no longer matches. Create a new resize at the current target and approve it.'
          : hasTarget
            ? 'Create a resize proposal at the target size and approve it.'
            : 'Set the print size first, then create the resize.',
    },
    {
      id: 'approved',
      label: 'Nothing awaiting review',
      done: !pending,
      blockedBy: pending
        ? `A ${pending.stepType.replaceAll('-', ' ')} proposal is waiting for approval or rejection.`
        : null,
    },
    {
      id: 'included',
      label: 'Included in the sheet',
      done: !excluded && !betterSource,
      blockedBy: excluded
        ? 'This design is excluded, so it will not appear on the sheet.'
        : betterSource
          ? 'A better source was requested, so packing is paused for this design.'
          : null,
    },
  ]

  const firstBlocked = steps.find((step) => !step.done)
  const packable = firstBlocked === undefined

  return {
    packable,
    headline: packable ? 'Ready to pack' : 'Not ready to pack yet',
    detail: packable
      ? 'This design is approved at its final print size and will be placed exactly as-is.'
      : (firstBlocked?.blockedBy ?? 'Something still needs attention.'),
    steps,
  }
}
