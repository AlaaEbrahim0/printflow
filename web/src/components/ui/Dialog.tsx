import { useEffect, useRef, type ReactNode } from 'react'

export interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  describedBy?: string
}

/**
 * A small accessible modal without a UI framework: role=dialog, Escape and
 * backdrop dismissal, focus moved into the panel on open and kept inside it
 * while open, then returned to whatever had focus before.
 *
 * The focus trap matters here because the workbench dialogs sit over a page of
 * live buttons (Pack, Exclude, Review). Without it, Tab walks out of the modal
 * and an operator can press a background action while a dialog is open.
 */
export function Dialog({ title, onClose, children, footer, describedBy }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hidden)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        panelRef.current?.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.activeElement as HTMLElement | null
    // Land on the first real control *in the body*, not the header close
    // button: opening "New batch" should put the cursor in the batch-name
    // field. Read-only dialogs fall back to the panel so Escape still works.
    const bodyControl = panelRef.current?.querySelector<HTMLElement>(
      '.modal-body a[href], .modal-body button:not([disabled]), .modal-body input:not([disabled]), .modal-body select:not([disabled]), .modal-body textarea:not([disabled])',
    )
    ;(bodyControl ?? panelRef.current)?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previous && 'focus' in previous) previous.focus()
    }
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal-panel card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <button type="button" className="close" onClick={onClose} aria-label={`Close ${title}`}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}
