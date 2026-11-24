import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PreviewContrastHint } from './PreviewContrastHint'
import type { PreviewBackground } from '../../lib/preview'

const WHITE = { kind: 'white', hex: '#ffffff' } as PreviewBackground
const BLACK = { kind: 'black', hex: '#000000' } as PreviewBackground
const CHECKER = { kind: 'checkerboard', hex: '#ffffff' } as PreviewBackground

describe('PreviewContrastHint', () => {
  it('explains a white-ink cut-out on a white preview and offers a dark surface', async () => {
    const user = userEvent.setup()
    const onUseContrasting = vi.fn()
    render(
      <PreviewContrastHint inkHex="#FEFEFE" background={WHITE} onUseContrasting={onUseContrasting} />,
    )

    // The operator is told the artwork is intact, not that processing failed.
    expect(screen.getByText(/hiding the artwork/i)).toBeInTheDocument()
    expect(screen.getByTestId('preview-contrast-hint')).toHaveTextContent('#FEFEFE')
    expect(screen.getByTestId('preview-contrast-hint')).toHaveTextContent(/intact/)

    await user.click(screen.getByTestId('preview-contrast-fix'))
    expect(onUseContrasting).toHaveBeenCalledWith({ kind: 'black', hex: '#000000' })
  })

  it('offers a light surface for dark ink on a black preview', async () => {
    const user = userEvent.setup()
    const onUseContrasting = vi.fn()
    render(
      <PreviewContrastHint inkHex="#101010" background={BLACK} onUseContrasting={onUseContrasting} />,
    )
    expect(screen.getByRole('button', { name: /show it on white/i })).toBeInTheDocument()
    await user.click(screen.getByTestId('preview-contrast-fix'))
    expect(onUseContrasting).toHaveBeenCalledWith({ kind: 'white', hex: '#ffffff' })
  })

  it('says nothing when the artwork is legible', () => {
    render(<PreviewContrastHint inkHex="#101010" background={WHITE} onUseContrasting={vi.fn()} />)
    expect(screen.queryByTestId('preview-contrast-hint')).not.toBeInTheDocument()
  })

  it('never warns on the checkerboard, which cannot hide artwork', () => {
    render(<PreviewContrastHint inkHex="#ffffff" background={CHECKER} onUseContrasting={vi.fn()} />)
    expect(screen.queryByTestId('preview-contrast-hint')).not.toBeInTheDocument()
  })

  it('says nothing while the ink colour is still unknown', () => {
    render(<PreviewContrastHint inkHex={null} background={WHITE} onUseContrasting={vi.fn()} />)
    expect(screen.queryByTestId('preview-contrast-hint')).not.toBeInTheDocument()
  })

  it('does not change the preview by itself', () => {
    // Showing the hint must never be the thing that changes the background;
    // only the operator's click may.
    const onUseContrasting = vi.fn()
    render(
      <PreviewContrastHint inkHex="#FEFEFE" background={WHITE} onUseContrasting={onUseContrasting} />,
    )
    expect(onUseContrasting).not.toHaveBeenCalled()
  })
})
