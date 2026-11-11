import type { CompositeRegion } from './composite'
import type { EditorDocument } from './document'
import type { CompositorWorkerRequest, CompositorWorkerResponse } from './compositor.worker'

export class CompositorClient {
  private readonly worker: Worker
  private sequence = 0
  private pending = new Map<string, (value: ImageData) => void>()

  constructor(worker = new Worker(new URL('./compositor.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker
    worker.onmessage = (event: MessageEvent<CompositorWorkerResponse>) => {
      if (event.data.type !== 'result') return
      const resolve = this.pending.get(event.data.requestId)
      if (!resolve) return
      this.pending.delete(event.data.requestId)
      resolve(new ImageData(new Uint8ClampedArray(event.data.pixels), event.data.width, event.data.height))
    }
  }

  init(sources: Record<string, ImageBitmap>, mipmaps: Record<string, ImageBitmap>): void {
    const request: CompositorWorkerRequest = { type: 'init', sources, mipmaps }
    this.worker.postMessage(request, [...Object.values(sources), ...Object.values(mipmaps)])
  }

  render(document: EditorDocument, region: CompositeRegion, scale: number, inputRevision: string): Promise<ImageData> {
    const requestId = `${Date.now()}-${this.sequence++}`
    return new Promise(resolve => {
      this.pending.set(requestId, resolve)
      this.worker.postMessage({ type: 'preview', requestId, document, region, scale, inputRevision } satisfies CompositorWorkerRequest)
    })
  }

  dispose(): void { this.worker.terminate(); this.pending.clear() }
}
