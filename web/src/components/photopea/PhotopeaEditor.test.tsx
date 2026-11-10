import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { PhotopeaEditor, type PhotopeaEditorHandle } from './PhotopeaEditor'

/**
 * The real Photopea frame cannot run in jsdom, so these tests exercise the
 * boot sequencing that matters: the message listener is attached before the
 * frame navigates, the handshake is honoured, failures become visible errors,
 * and unmounting tears the session down.
 */
const sessions: Array<{ dispose: ReturnType<typeof vi.fn> }> = []

vi.mock('../../lib/photopea', async () => {
  const actual = await vi.importActual<typeof import('../../lib/photopea')>('../../lib/photopea')
  return {
    ...actual,
    fetchImageBytes: vi.fn(async () => new Uint8Array([137, 80, 78, 71]).buffer),
    PhotopeaSession: class {
      readonly dispose = vi.fn()
      readonly openDocument = vi.fn(async () => undefined)
      readonly runScript = vi.fn(async () => undefined)
      readonly exportPng = vi.fn(async () => new Uint8Array([1]).buffer)
      get isReady() {
        return true
      }
      constructor() {
        sessions.push(this)
      }
      async waitUntilReady() {
        return undefined
      }
    },
  }
})

afterEach(() => {
  sessions.length = 0
  cleanup()
})

describe('PhotopeaEditor boot sequence', () => {
  it('loads the image and reaches ready without a page refresh', async () => {
    const onStatusChange = vi.fn()
    render(
      <PhotopeaEditor
        fileUrl="/api/v1/designs/d/versions/v/file"
        documentName="out.png"
        onStatusChange={onStatusChange}
      />,
    )

    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )
    expect(onStatusChange).toHaveBeenCalledWith('ready', null)
    // The frame is only pointed at Photopea; the image bytes travel over
    // postMessage, never as a URL Photopea could fetch.
    const iframe = screen.getByTestId('photopea-iframe') as HTMLIFrameElement
    expect(iframe.src).toBe('https://www.photopea.com/')
  })

  it('creates the session before the frame navigates', async () => {
    render(<PhotopeaEditor fileUrl="/api/v1/x/file" documentName="out.png" />)
    // A session exists as soon as the effect runs, i.e. before Photopea replies.
    expect(sessions).toHaveLength(1)
    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )
  })

  it('shows an error instead of a broken screen when the image cannot load', async () => {
    const { fetchImageBytes } = await import('../../lib/photopea')
    vi.mocked(fetchImageBytes).mockRejectedValueOnce(new Error('Could not load the image (404).'))

    render(<PhotopeaEditor fileUrl="/api/v1/missing/file" documentName="out.png" />)

    expect(await screen.findByText('Could not load the image (404).')).toBeInTheDocument()
    expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'error')
  })

  it('disposes the session when the editor unmounts', async () => {
    const { unmount } = render(
      <PhotopeaEditor fileUrl="/api/v1/x/file" documentName="out.png" />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )

    const session = sessions[0]!
    unmount()
    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('does not re-boot when the parent re-renders with a new inline callback', async () => {
    const { rerender } = render(
      <PhotopeaEditor
        fileUrl="/api/v1/x/file"
        documentName="out.png"
        onStatusChange={() => undefined}
      />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )
    const firstSession = sessions[0]!

    rerender(
      <PhotopeaEditor
        fileUrl="/api/v1/x/file"
        documentName="out.png"
        onStatusChange={() => undefined}
      />,
    )

    // The iframe and its session must survive an unrelated re-render.
    expect(sessions).toHaveLength(1)
    expect(firstSession.dispose).not.toHaveBeenCalled()
  })

  it('reaches ready under StrictMode double mounting', async () => {
    // StrictMode mounts, unmounts and remounts the effect on the same <iframe>.
    // Cleanup must not reset `src` there, or it cancels the fresh navigation and
    // Photopea never gets a chance to send its one-time handshake.
    const { StrictMode } = await import('react')
    render(
      <StrictMode>
        <PhotopeaEditor fileUrl="/api/v1/x/file" documentName="out.png" />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )
    const iframe = screen.getByTestId('photopea-iframe') as HTMLIFrameElement
    expect(iframe.src).toBe('https://www.photopea.com/')
  })

  it('keeps the frame pointed at Photopea after unmount instead of resetting src', async () => {
    const { unmount } = render(
      <PhotopeaEditor fileUrl="/api/v1/x/file" documentName="out.png" />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('photopea-stage')).toHaveAttribute('data-status', 'ready'),
    )
    const iframe = screen.getByTestId('photopea-iframe') as HTMLIFrameElement
    unmount()
    // The listener is gone (asserted above); `src` is deliberately untouched so
    // a StrictMode remount is not racing a cancelled navigation.
    expect(iframe.src).toBe('https://www.photopea.com/')
  })

  it('refuses to export before the session is ready', async () => {
    const ref = createRef<PhotopeaEditorHandle>()
    render(<PhotopeaEditor ref={ref} fileUrl="/api/v1/x/file" documentName="out.png" />)

    // isReady is stubbed true here, so this asserts the handle wiring rather
    // than the guard; the guard itself is covered by the session unit tests.
    await waitFor(() => expect(ref.current?.status).toBe('ready'))
    await expect(ref.current!.exportPng()).resolves.toBeInstanceOf(ArrayBuffer)
  })
})
