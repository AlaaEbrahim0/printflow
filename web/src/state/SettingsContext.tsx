import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type AppSettings } from '../api/client'
import { WORKBENCH_DEFAULTS } from '../lib/defaults'
import type { DpiThresholds } from '../lib/units'

export interface SettingsContextValue {
  settings: AppSettings
  usingDefaults: boolean
  loading: boolean
  error: unknown
  reload: () => void
  save: (next: AppSettings) => Promise<void>
  dpiThresholds: DpiThresholds
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(WORKBENCH_DEFAULTS)
  const [usingDefaults, setUsingDefaults] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)

  const reload = useCallback(() => {
    setLoading(true)
    api.settings
      .get()
      .then((next) => {
        setSettings(next)
        setUsingDefaults(false)
        setError(null)
      })
      .catch((caught: unknown) => setError(caught))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const save = useCallback(async (next: AppSettings) => {
    const saved = await api.settings.update(next)
    setSettings(saved)
    setUsingDefaults(false)
  }, [])

  const value: SettingsContextValue = {
    settings,
    usingDefaults,
    loading,
    error,
    reload,
    save,
    dpiThresholds: {
      warnBelow: settings.dpiWarnBelow,
      strongWarnBelow: settings.dpiStrongWarnBelow,
    },
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings must be used inside SettingsProvider')
  return context
}
