/**
 * Contract ranges from `contracts/openapi/printsheet-api.yaml` (frozen 1.0.0).
 * Kept in one place so client-side validation mirrors the server instead of
 * inventing numbers: roll 1–500 cm, margins 0–500 mm, working DPI 72–1200,
 * name 1–200 characters, currency exactly 3 characters.
 */
export const CONTRACT_RANGES = {
  name: { minLength: 1, maxLength: 200 },
  rollWidthCm: { min: 1, max: 500 },
  marginMm: { min: 0, max: 500 },
  edgeMarginMm: { min: 0, max: 500 },
  workingDpi: { min: 72, max: 1200 },
  dpiThreshold: { min: 1, max: 1200 },
  pricePerCm: { min: 0, max: 10_000 },
  alphaThreshold: { min: 0, max: 254 },
  cellMm: { min: 0.1, max: 50 },
  randomizedOrderings: { min: 1, max: 1000 },
  timeBudgetMs: { min: 1000, max: 600_000 },
} as const

export function rangeMessage(label: string, min: number, max: number): string {
  return `${label} must be between ${min} and ${max}`
}

export function checkRange(
  label: string,
  value: number | null,
  min: number,
  max: number,
  { integer = false, required = true }: { integer?: boolean; required?: boolean } = {},
): string | null {
  if (value === null || Number.isNaN(value)) {
    return required ? `${label} is required` : null
  }
  if (!Number.isFinite(value)) return `${label} must be a finite number`
  if (integer && !Number.isInteger(value)) return `${label} must be a whole number`
  if (value < min || value > max) return rangeMessage(label, min, max)
  return null
}
