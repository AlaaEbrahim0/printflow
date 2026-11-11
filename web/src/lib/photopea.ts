/**
 * Thin Live Messaging client for the official Photopea iframe API.
 *
 * Photopea uses the string `"done"` both for the initial handshake and for
 * every completed command. This session tracks which wait is outstanding so
 * those acknowledgements are not confused with one another.
 *
 * @see https://www.photopea.com/api/live
 */

export const PHOTOPEA_ORIGIN = 'https://www.photopea.com'
export const PHOTOPEA_EMBED_URL = `${PHOTOPEA_ORIGIN}/`

export type PhotopeaErrorCode =
  | 'timeout'
  | 'not-ready'
  | 'busy'
  | 'closed'
  | 'invalid'
  | 'export-empty'
  | 'load-failed'

export class PhotopeaError extends Error {
  readonly code: PhotopeaErrorCode

  constructor(message: string, code: PhotopeaErrorCode) {
    super(message)
    this.name = 'PhotopeaError'
    this.code = code
  }
}

type ReadyWaiter = {
  type: 'ready'
  resolve: () => void
  reject: (error: Error) => void
}

type CommandWaiter = {
  type: 'command'
  resolve: () => void
  reject: (error: Error) => void
}

type ExportWaiter = {
  type: 'export'
  buffers: ArrayBuffer[]
  resolve: (buffer: ArrayBuffer) => void
  reject: (error: Error) => void
}

type Waiter = ReadyWaiter | CommandWaiter | ExportWaiter

export interface PhotopeaSessionOptions {
  contentWindow: Window
  /** Defaults to the browser `window` that hosts the iframe. */
  eventTarget?: Window
  targetOrigin?: string
}

export class PhotopeaSession {
  private disposed = false
  private ready = false
  private waiter: Waiter | null = null
  private readonly contentWindow: Window
  private readonly eventTarget: Window
  private readonly targetOrigin: string
  private readonly onWindowMessage: (event: MessageEvent) => void

  constructor(options: PhotopeaSessionOptions) {
    this.contentWindow = options.contentWindow
    this.eventTarget = options.eventTarget ?? window
    this.targetOrigin = options.targetOrigin ?? PHOTOPEA_ORIGIN
    this.onWindowMessage = (event) => this.handleMessage(event)
    this.eventTarget.addEventListener('message', this.onWindowMessage)
  }

  get isReady(): boolean {
    return this.ready && !this.disposed
  }

