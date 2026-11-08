/**
 * Self-contained inline SVG artwork for the mock API. No network, no fixtures
 * on disk, no binary blobs in JSON.
 *
 * Each asset is split into a background layer and an artwork layer so the mock
 * can honestly serve three variants of the same design:
 *   - `with-bg`   — what the customer sent (opaque or keyed background);
 *   - `transparent` — artwork with existing alpha;
 *   - `mask`      — white-on-black coverage, the non-destructive mask artifact.
 *
 * Because the artwork layer keeps semi-transparent halo pixels, fringes and
 * dark edges are only visible when the browser composites them over a chosen
 * background — which is exactly the preview-honesty product rule.
 */
export type MockAssetVariant = 'with-bg' | 'transparent' | 'mask'

export interface MockAssetSize {
  widthPx: number
  heightPx: number
}

export interface MockAsset extends MockAssetSize {
  key: string
  label: string
  hasAlpha: boolean
  /** True when every edge carries content, so auto-trim must not propose a crop. */
  fullBleed: boolean
  background: string
  artwork: string
}

export interface ViewBoxRect {
  x: number
  y: number
  width: number
  height: number
}

const STICKER_HALO = `
  <g>
    <circle cx="450" cy="380" r="252" fill="#ffffff" opacity="0.10"/>
    <circle cx="450" cy="380" r="244" fill="#ffffff" opacity="0.16"/>
    <circle cx="450" cy="380" r="238" fill="#ffffff" opacity="0.28"/>
    <circle cx="450" cy="380" r="232" fill="none" stroke="#ffffff" stroke-width="7" opacity="0.55"/>
  </g>`

export const MOCK_ASSETS: Record<string, MockAsset> = {
  'sticker-fringe': {
    key: 'sticker-fringe',
    label: 'Round sticker with white fringe',
    widthPx: 900,
    heightPx: 760,
    hasAlpha: true,
    fullBleed: false,
    background: '',
    artwork: `
      ${STICKER_HALO}
      <circle cx="450" cy="380" r="226" fill="#ff6a3d"/>
      <circle cx="450" cy="380" r="226" fill="none" stroke="#12100e" stroke-width="10"/>
      <text x="450" y="350" text-anchor="middle" font-family="Manrope, sans-serif" font-size="86" font-weight="800" fill="#12100e">DTF</text>
      <text x="450" y="440" text-anchor="middle" font-family="Manrope, sans-serif" font-size="54" fill="#f3efe6">WORKBENCH</text>`,
  },
  'full-bleed-collage': {
    key: 'full-bleed-collage',
    label: 'Full-bleed collage screenshot',
    widthPx: 1200,
    heightPx: 900,
    hasAlpha: false,
    fullBleed: true,
    background: `<rect width="1200" height="900" fill="#1d2b3a"/>`,
    artwork: `
      <rect x="0" y="0" width="600" height="450" fill="#c9463a"/>
      <rect x="600" y="450" width="600" height="450" fill="#e2b23c"/>
      <circle cx="820" cy="250" r="190" fill="#f3efe6"/>
      <path d="M0 900 L400 520 L780 900 Z" fill="#12100e" opacity="0.75"/>
      <rect x="60" y="60" width="1080" height="780" fill="none" stroke="#f3efe6" stroke-width="18"/>`,
  },
  'tall-banner': {
    key: 'tall-banner',
    label: 'Tall vertical banner',
    widthPx: 700,
    heightPx: 2600,
    hasAlpha: false,
    fullBleed: true,
    background: `<rect width="700" height="2600" fill="#0f172a"/>`,
    artwork: `
      <rect x="40" y="40" width="620" height="2520" fill="none" stroke="#ff6a3d" stroke-width="12"/>
      <text x="350" y="360" text-anchor="middle" font-family="Manrope, sans-serif" font-size="120" font-weight="800" fill="#f3efe6">SUMMER</text>
      <text x="350" y="520" text-anchor="middle" font-family="Manrope, sans-serif" font-size="90" fill="#ff6a3d">DROP 01</text>
      <circle cx="350" cy="1250" r="220" fill="#e2b23c"/>
      <circle cx="350" cy="1250" r="120" fill="#0f172a"/>
      <rect x="150" y="1900" width="400" height="120" rx="24" fill="#ff6a3d"/>
      <text x="350" y="2420" text-anchor="middle" font-family="Manrope, sans-serif" font-size="70" fill="#f3efe6">printsheet</text>`,
  },
  'wide-lockup': {
    key: 'wide-lockup',
    label: 'Extra-wide back print lockup',
    widthPx: 1800,
    heightPx: 700,
    hasAlpha: false,
    fullBleed: false,
    background: `<rect width="1800" height="700" fill="#f3efe6"/>`,
    artwork: `
      <rect x="0" y="0" width="1800" height="700" fill="none"/>
      <text x="900" y="330" text-anchor="middle" font-family="Manrope, sans-serif" font-size="190" font-weight="800" fill="#12100e">PRINTSHEET</text>
      <text x="900" y="470" text-anchor="middle" font-family="DM Mono, monospace" font-size="90" fill="#c9463a">WORKBENCH 58CM</text>`,
  },
  'thin-signature': {
    key: 'thin-signature',
    label: 'Thin signature screenshot',
    widthPx: 480,
    heightPx: 160,
    hasAlpha: false,
    fullBleed: false,
    background: `<rect width="480" height="160" fill="#8f8a80"/>`,
    artwork: `
      <path d="M40 110 C110 30 150 130 210 60 C250 10 290 120 350 70 C390 40 420 96 450 60"
        fill="none" stroke="#12100e" stroke-width="4"/>
      <path d="M60 130 L420 130" stroke="#12100e" stroke-width="2" opacity="0.6"/>`,
  },
  'pale-mist': {
    key: 'pale-mist',
    label: 'Pale misty art on white',
    widthPx: 1000,
    heightPx: 800,
    hasAlpha: false,
    fullBleed: false,
    background: `<rect width="1000" height="800" fill="#ffffff"/>`,
    artwork: `
      <defs>
        <radialGradient id="mist" cx="50%" cy="55%" r="60%">
          <stop offset="0%" stop-color="#cfe3f5" stop-opacity="0.95"/>
          <stop offset="55%" stop-color="#e6d6f0" stop-opacity="0.45"/>
          <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="ridge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#9aa7b8"/>
          <stop offset="100%" stop-color="#dfe6ee"/>
        </linearGradient>
      </defs>
      <rect x="60" y="60" width="880" height="680" fill="url(#mist)"/>
      <path d="M120 600 L320 400 L470 560 L640 340 L880 600 Z" fill="url(#ridge)" opacity="0.75"/>
      <circle cx="700" cy="220" r="70" fill="#e2b23c" opacity="0.35"/>`,
  },
  'flat-logo-black': {
    key: 'flat-logo-black',
    label: 'Flat logo on black with margins',
    widthPx: 800,
    heightPx: 800,
    hasAlpha: false,
    fullBleed: false,
    background: `<rect width="800" height="800" fill="#0b0b0b"/>`,
    artwork: `
      <path d="M200 560 L400 200 L600 560 Z" fill="#f3efe6"/>
      <rect x="330" y="420" width="140" height="140" fill="#0b0b0b"/>
      <text x="400" y="700" text-anchor="middle" font-family="Manrope, sans-serif" font-size="72" font-weight="700" fill="#ff6a3d">APEX</text>`,
  },
  'screenshot-mock': {
    key: 'screenshot-mock',
    label: 'Low-quality phone screenshot',
    widthPx: 640,
    heightPx: 900,
    hasAlpha: false,
    fullBleed: false,
    background: `<rect width="640" height="900" fill="#e9e4d8"/>`,
    artwork: `
      <rect x="40" y="40" width="560" height="820" fill="none" stroke="#b7ae9e" stroke-width="4"/>
      <circle cx="320" cy="300" r="140" fill="#12100e"/>
      <text x="320" y="330" text-anchor="middle" font-family="Manrope, sans-serif" font-size="70" fill="#f3efe6">GO</text>
      <rect x="90" y="520" width="460" height="60" rx="12" fill="#c9463a"/>
      <rect x="90" y="620" width="360" height="40" rx="10" fill="#8f8a80"/>
      <rect x="90" y="700" width="300" height="30" rx="8" fill="#b7ae9e"/>`,
  },
}

