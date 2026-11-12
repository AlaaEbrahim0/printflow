import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Levels / Hue / Saturation panel must reach the pixels.
 *
 * It used to be decorative: each slider set `dirty` and nothing else, because
 * the document handed to `compositeDocument` never carried an adjustment layer.
 * The preview did not change, the exported PNG did not change, and the only
 * visible effect of a Levels edit was the "unsaved changes" hint. These tests
 * drive the real sliders and assert on what the compositor was asked to draw.
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

/**
 * A saturated mid-tone, so every control has something to act on: Levels has
 * headroom above the black point, and hue has a hue to rotate. A grey source
 * would make the hue slider legitimately a no-op.
 */
const SOURCE = [200, 100, 50, 255] as const

let putImageData: ReturnType<typeof vi.fn>

beforeEach(() => {
  putImageData = vi.fn()
  vi.stubGlobal('Image', TestImage)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value(this: HTMLCanvasElement) {
      return {
        canvas: this,
        putImageData,
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

function editor() {
  return render(<ManualEditor title="Test" fileUrl="/test.png" onSave={async () => {}} onBack={() => {}} />)
}

/** The pixel the compositor last handed to the canvas. */
function lastRenderedPixel(): number[] {
  const call = putImageData.mock.calls.at(-1)
  const image = call?.[0] as { data: Uint8ClampedArray } | undefined
  if (!image) throw new Error('the editor never drew the composite')
  return Array.from(image.data.slice(0, 4))
}

function slider(view: ReturnType<typeof editor>, min: string, max: string, step?: string): HTMLInputElement {
  const found = (view.getAllByRole('slider') as HTMLInputElement[]).find(
    input => input.min === min && input.max === max && (step === undefined || input.step === step),
  )
  if (!found) throw new Error(`no slider with min=${min} max=${max}${step ? ` step=${step}` : ''}`)
  return found
}

describe('editor adjustment panel', () => {
  it('darkens the render when the Levels black point is raised', async () => {
    const view = editor()
    await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
    expect(lastRenderedPixel()).toEqual([...SOURCE])

    // Black point 0 -> 128 stretches the 128-255 window over the full range, so
    // the 200 source red channel lands well below where it started.
    fireEvent.change(slider(view, '0', '255', '1'), { target: { value: '128' } })
    await waitFor(() => expect(lastRenderedPixel()[0]).toBeLessThan(SOURCE[0]))
    // An adjustment changes colour, never coverage.
    expect(lastRenderedPixel()[3]).toBe(SOURCE[3])
  })

  it('leaves the render untouched while every adjustment is at its default', async () => {
    const view = editor()
    await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
    const initial = lastRenderedPixel()
    // Nudging and returning must land back on the original pixels, because the
    // adjustment layer is only added while the adjustments are non-identity.
    const black = slider(view, '0', '255', '1')
    fireEvent.change(black, { target: { value: '128' } })
    await waitFor(() => expect(lastRenderedPixel()).not.toEqual(initial))
    fireEvent.change(black, { target: { value: '0' } })
    await waitFor(() => expect(lastRenderedPixel()).toEqual(initial))
  })

  it('shifts hue without changing coverage', async () => {
    const view = editor()
    await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
    fireEvent.change(slider(view, '-180', '180'), { target: { value: '90' } })
    await waitFor(() => expect(lastRenderedPixel()).not.toEqual([...SOURCE]))
    expect(lastRenderedPixel()[3]).toBe(SOURCE[3])
  })

  it('desaturates towards grey without changing coverage', async () => {
    const view = editor()
    await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
    fireEvent.change(slider(view, '-100', '100'), { target: { value: '-100' } })
    await waitFor(() => expect(lastRenderedPixel()).not.toEqual([...SOURCE]))
    const [r, g, b, a] = lastRenderedPixel()
    // Full desaturation leaves the three channels equal.
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(a).toBe(SOURCE[3])
  })

  it('marks the session dirty as soon as a slider moves', async () => {
    const view = editor()
    await waitFor(() => expect(view.getByTestId('manual-save')).toBeEnabled())
    expect(view.getByRole('status')).not.toHaveTextContent(/unsaved changes/)
    fireEvent.change(slider(view, '0', '255', '1'), { target: { value: '64' } })
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(/unsaved changes/))
  })
})
