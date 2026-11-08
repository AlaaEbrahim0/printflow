import type { DesignSummary } from '../../api/client'

/**
 * Grouping and search for the design grid.
 *
 * A batch can hold thirty designs, and the one the operator needs is almost
 * always the one that is *not* ready. Sorting ready designs to the back means
 * the top of the grid is always the work queue, and grouping keeps excluded
 * designs out of the way without hiding them.
 */
export type DesignFilter = 'all' | 'needs-work' | 'ready' | 'excluded'

export interface DesignGroup {
  id: 'blocking' | 'ready' | 'excluded'
  title: string
  designs: DesignSummary[]
}

const FILTER_LABELS: Record<DesignFilter, string> = {
  all: 'All designs',
  'needs-work': 'Needs work',
  ready: 'Ready',
  excluded: 'Excluded',
}

export function designFilterLabel(filter: DesignFilter): string {
  return FILTER_LABELS[filter]
}

/** A design that still needs an operator decision before it can be packed. */
export function designNeedsWork(design: DesignSummary): boolean {
  return design.status !== 'ready' && design.status !== 'excluded'
}

export function searchDesigns(designs: DesignSummary[], query: string): DesignSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return designs
  return designs.filter((design) => design.name.toLowerCase().includes(needle))
}

export function filterDesigns(designs: DesignSummary[], filter: DesignFilter): DesignSummary[] {
  switch (filter) {
    case 'all':
      return designs
    case 'needs-work':
      return designs.filter(designNeedsWork)
    case 'ready':
      return designs.filter((design) => design.status === 'ready')
    case 'excluded':
      return designs.filter((design) => design.status === 'excluded')
  }
}

/**
 * Split into the three groups the page renders, dropping empty ones.
 *
 * Order is deliberate: blocking first (that is the work queue), then ready,
 * then excluded last so a pile of excluded designs never pushes real work off
 * the screen.
 */
export function groupDesigns(designs: DesignSummary[]): DesignGroup[] {
  const groups: DesignGroup[] = [
    {
      id: 'blocking',
      title: 'Needs work',
      designs: designs.filter(designNeedsWork),
    },
    {
      id: 'ready',
      title: 'Ready to pack',
      designs: designs.filter((design) => design.status === 'ready'),
    },
    {
      id: 'excluded',
      title: 'Excluded from this sheet',
      designs: designs.filter((design) => design.status === 'excluded'),
    },
  ]
  return groups.filter((group) => group.designs.length > 0)
}

export interface DesignGridResult {
  groups: DesignGroup[]
  /** Number of designs shown after search and filter. */
  shown: number
  total: number
  narrowed: boolean
}

export function prepareDesignGrid(
  designs: DesignSummary[],
  { filter, query }: { filter: DesignFilter; query: string },
): DesignGridResult {
  const matched = searchDesigns(designs, query)
  const filtered = filterDesigns(matched, filter)
  return {
    groups: groupDesigns(filtered),
    shown: filtered.length,
    total: designs.length,
    narrowed: filtered.length !== designs.length,
  }
}
