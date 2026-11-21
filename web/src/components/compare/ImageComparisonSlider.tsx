import { useRef, useState, type MouseEvent, type TouchEvent, type KeyboardEvent } from 'react'
import { type PreviewBackground, DEFAULT_PREVIEW_BACKGROUND, backgroundStyle } from '../../lib/preview'
import { isIdentityLevels, type LevelsAdjustment } from '../../lib/levels'
import { PreviewSurface } from '../preview/PreviewSurface'
import './ImageComparisonSlider.css'

export interface ImageComparisonSliderProps {
  beforeUrl: string
  afterUrl: string
  beforeAlt: string
  afterAlt: string
  beforeWidthPx: number
  beforeHeightPx: number
  afterWidthPx: number
  afterHeightPx: number
  background?: PreviewBackground
  /** Label for the before image (default: "Before") */
  beforeLabel?: string
  /** Label for the after image (default: "After") */
  afterLabel?: string
  /** Initial slider position 0–1 (default: 0.5) */
  initialPosition?: number
  /** Levels applied to the after side only; the before side is untouched. */
  afterImageLevels?: LevelsAdjustment
  afterMaskLevels?: LevelsAdjustment
  /** Test ID prefix */
  testId?: string
}

/**
 * Two layers, one clip edge.
 *
 * Both sides share one stage element and one background so the seam is a single
 * vertical line at the same place in both images. The previous version put each
 * image in its own padded, absolutely-positioned box and anchored the divider
 * with `inset: 0; left: p%`, which stretched it from the split to the right edge
 * and drew the handle halfway along *that* box — so the handle never sat on the
 * seam.
 */
export function ImageComparisonSlider({
  beforeUrl,
  afterUrl,
  beforeAlt,
  afterAlt,
  beforeWidthPx,
  beforeHeightPx,
  afterWidthPx,
  afterHeightPx,
  background = DEFAULT_PREVIEW_BACKGROUND,
  beforeLabel = 'Before',
  afterLabel = 'After',
  initialPosition = 0.5,
  afterImageLevels,
  afterMaskLevels,
  testId = 'comparison',
}: ImageComparisonSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(initialPosition)
  const [dragging, setDragging] = useState(false)

  const clamp = (value: number) => Math.max(0, Math.min(1, value))

  function getPositionFromEvent(event: MouseEvent | TouchEvent): number | null {
    const container = containerRef.current
    if (!container) return null
    const rect = container.getBoundingClientRect()
    const clientX = 'touches' in event ? event.touches[0]?.clientX ?? 0 : event.clientX
    if (!rect.width) return null
    return clamp((clientX - rect.left) / rect.width)
  }

  function handlePointerDown(event: MouseEvent | TouchEvent) {
    if ('button' in event && event.button !== 0) return
    const pos = getPositionFromEvent(event)
    if (pos !== null) {
      setDragging(true)
      setPosition(pos)
    }
  }

  function handlePointerMove(event: MouseEvent | TouchEvent) {
    if (!dragging) return
    const pos = getPositionFromEvent(event)
    if (pos !== null) setPosition(pos)
  }

  function handlePointerUp() {
    setDragging(false)
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setPosition((p) => clamp(p - 0.05))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setPosition((p) => clamp(p + 0.05))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPosition(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPosition(1)
    }
  }

  // The after side is the layer under review, so its artwork ratio sizes the
  // stage; a crop that changed the ratio would otherwise letterbox in a box that
  // still claims the old shape.
  const aspectRatio =
    afterWidthPx > 0 && afterHeightPx > 0
      ? afterWidthPx / afterHeightPx
      : beforeWidthPx > 0 && beforeHeightPx > 0
        ? beforeWidthPx / beforeHeightPx
        : 1
  const levelsActive =
    !isIdentityLevels(afterImageLevels) || !isIdentityLevels(afterMaskLevels)

  return (
    <div
      ref={containerRef}
      className="comparison-slider"
      data-testid={testId}
      role="group"
      aria-label={`${beforeLabel} / ${afterLabel} comparison. Use arrow keys to move the divider.`}
      tabIndex={0}
      onMouseDown={handlePointerDown}
      onTouchStart={handlePointerDown}
      onKeyDown={handleKeyDown}
      style={{ aspectRatio: `${aspectRatio.toFixed(4)}` }}
    >
      <div className="comparison-stage" style={backgroundStyle(background)}>
        <img
          className="comparison-image"
          src={beforeUrl}
          alt={beforeAlt}
          draggable={false}
        />
        <div
          className="comparison-layer after"
          style={{ clipPath: `inset(0 0 0 ${(position * 100).toFixed(3)}%)` }}
        >
          {levelsActive ? (
            <PreviewSurface
              fileUrl={afterUrl}
              alt={afterAlt}
              background={background}
              imageLevels={afterImageLevels}
              maskLevels={afterMaskLevels}
              layout="fill"
              testId={`${testId}-after`}
            />
          ) : (
            <img
              className="comparison-image"
              src={afterUrl}
              alt={afterAlt}
              draggable={false}
            />
          )}
        </div>
      </div>

      <div className="comparison-split" style={{ left: `${position * 100}%` }} aria-hidden="true" />
      <div className="comparison-handle" style={{ left: `${position * 100}%` }} aria-hidden="true">
        <span />
      </div>

      <span className="comparison-label before">{beforeLabel}</span>
      <span className="comparison-label after">{afterLabel}</span>

      <div className="comparison-hint" aria-hidden="true">
        Drag or use ← → to compare
      </div>

      <div
        onMouseMove={handlePointerMove}
        onTouchMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onTouchEnd={handlePointerUp}
        onMouseLeave={handlePointerUp}
        className="comparison-hit-area"
        aria-hidden="true"
      />
    </div>
  )
}
