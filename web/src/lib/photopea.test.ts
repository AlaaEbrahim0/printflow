import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PhotopeaError,
  PhotopeaSession,
  PHOTOPEA_ORIGIN,
  arrayBufferToPngFile,
  fetchImageBytes,
  photopeaEditorPath,
  photopeaExportFileName,
} from './photopea'

class FakeContentWindow {
  readonly posts: Array<{ data: unknown; origin: string; transfer?: Transferable[] }> = []

  postMessage(data: unknown, origin: string, transfer?: Transferable[]): void {
    this.posts.push({ data, origin, transfer })
  }
}

function installMessageBridge(contentWindow: FakeContentWindow) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const eventTarget = {
    addEventListener: (_type: string, listener: EventListener) => {
      listeners.add(listener as (event: MessageEvent) => void)
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      listeners.delete(listener as (event: MessageEvent) => void)
    },
  } as unknown as Window

  const emit = (data: unknown, origin = PHOTOPEA_ORIGIN, source: unknown = contentWindow) => {
    const event = { data, origin, source } as MessageEvent
    for (const listener of listeners) listener(event)
  }

  return { eventTarget, emit, listenerCount: () => listeners.size }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PhotopeaSession', () => {
  it('waits for the initial done handshake before accepting work', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })

    const ready = session.waitUntilReady(5_000)
    expect(session.isReady).toBe(false)
    bridge.emit('done')
    await ready
    expect(session.isReady).toBe(true)

    session.dispose()
    expect(bridge.listenerCount()).toBe(0)
  })

  it('ignores messages from other windows or origins', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })

    const ready = session.waitUntilReady(5_000)
    bridge.emit('done', PHOTOPEA_ORIGIN, {})
    bridge.emit('done', 'https://evil.example', contentWindow)
    expect(session.isReady).toBe(false)

    bridge.emit('done')
    await ready
    session.dispose()
  })

  it('opens a document by posting bytes and waiting for done', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    const open = session.openDocument(bytes)
    expect(contentWindow.posts).toHaveLength(1)
    expect(contentWindow.posts[0]?.origin).toBe(PHOTOPEA_ORIGIN)
    expect(contentWindow.posts[0]?.data).toBeInstanceOf(ArrayBuffer)

    bridge.emit('done')
    await open
    session.dispose()
  })

  it('exports a PNG buffer then accepts the completion done', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    expect(contentWindow.posts.at(-1)?.data).toBe('app.activeDocument.saveToOE("png");')

    const png = new Uint8Array([137, 80, 78, 71]).buffer
    bridge.emit(png)
    bridge.emit('done')

    await expect(exported).resolves.toBe(png)
    session.dispose()
  })

  it('exports the PNG with its alpha channel intact', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    // PNG is a lossless format with an alpha channel, so a transparent canvas
    // survives saveToOE("png") byte-for-byte; the bytes must not be re-encoded.
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).buffer
    bridge.emit(png)
    bridge.emit('done')

    const result = await exported
    expect(new Uint8Array(result)).toEqual(new Uint8Array(png))
    session.dispose()
  })

  it('keeps only the last image buffer when Photopea sends more than one', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    const stale = new Uint8Array([1, 1, 1]).buffer
    const finalPng = new Uint8Array([137, 80, 78, 71]).buffer
    bridge.emit(stale)
    bridge.emit(finalPng)
    bridge.emit('done')

    await expect(exported).resolves.toBe(finalPng)
    session.dispose()
  })

  it('rejects concurrent commands instead of mixing message streams', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const first = session.runScript('app.echoToOE("a");')
    await expect(session.exportPng()).rejects.toMatchObject({ code: 'busy' })
    bridge.emit('done')
    await first
    session.dispose()
  })

  it('times out when Photopea never answers', async () => {
    vi.useFakeTimers()
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })

    const ready = session.waitUntilReady(1_000)
    const expectation = expect(ready).rejects.toBeInstanceOf(PhotopeaError)
    await vi.advanceTimersByTimeAsync(1_000)
    await expectation
    session.dispose()
  })

  it('rejects in-flight work and drops its listener when disposed', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    expect(bridge.listenerCount()).toBe(1)

    session.dispose()

    // Unmounting must not leave a pending promise or a live listener behind.
    await expect(exported).rejects.toMatchObject({ code: 'closed' })
    expect(bridge.listenerCount()).toBe(0)
    expect(session.isReady).toBe(false)
    expect(session.isBusy).toBe(false)
  })

  it('ignores messages from a different window after the handshake', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    const foreignPng = new Uint8Array([1, 2, 3]).buffer
    bridge.emit(foreignPng, PHOTOPEA_ORIGIN, new FakeContentWindow())
    bridge.emit(foreignPng, 'https://evil.example')

    // Neither spoofed message may satisfy the export.
    const settled = await Promise.race([
      exported.then(() => 'resolved', () => 'rejected'),
      Promise.resolve('pending'),
    ])
    expect(settled).toBe('pending')

    session.dispose()
    await expect(exported).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects an export that finishes without image bytes', async () => {
    const contentWindow = new FakeContentWindow()
    const bridge = installMessageBridge(contentWindow)
    const session = new PhotopeaSession({
      contentWindow: contentWindow as unknown as Window,
      eventTarget: bridge.eventTarget,
    })
    bridge.emit('done')
    await session.waitUntilReady()

    const exported = session.exportPng()
    bridge.emit('done')
    await expect(exported).rejects.toMatchObject({ code: 'export-empty' })
    session.dispose()
  })
})

describe('fetchImageBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the image same-origin with credentials and returns raw bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchImageBytes('/api/v1/designs/d/versions/v/file')

    expect(new Uint8Array(result)).toEqual(new Uint8Array(bytes))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/designs/d/versions/v/file')
    expect(init.credentials).toBe('same-origin')
  })

  it('surfaces a load-failed error instead of returning empty bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))

    await expect(fetchImageBytes('/api/v1/missing.png')).rejects.toMatchObject({
      code: 'load-failed',
    })
  })

  it('propagates an abort so a navigating user is not left waiting', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      ),
    )

    const pending = fetchImageBytes('/api/v1/slow.png', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('photopea helpers', () => {
  it('builds a version-scoped editor path', () => {
    expect(photopeaEditorPath('batch-1', 'design-1', 'version-1')).toBe(
      '/batches/batch-1/designs/design-1/photopea?versionId=version-1',
    )
  })

  it('derives a stable edited PNG filename from the design and version', () => {
    expect(
      photopeaExportFileName('ACME Logo!', { id: 'abcdef12-9999', stepType: 'resize' }),
    ).toBe('ACME-Logo-resize-abcdef12-photopea.png')
  })

  it('wraps exported bytes as a PNG File', () => {
    const file = arrayBufferToPngFile(new Uint8Array([1, 2]).buffer, 'out.png')
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('out.png')
    expect(file.type).toBe('image/png')
  })
})
