/**
 * The one and only size conversion for the workbench. Mirrors
 * `PrintUnits.PixelsForCentimeters` in the API: round half away from zero, no
 * local rounding anywhere else.
 */
export const CM_PER_INCH = 2.54

export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function pixelsForCentimeters(centimeters: number, dpi: number): number {
  if (!Number.isFinite(centimeters) || !Number.isFinite(dpi) || centimeters <= 0 || dpi <= 0) {
    return 0
  }
  return roundHalfAwayFromZero((centimeters * dpi) / CM_PER_INCH)
}

export function centimetersForPixels(pixels: number, dpi: number): number {
  if (!Number.isFinite(pixels) || !Number.isFinite(dpi) || dpi <= 0) return 0
  return (pixels * CM_PER_INCH) / dpi
}

export interface PixelSize {
  widthPx: number
  heightPx: number
}

export interface CentimeterSize {
  widthCm: number
  heightCm: number
}

export function targetPixels(size: CentimeterSize, dpi: number): PixelSize {
  return {
    widthPx: pixelsForCentimeters(size.widthCm, dpi),
    heightPx: pixelsForCentimeters(size.heightCm, dpi),
  }
}

export function sizeInCentimeters(size: PixelSize, dpi: number): CentimeterSize {
  return {
    widthCm: centimetersForPixels(size.widthPx, dpi),
    heightCm: centimetersForPixels(size.heightPx, dpi),
  }
}

/** Width divided by height. `null` when the raster has no usable dimensions. */
export function aspectRatioOf(size: PixelSize): number | null {
  if (size.widthPx <= 0 || size.heightPx <= 0) return null
  return size.widthPx / size.heightPx
}

/** Two decimal places keeps the linked side within a fraction of a pixel at 300 DPI. */
export function roundCentimeters(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return roundHalfAwayFromZero(value * factor) / factor
}

/** Height that keeps `widthCm` at the artwork aspect ratio (width / height). */
export function heightForWidth(widthCm: number, aspectRatio: number): number {
  if (!Number.isFinite(widthCm) || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return 0
  return roundCentimeters(widthCm / aspectRatio)
}

/** Width that keeps `heightCm` at the artwork aspect ratio (width / height). */
export function widthForHeight(heightCm: number, aspectRatio: number): number {
  if (!Number.isFinite(heightCm) || !Number.isFinite(aspectRatio) || aspectRatio <= 0) return 0
  return roundCentimeters(heightCm * aspectRatio)
}

/**
 * Whether an already-saved target follows the artwork ratio. Used to choose
 * the initial lock state without silently rewriting an intentional size.
 */
export function matchesAspectRatio(
  size: CentimeterSize,
  aspectRatio: number,
  tolerance = 0.005,
): boolean {
  if (size.widthCm <= 0 || size.heightCm <= 0 || aspectRatio <= 0) return true
  const actual = size.widthCm / size.heightCm
  return Math.abs(actual - aspectRatio) <= aspectRatio * tolerance
}

/**
 * Effective DPI of a source raster at a printed target size: the lower of the
 * horizontal and vertical density. `null` when the inputs are not usable.
 */
export function effectiveDpi(source: PixelSize, target: CentimeterSize): number | null {
  if (source.widthPx <= 0 || source.heightPx <= 0) return null
  if (target.widthCm <= 0 || target.heightCm <= 0) return null
  const horizontal = source.widthPx / (target.widthCm / CM_PER_INCH)
  const vertical = source.heightPx / (target.heightCm / CM_PER_INCH)
  return Math.min(horizontal, vertical)
}

export type DpiWarningLevel = 'ok' | 'warn' | 'strong'

export interface DpiThresholds {
  warnBelow: number
  strongWarnBelow: number
}

export function defaultDpiThresholds(): DpiThresholds {
  return { warnBelow: 150, strongWarnBelow: 100 }
}

/** Warnings never block: they are reasons to upscale or ask for a better source. */
export function dpiWarningLevel(
  dpi: number | null | undefined,
  thresholds: DpiThresholds = defaultDpiThresholds(),
): DpiWarningLevel {
  if (dpi === null || dpi === undefined || !Number.isFinite(dpi)) return 'ok'
  if (dpi < thresholds.strongWarnBelow) return 'strong'
  if (dpi < thresholds.warnBelow) return 'warn'
  return 'ok'
}

export function dpiWarningMessage(
  dpi: number | null | undefined,
  thresholds: DpiThresholds = defaultDpiThresholds(),
): string | null {
  const level = dpiWarningLevel(dpi, thresholds)
  if (level === 'ok' || dpi === null || dpi === undefined) return null
  const rounded = Math.round(dpi)
  return level === 'strong'
    ? `Effective DPI is ${rounded} — below ${thresholds.strongWarnBelow}. Print quality will suffer; upscale or request a better source.`
    : `Effective DPI is ${rounded} — below ${thresholds.warnBelow}. Consider an upscale proposal.`
}

/**
 * What the final resize produces: the canvas is resampled exactly once to
 * `round(cm * dpi / 2.54)` px in both axes. `fitMode` only decides how the
 * artwork sits inside that box (letterboxed or stretched), never the box size —
 * which is what makes `ready` comparable against the target.
 */
export type ResizeFitMode = 'width' | 'height' | 'contain'

export function resizeOutputPixels(
  target: CentimeterSize,
  dpi: number,
  _fitMode: ResizeFitMode = 'contain',
): PixelSize {
  return targetPixels(target, dpi)
}

/** A design is ready only when the current resize matches the target px exactly. */
export function matchesTargetPixels(
  version: PixelSize & { stepType?: string },
  target: CentimeterSize | null | undefined,
  dpi: number,
): boolean {
  if (!target || target.widthCm <= 0 || target.heightCm <= 0) return false
  const expected = targetPixels(target, dpi)
  return version.widthPx === expected.widthPx && version.heightPx === expected.heightPx
}

export function usableRollWidthCm(rollWidthCm: number, edgeMarginMm: number): number {
  return rollWidthCm - (2 * edgeMarginMm) / 10
}

export function mmToCm(mm: number): number {
  return mm / 10
}

export function cmToMm(cm: number): number {
  return cm * 10
}

/** Placement dragging snaps to 0.1 cm, as a whole number of tenths. */
export function snapCentimeters(value: number, step = 0.1): number {
  return Math.round(value / step) * step
}
