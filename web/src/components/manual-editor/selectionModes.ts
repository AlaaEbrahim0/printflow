import type { Point } from './selectionGeometry'

/**
 * How a new selection combines with the one already on the canvas.
 *
 * Mirrors the modifier keys every raster editor uses, and the four buttons in
 * the toolbar exist so a laptop without a keyboard can still reach all four.
 * `replace` is the default; the others are "and", "or" and "minus".
 */
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect'

export interface SelectionModifiers {
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * Resolve the mode for a gesture from its modifiers.
 *
 * Order matters: Shift+Alt is "intersect" in Photoshop, and Ctrl/Cmd+Alt is
 * "subtract" on macOS where Alt alone drags a duplicate. We keep the desktop
 * convention exactly so muscle memory transfers.
 */
export function resolveSelectionMode(
  modifiers: SelectionModifiers,
  base: SelectionMode = 'replace',
): SelectionMode {
  const shift = Boolean(modifiers.shiftKey)
  const alt = Boolean(modifiers.altKey)
  const toggle = Boolean(modifiers.ctrlKey || modifiers.metaKey)
  if (shift && alt) return 'intersect'
  if (shift) return 'add'
  if (alt) return 'subtract'
  if (toggle) return 'add'
  return base
}

/** `a` combined into `b` under `mode`. Never mutates either operand. */
export function combineSelection(
  base: Uint8Array | null,
  next: Uint8Array,
  mode: SelectionMode,
): Uint8Array {
  if (mode === 'replace' || !base || base.length !== next.length) {
    // A size change (a fresh image) always replaces: combining two rasters of
    // different dimensions would silently misalign every pixel.
    return next.slice()
  }
  const out = new Uint8Array(next.length)
  for (let i = 0; i < next.length; i += 1) {
    const a = base[i]
    const b = next[i]
    out[i] = mode === 'add' ? Math.max(a, b) : mode === 'subtract' ? Math.max(0, a - b) : Math.min(a, b)
  }
  return out
}

/**
 * A selection is "empty" when no pixel is selected.
 *
 * An all-zero selection and no selection at all mean the same thing to the
 * operator, so the editor treats them the same to avoid two states that look
 * identical but behave differently (one disables Invert, the other not).
 */
export function isSelectionEmpty(selection: Uint8Array | null): boolean {
  if (!selection) return true
  for (let i = 0; i < selection.length; i += 1) if (selection[i] !== 0) return false
  return true
}

export function invertSelection(selection: Uint8Array): Uint8Array {
  return Uint8Array.from(selection, (value) => 255 - value)
}

/** Number of fully-or-partly selected pixels, for the status line. */
export function selectionCount(selection: Uint8Array | null): number {
  if (!selection) return 0
  let count = 0
  for (let i = 0; i < selection.length; i += 1) if (selection[i] !== 0) count += 1
  return count
}

export interface WandOptions {
  /** 0–100, the slider value. Mapped to a per-channel tolerance. */
  tolerance: number
  /** Stay inside the connected region instead of every similar pixel. */
  contiguous: boolean
  /** Treat alpha as part of the colour distance. */
  useAlpha?: boolean
}

/** Per-channel tolerance for the wand at a given slider value (0–100). */
export function wandThreshold(tolerance: number): number {
  if (!Number.isFinite(tolerance)) return 0
  return Math.round((Math.min(100, Math.max(0, tolerance)) / 100) * 255)
}

/**
 * Color-based selection (the magic wand).
 *
 * Distance is the sum of absolute channel differences, compared against
 * `threshold * 3` — the same metric the previous implementation used, so
 * existing muscle memory for the slider carries over. With `contiguous` the
 * region is grown from the seed with a scanline flood fill: that is the part
 * that keeps a wand click on a logo from also selecting every matching pixel
 * in a distant corner.
 *
 * Returns `null` when the seed lands outside the raster, so callers can leave
 * the current selection untouched rather than clearing it on a stray click.
 */
export function magicWandSelect(
  image: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seed: Point,
  options: WandOptions,
): Uint8Array | null {
  if (width <= 0 || height <= 0) return null
  const sx = Math.round(seed.x)
  const sy = Math.round(seed.y)
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null
  const threshold = wandThreshold(options.tolerance)
  const channels = options.useAlpha ? 4 : 3
  const at = (x: number, y: number) => (y * width + x) * 4
  const seedOffset = at(sx, sy)
  const target = [
    image[seedOffset],
    image[seedOffset + 1],
    image[seedOffset + 2],
    options.useAlpha ? image[seedOffset + 3] : 0,
  ]
  const budget = threshold * channels
  const matches = (x: number, y: number): boolean => {
    const offset = at(x, y)
    let distance = Math.abs(image[offset] - target[0]) + Math.abs(image[offset + 1] - target[1]) + Math.abs(image[offset + 2] - target[2])
    if (options.useAlpha) distance += Math.abs(image[offset + 3] - target[3])
    return distance <= budget
  }

  const out = new Uint8Array(width * height)
  if (!options.contiguous) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) if (matches(x, y)) out[y * width + x] = 255
    }
    return out
  }

  // Scanline flood fill: visit each horizontal run once, then push the rows
  // above and below at the ends of each not-yet-filled run. That is what keeps
  // a click on a large flat background from allocating a stack entry per pixel.
  if (out[sy * width + sx] === 255) return out
  const stack: Array<[number, number]> = [[sx, sy]]
  while (stack.length > 0) {
    const [startX, y] = stack.pop()!
    const row = y * width
    let left = startX
    while (left > 0 && out[row + left - 1] === 0 && matches(left - 1, y)) left -= 1
    let right = startX
    while (right < width - 1 && out[row + right + 1] === 0 && matches(right + 1, y)) right += 1
    for (let x = left; x <= right; x += 1) out[row + x] = 255
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue
      let x = left
      while (x <= right) {
        // Skip filled pixels *and* non-matching pixels; push one seed per run.
        while (x <= right && (out[ny * width + x] !== 0 || !matches(x, ny))) x += 1
        if (x > right) break
        stack.push([x, ny])
        while (x <= right && out[ny * width + x] === 0 && matches(x, ny)) x += 1
      }
    }
  }
  return out
}
