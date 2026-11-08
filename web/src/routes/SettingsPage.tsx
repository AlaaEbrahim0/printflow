import { useEffect, useState, type FormEvent } from 'react'
import { ErrorBanner } from '../components/ui/Banner'
import { NumberField, TextField } from '../components/ui/Field'
import { ErrorState, Loading } from '../components/ui/States'
import { useSettings } from '../state/SettingsContext'
import type { AppSettings } from '../api/client'

export default function SettingsPage() {
  const { settings, usingDefaults, loading, error: loadError, reload, save } = useSettings()
  const [draft, setDraft] = useState<AppSettings>(settings)
  const [saveError, setSaveError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => setDraft(settings), [settings])

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  function updatePacker<K extends keyof AppSettings['packer']>(
    key: K,
    value: AppSettings['packer'][K],
  ) {
    setDraft((current) => ({
      ...current,
      packer: { ...current.packer, [key]: value },
    }))
    setSaved(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      await save(draft)
      setSaved(true)
    } catch (caught: unknown) {
      setSaveError(caught)
    } finally {
      setSaving(false)
    }
  }

  if (loading && loadError) {
    return <ErrorState error={loadError} onRetry={reload} title="Could not load settings" />
  }

  return (
    <section className="stack">
      <header className="page-head">
        <div>
          <h1 className="page-title">Workbench settings</h1>
          <p className="page-subtitle">
            Defaults apply to new batches. Existing batch geometry and working DPI are not rewritten.
          </p>
        </div>
        <button type="button" className="btn" onClick={reload}>Reload settings</button>
      </header>

      {loading ? <Loading label="Loading settings…" rows={2} /> : null}
      {loadError ? <ErrorBanner error={loadError} title="Settings could not be refreshed" /> : null}
      {saveError ? <ErrorBanner error={saveError} title="Settings were not saved" /> : null}
      {saved ? <div className="banner good" role="status">Settings saved.</div> : null}
      {usingDefaults ? (
        <div className="banner warn" role="status">
          The API settings could not be loaded yet; these are local defaults. Saving will send them to the API.
        </div>
      ) : null}

      <form className="stack" onSubmit={submit}>
        <section className="card">
          <h2 className="card-title">Print defaults</h2>
          <div className="field set">
            <NumberField label="Working DPI" suffix="dpi" value={draft.workingDpi} min={72} max={1200} step={1} onValueChange={(value) => value !== null && update('workingDpi', value)} />
            <NumberField label="Default roll width" suffix="cm" value={draft.defaultRollWidthCm} min={1} step={0.1} onValueChange={(value) => value !== null && update('defaultRollWidthCm', value)} />
            <NumberField label="Default design gap" suffix="mm" value={draft.defaultMarginMm} min={0} step={1} onValueChange={(value) => value !== null && update('defaultMarginMm', value)} />
            <NumberField label="Default edge margin" suffix="mm" value={draft.defaultEdgeMarginMm} min={0} step={1} onValueChange={(value) => value !== null && update('defaultEdgeMarginMm', value)} />
            <NumberField label="Price per cm" value={draft.pricePerCm} min={0} step={0.01} onValueChange={(value) => value !== null && update('pricePerCm', value)} />
            <TextField label="Currency" value={draft.currency} maxLength={3} onChange={(event) => update('currency', event.target.value.toUpperCase())} />
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">Source resolution warnings</h2>
          <p className="hint">A strong warning threshold must remain lower than the warning threshold.</p>
          <div className="field set">
            <NumberField label="Warn below" suffix="dpi" value={draft.dpiWarnBelow} min={1} step={1} onValueChange={(value) => value !== null && update('dpiWarnBelow', value)} />
            <NumberField label="Strong warning below" suffix="dpi" value={draft.dpiStrongWarnBelow} min={1} step={1} onValueChange={(value) => value !== null && update('dpiStrongWarnBelow', value)} />
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">Packer defaults</h2>
          <p className="hint">The low alpha threshold keeps faint smoke and soft artwork edges occupied.</p>
          <div className="field set">
            <NumberField label="Alpha threshold" suffix="/255" value={draft.packer.alphaThreshold} min={0} max={255} step={1} onValueChange={(value) => value !== null && updatePacker('alphaThreshold', value)} />
            <NumberField label="Occupancy cell" suffix="mm" value={draft.packer.cellMm} min={0.1} step={0.1} onValueChange={(value) => value !== null && updatePacker('cellMm', value)} />
            <NumberField label="Randomized orderings" value={draft.packer.randomizedOrderings} min={1} step={1} onValueChange={(value) => value !== null && updatePacker('randomizedOrderings', value)} />
            <NumberField label="Time budget" suffix="ms" value={draft.packer.timeBudgetMs} min={100} step={100} onValueChange={(value) => value !== null && updatePacker('timeBudgetMs', value)} />
          </div>
        </section>

        <div className="row row-end">
          <button type="submit" className="btn primary" disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  )
}
