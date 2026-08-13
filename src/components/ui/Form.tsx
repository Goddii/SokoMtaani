import { ChevronDown } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const FIELD_BASE =
  'h-10 w-full rounded-lg border border-ink-300 bg-white px-3 text-[15px] text-ink-900 placeholder:text-ink-400 ' +
  'focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none transition-colors disabled:opacity-50'

interface FieldShellProps {
  label?: ReactNode
  error?: string
  hint?: string
  required?: boolean
  children: ReactNode
  id?: string
}

function FieldShell({ label, error, hint, required, children, id }: FieldShellProps) {
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-[13px] font-semibold text-ink-700">
          {label}
          {required && <span className="ml-0.5 text-danger-600">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[13px] font-medium text-danger-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[13px] text-ink-500">{hint}</p>
      ) : null}
    </div>
  )
}

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode
  error?: string
  hint?: string
}

export function TextField({ label, error, hint, required, id, className, ...rest }: TextFieldProps) {
  return (
    <FieldShell label={label} error={error} hint={hint} required={required} id={id}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        className={cn(FIELD_BASE, error && 'border-danger-600 focus:border-danger-600 focus:ring-danger-600/15', className)}
        {...rest}
      />
    </FieldShell>
  )
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode
  error?: string
  hint?: string
  options: Array<{ value: string; label: string }>
}

export function SelectField({ label, error, hint, required, id, options, className, ...rest }: SelectFieldProps) {
  return (
    <FieldShell label={label} error={error} hint={hint} required={required} id={id}>
      <div className="relative">
        <select
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          className={cn(FIELD_BASE, 'appearance-none pr-9', error && 'border-danger-600', className)}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-400"
          aria-hidden
        />
      </div>
    </FieldShell>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string; hint?: string }>
  label?: ReactNode
  id?: string
  /** Locks the control — options stay visible but unclickable. */
  disabled?: boolean
}

export function Segmented<T extends string>({ value, onChange, options, label, id, disabled }: SegmentedProps<T>) {
  return (
    <div className="space-y-1.5">
      {label && (
        <span id={id} className="block text-[13px] font-semibold text-ink-700">
          {label}
        </span>
      )}
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="inline-flex rounded-lg border border-ink-300 bg-ink-100 p-0.5"
      >
        {options.map((o) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={cn(
                'h-8 rounded-md px-3.5 text-[13px] font-semibold transition-all duration-150',
                disabled && 'cursor-not-allowed opacity-50',
                selected
                  ? 'bg-white text-ink-900 shadow-sm ring-1 ring-ink-200'
                  : 'text-ink-600 hover:text-ink-800',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
