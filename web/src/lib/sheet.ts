import type {
  IntegrityCheck,
  IntegrityCheckResult,
  IntegrityReport,
  ManualPlacement,
  Money,
  Placement,
  Sheet,
} from '../api/client'
import { snapCentimeters } from './units'

/**
 * Every placement computation for the packing preview lives here, as pure
 * functions. No React, no DOM, no fetch. Geometry is always in cm (and explicit
 * px at the working DPI); the canvas only ever multiplies by a display scale.
 *
 * Product rule 5 / ARCHITECTURE §8: the packer translates and rotates by
 * multiples of 90° only. It never resamples, recolours or crops. Nothing in this
 * module changes a pixel — it only moves and turns placement rectangles.
 */

export type Rotation = 0 | 90 | 180 | 270

/** The four blocking integrity checks from ARCHITECTURE §8.2. */
export const INTEGRITY_CHECK_IDS = [
  'visible-pixels-inside-sheet',
  'dilated-masks-no-overlap',
  'minimum-gap',
  'pixel-equality',
] as const

export type IntegrityCheckId = (typeof INTEGRITY_CHECK_IDS)[number]

/**
 * A placement rectangle in cm. `Placement` (server) and locally edited copies
 * both satisfy this, so the math below never depends on the fuller server type.
 */
export interface Rect {
  xCm: number
  yCm: number
  widthCm: number
  heightCm: number
}

/** The printed footprint: width/height swap on 90°/270° rotations. */
export interface Footprint {
  widthCm: number
  heightCm: number
}

/** A colliding pair of design ids (never self, order-independent). */
export interface PlacementCollision {
  a: string
  b: string
}

const EPSILON = 1e-6

/**
 * Normalise a rotation to the only angles the packer allows.
 *
 * "Refused" means: the return type is `Rotation | null`, and `null` is produced
 * for every input that is not a non-negative multiple of 90° — negatives, 45°,
 * 100° and anything else are refused, never silently approximated. Non-negative
 * multiples are folded into the canonical range, so 360 → 0 and 450 → 90 (this
 * is what lets the rotate button cycle 270 → 0).
 */
export function normalizeRotation(deg: number): Rotation | null {
  if (!Number.isFinite(deg) || deg < 0) return null
  const folded = deg % 360
  if (folded % 90 !== 0) return null
  return folded as Rotation
}

/** True when 90/270 swap the axes of a footprint. */
export function rotationSwapsAxis(rotationDeg: number): boolean {
  return rotationDeg === 90 || rotationDeg === 270
}

/**
 * Footprint of a design at a rotation. The rectangle grows/swaps only by
 * translation and 90° turns — never by scaling. Non-multiple-of-90 rotations
 * fall back to the unrotated footprint (callers should use normalizeRotation
 * to refuse those before ever reaching here).
 */
export function rotatedFootprint(
  size: Footprint & { rotationDeg?: number },
): Footprint {
  const rotation = size.rotationDeg ?? 0
  return rotationSwapsAxis(rotation)
    ? { widthCm: size.heightCm, heightCm: size.widthCm }
    : { widthCm: size.widthCm, heightCm: size.heightCm }
}

/**
 * Rotate an existing placement by exactly +90°. Returns the swapped footprint
 * plus the normalised angle, or `null` when the resulting angle is not a valid
 * step (which cannot happen for a valid input, but keeps the contract honest).
 */
export function rotateBy90(placement: {
  widthCm: number
  heightCm: number
  rotationDeg: number
}): (Footprint & { rotationDeg: Rotation }) | null {
  const next = normalizeRotation(placement.rotationDeg + 90)
  if (next === null) return null
  // The input is the current printed footprint, so recover the base size
  // before applying the new rotation. Both steps only swap width and height.
  const base = baseFootprint(placement)
  const swapped = rotatedFootprint({ ...base, rotationDeg: next })
  return { ...swapped, rotationDeg: next }
}

/** The un-rotated base size of a placement whose footprint already reflects its rotation. */
export function baseFootprint(placement: Footprint & { rotationDeg: number }): Footprint {
  return rotatedFootprint(placement)
}

export interface ClampedPlacement {
  placement: Rect
  clamped: boolean
}

/**
 * Keep a placement fully inside the sheet, never letting it leave the roll or go
 * negative on either axis. A design wider/taller than the sheet is pinned to the
 * origin (max is clamped to 0) rather than allowed off-sheet.
 */
