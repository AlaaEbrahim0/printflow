import { useRef, useState, type MouseEvent, type TouchEvent, type KeyboardEvent } from 'react'
import { AlphaPreview } from '../preview/AlphaPreview'
import { type PreviewBackground, DEFAULT_PREVIEW_BACKGROUND } from '../../lib/preview'
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
  /** Test ID prefix */
  testId?: string
}

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

  const beforeStyle = { clipPath: `inset(0 ${(1 - position) * 100}% 0 0)` }
  const afterStyle = { clipPath: `inset(0 0 0 ${position * 100}%)` }
  const dividerStyle = { left: `${position * 100}%` }

  const aspectRatio = beforeWidthPx / beforeHeightPx

  return (
    <div
      ref={containerRef}
      className="comparison-slider"
      data-testid={testId}
      role="img"
      aria-label={`${beforeLabel} / ${afterLabel} comparison. Use arrow keys to move slider.`}
      tabIndex={0}
      onMouseDown={handlePointerDown}
      onTouchStart={handlePointerDown}
      onKeyDown={handleKeyDown}
      style={{ aspectRatio: `${aspectRatio.toFixed(4)}` } as React.CSSProperties}
    >
      <div className="comparison-layer before" style={beforeStyle} aria-hidden="true">
        <AlphaPreview
          fileUrl={beforeUrl}
          alt={beforeAlt}
          background={background}
          widthPx={beforeWidthPx}
          heightPx={beforeHeightPx}
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </div>

      <div className="comparison-layer after" style={afterStyle} aria-hidden="true">
        <AlphaPreview
          fileUrl={afterUrl}
          alt={afterAlt}
          background={background}
          widthPx={afterWidthPx}
          heightPx={afterHeightPx}
          loading="eager"
          decoding="async"
          fetchPriority="high"
        />
      </div>

      <div
        className="comparison-divider"
        style={dividerStyle}
        aria-hidden="true"
      >
        <span className="comparison-handle" />
        <span className="comparison-label before">{beforeLabel}</span>
        <span className="comparison-label after">{afterLabel}</span>
      </div>

      <div className="comparison-hint" aria-hidden="true">
        Drag or use ← → keys to compare
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