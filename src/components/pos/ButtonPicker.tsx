import { Minus, Plus, Tag, X } from 'lucide-react'
import type { ApiPriceButton, ApiProduct } from '../../lib/api'
import { fmtKES, fmtNum } from '../../lib/format'
import { cn } from '../../lib/utils'

interface Props {
  /** The product whose buttons are being picked; null hides the picker. */
  product: ApiProduct | null
  /** How many times each button is currently in the cart (buttonId → count). */
  counts: Record<number, number>
  /**
   * Max count a button can take from the stock on hand (null = untracked
   * legacy button — no cap). Used to disable the + control / sold-out rows.
   */
  maxCountFor: (button: ApiPriceButton) => number | null
  /** Add a line for this button at `count` (consolidating identical taps). */
  onAdd: (button: ApiPriceButton, count: number) => void
  /** Set a button's count; 0 removes its cart line. */
  onChangeCount: (button: ApiPriceButton, count: number) => void
  onClose: () => void
}

/**
 * Fixed-price button picker for the POS — used by BOTH pricing modes.
 * Mobile: bottom sheet. Desktop: centered modal.
 *
 * PRICE BUTTON = what is being sold · COUNT = how many times.
 * Tapping a button adds it to the cart at count 1 and expands it in place
 * with a −/+ count control and the running total — no repeated tapping to
 * sell "3 × 1 tomato @ KSh5". Identical buttons consolidate into one line;
 * different buttons stay separate lines (different pricing rules).
 */
export function ButtonPicker({ product, counts, maxCountFor, onAdd, onChangeCount, onClose }: Props) {
  if (!product) return null
  const buttons = product.price_buttons ?? []
  const counted = product.pricing_mode === 'counted'

  const totalCount = Object.values(counts).reduce((s, c) => s + c, 0)
  const totalKes = buttons.reduce((s, b) => s + (counts[b.id] ?? 0) * b.price, 0)

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Choose a price for ${product.name}`}>
      <div className="absolute inset-0 bg-ink-950/40" onClick={onClose} aria-hidden />

      <div className="absolute inset-x-0 bottom-0 max-h-[80dvh] animate-[sheet-up_240ms_cubic-bezier(0.16,1,0.3,1)] overflow-hidden rounded-t-2xl bg-white shadow-docked sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[400px] sm:max-h-none sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-none sm:rounded-2xl">
        <div className="flex justify-center pt-2.5 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-ink-200" aria-hidden />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Tag className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-bold leading-tight text-ink-900">{product.name}</h2>
              <p className="text-xs font-medium text-ink-500">
                {counted
                  ? 'Sold by piece — tap a price, then use + for more'
                  : 'Tap a price, then use + for more'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close price picker"
            className="rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-100"
          >
            <X className="size-4.5" aria-hidden />
          </button>
        </div>

        {/* Buttons */}
        <div className="max-h-[52dvh] overflow-y-auto p-3 scrollbar-thin sm:max-h-none">
          <ul className="space-y-2">
            {buttons.map((button) => {
              const count = counts[button.id] ?? 0
              const amount = button.kg_amount
              const max = maxCountFor(button)
              const soldOut = amount != null && max != null && max <= 0 && count === 0

              if (count > 0) {
                // In the cart — the row expands with a count control and the
                // running total (count × fixed price).
                return (
                  <li
                    key={button.id}
                    className="rounded-xl border border-brand-600 bg-brand-50/40 px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-bold text-ink-900">{button.label}</p>
                        <p className="text-xs font-medium text-ink-500">
                          {count} {count === 1 ? 'time' : 'times'} at {fmtKES(button.price)}
                          {amount != null && ` · ${fmtNum(amount)} ${product.base_unit} each`}
                        </p>
                      </div>
                      <span className="shrink-0 text-[15px] font-extrabold tabular text-ink-900">
                        {fmtKES(button.price)}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onChangeCount(button, count - 1)}
                          aria-label={`Remove one ${button.label} from the sale`}
                          className="flex size-9 items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-700 transition-colors hover:bg-ink-100 active:scale-[0.97]"
                        >
                          <Minus className="size-4" aria-hidden />
                        </button>
                        <span
                          className="w-9 text-center text-[15px] font-extrabold tabular text-ink-900"
                          aria-label={`Count ${count}`}
                        >
                          {count}
                        </span>
                        <button
                          type="button"
                          onClick={() => onChangeCount(button, count + 1)}
                          disabled={max != null && count >= max}
                          aria-label={`Add another ${button.label} to the sale`}
                          className="flex size-9 items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-700 transition-colors hover:bg-ink-100 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          <Plus className="size-4" aria-hidden />
                        </button>
                      </div>
                      <p className="text-[13px] font-bold text-ink-700">
                        Total <span className="tabular font-extrabold text-ink-900">{fmtKES(button.price * count)}</span>
                      </p>
                    </div>
                  </li>
                )
              }

              // Not in the cart — plain tap-to-add row.
              return (
                <li key={button.id}>
                  <button
                    type="button"
                    onClick={() => onAdd(button, 1)}
                    disabled={soldOut}
                    aria-label={`${button.label}, ${fmtKES(button.price)}`}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-all duration-150',
                      soldOut
                        ? 'cursor-not-allowed border-ink-200 bg-ink-50 opacity-50'
                        : 'border-ink-200 bg-white hover:border-brand-600 hover:shadow-sm active:scale-[0.99]',
                    )}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-bold text-ink-900">{button.label}</p>
                      <p className="text-xs font-medium text-ink-500">
                        {soldOut
                          ? 'Not enough stock on hand'
                          : amount != null
                            ? `${fmtNum(amount)} ${product.base_unit} at a fixed price`
                            : 'Fixed price — not tracked against stock'}
                      </p>
                    </div>
                    <span className="shrink-0 text-[15px] font-extrabold tabular text-ink-900">
                      {fmtKES(button.price)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Footer — live in-cart total + Done */}
        <div className="flex items-center justify-between gap-3 border-t border-ink-200 px-4 py-3">
          <div>
            <p className="text-xs font-semibold text-ink-500">
              {totalCount > 0 ? `${totalCount} in cart` : 'Nothing added yet'}
            </p>
            <p className="text-base font-extrabold tabular tracking-tight text-ink-900">{fmtKES(totalKes)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl bg-brand-700 px-5 text-[15px] font-bold text-white shadow-sm transition-colors hover:bg-brand-800 active:scale-[0.99]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
