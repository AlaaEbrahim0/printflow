import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dialog } from './Dialog'

function renderDialog(onClose = vi.fn()) {
  render(
    <Dialog
      title="New batch"
      onClose={onClose}
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button">Create batch</button>
        </>
      }
    >
      <label>
        Batch name
        <input />
      </label>
    </Dialog>,
  )
  return onClose
}

describe('Dialog', () => {
  it('moves focus into the dialog on open', async () => {
    renderDialog()
    expect(await screen.findByRole('textbox', { name: 'Batch name' })).toHaveFocus()
  })

  it('closes on Escape', async () => {
    const onClose = renderDialog()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the dialog instead of reaching the page behind it', async () => {
    renderDialog()
    const panel = screen.getByRole('dialog', { name: 'New batch' })
    const input = screen.getByRole('textbox', { name: 'Batch name' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const create = screen.getByRole('button', { name: 'Create batch' })

    input.focus()
    await userEvent.tab()
    expect(cancel).toHaveFocus()
    await userEvent.tab()
    expect(create).toHaveFocus()
    // Wrapping past the last control returns to the top of the dialog (the
    // header close button), never to a control on the page behind it.
    await userEvent.tab()
    expect(panel.contains(document.activeElement)).toBe(true)
    expect(screen.getByRole('button', { name: 'Close New batch' })).toHaveFocus()
  })

  it('wraps backwards from the top of the dialog to the last control', async () => {
    renderDialog()
    const panel = screen.getByRole('dialog', { name: 'New batch' })
    const close = screen.getByRole('button', { name: 'Close New batch' })
    const create = screen.getByRole('button', { name: 'Create batch' })

    close.focus()
    await userEvent.tab({ shift: true })
    expect(create).toHaveFocus()
    expect(panel.contains(document.activeElement)).toBe(true)
  })

  it('never lets repeated tabbing escape the dialog', async () => {
    renderDialog()
    const panel = screen.getByRole('dialog', { name: 'New batch' })
    screen.getByRole('textbox', { name: 'Batch name' }).focus()
    for (let step = 0; step < 8; step += 1) {
      await userEvent.tab()
      expect(panel.contains(document.activeElement)).toBe(true)
    }
  })

  it('returns focus to the opener when it closes', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.append(opener)
    opener.focus()

    const { unmount } = render(
      <Dialog title="Confirm" onClose={() => {}}>
        <button type="button">OK</button>
      </Dialog>,
    )
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('is labelled for assistive technology', () => {
    renderDialog()
    expect(screen.getByRole('dialog', { name: 'New batch' })).toHaveAttribute('aria-modal', 'true')
  })
})
