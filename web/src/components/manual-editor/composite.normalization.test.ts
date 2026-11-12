import { describe, expect, it } from 'vitest'
import { ColorKeyCache, compositeDocument } from './composite'
import type { CompositeOptions, PixelResolver } from './composite'
import type {
  AdjustmentLayer,
  BaseRasterLayer,
  EditorDocument,
  EditorLayer,
  PackedMask,
  PixelOperation,
  PixelOpLayer,
} from './document'

if (typeof globalThis.ImageData === 'undefined') {
  class TestImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(dataOrWidth: Uint8ClampedArray | number, width: number, height?: number) {
      this.width = typeof dataOrWidth === 'number' ? dataOrWidth : width
      this.height = typeof dataOrWidth === 'number' ? width : height!
      this.data = typeof dataOrWidth === 'number' ? new Uint8ClampedArray(this.width * this.height * 4) : dataOrWidth
    }
  }
  globalThis.ImageData = TestImageData as unknown as typeof ImageData
}

const WIDTH = 8
const HEIGHT = 6
const PIXEL_COUNT = WIDTH * HEIGHT
const MASK_BYTES = Math.ceil(PIXEL_COUNT / 8)

/** Small deterministic PRNG so a failure is always reproducible. */
function randomBytes(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/**
 * Artwork with the shape a canvas leaves behind after a cutout: every third
 * pixel is fully transparent yet still carries a non-zero colour, and a few
 * pixels sit at alpha 1 because the compositor rounds 8-bit alpha at the end.
 */
function patternedSource(seed: number): ImageData {
  const next = randomBytes(seed)
  const data = new Uint8ClampedArray(PIXEL_COUNT * 4)
  for (let i = 0; i < PIXEL_COUNT; i += 1) {
    const offset = i * 4
    data[offset] = 1 + Math.floor(next() * 255)
    data[offset + 1] = 1 + Math.floor(next() * 255)
    data[offset + 2] = 1 + Math.floor(next() * 255)
    data[offset + 3] = i % 3 === 0 ? 0 : i % 5 === 0 ? 1 : 255
  }
  return new ImageData(data, WIDTH, HEIGHT)
}

/** Fully opaque, uniformly coloured artwork; nothing transparent to begin with. */
function opaqueSource(): ImageData {
  const data = new Uint8ClampedArray(PIXEL_COUNT * 4)
  for (let i = 0; i < PIXEL_COUNT; i += 1) {
    const offset = i * 4
    data[offset] = 220
    data[offset + 1] = 120
    data[offset + 2] = 60
    data[offset + 3] = 255
  }
  return new ImageData(data, WIDTH, HEIGHT)
}

function baseLayer(overrides: Partial<BaseRasterLayer> = {}): BaseRasterLayer {
  return {
    id: 'base',
    kind: 'base-raster',
    name: 'Base',
    sourceId: 'source',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    ...overrides,
  }
}

function adjustmentLayer(overrides: Partial<AdjustmentLayer> = {}): AdjustmentLayer {
  return {
    id: 'adjust',
    kind: 'adjustment',
    name: 'Levels',
    visible: true,
    opacity: 1,
    blendMode: 'multiply',
    mask: null,
    adjustment: {
      levels: { black: 12, white: 240, gamma: 1.4, outputBlack: 6, outputWhite: 250 },
      hue: 15,
      saturation: 30,
      lightness: -10,
    },
    ...overrides,
  }
}

function colorKeyLayer(operation: PixelOperation, overrides: Partial<PixelOpLayer> = {}): PixelOpLayer {
  return {
    id: 'key',
    kind: 'pixel-op',
    name: 'Colour key',
    visible: true,
    opacity: 0.5,
    blendMode: 'multiply',
    mask: null,
    operation,
    ...overrides,
  }
}

function buildDocument(layers: EditorLayer[], overrides: Partial<EditorDocument> = {}): EditorDocument {
  return {
    schemaVersion: 1,
    id: 'doc',
    designId: 'design',
    sourceVersionId: 'source-version',
    width: WIDTH,
    height: HEIGHT,
    layers,
    activeLayerId: layers[0]?.id ?? 'base',
    selection: null,
    ...overrides,
  }
}

function resolverFor(image: ImageData, sources: Record<string, ImageData> = {}): PixelResolver {
  return { resolve: (sourceId: string) => sources[sourceId] ?? image }
}

function packedMask(selected: (index: number) => boolean, feather = 0): PackedMask {
  const bytes = new Uint8Array(MASK_BYTES)
  for (let i = 0; i < PIXEL_COUNT; i += 1) if (selected(i)) bytes[i >> 3] |= 1 << (i & 7)
  return { encoding: 'bitpack-v1', width: WIDTH, height: HEIGHT, feather, bytes }
}

interface RgbLeak { pixel: number; rgba: [number, number, number, number] }

/** Every alpha-zero pixel that still carries colour, with the offending value. */
function transparentRgbLeaks(image: ImageData): RgbLeak[] {
  const leaks: RgbLeak[] = []
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3]
    if (alpha !== 0) continue
    const r = image.data[i]
    const g = image.data[i + 1]
    const b = image.data[i + 2]
    if (r !== 0 || g !== 0 || b !== 0) leaks.push({ pixel: i / 4, rgba: [r, g, b, alpha] })
  }
  return leaks
}

function transparentCount(image: ImageData): number {
  let count = 0
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] === 0) count += 1
  return count
}

function bytesOf(image: ImageData): number[] {
  return Array.from(image.data)
}

