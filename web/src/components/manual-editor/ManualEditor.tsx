import { useEffect, useRef, useState } from 'react'
import { toDisplayMessage } from '../../api/problem'
import './manual-editor.css'
import { DEFAULT_ADJUSTMENTS, type Adjustments } from './adjustments'
import { colorRangeSelect, sampleColor } from './colorRange'
import {
  canRedo,
  canUndo,
  commitHistory,
  currentSnapshot,
  emptyHistory,
  redoHistory,
  redoLabel,
  undoHistory,
  undoLabel,
  type HistoryState,
} from './history'
import { contractMask, featherMask, growMask, maskCoverage, thresholdMask } from './maskOps'
import { EMPTY_PATH, addPathPoint, canFillPath, fillPath, type PathState } from './pathModel'
import { drawBase, drawMaskOverlay, drawPathOverlay, drawSelectionOverlay } from './render'
import {
  combineSelection,
  invertSelection,
  magicWandSelect,
  selectionCount,
  type SelectionMode,
} from './selectionModes'
import { dragRect, shapeContains, toPixel, type Point } from './selectionGeometry'

type Tool = 'marquee' | 'ellipse' | 'lasso' | 'polygon' | 'wand' | 'color-range'

const TOOLS: Tool[] = ['marquee', 'ellipse', 'lasso', 'polygon', 'wand', 'color-range']
const MODES: SelectionMode[] = ['replace', 'add', 'subtract', 'intersect']