export function clampPlacement(
  placement: Rect,
  sheet: { widthCm: number; heightCm: number },
): ClampedPlacement {
  const maxX = Math.max(0, sheet.widthCm - placement.widthCm)
  const maxY = Math.max(0, sheet.heightCm - placement.heightCm)
  const xCm = roundCm(Math.min(maxX, Math.max(0, placement.xCm)))
  const yCm = roundCm(Math.min(maxY, Math.max(0, placement.yCm)))
  const clamped = Math.abs(xCm - placement.xCm) > EPSILON || Math.abs(yCm - placement.yCm) > EPSILON
  return { placement: { ...placement, xCm, yCm }, clamped }
}

/**
 * Snap both axes to a fixed cm step (default 0.1 cm). Uses a decimal-safe
 * rounding so 0.1 + 0.2 lands on exactly 0.3 and never leaks float drift into a
 * PUT body.
 */
export function snapPlacement(placement: Rect, stepCm = 0.1): Rect {
  return {
    ...placement,
    xCm: snapStep(placement.xCm, stepCm),
    yCm: snapStep(placement.yCm, stepCm),
  }
}

function snapStep(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value
  const steps = Math.round(snapCentimeters(value, step) / step)
  return roundCm(steps * step)
}

/** Round to a safe number of cm decimals to kill binary float drift. */
function roundCm(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1e6) / 1e6
}

/** Two footprints collide when they strictly overlap; touching edges do not. */
export function overlaps(a: Rect, b: Rect): boolean {
  const gapX = Math.max(b.xCm - (a.xCm + a.widthCm), a.xCm - (b.xCm + b.widthCm))
  const gapY = Math.max(b.yCm - (a.yCm + a.heightCm), a.yCm - (b.yCm + b.heightCm))
  return gapX < -EPSILON && gapY < -EPSILON
}

/** Every colliding pair of design ids, as stable ordered pairs. */
export function collisionsFor(placements: (Rect & { designId: string })[]): PlacementCollision[] {
  const pairs: PlacementCollision[] = []
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (overlaps(placements[i]!, placements[j]!)) {
        pairs.push({ a: placements[i]!.designId, b: placements[j]!.designId })
      }
    }
  }
  return pairs
}

/** The set of design ids that overlap at least one other placement — for highlight. */
export function collidingDesignIds(placements: (Rect & { designId: string })[]): Set<string> {
  const ids = new Set<string>()
  for (const pair of collisionsFor(placements)) {
    ids.add(pair.a)
    ids.add(pair.b)
  }
  return ids
}

/**
 * The sheet height needed to contain every placement plus a bottom edge margin.
 * Never smaller than the configured height, so shrinking the sheet only happens
 * on a fresh pack — a manual drag grows the sheet, it cannot cut artwork off
 * (product rule: nothing is silently cropped).
 */
export function sheetHeightFor(
  placements: { yCm: number; heightCm: number }[],
  edgeMarginCm: number,
  configuredHeightCm: number,
): number {
  const bottom = placements.reduce(
    (max, item) => Math.max(max, item.yCm + item.heightCm),
    0,
  )
  const needed = bottom + Math.max(0, edgeMarginCm)
  return roundCm(Math.max(Math.max(0, configuredHeightCm), needed))
}

/** Height is the only cost driver: cost = heightCm × pricePerCm. */
export function costFor(heightCm: number, pricePerCm: number, currency: string): Money {
  const safeHeight = Number.isFinite(heightCm) && heightCm > 0 ? heightCm : 0
  const safePrice = Number.isFinite(pricePerCm) && pricePerCm > 0 ? pricePerCm : 0
  return { amount: Math.round(safeHeight * safePrice * 100) / 100, currency }
}

/**
 * Map server placements to the PUT body the contract allows: only designId,
 * versionId, xCm, yCm and rotationDeg. Width/height and any px fields are
 * derived by the packer from the immutable approved version, so sending them
 * would invite resampling — they are stripped here.
 */
export function toManualPlacements(placements: Placement[]): ManualPlacement[] {
  return placements.map((placement) => ({
    designId: placement.designId,
    versionId: placement.versionId,
    xCm: roundCm(placement.xCm),
    yCm: roundCm(placement.yCm),
    rotationDeg: placement.rotationDeg,
  }))
}

export interface IntegritySummary {
  status: 'passed' | 'failed' | 'skipped' | 'none'
  passed: boolean
  checks: Record<IntegrityCheckId, IntegrityCheckResult>
  failedChecks: IntegrityCheckId[]
  skippedChecks: IntegrityCheckId[]
}

