/**
 * Color Range: a selection built from a colour sampled off the canvas, with
 * separate tolerances for how far each channel may wander.
 *
 * This is deliberately *not* the magic wand. The wand is a connectivity tool —
 * it answers "which blob is this pixel part of". Color Range answers "which
 * pixels look like this colour, wherever they are", which is what makes it the
 * right tool for knocking out a printed background behind several separate
 * shapes. Keeping them separate also means the wand's existing slider behaviour
 * stays exactly as it was.
 *
 * Matching happens in HSL rather than RGB because a gradient background varies
 * mostly in lightness: a pure RGB distance forces the tolerance up until the
 * mask bleeds into the artwork, while a lightness-only tolerance holds the hue
 * still. `fuzziness` still works in RGB for people who want PS's behaviour.
 */
import type { Point } from './selectionGeometry'

export type ColorRangeMetric = 'rgb' | 'hsl'

export interface ColorRangeOptions {
  /** 0–100. Channel tolerance derived from this, as the wand does. */
  fuzziness: number
  /** 0–100. Hue window in degrees (mapped to 0–180). HSL only. */
  hueTolerance?: number
  /** 0–100. Saturation window, 0–1 scale. HSL only. */
  saturationTolerance?: number
  /** 0–100. Lightness window, 0–1 scale. HSL only. */
  lightnessTolerance?: number
  /** Include alpha as another channel in RGB mode. */
  useAlpha?: boolean
  metric?: ColorRangeMetric
}

export interface RGBColor {
  r: number
  g: number
  b: number
  a?: number
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { h: 0, s: 0, l }
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / delta) % 6
  else if (max === gn) h = (bn - rn) / delta + 2
  else h = (rn - gn) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** Shortest angular distance between two hues, in degrees. */
export function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360
  return delta > 180 ? 360 - delta : delta
}

/** The RGB colour under a pixel. `null` when the point is outside the raster. */
export function sampleColor(
  image: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  point: Point,
): RGBColor | null {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  if (x < 0 || y < 0 || x >= width || y >= height) return null
  const offset = (y * width + x) * 4
  return { r: image[offset], g: image[offset + 1], b: image[offset + 2], a: image[offset + 3] }
}

/**
 * Build a full-image selection matching `target`.
 *
 * The returned mask is soft at the edges: instead of one binary threshold, the
 * last `feather` percentage of the tolerance ramps 255 → 0. A hard threshold on
 * a photographic background leaves a stairstepped halo that the operator then
 * has to feather by hand; the ramp costs one multiply per pixel and removes
 * that whole repair step.
 */
export function colorRangeSelect(
  image: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  target: RGBColor,
  options: ColorRangeOptions,
): Uint8Array {
  const out = new Uint8Array(Math.max(0, width * height))
  if (width <= 0 || height <= 0) return out
  const metric = options.metric ?? 'rgb'
  if (metric === 'hsl') {
    const targetHsl = rgbToHsl(target.r, target.g, target.b)
    const hueWindow = ((options.hueTolerance ?? options.fuzziness) / 100) * 180
    const satWindow = ((options.saturationTolerance ?? options.fuzziness) / 100)
    const lightWindow = ((options.lightnessTolerance ?? options.fuzziness) / 100)
    const feather = Math.max(0.001, (options.fuzziness / 100))
    for (let i = 0; i < out.length; i += 1) {
      const offset = i * 4
      const pixel = rgbToHsl(image[offset], image[offset + 1], image[offset + 2])
      // Normalise each axis by its own window so no one channel dominates.
      const dh = hueWindow === 0 ? (hueDistance(pixel.h, targetHsl.h) === 0 ? 0 : 2) : hueDistance(pixel.h, targetHsl.h) / hueWindow
      const ds = satWindow === 0 ? Math.abs(pixel.s - targetHsl.s) * 2 : Math.abs(pixel.s - targetHsl.s) / satWindow
      const dl = lightWindow === 0 ? Math.abs(pixel.l - targetHsl.l) * 2 : Math.abs(pixel.l - targetHsl.l) / lightWindow
      const worst = Math.max(dh, ds, dl)
      out[i] = rampAlpha(worst, feather)
    }
    return out
  }

  const threshold = Math.round((Math.min(100, Math.max(0, options.fuzziness)) / 100) * 255)
  const useAlpha = Boolean(options.useAlpha)
  const channels = useAlpha ? 4 : 3
  const budget = Math.max(1, threshold * channels)
  // The last quarter of the window is the soft edge; see the doc comment.
  const feather = 0.25
  for (let i = 0; i < out.length; i += 1) {
    const offset = i * 4
    let distance =
      Math.abs(image[offset] - target.r) +
      Math.abs(image[offset + 1] - target.g) +
      Math.abs(image[offset + 2] - target.b)
    if (useAlpha) distance += Math.abs(image[offset + 3] - (target.a ?? 255))
    out[i] = rampAlpha(distance / budget, feather)
  }
  return out
}

/** 255 well inside the window, ramping to 0 at its edge. */
function rampAlpha(normalisedDistance: number, feather: number): number {
  if (normalisedDistance <= 1 - feather) return 255
  if (normalisedDistance >= 1) return 0
  return Math.round((1 - (normalisedDistance - (1 - feather)) / feather) * 255)
}

/** Wording for the panel so the operator knows what the selection did. */
export function describeColorRange(options: ColorRangeOptions): string {
  const parts: string[] = [`fuzziness ${Math.round(options.fuzziness)}`]
  if ((options.metric ?? 'rgb') === 'hsl') {
    parts.push(`hue ±${Math.round(((options.hueTolerance ?? options.fuzziness) / 100) * 180)}°`)
    parts.push(`sat ±${Math.round(options.saturationTolerance ?? options.fuzziness)}`)
    parts.push(`light ±${Math.round(options.lightnessTolerance ?? options.fuzziness)}`)
  }
  return parts.join(' · ')
}
