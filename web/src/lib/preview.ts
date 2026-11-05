import type { CSSProperties } from 'react'
import type { GarmentColor } from '../api/client'

/**
 * Preview honesty (ARCHITECTURE §9): transparency is always composited over a
 * background the operator chose. Checkerboard is the default — never a hidden
 * white. Switching the background must never change the image source.
 */
export type PreviewBackgroundKind = 'checkerboard' | 'white' | 'black' | 'custom'

export interface PreviewBackground {
  kind: PreviewBackgroundKind
  /** Only meaningful when kind is `custom`. */
  hex: string
}

export const PRESET_GARMENT_COLORS = [
  { label: 'White garment', hex: '#ffffff' },
  { label: 'Black garment', hex: '#000000' },
  { label: 'Ash grey', hex: '#b9b6ae' },
  { label: 'Navy', hex: '#1b2a4a' },
  { label: 'Red', hex: '#8c1d1d' },
] as const

export const CHECKER_LIGHT = '#d5d1c8'
export const CHECKER_DARK = '#8f8a80'
export const CHECKER_CELL_PX = 12

export const DEFAULT_PREVIEW_BACKGROUND: PreviewBackground = {
  kind: 'checkerboard',
  hex: '#ffffff',
}

export function isHexColor(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
}

export function normalizeHex(value: string): string {
  const trimmed = value.trim()
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
  return isHexColor(withHash) ? withHash.toLowerCase() : '#ffffff'
}

export function previewBackgroundFor(
  garmentColor: GarmentColor | null | undefined,
): PreviewBackground {
  if (!garmentColor) return DEFAULT_PREVIEW_BACKGROUND
  if (garmentColor.kind === 'light') return { kind: 'white', hex: '#ffffff' }
  if (garmentColor.kind === 'dark') return { kind: 'black', hex: '#000000' }
  const hex = isHexColor(garmentColor.hex ?? undefined) ? garmentColor.hex!.toLowerCase() : '#ff00ff'
  return { kind: 'custom', hex }
}

export function backgroundToGarmentColor(
  background: PreviewBackground,
): GarmentColor {
  if (background.kind === 'white') return { kind: 'light' }
  if (background.kind === 'black') return { kind: 'dark' }
  if (background.kind === 'custom') return { kind: 'custom', hex: background.hex }
  // Checkerboard is a view mode, not a garment color; report the neutral default.
  return { kind: 'light' }
}

/** CSS for the compositing surface behind the immutable RGBA file. */
export function backgroundStyle(
  background: PreviewBackground,
  cellPx: number = CHECKER_CELL_PX,
): CSSProperties {
  if (background.kind !== 'checkerboard') {
    return { backgroundColor: background.hex }
  }
  const half = cellPx / 2
  return {
    backgroundColor: CHECKER_LIGHT,
    backgroundImage: `linear-gradient(45deg, ${CHECKER_DARK} 25%, transparent 25%), linear-gradient(-45deg, ${CHECKER_DARK} 25%, transparent 25%), linear-gradient(45deg, transparent 75%, ${CHECKER_DARK} 75%), linear-gradient(-45deg, transparent 75%, ${CHECKER_DARK} 75%)`,
    backgroundSize: `${cellPx}px ${cellPx}px`,
    backgroundPosition: `0 0, 0 ${half}px, ${-half}px ${-half}px, ${-half}px 0px`,
  }
}

export const BACKGROUND_LABELS: Record<PreviewBackgroundKind, string> = {
  checkerboard: 'Checkerboard',
  white: 'White',
  black: 'Black',
  custom: 'Custom',
}
