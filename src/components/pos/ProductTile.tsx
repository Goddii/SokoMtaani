import { Check } from 'lucide-react'
import type { ApiProduct } from '../../lib/api'
import { fmtKES, fmtNum } from '../../lib/format'
import { CATEGORY_META } from './posMeta'
import { cn } from '../../lib/utils'

interface Props {
  product: ApiProduct
  selected: boolean
  inCartQty: number
  disabled: boolean
  /** True when the product sells through fixed-price buttons (no single price). */
  hasButtons?: boolean
  onTap: () => void
}

/**
 * Tappable product card on the till. Deliberately shows NO cost or margin
 * data — cost intelligence is the owner's, on the Dashboard/Products/Batches
 * screens. The attendant sees price, stock and availability only.
 */
export function ProductTile({ product, selected, inCartQty, disabled, hasButtons, onTap }: Props) {
  const meta = CATEGORY_META[product.category]
  const Icon = meta.icon
  const counted = product.pricing_mode === 'counted'
  // Legacy counted products (options without amounts) show estimate stock;
  // tracked counted products show exact on-hand like weighed ones.
  const estimateStock = counted && (product.price_buttons ?? []).some((b) => b.kg_amount == null)
  const low = product.is_low_stock
  const out = product.total_stock <= 0

  const priceLabel = hasButtons
    ? `fixed prices, tap to choose`
    : `${fmtKES(product.sell_price)} per ${product.base_unit}`

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      aria-label={`Add ${product.name}, ${priceLabel}${selected ? `, ${fmtNum(inCartQty)} in cart` : ''}`}
      className={cn(
        'group relative flex min-h-[108px] flex-col rounded-xl border bg-white p-3 text-left transition-all duration-150',
        'active:scale-[0.98]',
        selected
          ? 'border-brand-600 ring-2 ring-brand-600/25'
          : 'border-ink-200 hover:border-ink-300 hover:shadow-sm',
        out ? 'opacity-45' : 'hover:-translate-y-px',
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn('flex size-8 items-center justify-center rounded-lg', meta.tile)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex items-center gap-1">
          {low && !out && (
            <span className="size-2 animate-pulse rounded-full bg-danger-600" title="Low stock" aria-hidden />
          )}
          {selected && (
            <span className="flex size-5 items-center justify-center rounded-full bg-brand-600 text-white">
              <Check className="size-3" strokeWidth={3} aria-hidden />
            </span>
          )}
        </span>
      </div>

      <p className="mt-2.5 truncate text-[15px] font-bold leading-tight text-ink-900">{product.name}</p>

      <div className="mt-auto flex items-baseline gap-1 pt-2">
        {hasButtons ? (
          <span
            className="inline-flex items-center rounded-md bg-ink-100 px-2 py-0.5 text-xs font-bold tracking-widest text-ink-700"
            title="Fixed prices — tap to choose"
          >
            ···
          </span>
        ) : (
          <>
            <span className={cn('text-[15px] font-extrabold tabular', out ? 'text-ink-400' : 'text-ink-900')}>
              {fmtKES(product.sell_price)}
            </span>
            <span className="text-xs font-medium text-ink-400">/ {product.base_unit}</span>
          </>
        )}
      </div>
      <p className={cn('mt-0.5 text-xs font-medium', out ? 'text-ink-400' : low ? 'text-danger-600' : 'text-ink-400')}>
        {out
          ? counted
            ? 'No open batch'
            : 'Out of stock'
          : low
            ? `Low — ${estimateStock ? '~' : ''}${fmtNum(product.total_stock)} ${product.base_unit} left`
            : `${estimateStock ? '~' : ''}${fmtNum(product.total_stock)} ${product.base_unit} in stock`}
      </p>
    </button>
  )
}
