import { useState, type FormEvent } from 'react'
import { api } from '../../api/client'
import { ApiError } from '../../api/problem'
import type { BatchSummary } from '../../api/client'
import { useSettings } from '../../state/SettingsContext'
import { Dialog } from '../ui/Dialog'
import { ErrorBanner } from '../ui/Banner'
import { NumberField, TextField } from '../ui/Field'
import { formatCentimeters } from '../../lib/format'
import { usableRollWidthCm } from '../../lib/units'
import { CONTRACT_RANGES, checkRange } from './contractRanges'
import './batch.css'

interface BatchForm {
  name: string
  rollWidthCm: number | null
  marginMm: number | null
  edgeMarginMm: number | null
  workingDpi: number | null
}

export interface CreateBatchDialogProps {
  onClose: () => void
  onCreated: (batch: BatchSummary) => void
}

export function CreateBatchDialog({ onClose, onCreated }: CreateBatchDialogProps) {
  const { settings } = useSettings()
  const [form, setForm] = useState<BatchForm>({
    name: '',
    rollWidthCm: settings.defaultRollWidthCm,
    marginMm: settings.defaultMarginMm,
    edgeMarginMm: settings.defaultEdgeMarginMm,
    workingDpi: settings.workingDpi,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [submitting, setSubmitting] = useState(false)

  const set = (patch: Partial<BatchForm>) => setForm((previous) => ({ ...previous, ...patch }))

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {}
    const trimmed = form.name.trim()
    if (trimmed.length < CONTRACT_RANGES.name.minLength) {
      next.name = 'A batch name is required'
    } else if (trimmed.length > CONTRACT_RANGES.name.maxLength) {
      next.name = `Batch name must be ${CONTRACT_RANGES.name.maxLength} characters or fewer`
    }
    for (const [field, label, min, max, integer] of [
      ['rollWidthCm', 'Roll width (cm)', CONTRACT_RANGES.rollWidthCm.min, CONTRACT_RANGES.rollWidthCm.max, false],
      ['marginMm', 'Margin (mm)', CONTRACT_RANGES.marginMm.min, CONTRACT_RANGES.marginMm.max, false],
      ['edgeMarginMm', 'Edge margin (mm)', CONTRACT_RANGES.edgeMarginMm.min, CONTRACT_RANGES.edgeMarginMm.max, false],
      ['workingDpi', 'Working DPI', CONTRACT_RANGES.workingDpi.min, CONTRACT_RANGES.workingDpi.max, true],
    ] as const) {
      const message = checkRange(label, form[field], min, max, { integer })
      if (message) next[field] = message
    }
    if (!next.rollWidthCm && !next.edgeMarginMm && form.rollWidthCm !== null && form.edgeMarginMm !== null) {
      const usableNow = usableRollWidthCm(form.rollWidthCm, form.edgeMarginMm)
      if (usableNow <= 0) {
        next.edgeMarginMm = `Edge margins leave no printable width — usable width is ${formatCentimeters(usableNow)}`
      }
    }
    return next
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const found = validate()
    setErrors(found)
    setError(null)
    if (Object.keys(found).length > 0) return
    setSubmitting(true)
    try {
      const created = await api.batches.create({
        name: form.name.trim(),
        rollWidthCm: form.rollWidthCm,
        marginMm: form.marginMm,
        edgeMarginMm: form.edgeMarginMm,
        workingDpi: form.workingDpi,
      })
      onCreated(created)
    } catch (caught: unknown) {
      // The server keeps the last word: show its code and field errors.
      setError(caught)
      if (caught instanceof ApiError && Object.keys(caught.fieldErrors).length > 0) {
        setErrors(Object.fromEntries(
          Object.entries(caught.fieldErrors).map(([field, messages]) => [field, messages.join(', ')]),
        ))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const usable =
    form.rollWidthCm !== null && form.edgeMarginMm !== null
      ? usableRollWidthCm(form.rollWidthCm, form.edgeMarginMm)
      : null

  return (
    <Dialog title="New batch" onClose={onClose} describedBy="create-batch-help">
      <p className="hint" id="create-batch-help">
        Geometry and working DPI are snapshotted onto the batch when it is created. Changing the shop
        defaults later never rewrites this batch.
      </p>
      <form className="stack" onSubmit={submit} data-testid="create-batch-form">
        <TextField
          label="Batch name"
          value={form.name}
          placeholder="ACME summer drop 02"
          onChange={(event) => set({ name: event.target.value })}
          error={errors.name ?? null}
          autoFocus
        />
        <div className="field set">
          <NumberField
            label="Roll width"
            suffix="cm"
            value={form.rollWidthCm}
            min={CONTRACT_RANGES.rollWidthCm.min}
            max={CONTRACT_RANGES.rollWidthCm.max}
            step={0.1}
            onValueChange={(value) => set({ rollWidthCm: value })}
            error={errors.rollWidthCm ?? null}
            hint={`${CONTRACT_RANGES.rollWidthCm.min}–${CONTRACT_RANGES.rollWidthCm.max} cm`}
          />
          <NumberField
            label="Design gap"
            suffix="mm"
            value={form.marginMm}
            min={CONTRACT_RANGES.marginMm.min}
            max={CONTRACT_RANGES.marginMm.max}
            step={1}
            onValueChange={(value) => set({ marginMm: value })}
            error={errors.marginMm ?? null}
            hint="minimum visible gap between designs"
          />
          <NumberField
            label="Edge margin"
            suffix="mm"
            value={form.edgeMarginMm}
            min={CONTRACT_RANGES.edgeMarginMm.min}
            max={CONTRACT_RANGES.edgeMarginMm.max}
            step={1}
            onValueChange={(value) => set({ edgeMarginMm: value })}
            error={errors.edgeMarginMm ?? null}
            hint="gap from the sheet edge"
          />
          <NumberField
            label="Working DPI"
            suffix="dpi"
            value={form.workingDpi}
            min={CONTRACT_RANGES.workingDpi.min}
            max={CONTRACT_RANGES.workingDpi.max}
            step={1}
            onValueChange={(value) => set({ workingDpi: value })}
            error={errors.workingDpi ?? null}
            hint={`${CONTRACT_RANGES.workingDpi.min}–${CONTRACT_RANGES.workingDpi.max}, whole number`}
          />
        </div>
        {usable !== null ? (
          <p className="mono dim" data-testid="usable-width">
            usable print width {formatCentimeters(usable)}
          </p>
        ) : null}
        {error ? <ErrorBanner error={error} title="The API refused the batch" /> : null}
        <div className="row row-end">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={submitting} data-testid="create-batch-submit">
            {submitting ? 'Creating…' : 'Create batch'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
