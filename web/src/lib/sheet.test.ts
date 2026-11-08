import { describe, expect, it } from 'vitest'
import type { IntegrityCheck, IntegrityReport, Placement, Sheet } from '../api/client'
import {
  baseFootprint,
  canExport,
  clampPlacement,
  collidingDesignIds,
  collisionsFor,
  costFor,
  integritySummary,
  normalizeRotation,
  overlaps,
  pxPerCmFor,
  rotateBy90,
  rotatedFootprint,
  sheetHeightFor,
  snapPlacement,
  toManualPlacements,
  zoomFor,
  MAX_PX_PER_CM,
  MIN_PX_PER_CM,
  type Rect,
} from './sheet'

function rect(overrides: Partial<Rect> = {}): Rect {
  return { xCm: 0, yCm: 0, widthCm: 10, heightCm: 20, ...overrides }
}

function placement(overrides: Partial<Placement> = {}): Placement {
  return {
    designId: 'design-1',
    versionId: 'version-1',
    designName: 'Crest',
    xCm: 1,
    yCm: 2,
    widthCm: 10,
    heightCm: 20,
    widthPx: 1181,
    heightPx: 2362,
    rotationDeg: 0,
    ...overrides,
  }
}

function check(id: IntegrityCheck['id'], status: IntegrityCheck['status']): IntegrityCheck {
  return { id, blocking: true, status, message: `${id} ${status}` }
}

function report(checks: IntegrityCheck[], passed = checks.every((c) => c.status === 'passed')): IntegrityReport {
  return {
    schemaVersion: '2.0',
    reportId: 'report-1',
    generatedAt: '2026-11-05T00:00:00Z',
    passed,
    sheet: { widthPx: 6850, heightPx: 2362, widthCm: 58, heightCm: 20, dpi: 300 },
    checks,
    failures: [],
    metrics: { placements: 1 },
  }
}

function sheetFor(overrides: Partial<Sheet> = {}): Sheet {
  return {
    id: 'sheet-1',
    batchId: 'batch-1',
    revision: 3,
    state: 'valid',
    widthCm: 58,
    heightCm: 40,
    widthPx: 6850,
    heightPx: 4724,
    dpi: 300,
    placements: [placement()],
    integrityReport: report([
      check('visible-pixels-inside-sheet', 'passed'),
      check('dilated-masks-no-overlap', 'passed'),
      check('minimum-gap', 'passed'),
      check('pixel-equality', 'passed'),
      check('all-designs-placed', 'passed'),
    ]),
    stale: false,
    estimatedCost: { amount: 34, currency: 'EUR' },
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    ...overrides,
  }
}

describe('normalizeRotation', () => {
  it('only ever yields 0/90/180/270 for valid steps and folds large multiples', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(180)).toBe(180)
    expect(normalizeRotation(270)).toBe(270)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    const results = [0, 90, 180, 270, 360, 450, 540, 630].map((deg) => normalizeRotation(deg))
    expect(results).toEqual([0, 90, 180, 270, 0, 90, 180, 270])
    expect(results.every((r) => r === 0 || r === 90 || r === 180 || r === 270)).toBe(true)
  })

  it('refuses any angle that is not a non-negative multiple of 90', () => {
    expect(normalizeRotation(45)).toBeNull()
    expect(normalizeRotation(100)).toBeNull()
    expect(normalizeRotation(-90)).toBeNull()
    expect(normalizeRotation(-1)).toBeNull()
    expect(normalizeRotation(Number.NaN)).toBeNull()
  })
})

describe('rotatedFootprint', () => {
  it('swaps width and height for 90 and 270 only', () => {
    expect(rotatedFootprint({ widthCm: 10, heightCm: 20, rotationDeg: 0 })).toEqual({ widthCm: 10, heightCm: 20 })
    expect(rotatedFootprint({ widthCm: 10, heightCm: 20, rotationDeg: 90 })).toEqual({ widthCm: 20, heightCm: 10 })
    expect(rotatedFootprint({ widthCm: 10, heightCm: 20, rotationDeg: 180 })).toEqual({ widthCm: 10, heightCm: 20 })
    expect(rotatedFootprint({ widthCm: 10, heightCm: 20, rotationDeg: 270 })).toEqual({ widthCm: 20, heightCm: 10 })
  })

  it('rotateBy90 cycles the angle and swaps the printed footprint', () => {
    expect(rotateBy90({ widthCm: 10, heightCm: 20, rotationDeg: 0 })).toEqual({ widthCm: 20, heightCm: 10, rotationDeg: 90 })
    expect(rotateBy90({ widthCm: 20, heightCm: 10, rotationDeg: 90 })).toEqual({ widthCm: 10, heightCm: 20, rotationDeg: 180 })
    expect(rotateBy90({ widthCm: 10, heightCm: 20, rotationDeg: 270 })).toEqual({ widthCm: 20, heightCm: 10, rotationDeg: 0 })
  })

  it('baseFootprint is its own inverse for swapped rotations', () => {
    const rotated = { widthCm: 20, heightCm: 10, rotationDeg: 90 as const }
    expect(baseFootprint(rotated)).toEqual({ widthCm: 10, heightCm: 20 })
  })
})

