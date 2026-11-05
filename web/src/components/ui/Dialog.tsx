import { useEffect, useRef, type ReactNode } from 'react'
import '../styles/ui.css'

export interface DialogProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  describedBy?: string
}

/**
 * A small accessible modal without a UI framework: role=dialog, Escape and
 * backdrop dismissal, focus moved into the panel on open. Implemented with a
 * plain overlay so it behaves identically in jsdom tests.
 */
export function Dialog({ title, onClose, children, footer, describedBy }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    const previous = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
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
