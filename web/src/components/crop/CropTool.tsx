import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import type { CropRect } from '../../api/client'
import {
  applyAspectLock,
  applyDrag,
  aspectFor,
  clampZoom,
  CROP_HANDLES,
  fullImageRect,
  gripAxes,
  GUIDE_FRACTIONS,
  HANDLE_CURSORS,
  HANDLE_LABELS,
  isFullImage,
  makeBounds,
  MAX_ZOOM,
  MIN_CROP_PX,
  MIN_ZOOM,
  moveRect,
  nudgeStep,
  NUDGE_COARSE_STEP_PX,
  NUDGE_STEP_PX,
  panView,
  rectFromInputs,
  resizeRect,
  sourceDeltaFromViewport,
  sourcePointFromViewport,
  viewportFor,
  viewportRectFromSource,
  zoomAt,
  ZOOM_STEP,
  type CropField,
  type CropFieldError,
  type CropHandle,
  type DragMode,
  type ScreenPoint,
  type ViewState,
  type ViewportFrame,
} from '../../lib/crop'
import { Chip } from '../ui/Chip'
import { NumberField } from '../ui/Field'
import './crop.css'

export interface CropToolProps {
  /** Immutable version file to crop. Never rewritten, never resampled. */
  fileUrl: string
  widthPx: number
  heightPx: number
  initialRect?: CropRect | null
  /** Width ÷ height to hold, e.g. `widthPx / heightPx`. `null` leaves it free. */
  aspectLock?: number | null
  onCancel: () => void
  onApply: (rect: CropRect) => void
}

/** A pointer gesture: a crop gesture, or a pan of the view. */
type Gesture = { mode: DragMode; rect: CropRect; anchor: ScreenPoint; view: ViewState } | { pan: ScreenPoint; view: ViewState }

const VIEWPORT_PADDING_PX = 12

function stagePoint(stage: HTMLDivElement, event: { clientX: number; clientY: number }): ScreenPoint {
  const box = stage.getBoundingClientRect()
  return { x: event.clientX - box.left, y: event.clientY - box.top }
}

function gestureAnchor(gesture: Gesture): ScreenPoint {
  return 'pan' in gesture ? gesture.pan : gesture.anchor
}

function zoomAtSafely(view: ViewState, nextZoom: number, anchor: ScreenPoint): ViewState {
  return zoomAt(view, clampZoom(nextZoom), anchor)
}

function capturePointer(stage: HTMLDivElement, pointerId: number): void {
  try {
    stage.setPointerCapture(pointerId)
  } catch {
    // Pointer capture is a nicety; jsdom and some browsers reject it.
  }
}

function releasePointer(stage: HTMLDivElement | null, pointerId: number): void {
  try {
    stage?.releasePointerCapture(pointerId)
  } catch {
    // Already released.
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function arrowDelta(key: string, step: number): ScreenPoint | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -step, y: 0 }
    case 'ArrowRight':
      return { x: step, y: 0 }
    case 'ArrowUp':
      return { x: 0, y: -step }
    case 'ArrowDown':
      return { x: 0, y: step }
    default:
      return null
  }
}