describe('clampPlacement', () => {
  const sheet = { widthCm: 58, heightCm: 40 }

  it('reports no clamp for an in-bounds placement', () => {
    const result = clampPlacement(rect({ xCm: 1, yCm: 1 }), sheet)
    expect(result.clamped).toBe(false)
    expect(result.placement).toMatchObject({ xCm: 1, yCm: 1 })
  })

  it('clamps the left and top edges back to zero', () => {
    expect(clampPlacement(rect({ xCm: -3, yCm: 0 }), sheet).placement.xCm).toBe(0)
    expect(clampPlacement(rect({ xCm: 0, yCm: -5 }), sheet).placement.yCm).toBe(0)
  })

  it('clamps the right and bottom edges to keep the whole footprint inside', () => {
    const right = clampPlacement(rect({ xCm: 55, widthCm: 10 }), sheet)
    expect(right.placement.xCm).toBe(48)
    expect(right.clamped).toBe(true)
    const bottom = clampPlacement(rect({ yCm: 35, heightCm: 20 }), sheet)
    expect(bottom.placement.yCm).toBe(20)
  })

  it('pins an oversized design to the origin instead of letting it leave the sheet', () => {
    const huge = clampPlacement(rect({ xCm: 5, yCm: 5, widthCm: 90, heightCm: 90 }), sheet)
    expect(huge.placement.xCm).toBe(0)
    expect(huge.placement.yCm).toBe(0)
    expect(huge.clamped).toBe(true)
  })
})

describe('snapPlacement', () => {
  it('snaps to a tenth of a centimetre without float drift', () => {
    expect(snapPlacement(rect({ xCm: 0.1 + 0.2, yCm: 0 })).xCm).toBe(0.3)
    expect(snapPlacement(rect({ xCm: 12.34, yCm: 12.36 }))).toMatchObject({ xCm: 12.3, yCm: 12.4 })
    expect(snapPlacement(rect({ xCm: 1.05, yCm: 0 })).xCm).toBe(1.1)
    // 0.1 + 0.2 is the canonical float trap; the snapped value must serialise clean.
    expect(String(snapPlacement(rect({ xCm: 0.1 + 0.2, yCm: 0 })).xCm)).toBe('0.3')
  })
})

describe('overlap detection', () => {
  it('does not treat touching edges as an overlap', () => {
    const a = rect({ xCm: 0, yCm: 0, widthCm: 10, heightCm: 10 })
    const b = rect({ xCm: 10, yCm: 0, widthCm: 10, heightCm: 10 })
    expect(overlaps(a, b)).toBe(false)
  })

  it('detects a partial overlap', () => {
    const a = rect({ xCm: 0, yCm: 0, widthCm: 10, heightCm: 10 })
    const b = rect({ xCm: 9.9, yCm: 0, widthCm: 10, heightCm: 10 })
    expect(overlaps(a, b)).toBe(true)
  })

  it('detects a contained rectangle', () => {
    const outer = rect({ xCm: 0, yCm: 0, widthCm: 20, heightCm: 20 })
    const inner = rect({ xCm: 5, yCm: 5, widthCm: 4, heightCm: 4 })
    expect(overlaps(outer, inner)).toBe(true)
  })

  it('lists colliding design id pairs and the highlight set', () => {
    const placements = [
      { ...rect({ xCm: 0, yCm: 0 }), designId: 'a' },
      { ...rect({ xCm: 5, yCm: 5 }), designId: 'b' },
      { ...rect({ xCm: 40, yCm: 0 }), designId: 'c' },
    ]
    expect(collisionsFor(placements)).toEqual([{ a: 'a', b: 'b' }])
    expect([...collidingDesignIds(placements)]).toEqual(['a', 'b'])
  })
})

describe('sheetHeightFor and costFor', () => {
  it('grows the sheet past the configured height to contain the lowest placement', () => {
    const placements = [{ yCm: 10, heightCm: 20 }, { yCm: 0, heightCm: 5 }]
    expect(sheetHeightFor(placements, 0, 12)).toBe(30)
  })

  it('adds a bottom edge margin and never shrinks below the configured height', () => {
    const placements = [{ yCm: 0, heightCm: 5 }]
    expect(sheetHeightFor(placements, 2, 40)).toBe(40)
    expect(sheetHeightFor(placements, 2, 1)).toBe(7)
    expect(sheetHeightFor([], 0, 0)).toBe(0)
  })

  it('estimates cost from height, rounded to two decimals', () => {
    expect(costFor(40, 0.85, 'EUR')).toEqual({ amount: 34, currency: 'EUR' })
    expect(costFor(11.5, 0.33, 'EUR').amount).toBe(3.8)
    expect(costFor(-5, 0.85, 'EUR')).toEqual({ amount: 0, currency: 'EUR' })
  })
})

