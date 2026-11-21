import { useEffect, useRef } from 'react'

import { levelsCurve, levelsWithDefaults, type LevelsAdjustment } from '../../lib/levels'
import { backgroundStyle, type PreviewBackground } from '../../lib/preview'
import './preview.css'

export interface PreviewSurfaceProps {
  /** The immutable version file being judged. */
  fileUrl: string
  alt: string
  background: PreviewBackground
  /** Applied to the visible colours, exactly as the worker does. */
  imageLevels?: LevelsAdjustment
  /** Applied to the version's own alpha, which is the stored mask. */
  maskLevels?: LevelsAdjustment
  /** 1 fits the box; 2 and 3 zoom in and scroll. */
  zoom?: number
  /** Longest canvas side. The file is never re-encoded; this is display only. */
  maxRenderSide?: number
  /**
   * `contain` keeps the whole artwork in the box and scrolls when zoomed.
   * `fill` sizes the canvas to its parent, for the comparison panes.
   */
  layout?: 'contain' | 'fill'
  className?: string
  testId?: string
}

/**
 * The main review canvas: the version's pixels with the live levels applied.
 *
 * The worker applies levels to the full-resolution file, which is far too slow to
 * redo on every slider drag. This draws the same 256-entry curves over a
 * downscaled copy instead, so the operator can see a halo appear or a pinhole
 * close *on the big canvas* while the slider moves. The proposal the worker
 * writes is still the thing that gets approved.
 *
 * `maskLevels` is applied to the version's own alpha rather than to a separate
 * stored mask: a background-removal version's alpha **is** its mask, so one fetch
 * is enough and the preview cannot drift from the artefact.
 */
export function PreviewSurface({
  fileUrl,
  alt,
  background,
  imageLevels,
  maskLevels,
  zoom = 1,
  maxRenderSide = 2600,
  layout = 'contain',
  className = '',
  testId = 'preview-surface',
}: PreviewSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const image = new Image()
    image.onload = () => {
      if (cancelled) return
      const naturalW = image.naturalWidth
      const naturalH = image.naturalHeight
      if (!naturalW || !naturalH) return

      // Cap the *rendered* pixels, never the source file. A 6850 px design costs
      // ~37 MB of canvas at 2600 and nothing else.
      const scale = Math.min(1, maxRenderSide / Math.max(naturalW, naturalH))
      const width = Math.max(1, Math.round(naturalW * scale))
      const height = Math.max(1, Math.round(naturalH * scale))

      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return
      context.clearRect(0, 0, width, height)
      context.drawImage(image, 0, 0, width, height)

      const pixels = context.getImageData(0, 0, width, height)
      const colour = levelsCurve(levelsWithDefaults(imageLevels))
      const alpha = levelsCurve(levelsWithDefaults(maskLevels))
      const data = pixels.data
      for (let index = 0; index < data.length; index += 4) {
        data[index] = Math.round(colour[data[index]] * 255)
        data[index + 1] = Math.round(colour[data[index + 1]] * 255)
        data[index + 2] = Math.round(colour[data[index + 2]] * 255)
        data[index + 3] = Math.round(alpha[data[index + 3]] * 255)
      }
      context.putImageData(pixels, 0, 0)
    }
    image.src = fileUrl

    return () => {
      cancelled = true
    }
  }, [fileUrl, imageLevels, maskLevels, maxRenderSide])

  return (
    <div
      className={`preview-surface ${layout === 'fill' ? 'is-fill' : ''} ${className}`.trim()}
      data-testid={testId}
      style={backgroundStyle(background)}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={alt}
        style={layout === 'fill' ? undefined : { width: `${zoom * 100}%` }}
      />
    </div>
  )
}