  get isBusy(): boolean {
    return this.waiter !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.eventTarget.removeEventListener('message', this.onWindowMessage)
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter.reject(new PhotopeaError('Photopea session was closed', 'closed'))
    }
  }

  waitUntilReady(timeoutMs = 60_000): Promise<void> {
    this.assertOpen()
    if (this.ready) return Promise.resolve()
    if (this.waiter) {
      return Promise.reject(new PhotopeaError('Another Photopea command is already in progress', 'busy'))
    }
    return this.withTimeout(
      new Promise<void>((resolve, reject) => {
        this.waiter = { type: 'ready', resolve, reject }
      }),
      timeoutMs,
      'Photopea did not become ready in time. Check the network or whether the editor is blocked.',
    )
  }

  /**
   * Opens a binary document in Photopea. Prefer transferring the buffer when
   * the caller no longer needs it — that avoids an extra large copy.
   */
  openDocument(
    bytes: ArrayBuffer,
    options: { timeoutMs?: number; transfer?: boolean } = {},
  ): Promise<void> {
    const guard = this.readyGuard()
    if (guard) return Promise.reject(guard)
    const payload = options.transfer ? bytes : bytes.slice(0)
    const transfer = options.transfer ? [payload] : undefined
    return this.sendAndWait(payload, options.timeoutMs ?? 120_000, transfer)
  }

  runScript(script: string, timeoutMs = 60_000): Promise<void> {
    const guard = this.readyGuard()
    if (guard) return Promise.reject(guard)
    return this.sendAndWait(script, timeoutMs)
  }

  exportPng(timeoutMs = 120_000): Promise<ArrayBuffer> {
    const guard = this.readyGuard()
    if (guard) return Promise.reject(guard)
    if (this.waiter) {
      return Promise.reject(
        new PhotopeaError('Another Photopea command is already in progress', 'busy'),
      )
    }
    return this.withTimeout(
      new Promise<ArrayBuffer>((resolve, reject) => {
        this.waiter = { type: 'export', buffers: [], resolve, reject }
        this.post('app.activeDocument.saveToOE("png");')
      }),
      timeoutMs,
      'Photopea PNG export timed out',
    )
  }

  /**
   * Synchronous on purpose: the waiter and the outgoing command must be
   * registered in the same tick, otherwise a fast `"done"` reply can arrive
   * before anyone is listening for it.
   */
  private readyGuard(): PhotopeaError | null {
    if (this.disposed) return new PhotopeaError('Photopea session was closed', 'closed')
    if (!this.ready) return new PhotopeaError('Photopea is not ready yet', 'not-ready')
    return null
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new PhotopeaError('Photopea session was closed', 'closed')
    }
  }

  private post(data: string | ArrayBuffer, transfer?: Transferable[]): void {
    if (transfer && transfer.length > 0) {
      this.contentWindow.postMessage(data, this.targetOrigin, transfer)
    } else {
      this.contentWindow.postMessage(data, this.targetOrigin)
    }
  }

  private sendAndWait(
    data: string | ArrayBuffer,
    timeoutMs: number,
    transfer?: Transferable[],
  ): Promise<void> {
    if (this.waiter) {
      return Promise.reject(new PhotopeaError('Another Photopea command is already in progress', 'busy'))
    }
    return this.withTimeout(
      new Promise<void>((resolve, reject) => {
        this.waiter = { type: 'command', resolve, reject }
        this.post(data, transfer)
      }),
      timeoutMs,
      'Photopea command timed out',
    )
  }

  private handleMessage(event: MessageEvent): void {
    if (this.disposed) return
    if (event.source !== this.contentWindow) return
    if (event.origin !== this.targetOrigin) return

    const data = event.data
    if (data === 'done') {
      this.handleDone()
      return
    }
    if (data instanceof ArrayBuffer) {
      if (this.waiter?.type === 'export') {
        this.waiter.buffers.push(data)
      }
      return
    }
    // Strings from echoToOE and unrelated payloads are intentionally ignored.
  }

  private handleDone(): void {
    if (!this.ready) {
      this.ready = true
      if (this.waiter?.type === 'ready') {
        const waiter = this.waiter
        this.waiter = null
        waiter.resolve()
      }
      return
    }

    if (!this.waiter) return

    if (this.waiter.type === 'command') {
      const waiter = this.waiter
      this.waiter = null
      waiter.resolve()
      return
    }

    if (this.waiter.type === 'export') {
      const waiter = this.waiter
      this.waiter = null
      const buffer = waiter.buffers.at(-1)
      if (!buffer) {
        waiter.reject(
          new PhotopeaError('Photopea finished export without sending image bytes', 'export-empty'),
        )
        return
      }
      waiter.resolve(buffer)
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.waiter) {
          const waiter = this.waiter
          this.waiter = null
          waiter.reject(new PhotopeaError(message, 'timeout'))
        }
      }, timeoutMs)

      promise.then(
        (value) => {
          window.clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          window.clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }
}

/** Same-origin fetch of a version file (or other workbench image URL) as bytes. */
export async function fetchImageBytes(
  fileUrl: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const response = await fetch(fileUrl, { credentials: 'same-origin', signal })
  if (!response.ok) {
    throw new PhotopeaError(
      `Could not load the image for Photopea (${response.status}).`,
      'load-failed',
    )
  }
  return response.arrayBuffer()
}

export function photopeaEditorPath(
  batchId: string,
  designId: string,
  versionId: string,
): string {
  return `/batches/${encodeURIComponent(batchId)}/designs/${encodeURIComponent(designId)}/photopea?versionId=${encodeURIComponent(versionId)}`
}

export function photopeaExportFileName(
  designName: string,
  version: { id: string; stepType: string },
): string {
  const safeName =
    designName
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'design'
  return `${safeName}-${version.stepType}-${version.id.slice(0, 8)}-photopea.png`
}

export function arrayBufferToPngFile(buffer: ArrayBuffer, fileName: string): File {
  // Pass a Uint8Array view — some test/XHR stacks reject a bare ArrayBuffer part
  // when building multipart FormData.
  return new File([new Uint8Array(buffer)], fileName, { type: 'image/png' })
}

export function downloadArrayBuffer(buffer: ArrayBuffer, fileName: string): void {
  const blob = new Blob([buffer], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
