import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import {
  PHOTOPEA_EMBED_URL,
  PHOTOPEA_ORIGIN,
  PhotopeaError,
  PhotopeaSession,
  fetchImageBytes,
} from '../../lib/photopea'
import './photopea.css'

export type PhotopeaEditorStatus =
  | 'loading-editor'
  | 'loading-image'
  | 'ready'
  | 'exporting'
  | 'error'

export interface PhotopeaEditorHandle {
  exportPng: () => Promise<ArrayBuffer>
  status: PhotopeaEditorStatus
}

export interface PhotopeaEditorProps {
  /** Same-origin relative URL of the exact version file to edit. */
  fileUrl: string
  /** Display / document name shown inside Photopea after import. */
  documentName: string
  onStatusChange?: (status: PhotopeaEditorStatus, error: string | null) => void
}

/**
 * Embeds Photopea and imports one image over the Live Messaging API.
 *
 * The iframe is created once per mount. Navigating away disposes the session
 * and aborts any in-flight fetch so listeners do not leak.
 */
export const PhotopeaEditor = forwardRef<PhotopeaEditorHandle, PhotopeaEditorProps>(
  function PhotopeaEditor({ fileUrl, documentName, onStatusChange }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const sessionRef = useRef<PhotopeaSession | null>(null)
    const [status, setStatus] = useState<PhotopeaEditorStatus>('loading-editor')
    const [error, setError] = useState<string | null>(null)
    const [retry, setRetry] = useState(0)

    // Held in a ref so the boot effect does not re-run when the parent
    // re-renders with a new inline callback.
    const onStatusChangeRef = useRef(onStatusChange)
    onStatusChangeRef.current = onStatusChange

    const update = useCallback((next: PhotopeaEditorStatus, nextError: string | null = null) => {
      setStatus(next)
      setError(nextError)
      onStatusChangeRef.current?.(next, nextError)
    }, [])

    useImperativeHandle(
      ref,
      () => ({
        status,
        exportPng: async () => {
          const session = sessionRef.current
          if (!session?.isReady) {
            throw new PhotopeaError('Photopea is not ready to export yet', 'not-ready')
          }
          update('exporting')
          try {
            const buffer = await session.exportPng()
            update('ready')
            return buffer
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : 'Photopea could not export a PNG.'
            update('ready', message)
            throw cause
          }
        },
      }),
      [status, update],
    )

    useEffect(() => {
      const iframe = iframeRef.current
      if (!iframe) return

      let cancelled = false
      let frameLoaded = false
      const abort = new AbortController()
      update('loading-editor')

      const contentWindow = iframe.contentWindow
      if (!contentWindow) {
        update('error', 'The Photopea frame could not be created.')
        return
      }

      // Attach the message listener before the frame navigates so a fast
      // `"done"` handshake can never arrive with nobody listening.
      const session = new PhotopeaSession({ contentWindow, targetOrigin: PHOTOPEA_ORIGIN })
      sessionRef.current = session

      const onLoad = () => {
        frameLoaded = true
      }
      iframe.addEventListener('load', onLoad)

      const boot = async () => {
        try {
          // Photopea normally handshakes in ~1s; a cold, slow or ad-blocked
          // network needs headroom, so keep the documented 60s default.
          await session.waitUntilReady()
          if (cancelled) return

          update('loading-image')
          const bytes = await fetchImageBytes(fileUrl, abort.signal)
          if (cancelled) return

          await session.openDocument(bytes, { transfer: true })
          if (cancelled) return

          await session.runScript(
            [
              `app.activeDocument.name = ${JSON.stringify(documentName)};`,
              `app.activeDocument.source = ${JSON.stringify(`printsheet:${documentName}`)};`,
            ].join('\n'),
          )
          if (cancelled) return

          update('ready')
        } catch (cause) {
          if (cancelled) return
          if (cause instanceof DOMException && cause.name === 'AbortError') return
          // Distinguish "the frame never loaded" from "the frame loaded but
          // never handshook" — the operator fixes those differently.
          const message =
            cause instanceof PhotopeaError && cause.code === 'timeout'
              ? frameLoaded
                ? 'Photopea loaded but never finished starting up. A browser extension, proxy or strict network filter may be blocking its worker scripts. Reload the page and try again.'
                : 'The Photopea editor never loaded. Check that www.photopea.com is reachable and not blocked by an extension, proxy or firewall.'
              : cause instanceof Error
                ? cause.message
                : 'Photopea could not load. Check that www.photopea.com is reachable.'
          update('error', message)
        }
      }

      iframe.src = PHOTOPEA_EMBED_URL
      void boot()

      return () => {
        cancelled = true
        abort.abort()
        iframe.removeEventListener('load', onLoad)
        session.dispose()
        sessionRef.current = null
        // Do NOT reset `src` here. Under StrictMode this cleanup runs and the
        // effect immediately re-runs on the same <iframe> element; touching
        // `src` would cancel the fresh navigation that the second run just
        // started, and Photopea only sends its handshake once per load.
        // `dispose()` already removed the message listener, which is what
        // actually stops Photopea from talking to this component.
      }
    }, [fileUrl, documentName, retry, update])

    const showOverlay = status !== 'ready'

    return (
      <div className="photopea-stage" data-testid="photopea-stage" data-status={status}>
        <iframe
          ref={iframeRef}
          className="photopea-frame"
          title="Photopea editor"
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          data-testid="photopea-iframe"
        />
        {showOverlay ? (
          <div className="photopea-overlay" role="status" aria-live="polite">
            <div className="photopea-overlay-card">
              {status === 'error' ? (
                <>
                  <strong>Photopea could not open</strong>
                  <p>{error ?? 'Unknown error.'}</p>
                  {error?.includes('never finished starting up') ? (
                    <div className="photopea-retry">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setRetry((value) => value + 1)}
                      >
                        Try again
                      </button>
                      <a
                        className="btn sm"
                        href={PHOTOPEA_EMBED_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Photopea in new tab
                      </a>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="photopea-spinner" aria-hidden="true" />
                  <strong>
                    {status === 'loading-editor'
                      ? 'Starting Photopea…'
                      : status === 'loading-image'
                        ? 'Importing artwork…'
                        : 'Exporting PNG…'}
                  </strong>
                  <p>
                    {status === 'exporting'
                      ? 'Waiting for Photopea to send the edited PNG.'
                      : 'The selected version is loaded by byte transfer — the original file stays untouched.'}
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}
      </div>
    )
  },
)