describe('compositeDocument RGB normalization', () => {
  it('zeroes RGB on alpha-zero pixels that came from a base raster', () => {
    const source = patternedSource(11)
    const result = compositeDocument(buildDocument([baseLayer()]), resolverFor(source))

    // Guard against a vacuous assertion: the input really does carry colour
    // under zero alpha before compositing, and it survives as zero alpha.
    expect(transparentCount(source)).toBe(16)
    expect(transparentRgbLeaks(source)).toHaveLength(transparentCount(source))
    expect(transparentCount(result)).toBe(transparentCount(source))
    expect(transparentRgbLeaks(result)).toEqual([])
  })

  it('leaves fully visible base-raster pixels byte-identical', () => {
    const source = patternedSource(12)
    const result = compositeDocument(buildDocument([baseLayer()]), resolverFor(source))

    for (let i = 0; i < source.data.length; i += 4) {
      if (source.data[i + 3] !== 255) continue
      expect(Array.from(result.data.slice(i, i + 4))).toEqual(Array.from(source.data.slice(i, i + 4)))
    }
  })

  it('zeroes RGB when a barely visible layer rounds alpha down to zero', () => {
    const source = opaqueSource()
    const result = compositeDocument(buildDocument([baseLayer({ opacity: 0.001 })]), resolverFor(source))

    // 255 alpha x 0.001 = 0.255, which rounds to an 8-bit alpha of 0 even
    // though the colour channels were blended and written first.
    expect(transparentCount(result)).toBe(PIXEL_COUNT)
    expect(transparentRgbLeaks(result)).toEqual([])
  })

  it('zeroes RGB where a layer mask removes every pixel', () => {
    const source = opaqueSource()
    const result = compositeDocument(
      buildDocument([baseLayer({ mask: packedMask(() => false) })]),
      resolverFor(source),
    )

    expect(transparentCount(result)).toBe(PIXEL_COUNT)
    expect(transparentRgbLeaks(result)).toEqual([])
  })

  it('keeps transparency normalized through adjustment and multiply layers', () => {
    const source = patternedSource(13)
    const result = compositeDocument(buildDocument([baseLayer(), adjustmentLayer()]), resolverFor(source))

    expect(transparentCount(result)).toBeGreaterThan(0)
    expect(transparentRgbLeaks(result)).toEqual([])
  })

  it('keeps transparency normalized through a colour-key pixel operation', () => {
    const source = patternedSource(15)
    const operation: PixelOperation = {
      type: 'color-key',
      color: { r: 128, g: 96, b: 64 },
      tolerance: 40,
      feather: 2,
      contiguous: false,
      useAlpha: false,
      seeds: [],
    }
    const result = compositeDocument(
      buildDocument([baseLayer(), colorKeyLayer(operation)]),
      resolverFor(source),
    )

    expect(transparentCount(result)).toBeGreaterThan(0)
    expect(transparentRgbLeaks(result)).toEqual([])
  })

  it('keeps transparency normalized after region cropping and upscaling', () => {
    const source = patternedSource(14)
    const options: CompositeOptions = { region: { x: 1, y: 0, width: 5, height: 4 }, scale: 2 }
    const result = compositeDocument(buildDocument([baseLayer()]), resolverFor(source), options)

    expect(result.width).toBe(10)
    expect(result.height).toBe(8)
    expect(transparentCount(result)).toBeGreaterThan(0)
    expect(transparentRgbLeaks(result)).toEqual([])
  })
})

describe('compositeDocument determinism', () => {
  const operation: PixelOperation = {
    type: 'color-key',
    color: { r: 128, g: 96, b: 64 },
    tolerance: 40,
    feather: 0,
    contiguous: false,
    useAlpha: false,
    seeds: [],
  }

  const layeredDocument = (): EditorDocument =>
    buildDocument([baseLayer(), adjustmentLayer(), colorKeyLayer(operation)])

  it('returns identical bytes for repeated runs of the same document', () => {
    const source = patternedSource(21)
    const document = layeredDocument()

    const first = compositeDocument(document, resolverFor(source))
    const second = compositeDocument(document, resolverFor(source))

    expect(second.width).toBe(first.width)
    expect(second.height).toBe(first.height)
    expect(bytesOf(second)).toEqual(bytesOf(first))
    expect(transparentRgbLeaks(second)).toEqual([])
  })

  it('returns identical bytes with a warm colour-key cache as with no cache', () => {
    const source = patternedSource(22)
    const document = layeredDocument()
    const uncached = compositeDocument(document, resolverFor(source))

    const cache = new ColorKeyCache()
    const cold = compositeDocument(document, resolverFor(source), { colorKeyCache: cache, inputRevision: 'rev-1' })
    const warm = compositeDocument(document, resolverFor(source), { colorKeyCache: cache, inputRevision: 'rev-1' })

    expect(cache.get(operation, 'rev-1')).toBeDefined()
    expect(bytesOf(cold)).toEqual(bytesOf(uncached))
    expect(bytesOf(warm)).toEqual(bytesOf(cold))
  })

  it('returns identical bytes for repeated region and scale renders', () => {
    const source = patternedSource(23)
    const document = buildDocument([baseLayer(), adjustmentLayer()])
    const options: CompositeOptions = { region: { x: 2, y: 1, width: 4, height: 4 }, scale: 2 }

    const first = compositeDocument(document, resolverFor(source), options)
    const second = compositeDocument(document, resolverFor(source), options)

    expect(bytesOf(second)).toEqual(bytesOf(first))
    expect(transparentRgbLeaks(second)).toEqual([])
  })

  it('never mutates the resolver source, so later runs see the same input', () => {
    const source = patternedSource(24)
    const before = bytesOf(source)
    const document = layeredDocument()

    compositeDocument(document, resolverFor(source))
    compositeDocument(document, resolverFor(source))

    expect(bytesOf(source)).toEqual(before)
  })
})
