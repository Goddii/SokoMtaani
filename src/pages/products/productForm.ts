import type { ApiProduct, PricingMode } from '../../lib/api'
import type { Category, Unit } from '../../lib/types'

export const CATEGORY_OPTIONS = [
  { value: 'produce', label: 'Fresh produce' },
  { value: 'dry', label: 'Dry goods' },
  { value: 'packaging', label: 'Packaging & household' },
]

export const UNIT_OPTIONS: Array<{ value: Unit; label: string }> = [
  { value: 'kg', label: 'kg' },
  { value: 'piece', label: 'piece' },
  { value: 'litre', label: 'litre' },
]

export const MODE_OPTIONS: Array<{ value: PricingMode; label: string }> = [
  { value: 'weighed', label: 'By weight / measure' },
  { value: 'counted', label: 'By count (pieces)' },
]

/** One fixed-price button row in the form. kgAmount is weighed-mode only. */
export interface ButtonRow {
  label: string
  kgAmount: string
  price: string
}

export interface ProductForm {
  id?: number
  name: string
  category: Category
  baseUnit: Unit
  pricingMode: PricingMode
  sellPrice: string
  lowStockThreshold: string
  buttons: ButtonRow[]
}

export const EMPTY_FORM: ProductForm = {
  name: '',
  category: 'produce',
  baseUnit: 'kg',
  pricingMode: 'weighed',
  sellPrice: '',
  lowStockThreshold: '',
  buttons: [],
}

export function formFromProduct(p: ApiProduct): ProductForm {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    baseUnit: p.base_unit,
    pricingMode: p.pricing_mode ?? 'weighed',
    sellPrice: String(p.sell_price),
    lowStockThreshold: String(p.reorder_threshold),
    buttons: (p.price_buttons ?? []).map((b) => ({
      label: b.label,
      kgAmount: b.kg_amount != null ? String(b.kg_amount) : '',
      price: String(b.price),
    })),
  }
}

interface PriceButtonBody {
  label: string
  kg_amount: number | null
  price: number
  sort_order: number
}

export interface ProductBody {
  name: string
  category: Category
  base_unit: Unit
  pricing_mode: PricingMode
  sell_price: number
  reorder_threshold: number
  price_buttons: PriceButtonBody[]
}

export type BuildResult = { ok: true; body: ProductBody } | { ok: false; error: string }

const fail = (error: string): BuildResult => ({ ok: false, error })

/** Validates the form and turns it into the API payload. */
export function buildProductBody(form: ProductForm): BuildResult {
  const name = form.name.trim()
  const threshold = parseFloat(form.lowStockThreshold)
  if (!name) return fail('Give the product a name.')
  if (!Number.isFinite(threshold) || threshold < 0) return fail('Low-stock threshold cannot be negative.')

  // Weighed products need a flat per-unit selling price; counted products
  // are priced entirely by their buttons.
  const sellPrice = parseFloat(form.sellPrice)
  if (form.pricingMode === 'weighed' && (!Number.isFinite(sellPrice) || sellPrice <= 0)) {
    return fail('Selling price must be more than 0.')
  }

  // Price buttons: ignore fully-empty rows, but every filled row needs the
  // fields relevant to the pricing mode.
  const filledButtons = form.buttons.filter(
    (b) => b.label.trim() !== '' || b.kgAmount.trim() !== '' || b.price.trim() !== '',
  )
  if (form.pricingMode === 'counted' && filledButtons.length === 0) {
    return fail('Add at least one price button — sold-by-piece products are priced at the till from these.')
  }

  const priceButtons: PriceButtonBody[] = []
  for (const [i, b] of filledButtons.entries()) {
    const price = parseFloat(b.price)
    const label = b.label.trim()
    if (!label) return fail('Each price button needs a label, e.g. “1 @ KSh5” or “1/4 kg”.')
    if (!Number.isFinite(price) || price < 0) return fail(`“${label}” needs a price of 0 or more.`)
    if (form.pricingMode === 'counted') {
      const amt = b.kgAmount.trim()
      if (amt === '') {
        // Untracked options are only allowed when editing a legacy product
        // that already sells without stock deduction. New counted products
        // must define how much stock each option consumes.
        if (!form.id) return fail(`“${label}” needs an amount — how many pieces it takes from stock.`)
        priceButtons.push({ label, kg_amount: null, price, sort_order: i })
      } else {
        const a = parseFloat(amt)
        if (!Number.isFinite(a) || a <= 0) return fail(`“${label}” needs an amount greater than 0 pieces.`)
        priceButtons.push({ label, kg_amount: a, price, sort_order: i })
      }
    } else {
      const kg = parseFloat(b.kgAmount)
      if (!Number.isFinite(kg) || kg <= 0) return fail(`“${label}” needs an amount greater than 0 ${form.baseUnit}.`)
      priceButtons.push({ label, kg_amount: kg, price, sort_order: i })
    }
  }

  return {
    ok: true,
    body: {
      name,
      category: form.category,
      base_unit: form.baseUnit,
      pricing_mode: form.pricingMode,
      sell_price: form.pricingMode === 'counted' ? 0 : sellPrice,
      reorder_threshold: threshold,
      price_buttons: priceButtons,
    },
  }
}
