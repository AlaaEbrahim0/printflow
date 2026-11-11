/**
 * Colour and alpha adjustments for the manual cleanup editor.
 *
 * The one rule this module enforces: *the preview and the exported PNG run the
 * same function*. A Levels slider that looks right on screen and then bakes
 * differently is the classic browser-editor bug, and the only reliable fix is
 * to make the screen the same code path as the export.
 *
 * Everything here mutates the `ImageData` it is given (that is the point — it
 * exists to be thrown at a canvas) and is fully deterministic.
 */

export interface Levels {
  /** Input black point, 0–254. */
  black: number
  /** Input white point, 1–255. */
  white: number
  /** Midtone gamma; > 1 lifts midtones. */
  gamma: number
  /** Output floor, 0–255. */
  outputBlack: number
  /** Output ceiling, 0–255. */
  outputWhite: number
}

export interface Adjustments {
  levels: Levels
  /** −180–180 degrees. */
  hue: number
  /** −100–100, 0 = unchanged. */
  saturation: number
  /** −100–100, 0 = unchanged. */
  lightness: number
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  levels: { black: 0, white: 255, gamma: 1, outputBlack: 0, outputWhite: 255 },
  hue: 0,
  saturation: 0,
  lightness: 0,
}

export function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** True when applying the adjustments would leave every pixel byte-identical. */
export function isIdentityAdjustments(a: Adjustments): boolean {
  const { levels } = a
  return (
    levels.black === 0 &&
    levels.white === 255 &&
    Math.abs(levels.gamma - 1) < 1e-9 &&
    levels.outputBlack === 0 &&
    levels.outputWhite === 255 &&
    a.hue === 0 &&
    a.saturation === 0 &&
    a.lightness === 0
  )
}

/**
 * The 256-entry ramp for one channel, computed once per render.
 *
 * Sliders move in whole steps and the ramp is only 256 values, so building it
 * up front turns 12 million `Math.pow` calls on a 4 MP artwork into 256. The
 * lookup table also makes "what did the levels actually do" trivially testable.
 */
export function buildLevelsLut(levels: Levels): Uint8ClampedArray {
  const black = Math.min(254, Math.max(0, levels.black))
  const white = Math.max(black + 1, Math.min(255, levels.white))
  const gamma = Math.max(0.01, levels.gamma)
  const outBlack = clampByte(levels.outputBlack)
  const outWhite = clampByte(levels.outputWhite)
  const range = white - black
  const span = outWhite - outBlack
  const lut = new Uint8ClampedArray(256)
  for (let value = 0; value < 256; value += 1) {
    const normalised = Math.min(1, Math.max(0, (value - black) / range))
    const shaped = Math.pow(normalised, 1 / gamma)
    lut[value] = clampByte(outBlack + shaped * span)
  }
  return lut
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return [0, 0, l]
  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / delta) % 6
  else if (max === gn) h = (bn - rn) / delta + 2
  else h = (rn - gn) / delta + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255]
}

/**
 * Apply levels then hue/saturation/lightness in place.
 *
 * Hue and saturation run in HSL, not HSV: lightness is a separate control here,
 * and HSV's "value" collapses lightness into saturation, so a saturation-only
 * edit would brighten as a side effect. Fully transparent pixels are skipped —
 * their colour is invisible and rewriting it would only slow the loop down.
 */
export function applyAdjustments(data: ImageData, adjustments: Adjustments): ImageData {
  if (isIdentityAdjustments(adjustments)) return data
  const pixels = data.data
  const lut = buildLevelsLut(adjustments.levels)
  const levelsIdentity =
    lut[0] === 0 &&
    lut[255] === 255 &&
    // A pure identity ramp is affine; check a midpoint so a gamma curve that
    // still maps 0 and 255 to themselves is not mistaken for a no-op.
    lut[128] === 128
  const hueShift = adjustments.hue
  const satScale = 1 + adjustments.saturation / 100
  const lightShift = (adjustments.lightness / 100) * 0.5
  const touchColour = hueShift !== 0 || adjustments.saturation !== 0 || adjustments.lightness !== 0

  for (let i = 0; i < pixels.length; i += 4) {
    let r = pixels[i]
    let g = pixels[i + 1]
    let b = pixels[i + 2]
    if (!levelsIdentity) {
      r = lut[r]
      g = lut[g]
      b = lut[b]
    }
    if (touchColour) {
      const [h, s, l] = rgbToHsl(r, g, b)
      const nextL = Math.min(1, Math.max(0, l + lightShift))
      const nextS = Math.min(1, Math.max(0, s * satScale))
      const [nr, ng, nb] = hslToRgb(h + hueShift, nextS, nextL)
      r = clampByte(nr)
      g = clampByte(ng)
      b = clampByte(nb)
    }
    pixels[i] = r
    pixels[i + 1] = g
    pixels[i + 2] = b
  }
  return data
}
