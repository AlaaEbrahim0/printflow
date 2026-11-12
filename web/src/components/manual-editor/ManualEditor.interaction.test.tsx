import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PathState } from './pathModel'

let filledPath: PathState | null = null

vi.mock('./pathModel', async importOriginal => {
  const actual = await importOriginal<typeof import('./pathModel')>()
  return {
    ...actual,
    fillPath: vi.fn((src: Uint8Array, width: number, height: number, path: PathState) => {
      filledPath = path
      return actual.fillPath(src, width, height, path)
    }),
  }
})

class TestImage {
  static naturalWidth = 4
  static naturalHeight = 4
  naturalWidth = TestImage.naturalWidth
  naturalHeight = TestImage.naturalHeight
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

const ManualEditor = (await import('./ManualEditor')).ManualEditor

beforeEach(() => {
  vi.stubGlobal('Image', TestImage)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
  HTMLCanvasElement.prototype.toBlob = (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  filledPath = null
})

function editor() {
  return render(<ManualEditor title="Test" fileUrl="/test.png" onSave={async () => {}} onBack={() => {}} />)
}

async function canvas(container: HTMLElement, size = 4): Promise<HTMLCanvasElement> {
  const element = container.querySelector('canvas:not([hidden])') as HTMLCanvasElement
  await waitFor(() => expect(element.width).toBe(size))
  return element
}

describe('manual editor pointer lifecycle', () => {
  it('captures pointer on selection start', async () => {
    const view = editor()
    const target = await canvas(view.container)
    fireEvent.pointerDown(target, { pointerId: 7, clientX: 0, clientY: 0 })
    expect(target.setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('clears an interrupted lasso on pointercancel', async () => {
    const view = editor()
    const target = await canvas(view.container)
    fireEvent.click(view.getByRole('button', { name: 'lasso' }))
    fireEvent.pointerDown(target, { pointerId: 8, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(target, { pointerId: 8, clientX: 3, clientY: 0 })
    fireEvent.pointerCancel(target, { pointerId: 8 })
    fireEvent.pointerUp(target, { pointerId: 8, clientX: 3, clientY: 3 })
    expect(view.getByRole('status')).toHaveTextContent('0 selected')
  })

  it('commits a drag when pointer leaves the canvas', async () => {
    const view = editor()
    const target = await canvas(view.container)
    fireEvent.pointerDown(target, { pointerId: 9, clientX: 0, clientY: 0 })
    fireEvent.pointerLeave(target, { pointerId: 9, clientX: 3, clientY: 3 })
    expect(view.getByRole('status')).not.toHaveTextContent('0 selected')
    expect(target.releasePointerCapture).toHaveBeenCalledWith(9)
  })

  it('does not append lasso endpoint twice', async () => {
    const view = editor()
    const target = await canvas(view.container)
    fireEvent.click(view.getByRole('button', { name: 'lasso' }))
    fireEvent.pointerDown(target, { pointerId: 10, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(target, { pointerId: 10, clientX: 3, clientY: 0 })
    fireEvent.pointerMove(target, { pointerId: 10, clientX: 3, clientY: 3 })
    fireEvent.pointerUp(target, { pointerId: 10, clientX: 3, clientY: 3 })
    expect(filledPath?.points).toHaveLength(3)
    expect(filledPath?.points.at(-1)).toEqual({ x: 3, y: 3 })
  })
})

describe('polygon pen gestures', () => {
  /**
   * jsdom reports a zero-sized canvas rect, which collapses every pointer
   * position onto pixel (0,0) — fine for "something happened" assertions but
   * useless for a pen tool, where the whole point is that corners are at
   * different places. Give the canvas a 1:1 rect so clientX/clientY map
   * straight through to pixel coordinates.
   *
   * The canvas is 40 px square rather than 4 px: `hitPathVertex` treats a press
   * within 8 px of an existing corner as grabbing that corner, so on a 4 px
   * raster every press would grab corner 0 and no polygon could ever be built.
   */
  async function polygonEditor() {
    TestImage.naturalWidth = 40
    TestImage.naturalHeight = 40
    const view = editor()
    const target = await canvas(view.container, 40)
    target.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 40, bottom: 40, width: 40, height: 40, toJSON: () => ({}) }) as DOMRect
    fireEvent.click(view.getByRole('button', { name: 'polygon' }))
    return { view, target }
  }

  it('closes and fills the path when the first corner is clicked again', async () => {
    const { view, target } = await polygonEditor()
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 3, clientX: 30, clientY: 30 })
    fireEvent.pointerUp(target, { pointerId: 3, clientX: 30, clientY: 30 })
    // Clicking the start corner completes the triangle.
    fireEvent.pointerDown(target, { pointerId: 4, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 4, clientX: 0, clientY: 0 })
    expect(filledPath).not.toBeNull()
    expect(filledPath!.points).toHaveLength(3)
    expect(view.getByRole('status')).not.toHaveTextContent('0 selected')
  })

  it('fills on Enter and cancels on Escape', async () => {
    const { view, target } = await polygonEditor()
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 30, clientY: 0 })
    // Two corners cannot enclose anything, so Enter is ignored rather than
    // filling a degenerate path.
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(filledPath).toBeNull()

    fireEvent.pointerDown(target, { pointerId: 3, clientX: 30, clientY: 30 })
    fireEvent.pointerUp(target, { pointerId: 3, clientX: 30, clientY: 30 })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(filledPath).not.toBeNull()

    // Escape drops an open path without committing anything: the selection
    // stays whatever the earlier Enter produced.
    filledPath = null
    const before = view.getByRole('status').textContent
    fireEvent.pointerDown(target, { pointerId: 4, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 4, clientX: 0, clientY: 0 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(filledPath).toBeNull()
    expect(view.getByRole('status').textContent).toBe(before)
  })

  it('drops the last corner on Backspace', async () => {
    const { target } = await polygonEditor()
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.keyDown(window, { key: 'Backspace' })
    fireEvent.keyDown(window, { key: 'Enter' })
    // One corner left: still not fillable.
    expect(filledPath).toBeNull()
  })

  it('drags a corner without closing the path', async () => {
    const { view, target } = await polygonEditor()
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 2, clientX: 30, clientY: 0 })
    fireEvent.pointerDown(target, { pointerId: 3, clientX: 30, clientY: 30 })
    fireEvent.pointerUp(target, { pointerId: 3, clientX: 30, clientY: 30 })

    // Grab the *second* corner and move it. The first corner is the close
    // target, so pressing it would finish the path; any other corner drags.
    fireEvent.pointerDown(target, { pointerId: 4, clientX: 30, clientY: 0 })
    fireEvent.pointerMove(target, { pointerId: 4, clientX: 35, clientY: 5 })
    fireEvent.pointerUp(target, { pointerId: 4, clientX: 35, clientY: 5 })
    expect(filledPath).toBeNull()
    expect(view.getByRole('status')).toHaveTextContent('0 selected')

    // The path is still open, so clicking the start corner closes it.
    fireEvent.pointerDown(target, { pointerId: 5, clientX: 0, clientY: 0 })
    fireEvent.pointerUp(target, { pointerId: 5, clientX: 0, clientY: 0 })
    expect(filledPath).not.toBeNull()
  })
})
