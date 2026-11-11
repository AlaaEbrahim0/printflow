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
  naturalWidth = 4
  naturalHeight = 4
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

async function canvas(container: HTMLElement): Promise<HTMLCanvasElement> {
  const element = container.querySelector('canvas:not([hidden])') as HTMLCanvasElement
  await waitFor(() => expect(element.width).toBe(4))
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
