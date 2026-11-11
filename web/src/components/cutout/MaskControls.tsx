import { useId } from 'react'
import type { LevelsAdjustment } from '../../api/client'
import { describeLevels, isIdentityLevels, levelsCurve, levelsWithDefaults } from '../../lib/levels'
import './mask-controls.css'

/**
 * Grow / contract for the selection edge.
 *
 * The value is a distance in **source pixels**, not a percentage, because that is
 * what the worker applies and what the operator can reason about ("pull the edge
 * back two pixels so the halo stops"). Negative contracts.
 */
export interface MaskGrowControlProps {
  value: number
  onChange: (value: number) => void
  disabled?: boolean
  /** Largest offset the contract allows. */
  max?: number
}

export function MaskGrowControl({ value, onChange, disabled, max = 100 }: MaskGrowControlProps) {
  const id = useId()
  const resolved = clamp(value, -max, max)
  return (
    <div className="mask-grow">
      <label htmlFor={`${id}-range`}>Selection edge</label>
      <div className="mask-grow-row">
        <button
          type="button"
          className="btn sm"
          disabled={disabled}
          onClick={() => onChange(-8)}
          title="Pull the selection edge 8 px inward"
        >
          Contract
        </button>
        <input
          id={`${id}-range`}
          type="range"
          min={-max}
          max={max}
          step={1}
          value={resolved}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Selection edge offset in pixels"
        />
        <button
          type="button"
          className="btn sm"
          disabled={disabled}
          onClick={() => onChange(8)}
          title="Push the selection edge 8 px outward"
        >
          Expand
        </button>
        <input
          className="mask-grow-number mono"
          type="number"
          min={-max}
          max={max}
          step={1}
          value={resolved}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number(event.target.value)
            onChange(Number.isFinite(parsed) ? clamp(parsed, -max, max) : 0)
          }}
          aria-label="Selection edge offset"
        />
        <span className="dim mono">px</span>
        <button
          type="button"
          className="btn sm ghost"
          disabled={disabled || resolved === 0}
          onClick={() => onChange(0)}
        >
          Reset
        </button>
      </div>
      <p className="hint">
        {resolved === 0
          ? 'Edge left where the key put it. Positive expands the cut-out, negative pulls it back.'
          : `Edge moved ${Math.abs(resolved)} px ${resolved > 0 ? 'outward' : 'inward'} in every direction, including diagonals.`}
      </p>
    </div>
  )
}

export interface LevelsControlProps {
  label: string
  hint?: string
  value: LevelsAdjustment
  onChange: (value: LevelsAdjustment) => void
  disabled?: boolean
  /** Small caption over the curve, e.g. "alpha" or "colour". */
  curveCaption?: string
}

/**
 * A compact Photoshop-style levels block: input black/white, midtone gamma, an
 * optional output range and a live curve so the mapping is visible instead of
 * guessed. `value` is always a complete object; callers hold defaults.
 */
export function LevelsControl({
  label,
  hint,
  value,
  onChange,
  disabled,
  curveCaption = 'curve',
}: LevelsControlProps) {
  const id = useId()
  const resolved = levelsWithDefaults(value)
  const patch = (changes: Partial<LevelsAdjustment>) => onChange(levelsWithDefaults({ ...resolved, ...changes }))
  const identity = isIdentityLevels(resolved)

  return (
    <fieldset className="levels" disabled={disabled}>
      <legend>
        {label} {identity ? <span className="levels-badge">neutral</span> : null}
      </legend>
      {hint ? <p className="hint">{hint}</p> : null}
      <div className="levels-body">
        <div className="levels-sliders">
          <SliderRow
            id={`${id}-black`}
            label="Input black"
            min={0}
            max={254}
            step={1}
            value={resolved.blackPoint}
            onChange={(blackPoint) => patch({ blackPoint })}
          />
          <SliderRow
            id={`${id}-gamma`}
            label="Midtones"
            min={0.1}
            max={4}
            step={0.05}
            value={resolved.gamma}
            onChange={(gamma) => patch({ gamma })}
            format={(gamma) => gamma.toFixed(2)}
          />
          <SliderRow
            id={`${id}-white`}
            label="Input white"
            min={1}
            max={255}
            step={1}
            value={resolved.whitePoint}
            onChange={(whitePoint) => patch({ whitePoint })}
          />
          <div className="levels-output">
            <SliderRow
              id={`${id}-outblack`}
              label="Output black"
              min={0}
              max={255}
              step={1}
              value={resolved.outputBlack}
              onChange={(outputBlack) => patch({ outputBlack })}
            />
            <SliderRow
              id={`${id}-outwhite`}
              label="Output white"
              min={0}
              max={255}
              step={1}
              value={resolved.outputWhite}
              onChange={(outputWhite) => patch({ outputWhite })}
            />
          </div>
        </div>
        <LevelsCurve levels={resolved} caption={curveCaption} />
      </div>
      <p className="hint levels-description">{describeLevels(resolved)}</p>
      {!identity ? (
        <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => onChange({ ...levelsWithDefaults(null) })}>
          Reset {label.toLowerCase()}
        </button>
      ) : null}
    </fieldset>
  )
}

function SliderRow({
  id,
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <div className="levels-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output htmlFor={id} className="mono">
        {format ? format(value) : value}
      </output>
    </div>
  )
}

function LevelsCurve({ levels, caption }: { levels: LevelsAdjustment; caption: string }) {
  const curve = levelsCurve(levels)
  const size = 100
  const points = curve
    .map((y, x) => `${(x / 255) * size},${size - y * size}`)
    .join(' ')
  return (
    <figure className="levels-curve">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${caption} levels curve`}>
        <rect x="0" y="0" width={size} height={size} className="levels-curve-bg" />
        <line x1="0" y1={size} x2={size} y2="0" className="levels-curve-diagonal" />
        <polyline points={points} className="levels-curve-line" />
      </svg>
      <figcaption className="mono dim">{caption}</figcaption>
    </figure>
  )
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.round(value), min), max)
}
