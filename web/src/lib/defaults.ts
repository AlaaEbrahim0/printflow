import type { AppSettings } from '../api/client'

/**
 * Defaults mirror ARCHITECTURE §14 and are shared by the settings screen, the
 * settings context fallback and the mock API, so nothing drifts.
 */
export const WORKBENCH_DEFAULTS: AppSettings = {
  workingDpi: 300,
  defaultRollWidthCm: 58,
  defaultMarginMm: 30,
  defaultEdgeMarginMm: 0,
  dpiWarnBelow: 150,
  dpiStrongWarnBelow: 100,
  pricePerCm: 0.85,
  currency: 'EUR',
  packer: {
    alphaThreshold: 5,
    cellMm: 5,
    randomizedOrderings: 30,
    timeBudgetMs: 20000,
  },
}
