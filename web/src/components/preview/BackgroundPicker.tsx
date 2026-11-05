import {
  BACKGROUND_LABELS,
  PRESET_GARMENT_COLORS,
  isHexColor,
  normalizeHex,
  type PreviewBackground,
  type PreviewBackgroundKind,
} from '../../lib/preview'
import './preview.css'

const ORDER: PreviewBackgroundKind[] = ['checkerboard', 'white', 'black', 'custom']

export interface BackgroundPickerProps {
  value: PreviewBackground
  onChange: (next: PreviewBackground) => void
  /** The design's own garment color, offered as a one-click custom target. */
  garmentHex?: string | null
}

export function BackgroundPicker({ value, onChange, garmentHex }: BackgroundPickerProps) {
  return (
    <div className="background-picker">
      <div className="segmented" role="radiogroup" aria-label="Preview background">
        {ORDER.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value.kind === kind}
            className={`segment${value.kind === kind ? ' active' : ''}`}
            data-testid={`background-${kind}`}
            data-background={kind}
            onClick={() =>
              onChange({
                kind,
                hex:
                  kind === 'custom'
                    ? value.kind === 'custom'
                      ? value.hex
                      : isHexColor(garmentHex)
                        ? garmentHex!.toLowerCase()
                        : value.hex || '#ff00ff'
                    : value.hex,
              })
            }
          >
            <span
              className={`swatch swatch-${kind}`}
              style={kind === 'custom' ? { backgroundColor: value.hex } : undefined}
              aria-hidden="true"
            />
            {BACKGROUND_LABELS[kind]}
          </button>
        ))}
      </div>
      {value.kind === 'custom' && (
        <div className="custom-background">
          <label className="field-label" htmlFor="garment-hex">
            Garment color
          </label>
          <div className="row">
            <input
              id="garment-hex"
              type="color"
              value={value.hex}
              onChange={(event) => onChange({ kind: 'custom', hex: event.target.value })}
            />
            <input
              className="hex-input mono"
              type="text"
              value={value.hex}
              aria-label="Garment colour hex value"
              onChange={(event) => onChange({ kind: 'custom', hex: normalizeHex(event.target.value) })}
            />
          </div>
          <div className="presets" role="group" aria-label="Preset garment colours">
            {PRESET_GARMENT_COLORS.map((preset) => (
              <button
                key={preset.hex}
                type="button"
                className="preset"
                title={preset.label}
                aria-label={preset.label}
                style={{ backgroundColor: preset.hex }}
                onClick={() => onChange({ kind: 'custom', hex: preset.hex })}
              />
            ))}
          </div>
        </div>
      )}
      <p className="hint muted">
        Transparency is composited here in the browser. The version file is never altered — halos,
        fringes and dark edges only appear against a real background.
      </p>
    </div>
  )
}
