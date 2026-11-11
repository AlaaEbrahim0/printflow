import { compositeDocument, type CompositeRegion, type PixelResolver } from './composite'
import type { EditorDocument } from './document'

export type CompositorWorkerRequest =
  | { type: 'init'; sources: Record<string, ImageBitmap>; mipmaps: Record<string, ImageBitmap> }
  | { type: 'preview' | 'commit'; requestId: string; document: EditorDocument; region: CompositeRegion; scale: number; inputRevision: string }

export type CompositorWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; requestId: string; width: number; height: number; pixels: ArrayBuffer }
  | { type: 'stale'; requestId: string }
  | { type: 'error'; requestId?: string; message: string }

const sources = new Map<string, ImageData>()
let latestRequest = ''

function imageData(bitmap: ImageBitmap): ImageData {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('worker cannot create 2D context')
  context.drawImage(bitmap, 0, 0)
  return context.getImageData(0, 0, bitmap.width, bitmap.height)
}

self.onmessage = (event: MessageEvent<CompositorWorkerRequest>) => {
  try {
    const request = event.data
    if (request.type === 'init') {
      for (const [id, bitmap] of Object.entries(request.sources)) sources.set(id, imageData(bitmap))
      self.postMessage({ type: 'ready' } satisfies CompositorWorkerResponse)
      return
    }
    latestRequest = request.requestId
    const resolver: PixelResolver = { resolve: sourceId => sources.get(sourceId) ?? (() => { throw new Error(`missing source: ${sourceId}`) })() }
    const output = compositeDocument(request.document, resolver, { region: request.region, scale: request.scale, inputRevision: request.inputRevision })
    if (request.requestId !== latestRequest) { self.postMessage({ type: 'stale', requestId: request.requestId } satisfies CompositorWorkerResponse); return }
    const pixels = output.data.buffer
    self.postMessage({ type: 'result', requestId: request.requestId, width: output.width, height: output.height, pixels } satisfies CompositorWorkerResponse, { transfer: [pixels] })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) } satisfies CompositorWorkerResponse)
  }
}
