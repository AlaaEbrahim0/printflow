import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The layer panel is the shell the rest of the complex-design work sits in.
 *
 * These tests drive the real panel against the real compositor: adding a layer
 * must change what gets drawn, hiding it must change it back, and every one of
 * those steps must be undoable. The panel is also the only place the operator
 * can reach the base layer's own visibility and opacity, which the single-layer
 * editor could not express at all.
 */

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

/** A saturated source so a Levels layer has something visible to do. */
const SOURCE = [200, 100, 50, 255] as const

/**
 * Pixels the *artwork* canvas was last given.
 *
 * The overlay canvas also receives `putImageData` (marching ants and the mask
 * tint), so recording every call would sometimes report an empty overlay buffer
 * as if it were the render. Source is hidden and created first; artwork second.
 */
let renderedPixels: number[] | null = null

beforeEach(() => {
  renderedPixels = null
  vi.stubGlobal('Image', TestImage)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      const element = this
      return {
        canvas: this,
        putImageData: (image: { data: Uint8ClampedArray }) => {
          // Identify the artwork canvas by what it *is*, not by creation order:
          // the source canvas is hidden and the overlay carries a class, so
          // anything else is the composite target.
          const isSource = element.hasAttribute('hidden')
          const isOverlay = element.classList.contains('manual-overlay')
          if (!isSource && !isOverlay) renderedPixels = Array.from(image.data.slice(0, 4))
        },
        drawImage: () => {},
        clearRect: () => {},
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        fill: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        setLineDash: () => {},
        createImageData: (width: number, height: number) => ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
        }),
        getImageData: (_x: number, _y: number, width: number, height: number) => {
          const data = new Uint8ClampedArray(width * height * 4)
          for (let i = 0; i < data.length; i += 4) data.set(SOURCE, i)
          return { width, height, data }
        },
      } as unknown as CanvasRenderingContext2D
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Mount the editor and wait until the first composite has been drawn.
 *
 * The Save button flips to enabled as soon as the image loads, while the draw
 * happens in a later effect. Reading a pixel between the two is a race that
 * passes alone and fails under a full parallel run.
 */
async function editor() {
  const view = render(<ManualEditor title="Test" fileUrl="/test.png" onSave={async () => {}} onBack={() => {}} />)
  await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
  await waitFor(() => expect(renderedPixels).not.toBeNull())
  return view
}

function lastRenderedPixel(): number[] {
  if (!renderedPixels) throw new Error('the editor never drew the composite')
  return renderedPixels
}

/** The layer rows, in the order the panel shows them (top first). */
function rowIds(): string[] {
  return Array.from(screen.getByTestId('layer-panel').querySelectorAll('[data-testid^="layer-row-"]')).map(
    row => row.getAttribute('data-testid')!.replace('layer-row-', ''),
  )
}

