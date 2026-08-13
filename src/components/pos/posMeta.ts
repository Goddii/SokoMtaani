import { Leaf, Package, ShoppingBag, type LucideIcon } from 'lucide-react'
import type { Category, Unit } from '../../lib/types'
import type { ApiPriceButton, PricingMode } from '../../lib/api'

export const CATEGORY_META: Record<Category, { label: string; icon: LucideIcon; tile: string; chip: string }> = {
  produce: {
    label: 'Produce',
    icon: Leaf,
    tile: 'bg-brand-50 text-brand-700',
    chip: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  },
  dry: {
    label: 'Dry goods',
    icon: Package,
    tile: 'bg-warning-50 text-warning-700',
    chip: 'bg-warning-50 text-warning-700 ring-warning-600/25',
  },
  packaging: {
    label: 'Packaging & household',
    icon: ShoppingBag,
    tile: 'bg-ink-100 text-ink-600',
    chip: 'bg-ink-100 text-ink-700 ring-ink-500/15',
  },
}

/** Default increment step for the quantity stepper, per unit. */
export function stepFor(unit: Unit): number {
  return unit === 'piece' ? 1 : 0.5
}

export function decimalsFor(unit: Unit): number {
  return unit === 'piece' ? 0 : 1
}

export function roundQty(n: number, unit: Unit): number {
  const d = decimalsFor(unit)
  return Math.round(n * 10 ** d) / 10 ** d
}

/**
 * Effective per-unit price for a cart line.
 *
 * A button's amount is the stock it consumes in the product's base unit. The
 * per-unit rate is the fixed price spread across that amount, so revenue stays
 * exactly the button price: a 0.25 kg button at KSh40 sells at KSh160/kg;
 * a "3 tomatoes" button at KSh10 sells at KSh10/3 per piece. A legacy counted
 * button without an amount is one fixed-price unit (rate = the price itself).
 * Flat lines use sell_price.
 */
/**
 * Base-unit quantity a cart line consumes from stock.
 *
 * PRICE BUTTON = what is being sold · COUNT = how many times it is sold.
 * A button line consumes `amount × count` of the base unit ("3 tomatoes"
 * sold 2 times = 6 pieces); a legacy button without an amount consumes
 * `count` untracked units; a flat-rate line's count IS the base-unit qty.
 */
export function lineBaseQty(
  count: number,
  button?: Pick<ApiPriceButton, 'kg_amount'> | null,
): number {
  if (!button) return count
  return button.kg_amount != null ? button.kg_amount * count : count
}

export function lineUnitPrice(
  sellPrice: number,
  button?: Pick<ApiPriceButton, 'price' | 'kg_amount'> | null,
  _mode: PricingMode = 'weighed',
): number {
  if (!button) return sellPrice
  return button.kg_amount != null ? button.price / button.kg_amount : button.price
}

/** Subtotal for a cart line in KES. */
export function lineTotal(
  qty: number,
  sellPrice: number,
  button?: Pick<ApiPriceButton, 'price' | 'kg_amount'> | null,
  mode: PricingMode = 'weighed',
): number {
  return qty * lineUnitPrice(sellPrice, button, mode)
}
