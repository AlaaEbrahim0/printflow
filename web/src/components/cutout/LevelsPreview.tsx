import { useEffect, useRef } from 'react'

import { levelsCurve, type LevelsAdjustment } from '../../lib/levels'

interface LevelsPreviewProps {
  /** Full-resolution file URL of the layer being judged. */
  imageUrl: string
  /** Stored mask artifact, when one exists. Its alpha-multiplied result is drawn. */
  maskUrl?: string | null
  imageLevels: LevelsAdjustment
  maskLevels: LevelsAdjustment
  /** CSS background shown through transparent pixels: checkerboard or garment colour. */
  background?: string
  /** Longest preview side, in CSS pixels. The worker still renders the real file. */
  maxSide?: number
}

/**
 * What the sliders will actually do, before committing a job.
 *
 * The worker applies levels to the full-resolution file, which is far too slow to
 * redo in the browser on every drag. This draws the same 256-entry curve over a
 * downscaled copy instead, multiplies the stored mask into the alpha, and lets the
 * operator judge a halo or a pinhole while the slider is moving. The preview is
 * explicitly labelled as an approximation: the proposal the worker writes is the
 * thing that gets approved.
 */
export function LevelsPreview({
  imageUrl,
  maskUrl,
  imageLevels,
  maskLevels,
  background,
  maxSide = 560,
}: LevelsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const load = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error(`could not load ${url}`))
        image.src = url
      })

    void (async () => {
      try {
        const image = await load(imageUrl)
        const mask = maskUrl ? await load(maskUrl).catch(() => null) : null
        if (cancelled) return

        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
        const width = Math.max(1, Math.round(image.naturalWidth * scale))
        const height = Math.max(1, Math.round(image.naturalHeight * scale))
        canvas.width = width
        canvas.height = height

        const colours = new OffscreenCanvas(width, height)
        const colourContext = colours.getContext('2d', { willReadFrequently: true })
        if (!colourContext) return
        colourContext.drawImage(image, 0, 0, width, height)
        const pixels = colourContext.getImageData(0, 0, width, height)

        const colourCurve = levelsCurve(imageLevels)
        for (let index = 0; index < pixels.data.length; index += 4) {
          pixels.data[index] = Math.round(colourCurve[pixels.data[index]] * 255)
          pixels.data[index + 1] = Math.round(colourCurve[pixels.data[index + 1]] * 255)
          pixels.data[index + 2] = Math.round(colourCurve[pixels.data[index + 2]] * 255)
        }

        if (mask) {
          const maskCanvas = new OffscreenCanvas(width, height)
          const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true })
          if (maskContext) {
            maskContext.drawImage(mask, 0, 0, width, height)
            const matte = maskContext.getImageData(0, 0, width, height)
            const alphaCurve = levelsCurve(maskLevels)
            for (let index = 0; index < pixels.data.length; index += 4) {
              const value = alphaCurve[matte.data[index]]
              pixels.data[index + 3] = Math.round(pixels.data[index + 3] * value)
            }
          }
        }

        const context = canvas.getContext('2d')
        if (!context) return
        context.putImageData(pixels, 0, 0)
      } catch {
        // A preview that cannot load is not an error the operator needs: the
        // submit path still renders the real file and reports a real failure.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [imageUrl, maskUrl, imageLevels, maskLevels, maxSide])

  return (
    <div className="levels-preview" style={background ? { background } : undefined}>
      <canvas ref={canvasRef} data-testid="levels-preview" />
    </div>
  )
}
