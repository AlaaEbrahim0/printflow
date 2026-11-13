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
import { assertSupportedSize } from './memoryBudget'
import { buildBaseLayer, buildDraftDocument, buildRenderDocument } from './documentBuild'
import {
  addAdjustmentLayer,
  addColorKeyLayer,
  moveLayer,
  removeLayer,
  setActiveLayer,
  setLayerBlend,
  setLayerOpacity,
  setLayerVisible,
} from './layerStack'
import { LayerPanel } from './LayerPanel'
import { EMPTY_PATH, canFillPath, fillPath, undoPathPoint, type PathState } from './pathModel'
import { dragWorkPath, pressWorkPath, workPathKeyAction } from './workPath'
import { drawMaskOverlay, drawPathOverlay, drawSelectionOverlay } from './render'
import { compositeDocument } from './composite'
import type { BlendMode, EditorDocument, EditorLayer } from './document'
import {
  clearEditorDraft,
  loadEditorDraft,
  saveEditorDraft,
  type DraftSnapshot,
} from '../../lib/editorDrafts'
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

export function ManualEditor({ title, fileUrl, batchId, designId, onSave, onBack }: { title: string; fileUrl: string; batchId?: string; designId?: string; onSave: (file: File) => Promise<void>; onBack: () => void }) {
  const base = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const source = useRef<HTMLCanvasElement>(null)

  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>('marquee')
  const [mode, setMode] = useState<SelectionMode>('replace')
  const [selection, setSelection] = useState<Uint8Array | null>(null)
  const [mask, setMask] = useState<Uint8Array | null>(null)
  /**
   * The full layer stack, bottom-first, including the base raster.
   *
   * The base layer is kept here rather than rebuilt on every render because the
   * operator can hide it, fade it, or pick it as the active layer — three pieces
   * of state that have to survive a render. Its *mask* is still rebuilt from the
   * live byte mask each time, so coverage has exactly one owner.
   */
  const [stack, setStack] = useState<EditorLayer[]>([])
  const [activeLayerId, setActiveLayerId] = useState('base')
  const [path, setPath] = useState<PathState>(EMPTY_PATH)
  const [drag, setDrag] = useState<Point | null>(null)
  /** Corner grabbed by a polygon press, or null when the press was not a grab. */
  const dragVertex = useRef<number | null>(null)
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draftNotice, setDraftNotice] = useState<string | null>(null)
  const [restorePrompt, setRestorePrompt] = useState<DraftSnapshot | null>(null)
  const draftReady = Boolean(batchId && designId)
  const pendingDraft = useRef(false)

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
    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = async () => {
      const s = source.current
      if (!s) return
      // Refuse a document the editor cannot hold *before* allocating its
      // canvases: the source, base and overlay buffers are four bytes a pixel
      // each, so a 46.9 MP square source would ask for roughly 750 MB. The
      // guard lives in memoryBudget.ts and this is the only place that can
      // enforce it, because it is the only place the real size is known.
      try {
        assertSupportedSize(img.naturalWidth, img.naturalHeight)
      } catch (error) {
        setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
        setLoadError(error instanceof Error ? error.message : 'This image is too large to edit.')
        return
      }
      s.width = img.naturalWidth
      s.height = img.naturalHeight
      s.getContext('2d')?.drawImage(img, 0, 0)
      setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
      setSelection(null)
      setMask(null)
      // A fresh stack with just the artwork on it, so the layer panel has
      // something to show and to select before the operator adds anything.
      const initialStack = [buildBaseLayer({ width: img.naturalWidth, height: img.naturalHeight, mask: null, threshold: 128, sourceId: fileUrl })]
      setStack(initialStack)
      setActiveLayerId('base')
      setPath(EMPTY_PATH)
      setDrag(null)
      setHover(null)
      setAdjustments(DEFAULT_ADJUSTMENTS)
      // The first history entry has to describe the same stack the editor just
      // installed. Without it, the first Ctrl+Z restores a snapshot with no
      // layers and the panel empties out.
      setHistory(emptyHistory({
        selection: null,
        mask: null,
        adjustments: DEFAULT_ADJUSTMENTS,
        layers: initialStack,
        activeLayerId: 'base',
        label: 'Original',
      }))
      setDirty(false)
      setSaveState('idle')
      setReady(true)
      if (!draftReady || cancelled) return
      try {
        const draft = await loadEditorDraft(batchId!, designId!)
        if (cancelled) return
        if (!draft) return
        if (draft.document.width !== img.naturalWidth || draft.document.height !== img.naturalHeight) {
          // Source changed since the draft was written; a stale draft is not restorable.
          await clearEditorDraft(batchId!, designId!)
          return
        }
        setRestorePrompt(draft.snapshot)
      } catch {
        setDraftNotice('Drafts unavailable — save manually.')
      }
    }
    img.src = fileUrl
    return () => { cancelled = true }
  }, [fileUrl, batchId, designId, draftReady])

  function acceptRestore() {
    const snapshot = restorePrompt
    setRestorePrompt(null)
    if (!snapshot) return
    setSelection(snapshot.selection?.slice() ?? null)
    setMask(snapshot.mask?.slice() ?? null)
    // An older draft has no stack; keep the single-artwork one the load built.
    if (snapshot.layers?.length) setStack(snapshot.layers)
    if (snapshot.activeLayerId) setActiveLayerId(snapshot.activeLayerId)
    setAdjustments(snapshot.adjustments)
    setHistory(emptyHistory({
      selection: snapshot.selection?.slice() ?? null,
      mask: snapshot.mask?.slice() ?? null,
      adjustments: snapshot.adjustments,
      layers: snapshot.layers,
      activeLayerId: snapshot.activeLayerId,
      label: snapshot.label,
    }))
  }

  function declineRestore() {
    setRestorePrompt(null)
    if (draftReady) clearEditorDraft(batchId!, designId!).catch(() => undefined)
  }

  function writeDraft() {
    if (!draftReady || !dirty) return
    const src = source.current
    if (!src) return
    saveEditorDraft({
      batchId: batchId!, designId: designId!,
      document: buildDraftDocument(src.width, src.height, mask, threshold, fileUrl),
      snapshot: {
        selection,
        mask,
        adjustments,
        // Layers persist with the snapshot: a reload has to bring back the
        // stack the operator built, not just the artwork underneath it.
        layers: stack,
        activeLayerId,
        label: currentSnapshot(history)?.label ?? 'Original',
      },
    }).catch(() => {
      // In-memory editing state is untouched; only persistence failed.
      setDraftNotice('Draft save failed — edits are kept, but reload will lose them. Save manually.')
    })
  }

  useEffect(() => {
    if (!draftReady || !dirty) return
    pendingDraft.current = true
    const timer = window.setTimeout(() => { pendingDraft.current = false; writeDraft() }, 1200)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, mask, adjustments, stack, activeLayerId, dirty, draftReady])

  useEffect(() => {
    if (!draftReady) return
    function flush() {
      if (!dirty || !pendingDraft.current) return
      pendingDraft.current = false
      writeDraft()
    }
    const onHide = () => { if (dirty) flush() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draftReady])

  useEffect(() => {
    if (!ready) return
    const src = source.current
    const canvas = base.current
    const ants = overlay.current
    if (!src || !canvas || !ants) return
    const pixels = src.getContext('2d')?.getImageData(0, 0, src.width, src.height)
    if (pixels) {
      // The adjustment layer carries the Levels/HSL sliders into the composite.
      // Without it the panel moved only `dirty`, so every slider was decorative:
      // the preview never changed and the exported PNG never changed either.
      const document = buildRenderDocument({
        width: src.width,
        height: src.height,
        mask,
        feather: featherRadius,
        threshold,
        sourceId: fileUrl,
        adjustments,
        stack,
        activeLayerId,
      })
      const rendered = compositeDocument(document, { resolve: () => pixels })
      canvas.width = rendered.width; canvas.height = rendered.height
      canvas.getContext('2d')?.putImageData(rendered, 0, 0)
    }
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
  }, [ready, selection, mask, adjustments, path, drag, hover, tool, showMask, stack, activeLayerId, threshold, featherRadius])

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

  function commit(
    label: string,
    next: { selection?: Uint8Array | null; mask?: Uint8Array | null; stack?: EditorLayer[]; activeLayerId?: string },
  ) {
    const nextSelection = next.selection === undefined ? selection : next.selection
    const nextMask = next.mask === undefined ? mask : next.mask
    const nextStack = next.stack === undefined ? stack : next.stack
    const nextActive = next.activeLayerId === undefined ? activeLayerId : next.activeLayerId
    setDirty(true)
    setSaveState('idle')
    setSelection(nextSelection)
    setMask(nextMask)
    setStack(nextStack)
    setActiveLayerId(nextActive)
    setHistory(state =>
      commitHistory(state, {
        selection: nextSelection,
        mask: nextMask,
        adjustments,
        layers: nextStack,
        activeLayerId: nextActive,
        label,
      }),
    )
  }

  /**
   * Apply a layer-stack operation and record it as one undoable step.
   *
   * `layerStack` validates every mutation through `applyCommand`, so this helper
   * only has to assemble the current document, let the operation run, and store
   * the resulting stack. Coverage comes back out of the base layer unchanged —
   * no layer operation edits the mask — so the live `mask` is left alone.
   */
  function applyLayers(label: string, change: (document: EditorDocument) => EditorDocument) {
    const src = source.current
    if (!src) return
    // Built *without* the global Levels layer on purpose. That layer is derived
    // from the sliders and always sits on top; if it were present here, "move up"
    // on the topmost real layer would appear to do nothing while the panel order
    // and the composite order drifted apart.
    const current = buildRenderDocument({
      width: src.width,
      height: src.height,
      mask,
      feather: featherRadius,
      threshold,
      sourceId: fileUrl,
      stack,
      activeLayerId,
    })
    const next = change(current)
    if (next === current) return
    commit(label, { stack: next.layers, activeLayerId: next.activeLayerId })
  }

  /*
   * Layer handlers.
   *
   * Each one is a label plus a pure `layerStack` call, so the validation and the
   * undo entry both come from the same place as every other edit. Selecting a
   * layer is deliberately *not* committed to history on its own: it is a view
   * state, not an edit, and folding it in would make Ctrl+Z spend a step on
   * nothing but the highlight moving.
   */
  const layerHandlers = {
    onAddAdjustment: () => applyLayers('Add levels layer', doc => addAdjustmentLayer(doc, adjustments)),
    onAddColorKey: () =>
      applyLayers('Add colour key layer', doc =>
        addColorKeyLayer(doc, {
          type: 'color-key',
          // Seed from the current mask's colour pick when there is one, so the
          // new layer starts as the same key the operator just sampled.
          color: { r: 255, g: 255, b: 255 },
          tolerance: 24,
          feather: 0,
          contiguous: false,
          useAlpha: false,
          seeds: [],
        }),
      ),
    onToggleVisible: (layerId: string) =>
      applyLayers('Toggle layer visibility', doc =>
        setLayerVisible(doc, layerId, !doc.layers.find(layer => layer.id === layerId)?.visible),
      ),
    onMove: (layerId: string, direction: -1 | 1) => applyLayers('Reorder layer', doc => moveLayer(doc, layerId, direction)),
    onRemove: (layerId: string) => applyLayers('Delete layer', doc => removeLayer(doc, layerId)),
    onOpacity: (layerId: string, opacity: number) =>
      applyLayers('Layer opacity', doc => setLayerOpacity(doc, layerId, opacity)),
    onBlend: (layerId: string, blendMode: BlendMode) =>
      applyLayers('Layer blend mode', doc => setLayerBlend(doc, layerId, blendMode)),
    onSelect: (layerId: string) => {
      // Selection is a view state, not an edit, so it is not recorded in
      // history — but it still goes through `setActiveLayer` so a layer id that
      // is not in the stack is ignored rather than stored as a dangling pointer.
      const src = source.current
      if (!src) return
      const current = buildRenderDocument({
        width: src.width,
        height: src.height,
        mask,
        feather: featherRadius,
        threshold,
        sourceId: fileUrl,
        adjustments,
        stack,
        activeLayerId,
      })
      setActiveLayerId(setActiveLayer(current, layerId).activeLayerId)
    },
  }

  function restore(next: HistoryState) {
    setHistory(next)
    const snapshot = currentSnapshot(next)
    setSelection(snapshot?.selection ?? null)
    setMask(snapshot?.mask ?? null)
    setStack(snapshot?.layers ?? [])
    setActiveLayerId(snapshot?.activeLayerId ?? 'base')
    setAdjustments(snapshot?.adjustments ?? DEFAULT_ADJUSTMENTS)
    setDirty(true)
    setSaveState('idle')
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // An open work path claims Enter/Escape/Backspace. Every other key falls
      // through untouched so Ctrl+Z and friends still reach history below.
      if (tool === 'polygon' && path.points.length > 0 && !event.ctrlKey && !event.metaKey) {
        const action = workPathKeyAction(path, event.key)
        if (action === 'fill') {
          event.preventDefault()
          commitPath(path)
          return
        }
        if (action === 'cancel') {
          event.preventDefault()
          setPath(EMPTY_PATH)
          return
        }
        if (action === 'undo-point') {
          event.preventDefault()
          const next = undoPathPoint(path)
          setPath(next)
          return
        }
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, tool, path])

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
      // The pen-tool gestures (drag a corner, Alt-click to drop one, click the
      // start point to close) live in workPath so they can be reasoned about
      // without a canvas. Adding a point is only the simplest of them.
      const press = pressWorkPath(path, p, { altKey: event.altKey })
      setPath(press.path)
      if (press.completed) commitPath(press.path)
      else if (press.vertex !== null) {
        dragVertex.current = press.vertex
        setDrag(p)
      }
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
    else if (tool === 'polygon' && dragVertex.current !== null) {
      setPath(prev => dragWorkPath(prev, dragVertex.current, p))
    }
  }

  function onPointerCancel(event: React.PointerEvent) {
    if (drag) event.currentTarget.releasePointerCapture(event.pointerId)
    dragVertex.current = null
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
    if (tool === 'polygon') {
      // Releasing a corner drag ends the drag but keeps the path open, so the
      // operator can keep adding corners.
      dragVertex.current = null
      setDrag(null)
      setHover(null)
      return
    }
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

  async function renderPng(): Promise<Blob> {
    const canvas = base.current
    if (!canvas) throw new Error('Editor canvas unavailable.')
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('Could not render canvas to PNG.')
    return blob
  }

  async function exportPng() {
    const blob = await renderPng()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'manual-cleanup.png'
    document.body.appendChild(anchor)
    anchor.click()
    window.setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url) }, 0)
  }

  async function save() {
    // Disabling the button is not enough: a refused or still-loading document
    // has no pixels to render, so guard the action itself.
    if (!ready || saveState === 'saving') return
    setSaveState('saving')
    setSaveError('')
    try {
      const blob = await renderPng()
      await onSave(new File([blob], 'manual-cleanup.png', { type: 'image/png' }))
      setDirty(false)
      setSaveState('saved')
      setDraftNotice(null)
      // Clear only after the API confirmed the proposal is stored.
      if (draftReady) clearEditorDraft(batchId!, designId!).catch(() => undefined)
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
        <button className="btn primary" data-testid="manual-save" disabled={!ready || saveState === 'saving'} onClick={() => void save()}>
          {saveState === 'saving' ? 'Saving…' : 'Save as proposal'}
        </button>
      </header>
      {loadError && (
        <div className="draft-notice" data-testid="manual-load-error" role="alert">
          {loadError} Open the original in Photopea instead, or downscale it before importing.
        </div>
      )}
      {restorePrompt && (
        <div className="draft-restore" data-testid="draft-restore">
          <span>Draft found — restore it?</span>
          <button className="btn primary" data-testid="draft-restore-accept" onClick={acceptRestore}>Restore</button>
          <button className="btn" data-testid="draft-restore-decline" onClick={declineRestore}>Discard</button>
        </div>
      )}
      {draftNotice && <div className="draft-notice" data-testid="draft-notice">{draftNotice}</div>}
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
          <LayerPanel
            layers={stack}
            activeLayerId={activeLayerId}
            ready={ready}
            {...layerHandlers}
          />
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
