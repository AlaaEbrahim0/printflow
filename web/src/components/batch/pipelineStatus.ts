import type { DesignVersion } from '../../api/client'

/**
 * Which pipeline steps this design has already been through.
 *
 * The review page shows three numbered steps (prepare, enhance, set size) as
 * plain expandable rows, so an operator returning to a half-finished design has
 * no way to tell "I already cropped this" from "I never touched it". Version
 * history already records every step, so this is a pure derivation with no
 * extra request.
 *
 * A step counts as done when the current version's lineage contains it — not
 * merely when such a version exists somewhere, because a rejected or abandoned
 * branch must not tick the box.
 */
export interface PipelineStatus {
  prepared: boolean
  enhanced: boolean
  cutout: boolean
  sized: boolean
}

export function pipelineStatus(
  versions: DesignVersion[],
  currentVersionId: string | null | undefined,
): PipelineStatus {
  const byId = new Map(versions.map((version) => [version.id, version]))
  const lineage: DesignVersion[] = []
  const seen = new Set<string>()

  let cursor = currentVersionId ? byId.get(currentVersionId) : undefined
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    lineage.push(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }

  return {
    prepared: lineage.some((version) => version.stepType === 'trim' || version.stepType === 'crop'),
    enhanced: lineage.some((version) => version.stepType === 'upscale'),
    cutout: lineage.some((version) => version.stepType === 'background-removal'),
    sized: lineage.some((version) => version.stepType === 'resize'),
  }
}
