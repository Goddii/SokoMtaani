import { Minus, Plus } from 'lucide-react'
import type { Unit } from '../../lib/types'
import { decimalsFor, stepFor } from './posMeta'
import { clamp } from '../../lib/utils'

interface Props {
  qty: number
  unit: Unit
  max: number
  onChange: (qty: number) => void
  compact?: boolean
}

export function QuantityStepper({ qty, unit, max, onChange, compact }: Props) {
  const step = stepFor(unit)
  const decimals = decimalsFor(unit)

  const set = (v: number) => {
    const next = clamp(Math.round(v * 10 ** decimals) / 10 ** decimals, 0, max)
    onChange(next)
  }

  const minusDisabled = qty <= 0
  const plusDisabled = qty >= max

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => set(qty - step)}
        disabled={minusDisabled}
        aria-label={`Decrease quantity by ${step}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-700 transition-colors hover:bg-ink-50 active:bg-ink-100 disabled:opacity-35"
      >
        <Minus className="size-3.5" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="decimal"
        value={qty}
        min={0}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          set(Number.isFinite(v) ? v : 0)
        }}
        aria-label="Quantity"
        className={cnInput(compact)}
      />
      <button
        type="button"
        onClick={() => set(qty + step)}
        disabled={plusDisabled}
        aria-label={`Increase quantity by ${step}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-700 transition-colors hover:bg-ink-50 active:bg-ink-100 disabled:opacity-35"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

function cnInput(compact?: boolean): string {
  return [
    'tabular h-8 w-14 rounded-lg border border-ink-300 bg-white text-center text-sm font-bold text-ink-900',
    'focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none',
    compact ? '' : 'w-16',
  ].join(' ')
}