export function ManualEditor({ title, fileUrl, onSave, onBack }: { title: string; fileUrl: string; onSave: (file: File) => Promise<void>; onBack: () => void }) {
  const base = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const source = useRef<HTMLCanvasElement>(null)

  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>('marquee')
  const [mode, setMode] = useState<SelectionMode>('replace')
  const [selection, setSelection] = useState<Uint8Array | null>(null)
  const [mask, setMask] = useState<Uint8Array | null>(null)
  const [path, setPath] = useState<PathState>(EMPTY_PATH)
  const [drag, setDrag] = useState<Point | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [history, setHistory] = useState<HistoryState>(() => emptyHistory())
  const [zoom, setZoom] = useState(1)
  const [tolerance, setTolerance] = useState(32)
  const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS)
  const [showMask, setShowMask] = useState(true)
  const [growRadius, setGrowRadius] = useState(4)
  const [featherRadius, setFeatherRadius] = useState(3)
  const [threshold, setThreshold] = useState(128)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function back() {
    if (dirty && !window.confirm('Discard unsaved edits? The design will not be changed.')) return
    onBack()
  }

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const s = source.current
      if (!s) return
      s.width = img.naturalWidth
      s.height = img.naturalHeight
      s.getContext('2d')?.drawImage(img, 0, 0)
      setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
      setSelection(null)
      setMask(null)
      setPath(EMPTY_PATH)
      setDrag(null)
      setHover(null)
      setAdjustments(DEFAULT_ADJUSTMENTS)
      setHistory(emptyHistory({ selection: null, mask: null, adjustments: DEFAULT_ADJUSTMENTS, label: 'Original' }))
      setDirty(false)
      setSaveState('idle')
      setReady(true)
    }
    img.src = fileUrl
  }, [fileUrl])

  useEffect(() => {
    if (!ready) return
    const src = source.current
    const canvas = base.current
    const ants = overlay.current
    if (!src || !canvas || !ants) return
    drawBase(canvas, src, adjustments, mask)
    const width = src.width
    const height = src.height
    if (drag && hover && (tool === 'marquee' || tool === 'ellipse')) {
      const rect = dragRect(drag, hover, width, height)
      drawPathOverlay(
        ants,
        [
          { x: rect.x, y: rect.y },
          { x: rect.x + rect.width, y: rect.y },
          { x: rect.x + rect.width, y: rect.y + rect.height },
          { x: rect.x, y: rect.y + rect.height },
        ],
        width,
        height,
        { closed: true, dashed: true },
      )
      return
    }
    if (path.points.length > 0) {
      drawPathOverlay(ants, path.points, width, height, { closed: path.closed, dashed: !path.closed })
      return
    }
    if (showMask && mask) {
      drawMaskOverlay(ants, mask, width, height, { show: true })
      return
    }
    drawSelectionOverlay(ants, selection, width, height)
  }, [ready, selection, mask, adjustments, path, drag, hover, tool, showMask])

  function point(event: React.PointerEvent): Point {
    const canvas = base.current!
    const rect = canvas.getBoundingClientRect()
    return toPixel(
      {
        x: ((event.clientX - rect.left) * canvas.width) / Math.max(1, rect.width),
        y: ((event.clientY - rect.top) * canvas.height) / Math.max(1, rect.height),
      },
      canvas.width,
      canvas.height,
    )
  }

  function commit(label: string, next: { selection?: Uint8Array | null; mask?: Uint8Array | null }) {
    const nextSelection = next.selection === undefined ? selection : next.selection
    const nextMask = next.mask === undefined ? mask : next.mask
    setDirty(true)
    setSaveState('idle')
    setSelection(nextSelection)
    setMask(nextMask)
    setHistory(state => commitHistory(state, { selection: nextSelection, mask: nextMask, adjustments, label }))
  }

  function restore(next: HistoryState) {
    setHistory(next)
    const snapshot = currentSnapshot(next)
    setSelection(snapshot?.selection ?? null)
    setMask(snapshot?.mask ?? null)
    setAdjustments(snapshot?.adjustments ?? DEFAULT_ADJUSTMENTS)
    setDirty(true)
    setSaveState('idle')
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        restore(event.shiftKey ? redoHistory(history) : undoHistory(history))
      } else if (key === 'y') {
        event.preventDefault()
        restore(redoHistory(history))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [history])

  function imageData(): ImageData | null {
    const src = source.current
    if (!src) return null
    return src.getContext('2d')?.getImageData(0, 0, src.width, src.height) ?? null
  }

  function onPointerDown(event: React.PointerEvent) {
    if (!ready) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const p = point(event)
    if (tool === 'wand' || tool === 'color-range') {
      const image = imageData()
      const src = source.current
      if (!image || !src) return
      if (tool === 'wand') {
        const next = magicWandSelect(image.data, src.width, src.height, p, { tolerance, contiguous: true })
        if (next) commit('Magic wand', { selection: combineSelection(selection, next, mode) })
      } else {
        const target = sampleColor(image.data, src.width, src.height, p)
        if (!target) return
        const next = colorRangeSelect(image.data, src.width, src.height, target, { fuzziness: tolerance, metric: 'hsl' })
        commit('Color range', { selection: combineSelection(selection, next, mode) })
      }
      return
    }
    if (tool === 'lasso') {
      setPath({ points: [p], closed: false })
      setDrag(p)
      setHover(p)
      return
    }
    if (tool === 'polygon') {
      const next = addPathPoint(path, p)
      setPath(next)
      if (next.closed) commitPath(next)
      return
    }
    setDrag(p)
    setHover(p)
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!drag) return
    const p = point(event)
    setHover(p)
    if (tool === 'lasso') setPath(prev => ({ ...prev, points: [...prev.points, p] }))
  }

  function onPointerCancel(event: React.PointerEvent) {
    if (drag) event.currentTarget.releasePointerCapture(event.pointerId)
    setDrag(null)
    setHover(null)
    setPath(EMPTY_PATH)
  }

  function onPointerUp(event: React.PointerEvent) {
    if (!drag) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    const end = point(event)
    const src = source.current
    if (!src) return
    if (tool === 'lasso') {
      setDrag(null)
      setHover(null)
      const last = path.points[path.points.length - 1]
      const points = last && last.x === end.x && last.y === end.y ? path.points : [...path.points, end]
      setPath(EMPTY_PATH)
      if (points.length >= 3) {
        commit('Lasso', {
          selection: combineSelection(selection, fillPath(new Uint8Array(src.width * src.height), src.width, src.height, { points, closed: true }), mode),
        })
      }
      return
    }
    const rect = dragRect(drag, end, src.width, src.height)
    const next = new Uint8Array(src.width * src.height)
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        if (shapeContains(rect, tool === 'ellipse' ? 'ellipse' : 'marquee', x, y)) next[y * src.width + x] = 255
      }
    }
    setDrag(null)
    setHover(null)
    commit(tool === 'ellipse' ? 'Ellipse' : 'Marquee', {
      selection: combineSelection(selection, next, mode),
    })
  }

  function commitPath(next: PathState) {
    const src = source.current
    if (!src || !canFillPath(next)) return
    const filled = fillPath(new Uint8Array(src.width * src.height), src.width, src.height, next)
    setPath(EMPTY_PATH)
    commit('Polygon', { selection: combineSelection(selection, filled, mode) })
  }

  function applyMaskOp(label: string, operation: (target: Uint8Array) => Uint8Array) {
    const src = source.current
    const target = mask ?? selection
    if (!src || !target) return
    const next = operation(target)
    if (mask) commit(label, { mask: next })
    else commit(label, { selection: next })
  }

  function exportPng() {
    const canvas = base.current
    if (!canvas) return
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'manual-cleanup.png'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(() => {
        anchor.remove()
        URL.revokeObjectURL(url)
      }, 0)
    }, 'image/png')
  }

  async function save() {
    const canvas = base.current
    if (!canvas || saveState === 'saving') return
    setSaveState('saving')
    setSaveError('')
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not render the canvas to PNG.')
      await onSave(new File([blob], 'manual-cleanup.png', { type: 'image/png' }))
      setDirty(false)
      setSaveState('saved')
    } catch (error) {
      setSaveState('error')
      setSaveError(toDisplayMessage(error))
    }
  }

  const maskTarget = mask ?? selection
  const size = dimensions
  const busy = !ready || !maskTarget

  return (
    <div className="manual-editor">
      <header className="manual-top">
        <button className="btn" onClick={back} data-testid="manual-back">
          ← Back
        </button>
        <strong className="manual-title" title={title}>
          {title}
        </strong>
        <span className="manual-top-spacer" />
        <button className="btn" data-testid="manual-undo" disabled={!canUndo(history)} title={undoLabel(history) ?? undefined} onClick={() => restore(undoHistory(history))}>
          Undo
        </button>
        <button className="btn" data-testid="manual-redo" disabled={!canRedo(history)} title={redoLabel(history) ?? undefined} onClick={() => restore(redoHistory(history))}>
          Redo
        </button>
        <button className="btn" onClick={exportPng}>
          Export PNG
        </button>
        <button className="btn primary" data-testid="manual-save" disabled={saveState === 'saving'} onClick={() => void save()}>
          {saveState === 'saving' ? 'Saving…' : 'Save as proposal'}
        </button>
      </header>
      <main className="manual-body">
        <aside className="manual-tools">
          {TOOLS.map(t => (
            <button className={`tool ${tool === t ? 'active' : ''}`} key={t} onClick={() => setTool(t)}>
              {t}
            </button>
          ))}
          <div className="mode-buttons">
            {MODES.map(m => (
              <button className={`tool ${mode === m ? 'active' : ''}`} key={m} onClick={() => setMode(m)}>
                {m}
              </button>
            ))}
          </div>
          <button className="tool" disabled={!ready} onClick={() => commit('Deselect', { selection: null })}>
            Deselect
          </button>
          <button
            className="tool"
            disabled={!ready}
            onClick={() => {
              const src = source.current
              if (!src) return
              const all = new Uint8Array(src.width * src.height)
              all.fill(255)
              commit('Select all', { selection: all })
            }}
          >
            Select all
          </button>
          <button className="tool" disabled={!selection} onClick={() => selection && commit('Invert selection', { selection: invertSelection(selection) })}>
            Invert
          </button>
          <button className="tool" disabled={!selection} data-testid="selection-to-mask" onClick={() => selection && commit('Selection → mask', { mask: selection })}>
            Selection → mask
          </button>
        </aside>
        <section className="manual-stage">
          <div className="manual-canvas-wrap" style={{ transform: `scale(${zoom})` }}>
            <canvas ref={source} hidden />
            <canvas ref={base} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onPointerLeave={event => {
                if (drag) onPointerUp(event)
              }} />
            <canvas ref={overlay} className="manual-overlay" aria-hidden />
          </div>
        </section>
        <aside className="manual-panel">
          <label>
            Zoom <input type="range" min="0.25" max="2" step=".05" value={zoom} onChange={e => setZoom(+e.target.value)} />
          </label>
          {(tool === 'wand' || tool === 'color-range') && (
            <label>
              Tolerance <input type="range" min="0" max="100" value={tolerance} onChange={e => setTolerance(+e.target.value)} />
            </label>
          )}
          {tool === 'polygon' && (
            <p>
              {path.points.length} corner{path.points.length === 1 ? '' : 's'} ·{' '}
              <button className="tool" disabled={!canFillPath(path)} onClick={() => commitPath(path)}>
                Fill path
              </button>
            </p>
          )}
          <h3>Layer mask</h3>
          <p data-testid="mask-status">
            {mask ? `Enabled · keeps ${Math.round(maskCoverage(mask) * 100)}%` : maskTarget ? 'From selection' : 'No mask'}
          </p>
          <label className="manual-toggle">
            <input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} /> Show mask overlay
          </label>
          <label>
            Grow / contract px{' '}
            <input type="range" min="0" max="100" value={growRadius} onChange={e => setGrowRadius(+e.target.value)} />
          </label>
          <div className="mode-buttons">
            <button className="tool" data-testid="mask-grow" disabled={busy} onClick={() => applyMaskOp('Grow mask', target => growMask(target, size, growRadius))}>
              Grow
            </button>
            <button className="tool" data-testid="mask-contract" disabled={busy} onClick={() => applyMaskOp('Contract mask', target => contractMask(target, size, growRadius))}>
              Contract
            </button>
          </div>
          <label>
            Feather px <input type="range" min="0" max="100" value={featherRadius} onChange={e => setFeatherRadius(+e.target.value)} />
          </label>
          <button className="tool" data-testid="mask-feather" disabled={busy} onClick={() => applyMaskOp('Feather mask', target => featherMask(target, size, featherRadius))}>
            Feather
          </button>
          <label>
            Threshold <input type="range" min="0" max="255" value={threshold} onChange={e => setThreshold(+e.target.value)} />
          </label>
          <button className="tool" data-testid="mask-threshold" disabled={busy} onClick={() => applyMaskOp('Threshold mask', target => thresholdMask(target, threshold))}>
            Threshold
          </button>
          <button className="tool" disabled={!mask} onClick={() => commit('Clear mask', { mask: null })}>
            Clear mask
          </button>
          <h3>Levels</h3>
          {(['black', 'gamma', 'white'] as const).map(k => (
            <label key={k}>
              {k}
              <input
                type="range"
                min={k === 'gamma' ? 0.2 : 0}
                max={k === 'gamma' ? 3 : 255}
                step={k === 'gamma' ? 0.05 : 1}
                value={adjustments.levels[k]}
                onChange={e => { setDirty(true); setSaveState('idle'); setAdjustments({ ...adjustments, levels: { ...adjustments.levels, [k]: +e.target.value } }) }}
              />
            </label>
          ))}
          <h3>Hue / saturation</h3>
          <label>
            Hue <input type="range" min="-180" max="180" value={adjustments.hue} onChange={e => { setDirty(true); setSaveState('idle'); setAdjustments({ ...adjustments, hue: +e.target.value }) }} />
          </label>
          <label>
            Saturation{' '}
            <input type="range" min="-100" max="100" value={adjustments.saturation} onChange={e => { setDirty(true); setSaveState('idle'); setAdjustments({ ...adjustments, saturation: +e.target.value }) }} />
          </label>
          <label>
            Lightness{' '}
            <input type="range" min="-100" max="100" value={adjustments.lightness} onChange={e => { setDirty(true); setSaveState('idle'); setAdjustments({ ...adjustments, lightness: +e.target.value }) }} />
          </label>
        </aside>
      </main>
      <footer className="manual-status" role="status" aria-live="polite">
        {dimensions.width} × {dimensions.height} · {Math.round(zoom * 100)}% · {selectionCount(selection)} selected ·{' '}
        {history.cursor + 1}/{history.entries.length} history
        {dirty && saveState === 'idle' && ' · unsaved changes'}
        {saveState === 'saving' && ' · saving proposal…'}
        {saveState === 'saved' && ' · saved as a new proposal — review it on the design page'}
        {saveError && <span className="manual-save-error"> · {saveError}</span>}
      </footer>
    </div>
  )
}
