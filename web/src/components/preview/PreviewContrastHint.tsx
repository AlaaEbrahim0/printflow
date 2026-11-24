import { Banner } from '../ui/Banner'
import { contrastingBackground, isInvisibleOnPreview } from '../../lib/previewContrast'
import type { PreviewBackground } from '../../lib/preview'

export interface PreviewContrastHintProps {
  /** Dominant opaque colour of the layer on the canvas, or null when unknown. */
  inkHex: string | null
  background: PreviewBackground
  onUseContrasting: (background: PreviewBackground) => void
}

/**
 * Explains a preview that looks empty because the ink and the surface are the
 * same colour.
 *
 * This is the difference between "the cut-out failed" and "the cut-out is fine,
 * you are looking at white on white". A white-ink design is ordinary DTF work,
 * so the page must never leave an operator to guess — but it also must not
 * silently switch the background, because the garment colour is the operator's
 * choice. It states the measurement and offers the one click that reveals the
 * artwork.
 */
export function PreviewContrastHint({
  inkHex,
  background,
  onUseContrasting,
}: PreviewContrastHintProps) {
  if (!isInvisibleOnPreview(inkHex, background)) return null

  const target = contrastingBackground(inkHex)
  return (
    <Banner kind="warn" title="This preview is hiding the artwork">
      <span data-testid="preview-contrast-hint">
        The ink is <span className="mono">{inkHex}</span>, almost the same colour as the{' '}
        {background.kind} preview, so the cut-out looks empty even though it is intact.{' '}
        <button
          type="button"
          className="btn sm"
          onClick={() => onUseContrasting(target)}
          data-testid="preview-contrast-fix"
        >
          Show it on {target.kind}
        </button>
      </span>
    </Banner>
  )
}
