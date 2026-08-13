import { Banknote, ShoppingBag, Smartphone, Trash2, WifiOff } from 'lucide-react'
import type { PaymentMethod } from '../../lib/types'
import type { ApiPriceButton, ApiProduct } from '../../lib/api'
import { fmtKES } from '../../lib/format'
import { lineBaseQty, lineTotal } from './posMeta'
import { QuantityStepper } from './QuantityStepper'
import { cn } from '../../lib/utils'

export interface CartLine {
  /** Stable identity for React keys and qty/remove callbacks. */
  id: number
  product: ApiProduct
  /**
   * Button line: how many times the selling button is sold ("1 tomato @
   * KSh5" x3 → count 3, consumes 3 × amount). Flat line: base-unit qty.
   */
  count: number
  /** Present when the line was sold at a fixed-price button. */
  button?: ApiPriceButton
}

interface Props {
  lines: CartLine[]
  payment: PaymentMethod
  onPaymentChange: (p: PaymentMethod) => void
  onQtyChange: (lineId: number, qty: number) => void
  onRemove: (lineId: number) => void
  onClear: () => void
  onCharge: () => void
  offline: boolean
}

export function CartPanel({ lines, payment, onPaymentChange, onQtyChange, onRemove, onClear, onCharge, offline }: Props) {
  const total = lines.reduce(
    (s, l) => s + lineTotal(lineBaseQty(l.count, l.button), l.product.sell_price, l.button, l.product.pricing_mode),
    0,
  )
  const itemCount = lines.length
  const empty = itemCount === 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <ShoppingBag className="size-4.5 text-ink-500" aria-hidden />
          <h2 className="text-sm font-bold text-ink-900">Current sale</h2>
          {itemCount > 0 && (
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-bold text-ink-600 tabular">
              {itemCount}
            </span>
          )}
        </div>
        {!empty && (
          <button
            type="button"
            onClick={onClear}
            className="rounded-md px-2 py-1 text-xs font-semibold text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            Clear
          </button>
        )}
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-ink-100 text-ink-400">
            <ShoppingBag className="size-5" aria-hidden />
          </div>
          <p className="text-sm font-semibold text-ink-700">Cart is empty</p>
          <p className="text-[13px] leading-relaxed text-ink-500">
            Tap a product on the left to add it. Quantities adjust by kg, litre or piece.
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
          {lines.map((l) => {
            const isButton = l.button != null
            // Button lines show the fixed price × count — the attendant never
            // does qty × rate math, weighed or counted.
            const lineAmount = lineTotal(
              lineBaseQty(l.count, l.button),
              l.product.sell_price,
              l.button,
              l.product.pricing_mode,
            )
            // Base-unit stock available for THIS line: on-hand minus what
            // other lines of the same product already hold. Capping here
            // means an attendant can never step a line past the shelf.
            const reserved = lines
              .filter((o) => o.product.id === l.product.id && o.id !== l.id)
              .reduce((s, o) => s + lineBaseQty(o.count, o.button), 0)
            const maxBaseQty = Math.max(0, l.product.total_stock - reserved)
            return (
              <li key={l.id} className="flex flex-col gap-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-ink-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink-900">{l.product.name}</p>
                    <p className="truncate text-xs text-ink-500">
                      {isButton ? l.button!.label : `${fmtKES(l.product.sell_price)} / ${l.product.base_unit}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <p className="text-sm font-extrabold tabular text-ink-900">{fmtKES(lineAmount)}</p>
                    <button
                      type="button"
                      onClick={() => onRemove(l.id)}
                      aria-label={`Remove ${l.product.name}${isButton ? ` (${l.button!.label})` : ''} from cart`}
                      className="rounded-md p-1 text-ink-300 transition-colors hover:bg-danger-50 hover:text-danger-600"
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
                {isButton ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-ink-400">
                      ×{l.count} at fixed price
                      {l.count > 1 && (
                        <span className="text-ink-500"> · {fmtKES(l.button!.price * l.count)}</span>
                      )}
                    </span>
                    <QuantityStepper
                      qty={l.count}
                      unit="piece"
                      max={
                        l.button!.kg_amount != null
                          ? Math.floor(maxBaseQty / l.button!.kg_amount)
                          : Number.MAX_SAFE_INTEGER
                      }
                      onChange={(c) => onQtyChange(l.id, c)}
                      compact
                    />
                  </div>
                ) : (
                  <QuantityStepper
                    qty={l.count}
                    unit={l.product.base_unit}
                    max={maxBaseQty}
                    onChange={(q) => onQtyChange(l.id, q)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="space-y-3 border-t border-ink-200 px-4 py-4">
        <div>
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-ink-400">Payment</p>
          <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-ink-100 p-1">
            {(
              [
                { value: 'mpesa', label: 'M-Pesa', icon: Smartphone },
                { value: 'cash', label: 'Cash', icon: Banknote },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => onPaymentChange(opt.value)}
                aria-pressed={payment === opt.value}
                className={cn(
                  'flex h-9 items-center justify-center gap-1.5 rounded-md text-[13px] font-semibold transition-all',
                  payment === opt.value
                    ? 'bg-white text-ink-900 shadow-sm ring-1 ring-ink-200'
                    : 'text-ink-500 hover:text-ink-800',
                )}
              >
                <opt.icon className="size-4" aria-hidden />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-sm font-medium text-ink-500">Total</span>
          <span className="text-xl font-extrabold tabular tracking-tight text-ink-900">{fmtKES(total)}</span>
        </div>

        {offline && (
          <p className="flex items-center gap-1.5 rounded-lg bg-warning-50 px-3 py-2 text-xs font-semibold text-warning-700">
            <WifiOff className="size-3.5 shrink-0" aria-hidden />
            Offline — this sale will queue and sync later.
          </p>
        )}

        <button
          type="button"
          onClick={onCharge}
          disabled={empty}
          className="flex h-13 w-full items-center justify-center rounded-xl bg-brand-700 text-[15px] font-bold text-white shadow-sm transition-all hover:bg-brand-800 active:scale-[0.99] disabled:opacity-40 disabled:shadow-none"
        >
          Charge {empty ? '' : fmtKES(total)}
        </button>
      </div>
    </div>
  )
}