describe('canExport', () => {
  it('explains each blocking reason', () => {
    expect(canExport(null).reason).toBe('no-sheet')
    expect(canExport(undefined).reason).toBe('no-sheet')
    expect(canExport(sheetFor({ stale: true })).reason).toBe('stale')
    expect(canExport(sheetFor({ state: 'unchecked', integrityReport: null })).reason).toBe('unchecked')
    expect(canExport(sheetFor({ state: 'invalid' })).reason).toBe('failed')
    const ok = canExport(sheetFor())
    expect(ok.can).toBe(true)
    expect(ok.reason).toBe('ok')
  })

  it('treats a valid-state sheet whose report has a skipped check as failed', () => {
    const blocked = sheetFor({
      integrityReport: report([
        check('visible-pixels-inside-sheet', 'passed'),
        check('dilated-masks-no-overlap', 'passed'),
        check('minimum-gap', 'skipped'),
        check('pixel-equality', 'passed'),
        check('all-designs-placed', 'passed'),
      ]),
    })
    expect(canExport(blocked).reason).toBe('failed')
  })
})

describe('integritySummary', () => {
  it('reports none when there is no report', () => {
    const summary = integritySummary(null)
    expect(summary.status).toBe('none')
    expect(summary.passed).toBe(false)
    expect(summary.skippedChecks).toHaveLength(5)
  })

  it('maps all five checks and passes when every one passes', () => {
    const summary = integritySummary(
      report([
        check('visible-pixels-inside-sheet', 'passed'),
        check('dilated-masks-no-overlap', 'passed'),
        check('minimum-gap', 'passed'),
        check('pixel-equality', 'passed'),
        check('all-designs-placed', 'passed'),
      ]),
    )
    expect(summary.status).toBe('passed')
    expect(summary.passed).toBe(true)
    expect(Object.keys(summary.checks)).toHaveLength(5)
  })

  it('treats a skipped blocking check as NOT passed', () => {
    const summary = integritySummary(
      report([
        check('visible-pixels-inside-sheet', 'passed'),
        check('dilated-masks-no-overlap', 'passed'),
        check('minimum-gap', 'skipped'),
        check('pixel-equality', 'passed'),
        check('all-designs-placed', 'passed'),
      ]),
    )
    expect(summary.status).toBe('skipped')
    expect(summary.passed).toBe(false)
    expect(summary.skippedChecks).toContain('minimum-gap')
  })

  it('surfaces failed checks', () => {
    const summary = integritySummary(
      report([
        check('visible-pixels-inside-sheet', 'passed'),
        check('dilated-masks-no-overlap', 'failed'),
        check('minimum-gap', 'passed'),
        check('pixel-equality', 'passed'),
        check('all-designs-placed', 'passed'),
      ]),
    )
    expect(summary.status).toBe('failed')
    expect(summary.failedChecks).toContain('dilated-masks-no-overlap')
  })

  it('counts a missing check id as skipped', () => {
    const summary = integritySummary(report([check('minimum-gap', 'passed')]))
    expect(summary.status).toBe('skipped')
    expect(summary.checks['pixel-equality']).toBe('skipped')
  })
})

describe('toManualPlacements', () => {
  it('keeps only the fields the contract allows', () => {
    const manual = toManualPlacements([placement({ xCm: 3.3000000000000003, yCm: 4, rotationDeg: 90 })])
    expect(manual).toHaveLength(1)
    expect(Object.keys(manual[0]!).sort()).toEqual(
      ['designId', 'rotationDeg', 'versionId', 'xCm', 'yCm'],
    )
    expect(manual[0]).toEqual({
      designId: 'design-1',
      versionId: 'version-1',
      xCm: 3.3,
      yCm: 4,
      rotationDeg: 90,
    })
  })

  it('strips width/height/px and designName — never sends resampling fields', () => {
    const json = JSON.stringify(toManualPlacements([placement()]))
    expect(json).not.toContain('widthCm')
    expect(json).not.toContain('widthPx')
    expect(json).not.toContain('designName')
  })
})

describe('zoomFor / pxPerCmFor', () => {
  it('fits the sheet width into the container and honours the zoom multiplier', () => {
    expect(zoomFor({ widthCm: 58 }, { width: 580, height: 400 }, 1)).toBe(10)
    expect(zoomFor({ widthCm: 58 }, { width: 580, height: 400 }, 2)).toBe(20)
  })

  it('clamps the display scale to a safe, finite range', () => {
    expect(pxPerCmFor(Number.NaN)).toBe(MIN_PX_PER_CM)
    expect(pxPerCmFor(0)).toBe(MIN_PX_PER_CM)
    expect(pxPerCmFor(5)).toBe(5)
    expect(pxPerCmFor(10_000)).toBe(MAX_PX_PER_CM)
    expect(zoomFor({ widthCm: 0 }, { width: 500, height: 400 })).toBe(MIN_PX_PER_CM)
    expect(zoomFor({ widthCm: 58 }, { width: 0, height: 0 })).toBe(MIN_PX_PER_CM)
  })
})
