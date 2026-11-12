import type { LevelsAdjustment } from '../api/client'
import { levelsWithDefaults } from './levels'

/**
 * Quick Levels: measured, not guessed.
 *
 * The histogram and the black/white points are computed from the artwork the
 * operator is looking at, so the presets answer "where does this image's tonal
 * range actually start and end" instead of asking them to hunt for slider
 * values. Everything is a pure function of pixel bytes, so the same file always
 * proposes the same adjustment — reviewable like any other proposal.
 *
 * All sampling runs on a bounded copy (see `samplePixels`): a 6850 px source is
 * stepped over on a fixed grid rather than decoded at full rate, keeping this
 * well under a frame budget in the browser.
 */

export interface Histogram {
  /** Luminance bucket counts, 256 entries summing to `sampled`. */
  bins: Uint32Array
  sampled: number
}

/** Fixed-step grid sample of the image, capped at ~16k pixels. */
export async function samplePixels(fileUrl: string, maxPixels = 16384): Promise<ImageData | null> {
  const image = await loadImage(fileUrl)
  if (!image) return null
  const scale = Math.min(1, Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

function loadImage(fileUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = fileUrl
  })
}

/** ITU-R BT.601 luminance, the same weights the worker's analysis uses. */
export function luminance(pixels: ImageData): Histogram {
  const bins = new Uint32Array(256)
  const data = pixels.data
  let sampled = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    bins[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++;
    sampled += 1
  }
  return { bins, sampled }
}

/** Percentile of the luminance histogram: first bucket where cumsum ≥ share. */
export function percentileAt(histogram: Histogram, share: number): number {
  const target = histogram.sampled * share
  let cumulative = 0
  for (let value = 0; value < 256; value += 1) {
    cumulative += histogram.bins[value]
    if (cumulative >= target) return value
  }
  return 255
}

export interface QuickLevelsProposal {
  levels: LevelsAdjustment
  summary: string
}

/**
 * Auto levels proposal from the measured range.
 *
 * Black point at the low percentile, white point at the high percentile, and a
 * gamma of 1 — the operator can still bend midtones afterwards. Clamped through
 * `levelsWithDefaults` so the proposal is always a legal value the API accepts.
 */
export function quickLevelsFrom(histogram: Histogram, blackShare = 0.005, whiteShare = 0.995): QuickLevelsProposal | null {
  if (histogram.sampled === 0) return null
  const blackPoint = percentileAt(histogram, blackShare)
  const whitePoint = percentileAt(histogram, whiteShare)
  if (whitePoint - blackPoint < 8) return null
  const levels = levelsWithDefaults({ blackPoint, whitePoint })
  return {
    levels,
    summary: `Measured range ${blackPoint}–${whitePoint}; values below ${blackPoint} go black, above ${whitePoint} go white.`,
  }
}

/** Ratio of the darkest bucket, for a "is this flat art?" hint. */
export function isFlatArt(histogram: Histogram, peakShare = 0.6): boolean {
  if (histogram.sampled === 0) return false
  let max = 0
  for (let value = 0; value < 256; value += 1) max = Math.max(max, histogram.bins[value])
  return max / histogram.sampled >= peakShare
}
