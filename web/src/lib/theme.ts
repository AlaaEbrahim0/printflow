import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'printsheet.theme'

/**
 * Dark is the default for every new operator: the review page is used in a lit
 * shop next to a printer, and the dark stage makes transparent artwork easier
 * to judge. Deliberately *not* derived from `prefers-color-scheme` — the shop
 * chose dark as the house default, and a workstation with a light OS theme
 * would otherwise open the workbench in a theme nobody asked for. Only an
 * explicit toggle is remembered.
 */
function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') return stored
  } catch {
    // Blocked storage: fall through to the default rather than throwing during
    // the first render.
  }

  return 'dark'
}

export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(initialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // Keep the browser chrome (mobile address bar, scrollbar) in step.
    document.documentElement.style.colorScheme = theme
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Private mode or a blocked storage partition: the theme still applies
      // for this session, it just will not be remembered.
    }
  }, [])

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark'
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // See above.
      }
      return next
    })
  }, [])

  return { theme, setTheme, toggle }
}
