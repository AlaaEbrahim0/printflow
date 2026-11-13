/**
 * The layer list.
 *
 * A presentation component: it owns no document state, only renders the stack it
 * is given and reports what the operator asked for. Keeping the mutations in
 * `layerStack.ts` means every one of them goes through `applyCommand` and is
 * therefore validated, and it means this file can be read as pure layout.
 *
 * The list is shown top-first, because that is how every raster editor presents
 * a stack and how the operator thinks about "the layer above". The underlying
 * document stays bottom-first; `layersTopFirst` does the flip in one place.
 */
import type { BlendMode, EditorLayer } from './document'
import { canMoveLayer, canRemoveLayer, describeLayer, layersTopFirst } from './layerStack'

export interface LayerPanelProps {
  /** The base raster plus every added layer, bottom-to-top. */
  layers: EditorLayer[]
  activeLayerId: string
  onSelect: (layerId: string) => void
  onToggleVisible: (layerId: string) => void
  onMove: (layerId: string, direction: -1 | 1) => void
  onRemove: (layerId: string) => void
  onOpacity: (layerId: string, opacity: number) => void
  onBlend: (layerId: string, blendMode: BlendMode) => void
  onAddAdjustment: () => void
  onAddColorKey: () => void
  /** True once the source image is loaded. */
  ready: boolean
}

const BLEND_MODES: BlendMode[] = ['normal', 'multiply']

export function LayerPanel({
  layers,
  activeLayerId,
  onSelect,
  onToggleVisible,
  onMove,
  onRemove,
  onOpacity,
  onBlend,
  onAddAdjustment,
  onAddColorKey,
  ready,
}: LayerPanelProps) {
  // `canMoveLayer` / `canRemoveLayer` take the whole document because they check
  // against the base raster; the panel only has the stack, so it passes a
  // minimal stand-in with the same shape those helpers read.
  const document = {
    layers,
    activeLayerId,
  } as Parameters<typeof canMoveLayer>[0]

  const active = layers.find(layer => layer.id === activeLayerId) ?? layers[0]

  // Before the source image has loaded there is no artwork to list. Show the
  // heading and a placeholder rather than an empty stack, because a panel that
  // vanishes and reappears is more confusing than one that says it is waiting.
  if (!active) {
    return (
      <section className="manual-layers" aria-label="Layers" data-testid="layer-panel">
        <h3>Layers</h3>
        <p className="layer-kind">No artwork loaded</p>
      </section>
    )
  }

  return (
    <section className="manual-layers" aria-label="Layers" data-testid="layer-panel">
      <h3>Layers</h3>
      <ul className="layer-list">
        {layersTopFirst(document).map(layer => {
          const isActive = layer.id === activeLayerId
          return (
            <li
              key={layer.id}
              className={`layer-row ${isActive ? 'active' : ''}`}
              data-hidden={String(!layer.visible)}
              data-testid={`layer-row-${layer.id}`}
            >
              <button
                type="button"
                className="layer-eye"
                aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
                aria-pressed={layer.visible}
                data-testid={`layer-visible-${layer.id}`}
                onClick={() => onToggleVisible(layer.id)}
              >
                {layer.visible ? '●' : '○'}
              </button>
              <button
                type="button"
                className="layer-pick"
                aria-current={isActive}
                data-testid={`layer-select-${layer.id}`}
                onClick={() => onSelect(layer.id)}
              >
                <span className="layer-name">{layer.name}</span>
                <span className="layer-kind">{describeLayer(layer)}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <div className="layer-actions">
        <button className="tool" disabled={!ready} data-testid="layer-add-adjustment" onClick={onAddAdjustment}>
          + Levels
        </button>
        <button className="tool" disabled={!ready} data-testid="layer-add-key" onClick={onAddColorKey}>
          + Key
        </button>
        <button
          className="tool"
          disabled={!canRemoveLayer(document, active.id)}
          data-testid="layer-remove"
          onClick={() => onRemove(active.id)}
        >
          Delete
        </button>
        <button
          className="tool"
          disabled={!canMoveLayer(document, active.id, 1)}
          data-testid="layer-up"
          onClick={() => onMove(active.id, 1)}
        >
          Up
        </button>
        <button
          className="tool"
          disabled={!canMoveLayer(document, active.id, -1)}
          data-testid="layer-down"
          onClick={() => onMove(active.id, -1)}
        >
          Down
        </button>
      </div>

      <div className="layer-props">
        <label>
          Opacity {Math.round(active.opacity * 100)}%
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(active.opacity * 100)}
            data-testid="layer-opacity"
            onChange={event => onOpacity(active.id, Number(event.target.value) / 100)}
          />
        </label>
        <label>
          Blend
          <select
            value={active.blendMode}
            data-testid="layer-blend"
            // The base raster has nothing underneath to blend with, so the
            // control is disabled there rather than offering a mode that
            // validateDocument would reject.
            disabled={active.kind === 'base-raster'}
            onChange={event => onBlend(active.id, event.target.value as BlendMode)}
          >
            {BLEND_MODES.map(mode => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}
