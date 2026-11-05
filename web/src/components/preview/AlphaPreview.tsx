import type { CSSProperties, ReactNode } from 'react'
import { backgroundStyle, type PreviewBackground } from '../../lib/preview'
import './preview.css'

export interface AlphaPreviewProps {
  /** The immutable version file. Switching the background never changes this. */
  fileUrl: string | null | undefined
  alt: string
  background: PreviewBackground
  widthPx?: number
  heightPx?: number
  /** CSS display scaling only; the bytes and the placement math stay untouched. */
  fit?: 'contain' | 'actual'
  cellPx?: number
  className?: string
  testId?: string
  children?: ReactNode
}

export function AlphaPreview({
  fileUrl,
  alt,
  background,
  widthPx,
  heightPx,
  fit = 'contain',
  cellPx,
  className = '',
  testId = 'preview-surface',
  children,
}: AlphaPreviewProps) {
  const surfaceStyle = backgroundStyle(background, cellPx)
  const imageStyle: CSSProperties =
    fit === 'actual' && widthPx && heightPx
      ? { width: widthPx, height: heightPx, maxWidth: 'none' }
      : {}
  return (
    <div
      className={`alpha-preview ${className}`}
      data-testid={testId}
      data-background={background.kind}
      data-background-hex={background.kind === 'custom' ? background.hex : undefined}
      style={surfaceStyle}
    >
      {fileUrl ? (
        <img
          className="alpha-preview-image"
          src={fileUrl}
          alt={alt}
          data-testid="preview-image"
          data-image-src={fileUrl}
          width={widthPx}
          height={heightPx}
          style={imageStyle}
          draggable={false}
        />
      ) : (
        <span className="alpha-preview-missing">no file</span>
      )}
      {children}
    </div>
  )
}
