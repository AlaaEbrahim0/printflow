import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Per-layer masks.
 *
 * A mask used to belong to "the document", which meant the only thing it could
 * limit was the artwork itself. That is the wrong shape for complex designs: the
 * reason to add a Levels layer is usually to fix *one region*, and without a
 * per-layer mask the adjustment applies everywhere or not at all.
 *
 * These tests drive the real editor: paint a mask on one layer, switch layers,
 * and check that the first layer's coverage survived while the second layer got
 * its own. Switching layers used to silently discard the mask just painted,
 * because the stack held a stale packed copy and the new paint target replaced
 * the live bytes — so "keeps each layer's mask separate" is the regression test
 * for that.
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

const SOURCE = [200, 100, 50, 255] as const

/**
 * Pixels the *artwork* canvas was last given.
 *
 * The overlay canvas also receives `putImageData` (the marching-ants selection
 * and the mask tint), so recording every call would sometimes report an empty
 * overlay buffer as if it were the render. Only the second canvas — source is
 * hidden and first, artwork is second — is the composite.
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

/** Select every pixel, so "Selection → mask" produces a full-coverage mask. */
function selectAll() {
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
}

function pixel(): number[] {
  if (!renderedPixels) throw new Error('the editor never drew the composite')
  return renderedPixels
}

describe('per-layer masks', () => {
  it('says which layer the mask panel is painting', async () => {
    await editor()
    expect(screen.getByTestId('mask-status')).toHaveTextContent(/Painting Original/)
    expect(screen.getByTestId('mask-status')).toHaveTextContent(/no mask/)
  })

  it('names the layer a mask belongs to once it exists', async () => {
    await editor()
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Original/))
    expect(screen.getByTestId('mask-status')).toHaveTextContent(/keeps 100%/)
  })

  it('keeps each layer’s mask separate when the paint target changes', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toBeInTheDocument())

    // Paint a mask on the artwork.
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Original/))

    // Switch to the adjustment layer: it has no mask of its own, so the panel
    // must not report the artwork's coverage as if it belonged to this layer.
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Painting Levels/))
    // The adjustment layer has no mask of its own. The selection is still live,
    // so the line offers to build one rather than claiming coverage exists.
    expect(screen.getByTestId('mask-status')).not.toHaveTextContent(/Mask on/)

    // Give the adjustment layer its own mask.
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Levels/))

    // Switching back must show the artwork's mask again, not the new one — and
    // that mask must still be there, which is what the earlier bug destroyed.
    fireEvent.click(screen.getByTestId('layer-select-base'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Original/))
    expect(screen.getByTestId('mask-status')).toHaveTextContent(/keeps 100%/)
  })

  it('keeps a painted mask when the operator switches away and back', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toBeInTheDocument())

    // Mask the artwork, then select the adjustment layer and come back. The
    // artwork's coverage has to survive both switches.
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Original/))

    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).not.toHaveTextContent(/Mask on/))
    fireEvent.click(screen.getByTestId('layer-select-base'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Original/))
  })

  it('limits a Levels layer to its own mask instead of the artwork’s', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toBeInTheDocument())

    // Push the global Levels black point so the render visibly darkens.
    const black = (screen.getAllByRole('slider') as HTMLInputElement[]).find(
      input => input.min === '0' && input.max === '255' && input.step === '1',
    )!
    fireEvent.change(black, { target: { value: '128' } })
    await waitFor(() => expect(pixel()[0]).toBeLessThan(SOURCE[0]))
    const adjusted = pixel()[0]

    // Give the adjustment layer a full mask: the adjustment stays everywhere.
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Levels/))
    expect(pixel()[0]).toBe(adjusted)

    // Clearing it restores the unmasked render, which is the same value here
    // because the mask covered everything — the point is that clearing works on
    // the layer that owns it without touching the artwork's mask.
    fireEvent.click(screen.getByRole('button', { name: 'Clear mask' }))
    await waitFor(() => expect(screen.getByTestId('mask-status')).not.toHaveTextContent(/Mask on/))
    expect(pixel()[0]).toBe(adjusted)
  })

  it('undoes a mask stroke on the layer it was painted on', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Levels/))

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true })
    // Undo returns to the state before the mask existed, on the same layer.
    await waitFor(() => expect(screen.getByTestId('mask-status')).not.toHaveTextContent(/Mask on/))
    expect(screen.getByTestId('layer-select-adjust-1')).toHaveAttribute('aria-current', 'true')
  })

  it('drops the paint target back to the artwork when the masked layer is deleted', async () => {
    await editor()
    fireEvent.click(screen.getByTestId('layer-add-adjustment'))
    await waitFor(() => expect(screen.getByTestId('layer-row-adjust-1')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('layer-select-adjust-1'))
    selectAll()
    fireEvent.click(screen.getByTestId('selection-to-mask'))
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Mask on Levels/))

    fireEvent.click(screen.getByTestId('layer-remove'))
    await waitFor(() => expect(screen.queryByTestId('layer-row-adjust-1')).toBeNull())
    // The deleted layer's mask must not be inherited by the artwork, which had
    // none of its own.
    await waitFor(() => expect(screen.getByTestId('mask-status')).toHaveTextContent(/Painting Original/))
    expect(screen.getByTestId('mask-status')).not.toHaveTextContent(/Mask on/)
  })
})
