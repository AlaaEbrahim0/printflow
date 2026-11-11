/**
 * Layer-mask operations.
 *
 * A mask is the same `Uint8Array` shape as a selection: one byte per pixel,
 * 255 = keep, 0 = hide. That is not a coincidence — "Selection → mask" is just
 * a copy, and every operator here also works on a selection, which is how
 * feather and grow apply to both without duplicating code.
 *
 * All functions are pure: they return a new buffer and never touch the input.
 * The editor's history relies on that, because a snapshot it handed out must
 * stay valid after the operator keeps painting.
 */

export interface MaskSize {
  width: number
  height: number
}

/**
 * Grow (positive) or contract (negative) a mask by `radius` pixels.
 *
 * Implemented as a separable pass: horizontal max then vertical max, which is
 * O(n·r) instead of O(n·r²). That is a square dilation (side 2r+1) rather than
 * a true disc — a per-pixel Euclidean pass at 6 MP is a visible freeze, and a
 * square kernel is the conservative choice for pulling an edge out from under
 * a halo.
 */
export function growMask(
  mask: Uint8Array,
  size: MaskSize,
  radius: number,
): Uint8Array {
  const r = Math.round(radius)
  if (r === 0) return mask.slice()
  const { width, height } = size
  if (width <= 0 || height <= 0) return mask.slice()
  if (r < 0) return contractMask(mask, size, -r)
  if (r * 2 + 1 >= width && r * 2 + 1 >= height) {
    // A radius beyond the image dilates everything; short-circuit rather than
    // scanning {width × height × r} cells to discover the same answer.
    const out = new Uint8Array(mask.length)
    out.fill(255)
    return out
  }
  // Offsets inside the kernel, shared by both passes.
  const offsets: number[] = []
  for (let dx = -r; dx <= r; dx += 1) offsets.push(dx)

  const horizontal = new Uint8Array(mask.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let best = 0
      for (const dx of offsets) {
        const sx = x + dx
        if (sx < 0 || sx >= width) continue
        const value = mask[row + sx]
        if (value > best) {
          best = value
          if (best === 255) break
        }
      }
      horizontal[row + x] = best
    }
  }

  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = 0
      for (const dy of offsets) {
        const sy = y + dy
        if (sy < 0 || sy >= height) continue
        const value = horizontal[sy * width + x]
        if (value > best) {
          best = value
          if (best === 255) break
        }
      }
      out[y * width + x] = best
    }
  }
  return out
}

/** Contract is grow on the inverse: erode dark by dilating the gaps. */
export function contractMask(mask: Uint8Array, size: MaskSize, radius: number): Uint8Array {
  const r = Math.round(radius)
  if (r <= 0) return mask.slice()
  const inverted = invertMask(mask)
  const grown = growMask(inverted, size, r)
  return invertMask(grown)
}

export function invertMask(mask: Uint8Array): Uint8Array {
  return Uint8Array.from(mask, (value) => 255 - value)
}

/**
 * Snap a soft mask to fully on or fully off at `threshold` (0–255).
 *
 * The operator needs this before using a soft selection as a *cut-out*: a
 * half-transparent edge prints as a halo, and no amount of levels fiddling on
 * the mask makes the edge crisp. Threshold is the explicit, reversible operator
 * for that decision.
 */
export function thresholdMask(mask: Uint8Array, threshold = 128): Uint8Array {
  const cut = Math.min(255, Math.max(0, Math.round(threshold)))
  return Uint8Array.from(mask, (value) => (value >= cut ? 255 : 0))
}

/**
 * Feather with a two-pass box blur.
 *
 * Three box passes approximate a Gaussian closely enough that nobody can see
 * the difference at print size, and each pass is a running sum — O(n) whatever
 * the radius. A true Gaussian at radius 40 on a 6000 px artwork is a visible
 * freeze; this is not.
 */
export function featherMask(mask: Uint8Array, size: MaskSize, radius: number): Uint8Array {
  const r = Math.round(radius)
  if (r <= 0) return mask.slice()
  const { width, height } = size
  if (width <= 0 || height <= 0) return mask.slice()
  let current = mask.slice()
  for (let pass = 0; pass < 3; pass += 1) {
    current = boxBlurH(current, width, height, r)
    current = boxBlurV(current, width, height, r)
  }
  return current
}

function boxBlurH(src: Uint8Array<ArrayBufferLike>, width: number, height: number, r: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length)
  const window = r * 2 + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let x = -r; x <= r; x += 1) sum += src[row + Math.min(width - 1, Math.max(0, x))]
    for (let x = 0; x < width; x += 1) {
      out[row + x] = Math.round(sum / window)
      const leaving = src[row + Math.min(width - 1, Math.max(0, x - r))]
      const entering = src[row + Math.min(width - 1, Math.max(0, x + r + 1))]
      sum += entering - leaving
    }
  }
  return out
}

function boxBlurV(src: Uint8Array<ArrayBufferLike>, width: number, height: number, r: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length)
  const window = r * 2 + 1
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let y = -r; y <= r; y += 1) sum += src[Math.min(height - 1, Math.max(0, y)) * width + x]
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = Math.round(sum / window)
      const leaving = src[Math.min(height - 1, Math.max(0, y - r)) * width + x]
      const entering = src[Math.min(height - 1, Math.max(0, y + r + 1)) * width + x]
      sum += entering - leaving
    }
  }
  return out
}

/**
 * Write a mask into the alpha channel of an RGB(A) buffer.
 *
 * The mask multiplies alpha, which is what "white visible, black transparent"
 * means. Colour is copied through untouched: the editor's knobs move colour,
 * and this step must not be the place that quietly changes it.
 */
export function applyMaskToAlpha(data: Uint8ClampedArray, mask: Uint8Array): void {
  const pixels = Math.min(mask.length, Math.floor(data.length / 4))
  for (let i = 0; i < pixels; i += 1) {
    if (mask[i] === 255) continue
    if (mask[i] === 0) {
      data[i * 4 + 3] = 0
      continue
    }
    data[i * 4 + 3] = Math.round((data[i * 4 + 3] * mask[i]) / 255)
  }
}

/** Fraction of pixels the mask keeps, for the panel's readout. */
export function maskCoverage(mask: Uint8Array | null): number {
  if (!mask || mask.length === 0) return 0
  let sum = 0
  for (let i = 0; i < mask.length; i += 1) sum += mask[i]
  return sum / (mask.length * 255)
}
