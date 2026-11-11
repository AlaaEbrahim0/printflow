import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { AlphaPreview } from './AlphaPreview'
import { BackgroundPicker } from './BackgroundPicker'
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PRESET_GARMENT_COLORS,
  backgroundStyle,
  previewBackgroundFor,
  isHexColor,
  normalizeHex,
  type PreviewBackground,
} from '../../lib/preview'

const FILE = '/api/v1/designs/aaa/versions/bbb/file'

/** A controllable picker so a click visibly changes the composited surface. */
function StatefulPicker({ initial }: { initial: PreviewBackground }) {
  const [value, setValue] = useState<PreviewBackground>(initial)
  return (
    <>
      <BackgroundPicker value={value} onChange={setValue} />
      <AlphaPreview fileUrl={FILE} alt="Swatch" background={value} />
    </>
  )
}

describe('AlphaPreview', () => {
  it('composites the immutable version file over the chosen background', () => {
    const { rerender } = render(
      <AlphaPreview fileUrl={FILE} alt="Sticker" background={{ kind: 'checkerboard', hex: '#ffffff' }} />,
    )
    const surface = screen.getByTestId('preview-surface')
    const image = screen.getByTestId('preview-image') as HTMLImageElement
    expect(surface.getAttribute('data-background')).toBe('checkerboard')
    expect(image.getAttribute('data-image-src')).toBe(FILE)
    expect(image.style.background).toBe('')

    rerender(<AlphaPreview fileUrl={FILE} alt="Sticker" background={{ kind: 'black', hex: '#000000' }} />)
    expect(screen.getByTestId('preview-surface').getAttribute('data-background')).toBe('black')
    // The product rule: the file reference is byte-identical after switching.
    expect(screen.getByTestId('preview-image').getAttribute('src')).toBe(FILE)
  })

  it('passes a custom garment colour through as the surface colour', () => {
    render(
      <AlphaPreview
        fileUrl={FILE}
        alt="Custom"
        background={{ kind: 'custom', hex: '#1b2a4a' }}
        widthPx={100}
        heightPx={80}
      />,
    )
    const surface = screen.getByTestId('preview-surface') as HTMLElement
    expect(surface.getAttribute('data-background-hex')).toBe('#1b2a4a')
    expect(surface.style.backgroundColor).toBe('rgb(27, 42, 74)')
    expect(surface.style.backgroundImage).toBe('')
  })

  it('can defer off-screen previews without changing the file source', () => {
    render(
      <AlphaPreview
        fileUrl={`${FILE}?maxPx=640`}
        alt="Grid thumbnail"
        background={DEFAULT_PREVIEW_BACKGROUND}
        loading="lazy"
        decoding="async"
        fetchPriority="low"
      />,
    )

    const image = screen.getByTestId('preview-image')
    expect(image.getAttribute('src')).toBe(`${FILE}?maxPx=640`)
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(image).toHaveAttribute('fetchpriority', 'low')
  })

  it('says so when a version has no file at all', () => {
    render(<AlphaPreview fileUrl={null} alt="Missing" background={DEFAULT_PREVIEW_BACKGROUND} />)
    expect(screen.getByText('no file')).toBeInTheDocument()
  })
})

describe('background model', () => {
  it('defaults to checkerboard, never to hidden white', () => {
    expect(DEFAULT_PREVIEW_BACKGROUND.kind).toBe('checkerboard')
    const style = backgroundStyle(DEFAULT_PREVIEW_BACKGROUND)
    expect(style.backgroundImage).toContain('linear-gradient')
  })

  it('maps garment colours onto honest backgrounds', () => {
    expect(previewBackgroundFor({ kind: 'light' })).toEqual({ kind: 'white', hex: '#ffffff' })
    expect(previewBackgroundFor({ kind: 'dark' })).toEqual({ kind: 'black', hex: '#000000' })
    expect(previewBackgroundFor({ kind: 'custom', hex: '#FF6A3D' }).hex).toBe('#ff6a3d')
    expect(previewBackgroundFor({ kind: 'custom', hex: 'nonsense' }).hex).toBe('#ff00ff')
    expect(previewBackgroundFor(undefined).kind).toBe('checkerboard')
  })

  it('normalises hex input and rejects junk', () => {
    expect(isHexColor('#abc123')).toBe(true)
    expect(isHexColor('abc123')).toBe(false)
    expect(normalizeHex('abc123')).toBe('#abc123')
    expect(normalizeHex('#ZZZZZZ')).toBe('#ffffff')
  })
})

describe('BackgroundPicker', () => {
  it('offers checkerboard, white, black and custom and reports the change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BackgroundPicker value={DEFAULT_PREVIEW_BACKGROUND} onChange={onChange} />)
    for (const kind of ['white', 'black', 'custom'] as const) {
      await user.click(screen.getByTestId(`background-${kind}`))
    }
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange.mock.calls[2]![0]).toMatchObject({ kind: 'custom', hex: '#ff00ff' })
  })

  it('uses the design garment colour as the starting custom swatch', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <BackgroundPicker value={DEFAULT_PREVIEW_BACKGROUND} onChange={onChange} garmentHex="#1b2a4a" />,
    )
    await user.click(screen.getByTestId('background-custom'))
    expect(onChange).toHaveBeenCalledWith({ kind: 'custom', hex: '#1b2a4a' })
  })

  it('reveals presets and a hex field only for the custom background', async () => {
    const user = userEvent.setup()
    render(
      <StatefulPicker initial={{ kind: 'checkerboard', hex: '#ffffff' }} />,
    )
    expect(screen.queryByLabelText('Garment color')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('background-custom'))
    const group = screen.getByRole('group', { name: 'Preset garment colours' })
    expect(within(group).getAllByRole('button')).toHaveLength(PRESET_GARMENT_COLORS.length)
    expect(screen.getByLabelText('Garment color')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Navy' }))
    expect(screen.getByTestId('preview-surface')).toHaveAttribute('data-background-hex', '#1b2a4a')
  })

  it('exposes a radiogroup and reflects the controlled selection', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <BackgroundPicker value={DEFAULT_PREVIEW_BACKGROUND} onChange={onChange} />,
    )
    const group = screen.getByRole('radiogroup', { name: 'Preview background' })
    expect(group).toBeInTheDocument()
    expect(screen.getByTestId('background-checkerboard')).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByTestId('background-white'))
    expect(onChange).toHaveBeenCalledWith({ kind: 'white', hex: '#ffffff' })
    rerender(<BackgroundPicker value={{ kind: 'white', hex: '#ffffff' }} onChange={onChange} />)
    expect(screen.getByTestId('background-white')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('background-checkerboard')).toHaveAttribute('aria-checked', 'false')
  })
})
