import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * jsdom hands us a `location` but keeps Node's `fetch`, which rejects relative
 * URLs. Browsers resolve them against the document origin, so tests do the same.
 */
const origin = window.location.origin
const nodeFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const resolved = typeof input === 'string' && input.startsWith('/') ? `${origin}${input}` : input
  return nodeFetch(resolved as RequestInfo, init)
}) as typeof fetch

/** jsdom has no canvas backend; the tools only need a callable 2D context. */
function createTestContext2d(): Record<string, unknown> & { canvas: HTMLCanvasElement } {
  const noop = () => {}
  return {
    canvas: undefined as unknown as HTMLCanvasElement,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    lineWidth: 1,
    lineCap: 'round',
    lineJoin: 'round',
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    setLineDash: noop,
    drawImage: noop,
    putImageData: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    getImageData: (width = 1, height = 1) =>
      ({
        width,
        height,
        colorSpace: 'srgb',
        data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4),
      }) as unknown as ImageData,
    createImageData: (width = 1, height = 1) =>
      ({
        width,
        height,
        colorSpace: 'srgb',
        data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4),
      }) as unknown as ImageData,
  }
}

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  writable: true,
  value(this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null
    const context = createTestContext2d()
    context.canvas = this
    return context as unknown as CanvasRenderingContext2D
  },
})

if (typeof window.ResizeObserver === 'undefined') {
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
}

Element.prototype.scrollIntoView = () => {}
window.URL.createObjectURL = () => 'blob:mock'
window.URL.revokeObjectURL = () => {}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