export default function CropTool({
  fileUrl,
  widthPx,
  heightPx,
  initialRect = null,
  aspectLock = null,
  onCancel,
  onApply,
}: CropToolProps): ReactElement {
  const bounds = useMemo(() => makeBounds(widthPx, heightPx), [widthPx, heightPx])
  const startingRect = useMemo<CropRect>(() => {
    const base = initialRect ? { ...initialRect } : fullImageRect(bounds)
    if (aspectLock !== null && aspectLock > 0) return applyAspectLock(base, aspectLock, 'se', bounds)
    return base
  }, [bounds, initialRect, aspectLock])

  const [rect, setRect] = useState<CropRect>(startingRect)
  const [draft, setDraft] = useState<Record<CropField, number | null>>({
    x: startingRect.x,
    y: startingRect.y,
    width: startingRect.width,
    height: startingRect.height,
  })
  const [fieldErrors, setFieldErrors] = useState<CropFieldError[]>([])
  const [lockRatio, setLockRatio] = useState<number | null>(
    aspectLock !== null && aspectLock > 0 ? aspectLock : null,
  )
  const [frame, setFrame] = useState<ViewportFrame>({ width: 0, height: 0 })
  const [view, setView] = useState<ViewState>(() => ({ zoom: 1, panX: 0, panY: 0 }))
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<Gesture | null>(null)

  /** One place that keeps the rectangle, the numeric fields and the errors in step. */
  const commit = useCallback((next: CropRect, errors: CropFieldError[] = []) => {
    setRect(next)
    setDraft({ x: next.x, y: next.y, width: next.width, height: next.height })
    setFieldErrors(errors)
  }, [])

  // The geometry never reads `lockRatio` from a handler's closure: drags started
  // before a toggle must still honour it.
  const lockRef = useRef<number | null>(lockRatio)
  useEffect(() => {
    lockRef.current = lockRatio
  }, [lockRatio])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const box = stage.getBoundingClientRect()
      setFrame({ width: box.width, height: box.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  // Fit once the viewport has a real size; before that (and in jsdom) the view
  // stays 1:1, which is why no geometry depends on it.
  useEffect(() => {
    if (frame.width <= 0 || frame.height <= 0) return
    setView(viewportFor(fullImageRect(bounds), frame, { paddingPx: VIEWPORT_PADDING_PX, maxZoom: 1 }))
  }, [bounds, frame])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      // Wheel zoom must own the gesture, otherwise the page scrolls under it.
      event.preventDefault()
      const point = stagePoint(stage, event)
      setView((current) =>
        zoomAtSafely(current, current.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), point),
      )
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [])

  const imageStyle: CSSProperties = {
    left: view.panX,
    top: view.panY,
    width: bounds.widthPx * view.zoom,
    height: bounds.heightPx * view.zoom,
  }
  const cropBox = viewportRectFromSource(rect, view)

  function beginCropGesture(event: ReactPointerEvent<Element>, mode: DragMode) {
    event.preventDefault()
    event.stopPropagation()
    const stage = stageRef.current
    if (!stage) return
    capturePointer(stage, event.pointerId)
    gestureRef.current = {
      mode,
      rect,
      anchor: stagePoint(stage, event),
      view,
    }
    setDragging(true)
  }

  function beginPan(event: ReactPointerEvent<Element>) {
    const stage = stageRef.current
    if (!stage) return
    event.preventDefault()
    capturePointer(stage, event.pointerId)
    gestureRef.current = { pan: stagePoint(stage, event), view }
    setDragging(true)
  }

  /** Dragging the image draws a fresh crop; panning needs a modifier. */
  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || event.shiftKey || event.altKey) {
      beginPan(event)
      return
    }
    const stage = stageRef.current
    if (!stage) return
    const anchor = sourcePointFromViewport(stagePoint(stage, event), view)
    beginCropGesture(event, {
      kind: 'draw',
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    })
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    const stage = stageRef.current
    if (!gesture || !stage) return
    const point = stagePoint(stage, event)
    const onScreen: ScreenPoint = { x: point.x - gestureAnchor(gesture).x, y: point.y - gestureAnchor(gesture).y }
    if ('pan' in gesture) {
      setView(panView(gesture.view, onScreen.x, onScreen.y))
      return
    }
    const delta = sourceDeltaFromViewport(onScreen, gesture.view)
    commit(
      applyDrag(gesture.rect, gesture.mode, delta, bounds, { aspectLock: lockRef.current }),
    )
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (!gestureRef.current) return
    releasePointer(stageRef.current, event.pointerId)
    gestureRef.current = null
    setDragging(false)
  }

  function onRectKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    const delta = arrowDelta(event.key, nudgeStep(event.shiftKey))
    if (!delta) return
    event.preventDefault()
    commit(moveRect(rect, delta.x, delta.y, bounds))
  }

  function onHandleKeyDown(event: KeyboardEvent<HTMLButtonElement>, handle: CropHandle) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
      return
    }
    const delta = arrowDelta(event.key, nudgeStep(event.shiftKey))
    if (!delta) return
    event.preventDefault()
    commit(resizeRect(rect, handle, delta.x, delta.y, bounds, { aspectLock: lockRef.current }))
  }

  function setField(field: CropField, value: number | null) {
    const result = rectFromInputs({ ...draft, [field]: value }, bounds, rect)
    setDraft((current) => ({ ...current, [field]: value }))
    setRect(result.rect)
    setFieldErrors(result.errors)
  }

  function toggleLock(locked: boolean) {
    if (!locked) {
      setLockRatio(null)
      return
    }
    const ratio = aspectLock !== null && aspectLock > 0 ? aspectLock : aspectFor(rect)
    setLockRatio(ratio > 0 ? ratio : null)
    commit(applyAspectLock(rect, ratio, 'se', bounds))
  }

  function stepZoom(factor: number) {
    setView((current) =>
      zoomAtSafely(current, current.zoom * factor, {
        x: (frame.width || bounds.widthPx * current.zoom) / 2,
        y: (frame.height || bounds.heightPx * current.zoom) / 2,
      }),
    )
  }

  function apply() {
    onApply({ ...rect })
  }

  const errorFor = (field: CropField): string | null =>
    fieldErrors.find((error) => error.field === field)?.message ?? null
  const keepsWholeFile = isFullImage(rect, bounds)
  const maxX = bounds.widthPx - rect.width
  const maxY = bounds.heightPx - rect.height

  return (
    <div className="crop-tool card" data-testid="crop-tool">
      <div className="crop-toolbar">
        <div className="row" role="group" aria-label="Zoom and pan">
          <button
            type="button"
            className="btn sm"
            onClick={() => stepZoom(1 / ZOOM_STEP)}
            disabled={view.zoom <= MIN_ZOOM + 1e-9}
            aria-label="Zoom out"
            data-testid="zoom-out"
          >
            −
          </button>
          <span className="mono dim" data-testid="zoom-readout">
            {Math.round(view.zoom * 100)}%
          </span>
          <button
            type="button"
            className="btn sm"
            onClick={() => stepZoom(ZOOM_STEP)}
            disabled={view.zoom >= MAX_ZOOM - 1e-9}
            aria-label="Zoom in"
            data-testid="zoom-in"
          >
            +
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() =>
              setView(viewportFor(fullImageRect(bounds), frame, { paddingPx: VIEWPORT_PADDING_PX, maxZoom: 1 }))
            }
            aria-label="Fit the whole image into the view"
            data-testid="zoom-fit"
          >
            Fit
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() =>
              setView({
                zoom: 1,
                panX: Math.round((frame.width - bounds.widthPx) / 2),
                panY: Math.round((frame.height - bounds.heightPx) / 2),
              })
            }
            aria-label="Show the image at actual size, one screen pixel per source pixel"
            data-testid="zoom-actual"
          >
            1:1
          </button>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="crop-lock row" style={{ gap: 7 }}>
            <input
              type="checkbox"
              checked={lockRatio !== null}
              onChange={(event) => toggleLock(event.target.checked)}
              data-testid="crop-aspect-lock"
            />
            <span>Lock aspect</span>
          </label>
          <span className="mono dim" data-testid="aspect-readout">
            {lockRatio === null ? 'free' : `${round2(lockRatio)} : 1`}
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => commit(fullImageRect(bounds))}
            aria-label="Reset the crop to the full image"
            data-testid="crop-reset"
          >
            Reset to full image
          </button>
        </div>
      </div>

      <div
        className="crop-viewport"
        data-testid="crop-viewport"
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={endGesture}
      >
        {/* CSS box scaling only: the bytes behind `fileUrl` stay untouched. */}
        <img
          className="crop-image"
          src={fileUrl}
          alt={`Version file ${fileUrl} at ${bounds.widthPx} by ${bounds.heightPx} source pixels`}
          data-testid="crop-image"
          data-image-src={fileUrl}
          style={imageStyle}
          draggable={false}
        />

        <div
          className="crop-rect"
          data-testid="crop-rect"
          role="group"
          tabIndex={0}
          aria-label={`Crop region x ${rect.x}, y ${rect.y}, ${rect.width} by ${rect.height} source pixels. Arrow keys move it, Shift for ${NUDGE_COARSE_STEP_PX} at a time.`}
          style={{
            left: cropBox.left,
            top: cropBox.top,
            width: Math.max(cropBox.width, 1),
            height: Math.max(cropBox.height, 1),
          }}
          onPointerDown={(event) => beginCropGesture(event, { kind: 'move' })}
          onKeyDown={onRectKeyDown}
        >
          {dragging ? (
            <div className="crop-guides" data-testid="crop-guides" aria-hidden="true">
              {GUIDE_FRACTIONS.map((fraction) => (
                <span key={`v${fraction}`} className="crop-guide vertical" style={{ left: `${fraction * 100}%` }} />
              ))}
              {GUIDE_FRACTIONS.map((fraction) => (
                <span key={`h${fraction}`} className="crop-guide horizontal" style={{ top: `${fraction * 100}%` }} />
              ))}
            </div>
          ) : null}

          {CROP_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className="crop-handle"
              data-testid={`crop-handle-${handle}`}
              data-handle={handle}
              aria-label={`Resize from the ${HANDLE_LABELS[handle]}. Arrow keys adjust, Shift for ${NUDGE_COARSE_STEP_PX} px at a time.`}
              style={handleStyle(handle)}
              onPointerDown={(event) => beginCropGesture(event, { kind: 'resize', handle })}
              onKeyDown={(event) => onHandleKeyDown(event, handle)}
            />
          ))}
        </div>
      </div>

      <p className="crop-hint" id="crop-tool-help">
        Drag on the image to draw a crop, drag the box to move it, drag a handle to resize it. Hold Shift and drag
        the background to pan; use the mouse wheel or ± to zoom. Arrow keys nudge {NUDGE_STEP_PX} px, Shift for{' '}
        {NUDGE_COARSE_STEP_PX} px. Zooming never changes the pixels — only the crop rectangle below is sent for
        approval.
      </p>

      <div className="field set">
        <NumberField
          label="X (px)"
          value={draft.x}
          onValueChange={(value) => setField('x', value)}
          min={0}
          max={maxX}
          step={1}
          inputMode="numeric"
          error={errorFor('x')}
          hint={`0 – ${maxX}`}
        />
        <NumberField
          label="Y (px)"
          value={draft.y}
          onValueChange={(value) => setField('y', value)}
          min={0}
          max={maxY}
          step={1}
          inputMode="numeric"
          error={errorFor('y')}
          hint={`0 – ${maxY}`}
        />
        <NumberField
          label="Width (px)"
          value={draft.width}
          onValueChange={(value) => setField('width', value)}
          min={MIN_CROP_PX}
          max={bounds.widthPx}
          step={1}
          inputMode="numeric"
          error={errorFor('width')}
          hint={`1 – ${bounds.widthPx}`}
        />
        <NumberField
          label="Height (px)"
          value={draft.height}
          onValueChange={(value) => setField('height', value)}
          min={MIN_CROP_PX}
          max={bounds.heightPx}
          step={1}
          inputMode="numeric"
          error={errorFor('height')}
          hint={`1 – ${bounds.heightPx}`}
        />
      </div>

      <div className="crop-footer row" style={{ gap: 10, justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Chip tone={keepsWholeFile ? 'info' : 'accent'}>
            <span data-testid="crop-size">{`${rect.width} × ${rect.height} px`}</span>
          </Chip>
          <Chip tone="neutral">{`origin ${rect.x}, ${rect.y}`}</Chip>
          <Chip tone="neutral">{`aspect ${round2(aspectFor(rect))} : 1`}</Chip>
          {keepsWholeFile ? <Chip tone="warn">full image</Chip> : null}
        </div>
        <p className="crop-status" role="status" aria-live="polite" data-testid="crop-status">
          {fieldErrors.length > 0 ? fieldErrors[0]!.message : `${rect.width} × ${rect.height} at ${rect.x}, ${rect.y}`}
        </p>
        <div className="btn-group">
          <button type="button" className="btn ghost" onClick={onCancel} data-testid="crop-cancel">
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={apply} data-testid="crop-apply">
            Apply crop
          </button>
        </div>
      </div>
    </div>
  )
}

function handleStyle(handle: CropHandle): CSSProperties {
  const axes = gripAxes(handle)
  return {
    left: axes.leftGrip ? 0 : axes.corner ? '100%' : '50%',
    top: axes.topGrip ? 0 : axes.corner ? '100%' : '50%',
    right: !axes.leftGrip && !axes.corner ? undefined : undefined,
    transform: `translate(${axes.leftGrip ? '-50%' : axes.corner ? '-50%' : '-50%'}, ${axes.topGrip ? '-50%' : '-50%'})`,
    cursor: HANDLE_CURSORS[handle],
  }
}