describe('layer panel', () => {
  it('lists the artwork as the only layer before anything is added', async () => {
    await editor()
    expect(rowIds()).toEqual(['base'])
    expect(screen.getByTestId('layer-panel')).toBeInTheDocument()
  })

  it('adds a Levels layer that visibly changes the render', async () => {
    await editor()
    const before = lastRenderedPixel()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    // The layer starts at identity, so the pixels must not change yet.
    expect(lastRenderedPixel()).toEqual(before)
  })

  it('hides a layer and shows it again without losing it', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))

    const eye = screen.getByTestId('layer-visible-adjust-1')
    fireEvent.click(eye)
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toHaveAttribute('data-hidden', 'true'))
    // Still in the stack, just not drawn.
    expect(rowIds()).toEqual(['adjust-1', 'base'])

    fireEvent.click(eye)
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toHaveAttribute('data-hidden', 'false'))
  })

  it('selects a layer and reports it as current', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))

    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('layer-select-adjust-1')).toHaveAttribute('aria-current', 'true'))
    expect(screen.getByTestId('layer-select-base')).toHaveAttribute('aria-current', 'false')
  })

  it('deletes an added layer but never the artwork', async () => {
    await editor()
    // The base layer is selected at load, and Delete must be refused there.
    expect(screen.getByTestId('layer-remove')).toBeDisabled()

    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('layer-remove')).toBeEnabled())

    fireEvent.click(screen.getByTestId('layer-remove'))
    await waitFor(() => expect(rowIds()).toEqual(['base']))
  })

  it('reorders layers and refuses to move past the ends', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    fireEvent.click(screen.getByTestId('layer-add-key'))
    await waitFor(() => expect(rowIds()).toEqual(['key-1', 'adjust-1', 'base']))

    // The top layer cannot go up.
    fireEvent.click(screen.getByTestId('layer-select-key-1'))
    await waitFor(() => expect(screen.getByTestId('layer-up')).toBeDisabled())

    fireEvent.click(screen.getByTestId('layer-down'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'key-1', 'base']))
  })

  it('records opacity on an added layer', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('layer-opacity')).toHaveValue('100'))

    fireEvent.change(screen.getByTestId('layer-opacity'), { target: { value: '40' } })
    await waitFor(() => expect(screen.getByTestId('layer-opacity')).toHaveValue('40'))
    // The stack survives the change and keeps the layer selected.
    expect(rowIds()).toEqual(['adjust-1', 'base'])
    expect(screen.getByTestId('layer-select-adjust-1')).toHaveAttribute('aria-current', 'true')
  })

  it('fades the artwork itself through the base layer opacity', async () => {
    await editor()
    // The base layer's own opacity is the one thing the single-layer editor
    // could not express at all. Half opacity over nothing leaves the pixel
    // half-covered with its colour intact, which is what source-over means.
    expect(screen.getByTestId('layer-select-base')).toHaveAttribute('aria-current', 'true')
    fireEvent.change(screen.getByTestId('layer-opacity'), { target: { value: '50' } })
    await waitFor(() => expect(lastRenderedPixel()[3]).toBeGreaterThan(100))
    await waitFor(() => expect(lastRenderedPixel()[3]).toBeLessThan(160))
    expect(lastRenderedPixel().slice(0, 3)).toEqual(Array.from(SOURCE.slice(0, 3)))
  })

  it('offers a blend mode on an added layer and refuses one on the artwork', async () => {
    await editor()
    expect(screen.getByTestId('layer-blend')).toBeDisabled()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('layer-blend')).toBeEnabled())
  })

  it('undoes a layer addition with Ctrl+Z', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(rowIds()).toEqual(['base']))
  })

  it('redoes a layer addition with Ctrl+Shift+Z', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(rowIds()).toEqual(['base']))

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
  })

  it('undoes a delete and brings the layer back', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('layer-remove')).toBeEnabled())
    fireEvent.click(screen.getByTestId('layer-remove'))
    await waitFor(() => expect(rowIds()).toEqual(['base']))

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(rowIds()).toEqual(['adjust-1', 'base']))
  })

  it('hiding the artwork clears the canvas', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-visible-base'))
    await waitFor(() => expect(lastRenderedPixel()[3]).toBe(0))
  })

  it('marks the session dirty when a layer changes', async () => {
    const view = await editor()
    expect(view.getByRole('status')).not.toHaveTextContent(/unsaved changes/)
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(/unsaved changes/))
  })

  it('labels each row so the operator knows what it is', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    fireEvent.click(screen.getByTestId('layer-add-key'))
    await waitFor(() => expect(rowIds()).toEqual(['key-1', 'adjust-1', 'base']))

    const baseRow = within(screen.getByTestId('layer-row-base'))
    expect(baseRow.getByText('Artwork')).toBeInTheDocument()
    const keyRow = within(screen.getByTestId('layer-row-key-1'))
    expect(keyRow.getByText('Colour key ±24')).toBeInTheDocument()
  })
})
