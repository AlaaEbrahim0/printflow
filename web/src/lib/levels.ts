import type { LevelsAdjustment } from '../api/client'

/**
 * Levels, mirroring the worker's `mask_ops.levels_lut` exactly.
 *
 * The operator sets four numbers and gets a 256-entry ramp remap. Doing the maths
 * in one place means the little curve preview in the panel and the pixels the
 * worker actually writes can never disagree: both apply
 * `outBlack + ((x - black) / (white - black)) ^ (1 / gamma) * (outWhite - outBlack)`
 * clamped to the input range first.
 *
 * The mask and the image share this object shape but are separate controls: the
 * mask levels move which pixels survive the cut-out, the image levels move the
 * colour of what survives.
 */
export type { LevelsAdjustment }

export const LEVELS_DEFAULTS: LevelsAdjustment = {
  blackPoint: 0,
  whitePoint: 255,
  gamma: 1,
  outputBlack: 0,
  outputWhite: 255,
}

/** Input black/white points the panel allows. 254/1 keeps the range non-empty. */
export const LEVELS_LIMITS = {
  blackPoint: { min: 0, max: 254 },
  whitePoint: { min: 1, max: 255 },
  gamma: { min: 0.1, max: 4 },
  outputBlack: { min: 0, max: 255 },
  outputWhite: { min: 0, max: 255 },
} as const

export function levelsWithDefaults(levels: Partial<LevelsAdjustment> | null | undefined): LevelsAdjustment {
  return {
    blackPoint: clampInt(levels?.blackPoint ?? LEVELS_DEFAULTS.blackPoint, 0, 254),
    whitePoint: clampInt(levels?.whitePoint ?? LEVELS_DEFAULTS.whitePoint, 1, 255),
    gamma: clampNumber(levels?.gamma ?? LEVELS_DEFAULTS.gamma, LEVELS_LIMITS.gamma.min, LEVELS_LIMITS.gamma.max),
    outputBlack: clampInt(levels?.outputBlack ?? LEVELS_DEFAULTS.outputBlack, 0, 255),
    outputWhite: clampInt(levels?.outputWhite ?? LEVELS_DEFAULTS.outputWhite, 0, 255),
  }
}

/** True when the adjustment would leave every pixel unchanged. */
export function isIdentityLevels(levels: LevelsAdjustment | null | undefined): boolean {
  if (!levels) return true
  const resolved = levelsWithDefaults(levels)
  return (
    resolved.blackPoint === 0 &&
    resolved.whitePoint === 255 &&
    Math.abs(resolved.gamma - 1) < 1e-9 &&
    resolved.outputBlack === 0 &&
    resolved.outputWhite === 255
  )
}

/**
 * The 256-entry ramp the worker applies, for the curve preview.
 *
 * Returned as 0..1 so it can be drawn straight into an SVG path without the
 * component re-deriving the mapping.
 */
export function levelsCurve(levels: LevelsAdjustment): number[] {
  const resolved = levelsWithDefaults(levels)
  const black = resolved.blackPoint
  const span = resolved.whitePoint - black
  const inverseGamma = 1 / resolved.gamma
  const outSpan = resolved.outputWhite - resolved.outputBlack
  const curve = new Array<number>(256)
  for (let value = 0; value < 256; value += 1) {
    const normalized = Math.min(Math.max((value - black) / span, 0), 1)
    const shaped = Math.pow(normalized, inverseGamma)
    curve[value] = (resolved.outputBlack + shaped * outSpan) / 255
  }
  return curve
}

/**
 * One-line description of what the adjustment does, in operator words.
 *
 * Shown under the sliders so a designer who moved something and cannot see it on
 * a 4 cm preview still knows what they asked for.
 */
export function describeLevels(levels: LevelsAdjustment): string {
  if (isIdentityLevels(levels)) return 'No change — every alpha/colour value passes through.'
  const resolved = levelsWithDefaults(levels)
  const parts: string[] = []
  if (resolved.blackPoint > 0) parts.push(`everything at or below ${resolved.blackPoint} → 0`)
  if (resolved.whitePoint < 255) parts.push(`everything at or above ${resolved.whitePoint} → 255`)
  if (Math.abs(resolved.gamma - 1) >= 0.01) {
    parts.push(resolved.gamma > 1 ? `midtones lifted ${resolved.gamma.toFixed(2)}×` : `midtones darkened ${(1 / resolved.gamma).toFixed(2)}×`)
  }
  if (resolved.outputBlack > 0 || resolved.outputWhite < 255) {
    parts.push(`output limited to ${resolved.outputBlack}–${resolved.outputWhite}`)
  }
  return `${parts.join(' · ')}.`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(Math.max(value, min), max)
}
