import type { PreviewBackground } from './preview'

/**
 * An artwork whose ink matches the preview background is not empty — it is
 * invisible. White ink on a white garment is a perfectly good DTF design, but
 * on a white canvas it renders as nothing at all, and an operator reasonably
 * concludes the cut-out failed.
 *
 * Preflight already measures this against the garment (`contrast`, minimum
 * 1.5:1). This is the same test against the *preview surface*, so the review
 * page can say why the canvas looks blank instead of leaving the operator to
 * guess. It is a hint, not a gate: nothing here changes a pixel or blocks a
 * decision.
 *
 * Keep the threshold in step with `PreflightProfile.MinimumContrastRatio`.
 */
export const MINIMUM_PREVIEW_CONTRAST = 1.5

export interface Rgb {
  r: number
  g: number
  b: number
}

/** Parses `#RRGGBB`. Returns null for anything else — never guesses. */
export function parseHexColour(hex: string | null | undefined): Rgb | null {
  if (typeof hex !== 'string') return null
  const match = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(hex.trim())
  if (!match) return null
  return {
    r: Number.parseInt(match[1], 16),
    g: Number.parseInt(match[2], 16),
    b: Number.parseInt(match[3], 16),
  }
}

export function toHexColour({ r, g, b }: Rgb): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

/** WCAG 2.x relative luminance, on a 0..1 scale. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const srgb = value / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * The solid colour a preview composites over, or null for the checkerboard.
 *
 * A checkerboard is deliberately exempt: its two tones guarantee that *some*
 * tone contrasts with any ink, so it can never hide artwork.
 */
export function previewSurfaceColour(background: PreviewBackground): Rgb | null {
  if (background.kind === 'checkerboard') return null
  return parseHexColour(background.hex)
}

/** True when the ink would be effectively invisible on this preview surface. */
export function isInvisibleOnPreview(
  inkHex: string | null | undefined,
  background: PreviewBackground,
): boolean {
  const ink = parseHexColour(inkHex)
  const surface = previewSurfaceColour(background)
  if (!ink || !surface) return false
  return contrastRatio(ink, surface) < MINIMUM_PREVIEW_CONTRAST
}

/**
 * A background that will certainly show the artwork, used by the one-click
 * escape from an invisible preview. White ink needs a dark surface and dark ink
 * needs a light one; the choice is by ink luminance, not by garment colour,
 * because the question is only "can I see it".
 */
export function contrastingBackground(inkHex: string | null | undefined): PreviewBackground {
  const ink = parseHexColour(inkHex)
  const dark = ink === null || relativeLuminance(ink) >= 0.5
  return dark
    ? { kind: 'black', hex: '#000000' }
    : { kind: 'white', hex: '#ffffff' }
}

/**
 * Reads the dominant opaque colour of a version file, for the contrast hint.
 *
 * The median rather than the mean: a photo with a small bright subject would
 * drag a mean towards mud and produce a misleading answer, while the median
 * stays on whatever most of the ink actually is. Returns null when the file
 * cannot be read (a test environment without a canvas backend, a decode
 * failure, a cross-origin image) — the caller simply shows no hint.
 */
export async function sampleInkColour(
  fileUrl: string,
  maxSide = 96,
): Promise<string | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('image failed to load'))
      element.src = fileUrl
    })
    const naturalW = image.naturalWidth || image.width
    const naturalH = image.naturalHeight || image.height
    if (!naturalW || !naturalH) return null

    const scale = Math.min(1, maxSide / Math.max(naturalW, naturalH))
    const width = Math.max(1, Math.round(naturalW * scale))
    const height = Math.max(1, Math.round(naturalH * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)

    const reds: number[] = []
    const greens: number[] = []
    const blues: number[] = []
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 128) continue
      reds.push(data[index])
      greens.push(data[index + 1])
      blues.push(data[index + 2])
    }
    if (reds.length === 0) return null

    const median = (values: number[]) => {
      values.sort((a, b) => a - b)
      return values[values.length >> 1]
    }
    return toHexColour({
      r: median(reds),
      g: median(greens),
      b: median(blues),
    })
  } catch {
    return null
  }
}
