export const MAX_EDITOR_PIXELS = 40_000_000
export const HISTORY_MAX_BYTES = 100 * 1024 * 1024
export const STRIP_HEIGHT = 256

export interface MemoryBudget {
  limitBytes: number
  usedBytes: number
  decodedBytes: number
  compositeBytes: number
  scratchBytes: number
  workingMaskBytes: number
  historyBytes: number
  warning: boolean
}

export function estimateMemory(width: number, height: number, historyBytes = 0): MemoryBudget {
  const pixels = width * height
  const decodedBytes = pixels * 4
  const compositeBytes = decodedBytes
  const scratchBytes = decodedBytes
  const workingMaskBytes = Math.ceil(pixels / 8) * 5
  const limitBytes = Math.ceil((decodedBytes + compositeBytes + scratchBytes + workingMaskBytes + HISTORY_MAX_BYTES) * 1.5)
  const usedBytes = decodedBytes + compositeBytes + scratchBytes + workingMaskBytes + historyBytes
  return { limitBytes, usedBytes, decodedBytes, compositeBytes, scratchBytes, workingMaskBytes, historyBytes, warning: usedBytes >= limitBytes * .8 }
}

export function assertSupportedSize(width: number, height: number): void {
  if (width * height > MAX_EDITOR_PIXELS) throw new Error('editor refuses documents above 40 megapixels')
}
