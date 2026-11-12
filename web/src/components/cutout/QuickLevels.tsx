import { useEffect, useState } from 'react'
import type { LevelsAdjustment } from '../../api/client'
import { isIdentityLevels, LEVELS_DEFAULTS } from '../../lib/levels'
import { luminance, quickLevelsFrom, samplePixels, type Histogram } from '../../lib/quickLevels'
import { isHexColor } from '../../lib/preview'
import './quick-levels.css'

/**
 * Quick Levels and the one-click Clean preset, inside the existing cut-out step.
 *
 * The histogram is measured from the current layer's pixels; the Auto button
 * fills image levels from the measured tonal range; Clean applies the sampled
 * background colour with safe defaults and submits the cut-out in one click.
 * Nothing here approves anything: the result is still a proposal layer.
 */

export interface BackgroundReadoutProps {
  kind: string | null
  hex: string | null
  confidence: number | null
}

const KIND_LABELS: Record<string, string> = {
  transparent: 'Transparent',
  black: 'Black',
  white: 'White',
  gray: 'Gray',
  custom: 'Colour',
}

export function BackgroundReadout({ kind, hex, confidence }: BackgroundReadoutProps) {
  if (!kind) return null
  return (
    <p className="mono muted" data-testid="background-readout">
      Background: {KIND_LABELS[kind] ?? kind}
      {hex && isHexColor(hex) ? (
        <>
          {' '}
          <span className="swatch" style={{ background: hex }} aria-hidden="true" />
          <span className="mono">{hex}</span>
        </>
      ) : null}
      {confidence != null ? ` · ${Math.round(confidence * 100)}% uniform` : ''}
    </p>
  )
}

export interface QuickLevelsProps {
  /** The layer the operator is looking at; the histogram is measured from it. */
  fileUrl: string
  value: LevelsAdjustment
  onChange: (value: LevelsAdjustment) => void
  disabled?: boolean
}

export function QuickLevels({ fileUrl, value, onChange, disabled }: QuickLevelsProps) {
  const [histogram, setHistogram] = useState<Histogram | null>(null)
  const identity = isIdentityLevels(value)

  useEffect(() => {
    let cancelled = false
    setHistogram(null)
    samplePixels(fileUrl).then((pixels) => {
      if (cancelled || !pixels) return
      setHistogram(luminance(pixels))
    })
    return () => {
      cancelled = true
    }
  }, [fileUrl])

  const apply = () => {
    if (!histogram) return
    const proposal = quickLevelsFrom(histogram)
    if (proposal) onChange(proposal.levels)
  }

  return (
    <div className="quick-levels" data-testid="quick-levels">
      {histogram ? <HistogramBars bins={histogram.bins} /> : <p className="hint">Measuring histogram…</p>}
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={disabled || !histogram || quickLevelsFrom(histogram!) === null}
          onClick={apply}
          data-testid="quick-levels-auto"
        >
          Auto levels
        </button>
        <button
          type="button"
          className="btn sm ghost"
          disabled={disabled || identity}
          onClick={() => onChange({ ...LEVELS_DEFAULTS })}
        >
          Reset
        </button>
      </div>
      <p className="hint">
        Auto sets image levels from the measured tonal range; adjust gamma below if midtones
        need work. The change only applies when the cut-out runs.
      </p>
    </div>
  )
}

function HistogramBars({ bins }: { bins: Uint32Array }) {
  const max = Math.max(...bins, 1)
  const path = Array.from(bins)
    .map((count, value) => `${(value / 255) * 100},${100 - (count / max) * 100}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="histogram"
      role="img"
      aria-label="Luminance histogram of the current layer"
    >
      <polyline points={`0,100 ${path} 100,100`} fill="currentColor" stroke="none" />
    </svg>
  )
}
