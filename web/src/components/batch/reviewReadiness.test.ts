import { describe, expect, it } from 'vitest'
import { reviewReadiness } from './reviewReadiness'
import type { DesignDetail } from '../../api/client'

function design(overrides: Partial<DesignDetail> = {}): DesignDetail {
  return {
    id: '00000000-0000-0000-0000-0000000000aa',
    batchId: '00000000-0000-0000-0000-0000000000bb',
    name: 'Wordmark',
    status: 'ready',
    garmentColor: { kind: 'light', hex: '#ffffff' },
    allowRotation: true,
    originalVersionId: 'v1',
    currentVersionId: 'v3',
    targetWidthCm: 30,
    targetHeightCm: 12,
    effectiveDpi: 300,
    versionCount: 3,
    currentVersion: {
      id: 'v3',
      designId: '00000000-0000-0000-0000-0000000000aa',
      stepType: 'resize',
      status: 'approved',
      widthPx: 3543,
      heightPx: 1417,
      hasAlpha: true,
      createdAt: '2026-01-01T00:00:00Z',
      fileUrl: '/v3.png',
    },
    pendingVersion: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    versions: [],
    ...overrides,
  } as DesignDetail
}

describe('reviewReadiness', () => {
  it('is packable when the current version is an approved final resize', () => {
    const readiness = reviewReadiness(design(), 300)
    expect(readiness.packable).toBe(true)
    expect(readiness.headline).toBe('Ready to pack')
    expect(readiness.steps.every((step) => step.done)).toBe(true)
  })

  it('is packable when the cut-out is the final version at the target pixels', () => {
    // The shop's order is crop → enhance → set print size → remove background,
    // so the last version is normally a cut-out. It is packable as long as it
    // kept the resize's exact pixels.
    const readiness = reviewReadiness(
      design({
        currentVersion: {
          id: 'v4',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'background-removal',
          status: 'approved',
          widthPx: 3543,
          heightPx: 1417,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v4.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(true)
    expect(readiness.steps.every((step) => step.done)).toBe(true)
  })

  it('blocks a cut-out that resampled the artwork off the target pixels', () => {
    // If the cut-out changed the dimensions, the packer would have to resample,
    // so this must not claim the design is packable.
    const readiness = reviewReadiness(
      design({
        currentVersion: {
          id: 'v4',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'background-removal',
          status: 'approved',
          widthPx: 4000,
          heightPx: 1600,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v4.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(false)
    const resize = readiness.steps.find((step) => step.id === 'resize')
    expect(resize?.done).toBe(false)
    expect(resize?.blockedBy).toContain('no longer matches')
  })

  it('is packable when a mono refinement is the final version at the target pixels', () => {
    // A refinement cuts the plate at the print pixels, so it is terminal too —
    // as long as it kept the resize's exact dimensions.
    const readiness = reviewReadiness(
      design({
        currentVersion: {
          id: 'v5',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'refine-mono',
          status: 'approved',
          widthPx: 3543,
          heightPx: 1417,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v5.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(true)
    expect(readiness.steps.every((step) => step.done)).toBe(true)
  })

  it('blocks a mono refinement that resampled the artwork off the target pixels', () => {
    const readiness = reviewReadiness(
      design({
        currentVersion: {
          id: 'v5',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'refine-mono',
          status: 'approved',
          widthPx: 4000,
          heightPx: 1600,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v5.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(false)
    expect(readiness.steps.find((step) => step.id === 'resize')?.done).toBe(false)
  })

  it('blocks when there is no target size and says which step to fix first', () => {
    const readiness = reviewReadiness(design({ targetWidthCm: null, targetHeightCm: null }), 300)
    expect(readiness.packable).toBe(false)
    const target = readiness.steps.find((step) => step.id === 'target')
    expect(target?.done).toBe(false)
    expect(target?.blockedBy).toContain('centimetres')
    // The headline reports the first blocked condition, not the last.
    expect(readiness.detail).toBe(target?.blockedBy)
  })

  it('blocks when the current version is not the final resize', () => {
    const readiness = reviewReadiness(
      design({
        currentVersion: {
          id: 'v2',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'trim',
          status: 'approved',
          widthPx: 4000,
          heightPx: 4000,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v2.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(false)
    const resize = readiness.steps.find((step) => step.id === 'resize')
    expect(resize?.done).toBe(false)
    expect(resize?.blockedBy).toContain('Set the print size and approve that version')
  })

  it('blocks while a proposal is awaiting review', () => {
    const readiness = reviewReadiness(
      design({
        pendingVersion: {
          id: 'v4',
          designId: '00000000-0000-0000-0000-0000000000aa',
          stepType: 'upscale',
          status: 'proposed',
          widthPx: 8000,
          heightPx: 8000,
          hasAlpha: true,
          createdAt: '2026-01-01T00:00:00Z',
          fileUrl: '/v4.png',
        },
      }),
      300,
    )
    expect(readiness.packable).toBe(false)
    const approved = readiness.steps.find((step) => step.id === 'approved')
    expect(approved?.done).toBe(false)
    expect(approved?.blockedBy).toContain('upscale proposal')
  })

  it('blocks an excluded design even when the version itself is fine', () => {
    const readiness = reviewReadiness(design({ status: 'excluded' }), 300)
    expect(readiness.packable).toBe(false)
    const included = readiness.steps.find((step) => step.id === 'included')
    expect(included?.done).toBe(false)
    expect(included?.blockedBy).toContain('excluded')
  })

  it('treats a better-source request as blocking, not as ready', () => {
    const readiness = reviewReadiness(design({ status: 'needs-better-source' }), 300)
    expect(readiness.packable).toBe(false)
    expect(readiness.steps.find((step) => step.id === 'included')?.blockedBy).toContain(
      'better source',
    )
  })

  it('treats a zero target as a set target rather than a missing one', () => {
    // Falsy checks would wrongly report this as unset; the API treats 0 as set.
    const readiness = reviewReadiness(design({ targetWidthCm: 0, targetHeightCm: 0 }), 300)
    expect(readiness.steps.find((step) => step.id === 'target')?.done).toBe(true)
  })

  it('blocks when the target changed after the resize was approved', () => {
    // The API's RecomputeStatus only keeps `ready` while the current resize's
    // pixels still equal the target. Checking stepType alone would claim this
    // design is packable, and the pack would then be rejected server-side.
    const readiness = reviewReadiness(
      design({ targetWidthCm: 40, targetHeightCm: 16 }),
      300,
    )
    expect(readiness.packable).toBe(false)
    const resize = readiness.steps.find((step) => step.id === 'resize')
    expect(resize?.done).toBe(false)
    expect(resize?.blockedBy).toContain('print size changed')
  })

  it('blocks when the resize matches the target at a different DPI', () => {
    // 3543x1417 px is 30x12 cm at 300 DPI; at 150 DPI the same target needs
    // half the pixels, so the stored resize no longer matches.
    const readiness = reviewReadiness(design(), 150)
    expect(readiness.packable).toBe(false)
    expect(readiness.steps.find((step) => step.id === 'resize')?.done).toBe(false)
  })

  it('lists exactly the four conditions in workflow order', () => {
    expect(reviewReadiness(design(), 300).steps.map((step) => step.id)).toEqual([
      'target',
      'resize',
      'approved',
      'included',
    ])
  })
})