export function assetSize(assetKey: string): MockAssetSize {
  const asset = MOCK_ASSETS[assetKey] ?? MOCK_ASSETS['sticker-fringe']
  return { widthPx: asset.widthPx, heightPx: asset.heightPx }
}

function maskLayerFor(asset: MockAsset): string {
  // Coverage is approximated by flattening the artwork to solid white, which is
  // what a binary alpha mask looks like when inspected in Photoshop.
  const shapes = asset.artwork
    .replace(/stop-color="[^"]*"/g, 'stop-color="#ffffff"')
    .replace(/stop-opacity="[^"]*"/g, 'stop-opacity="1"')
    .replace(/fill="none"/g, 'fill="#000000"')
    .replace(/(fill|stroke)="#[0-9a-fA-F]{3,8}"/g, (_m, attr: string) => `${attr}="#ffffff"` )
  return `<rect width="${asset.widthPx}" height="${asset.heightPx}" fill="#000000"/>${shapes}`
}

/** Renders the requested variant, optionally restricted to a pixel window. */
export function renderAssetSvg(
  assetKey: string,
  variant: MockAssetVariant = 'with-bg',
  viewBox?: ViewBoxRect | null,
): string {
  const asset = MOCK_ASSETS[assetKey] ?? MOCK_ASSETS['sticker-fringe']
  const box = viewBox ?? { x: 0, y: 0, width: asset.widthPx, height: asset.heightPx }
  const width = Math.max(1, Math.round(box.width))
  const height = Math.max(1, Math.round(box.height))
  const body =
    variant === 'mask'
      ? maskLayerFor(asset)
      : variant === 'transparent'
        ? asset.artwork
        : `${asset.background}${asset.artwork}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box.x} ${box.y} ${width} ${height}">${body}</svg>`
}

export const MOCK_ASSET_KEYS = Object.keys(MOCK_ASSETS)