/**
 * A small typed view of a report. `skipped` is always treated as NOT passed, and
 * a missing check for one of the four required ids counts as skipped. This is
 * the single source of truth the UI reads, so it can never claim "passed" on an
 * unchecked/stale sheet or on a report where a blocking check was skipped.
 */
export function integritySummary(report: IntegrityReport | null | undefined): IntegritySummary {
  if (!report) {
    const empty = {} as Record<IntegrityCheckId, IntegrityCheckResult>
    for (const id of INTEGRITY_CHECK_IDS) empty[id] = 'skipped'
    return {
      status: 'none',
      passed: false,
      checks: empty,
      failedChecks: [],
      skippedChecks: [...INTEGRITY_CHECK_IDS],
    }
  }

  const byId = new Map<string, IntegrityCheck>()
  for (const check of report.checks) byId.set(check.id, check)

  const checks = {} as Record<IntegrityCheckId, IntegrityCheckResult>
  const failed: IntegrityCheckId[] = []
  const skipped: IntegrityCheckId[] = []
  for (const id of INTEGRITY_CHECK_IDS) {
    const status = byId.get(id)?.status ?? 'skipped'
    checks[id] = status
    if (status === 'failed') failed.push(id)
    else if (status === 'skipped') skipped.push(id)
  }

  const allPassed = failed.length === 0 && skipped.length === 0
  const status: IntegritySummary['status'] = allPassed
    ? 'passed'
    : failed.length > 0
      ? 'failed'
      : 'skipped'

  return {
    status,
    passed: status === 'passed' && report.passed,
    checks,
    failedChecks: failed,
    skippedChecks: skipped,
  }
}

export type ExportBlock =
  | { can: true; reason: 'ok'; message: string }
  | {
      can: false
      reason: 'no-sheet' | 'stale' | 'unchecked' | 'failed'
      message: string
    }

/**
 * Whether an export may even be attempted, with the blocking reason spelled out.
 * A sheet is exportable only when it is present, not stale, not unchecked and
 * carries a fully-passing report (skipped counts as failing).
 */
export function canExport(sheet: Sheet | null | undefined): ExportBlock {
  if (!sheet) {
    return { can: false, reason: 'no-sheet', message: 'This batch has no sheet yet. Pack it first.' }
  }
  if (sheet.stale) {
    return {
      can: false,
      reason: 'stale',
      message: 'The sheet is stale: a design, target size or batch geometry changed after packing. Pack again before exporting.',
    }
  }
  if (sheet.state === 'unchecked') {
    return {
      can: false,
      reason: 'unchecked',
      message: 'The sheet has not been checked yet. Run the integrity check before exporting.',
    }
  }
  const summary = integritySummary(sheet.integrityReport)
  if (sheet.state === 'invalid' || !summary.passed) {
    return {
      can: false,
      reason: 'failed',
      message:
        summary.status === 'skipped'
          ? 'Export is blocked: a blocking integrity check was skipped, which counts as not passed.'
          : 'Export is blocked: this sheet revision has no passing integrity report.',
    }
  }
  return { can: true, reason: 'ok', message: 'Integrity passed. This sheet is ready to export.' }
}

export interface Size {
  width: number
  height: number
}

export const MIN_PX_PER_CM = 2
export const MAX_PX_PER_CM = 60

/**
 * Clamp a display scale to a safe, finite px/cm. All rendering sizes go through
 * here so a stray NaN or a runaway zoom can never produce negative or absurd
 * geometry — but the returned value is only ever used for CSS display, never
 * fed back into placement math.
 */
export function pxPerCmFor(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return MIN_PX_PER_CM
  return Math.min(MAX_PX_PER_CM, Math.max(MIN_PX_PER_CM, zoom))
}

/**
 * The px/cm scale that fits the sheet width into `targetScale` × the container
 * width (targetScale 1 = fit-to-width). `zoomFor` produces the base fit; the
 * canvas multiplies it by the user zoom and passes the result to `pxPerCmFor`.
 */
export function zoomFor(sheet: { widthCm: number }, container: Size, targetScale = 1): number {
  if (!Number.isFinite(sheet.widthCm) || sheet.widthCm <= 0) return MIN_PX_PER_CM
  if (!Number.isFinite(container.width) || container.width <= 0) return MIN_PX_PER_CM
  const scale = Number.isFinite(targetScale) && targetScale > 0 ? targetScale : 1
  return pxPerCmFor((container.width * scale) / sheet.widthCm)
}

/** Format helpers the sheet components share (kept here to avoid duplication). */
export function formatBlockMessage(block: ExportBlock): string {
  return block.message
}
