import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The memory guard is the one place the editor can refuse work outright, so it
 * gets its own file: it must refuse *before* allocating the source, base and
 * overlay canvases, and it must say why rather than rendering a blank stage.
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

beforeEach(() => {
  TestImage.naturalWidth = 4
  TestImage.naturalHeight = 4
  vi.stubGlobal('Image', TestImage)
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn()
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function editor() {
  return render(
    <ManualEditor title="Test" fileUrl="/test.png" onSave={async () => {}} onBack={() => {}} />,
  )
}

describe('editor size guard', () => {
  it('opens an ordinary image', async () => {
    editor()
    await waitFor(() => expect(screen.queryByTestId('manual-load-error')).toBeNull())
    expect(screen.getByTestId('manual-save')).toBeEnabled()
  })

  it('refuses a document above the memory budget and explains why', async () => {
    // 6850 px square is a legitimate 58 cm target at 300 DPI, but as a square it
    // is 46.9 MP — three 4-byte-per-pixel canvases would be roughly 750 MB.
    TestImage.naturalWidth = 6850
    TestImage.naturalHeight = 6850
    editor()

    const error = await screen.findByTestId('manual-load-error')
    expect(error).toHaveTextContent(/40 megapixels/i)
    // The refusal must point at a route that still works.
    expect(error).toHaveTextContent(/Photopea/i)
  })

  it('does not enable saving for a refused document', async () => {
    TestImage.naturalWidth = 8000
    TestImage.naturalHeight = 8000
    editor()
    await screen.findByTestId('manual-load-error')
    expect(screen.getByTestId('manual-save')).toBeDisabled()
  })

  it('keeps a wide banner inside the budget', async () => {
    // 8000 x 400 is the roll-width fixture: large in one axis, only 3.2 MP.
    TestImage.naturalWidth = 8000
    TestImage.naturalHeight = 400
    editor()
    await waitFor(() => expect(screen.queryByTestId('manual-load-error')).toBeNull())
  })
})
