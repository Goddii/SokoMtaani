import type { ApiPriceButton, ApiProduct } from '../../lib/api'
import type { Category } from '../../lib/types'
import { CATEGORY_META, lineBaseQty } from '../../components/pos/posMeta'

export type CatFilter = 'all' | Category

export const CAT_FILTERS: Array<{ value: CatFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'produce', label: CATEGORY_META.produce.label },
  { value: 'dry', label: CATEGORY_META.dry.label },
  { value: 'packaging', label: CATEGORY_META.packaging.label },
]

const LAST_ATTENDANT_KEY = 'soko-mtaani/last-attendant'

export function loadLastAttendant(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ATTENDANT_KEY)
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function saveLastAttendant(id: number) {
  try {
    localStorage.setItem(LAST_ATTENDANT_KEY, String(id))
  } catch {
    // ignore
  }
}

/**
 * One row in the in-memory cart — sold at flat rate or via a fixed-price button.
 *
 * `count` means:
 * - button line: how many times that selling button is being sold ("1 tomato
 *   @ KSh5" x3). The base-unit qty it consumes is `amount × count`. A line
 *   never exists below count 1 — decrementing to 0 removes it.
 * - flat-rate line: the quantity in the product's base unit.
 */
export interface CartLineState {
  id: number
  productId: number
  count: number
  button?: ApiPriceButton
}

/**
 * Max times a button can be sold against a cart snapshot: stock on hand minus
 * what every OTHER line of the product already holds (each sold at its own
 * base-unit qty), divided by the button's amount. null for legacy buttons
 * without an amount — they never deduct stock, so there is no cap.
 */
export function maxCountIn(
  cart: CartLineState[],
  product: ApiProduct,
  button: ApiPriceButton,
  excludeButtonId?: number,
): number | null {
  const amount = button.kg_amount
  if (amount == null) return null
  const otherBase = cart
    .filter((l) => l.productId === product.id && l.button?.id !== (excludeButtonId ?? button.id))
    .reduce((s, l) => s + lineBaseQty(l.count, l.button), 0)
  const remaining = Math.max(0, product.total_stock - otherBase)
  return Math.floor(remaining / amount)
}
