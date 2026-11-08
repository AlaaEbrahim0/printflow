import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

function Wrapper({
  label,
  hint,
  error,
  children,
  id,
}: {
  label: string
  hint?: ReactNode
  error?: string | null
  children: ReactNode
  id: string
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}

export interface NumberFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  label: string
  value: number | null | undefined
  onValueChange: (value: number | null) => void
  hint?: ReactNode
  error?: string | null
  suffix?: string
}

export function NumberField({
  label,
  value,
  onValueChange,
  hint,
  error,
  id,
  suffix,
  ...rest
}: NumberFieldProps) {
  const fieldId = id ?? `field-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Wrapper label={label} hint={hint} error={error} id={fieldId}>
      <div className="row" style={{ gap: 6 }}>
        <input
          id={fieldId}
          type="number"
          inputMode="decimal"
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(event) => {
            const raw = event.target.value
            if (raw === '') {
              onValueChange(null)
              return
            }
            const parsed = Number(raw)
            onValueChange(Number.isFinite(parsed) ? parsed : null)
          }}
          {...rest}
        />
        {suffix ? <span className="dim mono">{suffix}</span> : null}
      </div>
    </Wrapper>
  )
}

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: ReactNode
  error?: string | null
}

export function TextField({ label, hint, error, id, ...rest }: TextFieldProps) {
  const fieldId = id ?? `field-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Wrapper label={label} hint={hint} error={error} id={fieldId}>
      <input id={fieldId} type="text" {...rest} />
    </Wrapper>
  )
}

export interface ColorFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: ReactNode
}

export function ColorField({ label, hint, id, ...rest }: ColorFieldProps) {
  const fieldId = id ?? `field-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Wrapper label={label} hint={hint} id={fieldId}>
      <input id={fieldId} type="color" {...rest} />
    </Wrapper>
  )
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string
  options: readonly { value: string; label: string }[]
  hint?: ReactNode
  error?: string | null
}

export function SelectField({ label, options, hint, error, id, ...rest }: SelectFieldProps) {
  const fieldId = id ?? `field-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Wrapper label={label} hint={hint} error={error} id={fieldId}>
      <select id={fieldId} {...rest}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Wrapper>
  )
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  id,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  hint?: ReactNode
  id?: string
}) {
  const fieldId = id ?? `field-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className="field">
      <label htmlFor={fieldId} className="row" style={{ gap: 8 }}>
        <input
          id={fieldId}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}
