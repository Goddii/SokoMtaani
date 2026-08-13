import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MoreHorizontal, Package, PackagePlus, Pencil, Plus, Search, X } from 'lucide-react'
import { costOf, marginOf } from '../lib/calc'
import { fmtKES, fmtNum } from '../lib/format'
import { productsApi, type ApiProduct, type PricingMode } from '../lib/api'
import type { Category, Unit } from '../lib/types'
import { Card } from '../components/ui/Card'
import { StatusPill, type PillTone } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Menu } from '../components/ui/Menu'
import { TextField, SelectField, Segmented } from '../components/ui/Form'
import { CATEGORY_META } from '../components/pos/posMeta'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../lib/utils'

const CATEGORY_OPTIONS = [
  { value: 'produce', label: 'Fresh produce' },
  { value: 'dry', label: 'Dry goods' },
  { value: 'packaging', label: 'Packaging & household' },
]

const UNIT_OPTIONS: Array<{ value: Unit; label: string }> = [
  { value: 'kg', label: 'kg' },
  { value: 'piece', label: 'piece' },
  { value: 'litre', label: 'litre' },
]

const MODE_OPTIONS: Array<{ value: PricingMode; label: string }> = [
  { value: 'weighed', label: 'By weight / measure' },
  { value: 'counted', label: 'By count (pieces)' },
]

function marginTone(margin: number): PillTone {
  if (margin < 0.12) return 'danger'
  if (margin < 0.25) return 'warning'
  return 'success'
}

/** One fixed-price button row in the form. kgAmount is weighed-mode only. */
interface ButtonRow {
  label: string
  kgAmount: string
  price: string
}

interface ProductForm {
  id?: number
  name: string
  category: Category
  baseUnit: Unit
  pricingMode: PricingMode
  sellPrice: string
  lowStockThreshold: string
  buttons: ButtonRow[]
}

const EMPTY_FORM: ProductForm = {
  name: '',
  category: 'produce',
  baseUnit: 'kg',
  pricingMode: 'weighed',
  sellPrice: '',
  lowStockThreshold: '',
  buttons: [],
}

export function ProductsPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''

  const [products, setProducts] = useState<ApiProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState(q)
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all')
  const [sort, setSort] = useState<'name' | 'stock' | 'margin'>('name')
  const [form, setForm] = useState<ProductForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const loadProducts = useCallback(async () => {
    const res = await productsApi.list()
    if (res.ok) setProducts(res.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadProducts()
  }, [loadProducts])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = products.filter((p) => catFilter === 'all' || p.category === catFilter)
    const filteredList = list.filter((p) => !needle || p.name.toLowerCase().includes(needle))
    const sorted = [...filteredList]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'stock') sorted.sort((a, b) => a.total_stock - b.total_stock)
    else {
      // Counted products have no per-unit margin — treat them as the best so
      // they sink to the bottom of a worst-first margin sort.
      const margin = (p: ApiProduct) => (p.pricing_mode === 'counted' ? 1 : marginOf(p.sell_price, costOf(p)))
      sorted.sort((a, b) => margin(a) - margin(b))
    }
    return sorted
  }, [products, catFilter, query, sort])

  const openAdd = () => {
    setFormError(null)
    setForm(EMPTY_FORM)
  }

  const openEdit = (p: ApiProduct) => {
    setFormError(null)
    setForm({
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
    })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    const name = form.name.trim()
    const threshold = parseFloat(form.lowStockThreshold)
    if (!name) return setFormError('Give the product a name.')
    if (!Number.isFinite(threshold) || threshold < 0) return setFormError('Low-stock threshold cannot be negative.')

    // Weighed products need a flat per-unit selling price; counted products
    // are priced entirely by their buttons.
    const sellPrice = parseFloat(form.sellPrice)
    if (form.pricingMode === 'weighed' && (!Number.isFinite(sellPrice) || sellPrice <= 0)) {
      return setFormError('Selling price must be more than 0.')
    }

    // Price buttons: ignore fully-empty rows, but every filled row needs the
    // fields relevant to the pricing mode.
    const filledButtons = form.buttons.filter(
      (b) => b.label.trim() !== '' || b.kgAmount.trim() !== '' || b.price.trim() !== '',
    )
    if (form.pricingMode === 'counted' && filledButtons.length === 0) {
      return setFormError('Add at least one price button — sold-by-piece products are priced at the till from these.')
    }

    const priceButtons: Array<{ label: string; kg_amount: number | null; price: number; sort_order: number }> = []
    for (const [i, b] of filledButtons.entries()) {
      const price = parseFloat(b.price)
      if (!b.label.trim()) return setFormError('Each price button needs a label, e.g. “1 @ KSh5” or “1/4 kg”.')
      if (!Number.isFinite(price) || price < 0) return setFormError(`“${b.label.trim()}” needs a price of 0 or more.`)
      if (form.pricingMode === 'counted') {
        const amt = b.kgAmount.trim()
        if (amt === '') {
          // Untracked options are only allowed when editing a legacy product
          // that already sells without stock deduction. New counted products
          // must define how much stock each option consumes.
          if (!form.id) {
            return setFormError(`“${b.label.trim()}” needs an amount — how many pieces it takes from stock.`)
          }
          priceButtons.push({ label: b.label.trim(), kg_amount: null, price, sort_order: i })
        } else {
          const a = parseFloat(amt)
          if (!Number.isFinite(a) || a <= 0) {
            return setFormError(`“${b.label.trim()}” needs an amount greater than 0 pieces.`)
          }
          priceButtons.push({ label: b.label.trim(), kg_amount: a, price, sort_order: i })
        }
      } else {
        const kg = parseFloat(b.kgAmount)
        if (!Number.isFinite(kg) || kg <= 0) {
          return setFormError(`“${b.label.trim()}” needs an amount greater than 0 ${form.baseUnit}.`)
        }
        priceButtons.push({ label: b.label.trim(), kg_amount: kg, price, sort_order: i })
      }
    }

    setSaving(true)
    setFormError(null)

    const body = {
      name,
      category: form.category,
      base_unit: form.baseUnit,
      pricing_mode: form.pricingMode,
      sell_price: form.pricingMode === 'counted' ? 0 : sellPrice,
      reorder_threshold: threshold,
      price_buttons: priceButtons,
    }

    const res = form.id ? await productsApi.update(form.id, body) : await productsApi.create(body)

    setSaving(false)
    if (!res.ok) {
      setFormError(res.error || 'Could not save the product.')
      return
    }
    setForm(null)
    loadProducts()
  }

  const submitSearch = (e: FormEvent) => {
    e.preventDefault()
    setParams(query.trim() ? { q: query.trim() } : {})
  }

  // A product with open stock can't switch accounting models or its base unit
  // — the backend enforces both (422 on save); this locks the controls and
  // explains why, so the owner closes the open batches first instead of
  // hitting a save error. (total_stock > 0 is the frontend proxy for "has an
  // open batch" — a 0-remaining open batch is impossible due to auto-close,
  // and the backend 422 still catches it anyway.)
  const editingProduct = form?.id ? products.find((p) => p.id === form.id) : undefined
  const modeLocked = !!editingProduct && editingProduct.total_stock > 0
  const unitLocked = modeLocked

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-md bg-ink-100" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl bg-ink-100" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Products' }]}
        title="Products"
        subtitle="What the shop sells, what it costs you, and what's on the shelf."
        actions={
          <Button variant="primary" icon={<PackagePlus className="size-4" aria-hidden />} onClick={openAdd}>
            Add product
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <form onSubmit={submitSearch} role="search" className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
          <input
            type="search"
            name="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            aria-label="Search products"
            className="h-9 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-8 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setParams({})
              }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-400 hover:text-ink-700"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </form>

        <div className="flex gap-1.5" role="tablist" aria-label="Filter by category">
          {(['all', ...CATEGORY_OPTIONS.map((o) => o.value)] as Array<Category | 'all'>).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={catFilter === c}
              onClick={() => setCatFilter(c)}
              className={cn(
                'rounded-full px-3 py-1.5 text-[13px] font-semibold ring-1 ring-inset transition-colors',
                catFilter === c ? 'bg-brand-700 text-white ring-brand-700' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50',
              )}
            >
              {c === 'all' ? 'All' : CATEGORY_OPTIONS.find((o) => o.value === c)!.label.split(' ')[0]}
            </button>
          ))}
        </div>

        <div className="ml-auto">
          <select
            name="sort"
            aria-label="Sort products"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="h-9 rounded-lg border border-ink-300 bg-white px-3 text-[13px] font-semibold text-ink-700 focus:border-brand-600 focus:outline-none"
          >
            <option value="name">Sort: name</option>
            <option value="stock">Sort: stock</option>
            <option value="margin">Sort: margin</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Package className="size-5" aria-hidden />}
            title="No products match"
            body="Adjust the search or filter, or add the product to the catalogue."
            action={<Button variant="primary" onClick={openAdd}>Add product</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => {
            const meta = CATEGORY_META[p.category]
            const Icon = meta.icon
            const counted = p.pricing_mode === 'counted'
            const low = p.is_low_stock
            const barPct = Math.min(100, (p.total_stock / Math.max(p.reorder_threshold * 2, 1)) * 100)
            return (
              <Card key={p.id} className="group flex flex-col p-4 transition-shadow hover:shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', meta.tile)}>
                      <Icon className="size-4.5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[15px] font-bold text-ink-900">{p.name}</p>
                      <p className="text-xs font-medium text-ink-500">
                        {meta.label} · {counted ? 'sold by piece' : p.base_unit}
                      </p>
                    </div>
                  </div>
                  <Menu
                    align="right"
                    trigger={(open) => (
                      <button
                        type="button"
                        aria-label={`Actions for ${p.name}`}
                        aria-expanded={open}
                        className="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
                      >
                        <MoreHorizontal className="size-4.5" aria-hidden />
                      </button>
                    )}
                    items={[
                      { label: 'Edit product', icon: <Pencil className="size-4" aria-hidden />, onClick: () => openEdit(p) },
                    ]}
                  />
                </div>

                {counted ? (
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-xl font-extrabold tracking-tight tabular text-ink-900">
                      {(p.price_buttons?.length ?? 0) > 0 ? `${p.price_buttons!.length} prices` : '—'}
                    </span>
                    <span className="text-xs font-medium text-ink-400">on the till</span>
                    <span className="ml-auto">
                      <StatusPill tone="neutral" dot={false}>
                        Sold by piece
                      </StatusPill>
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="mt-4 flex items-baseline gap-2">
                      <span className="text-xl font-extrabold tracking-tight tabular text-ink-900">{fmtKES(p.sell_price)}</span>
                      <span className="text-xs font-medium text-ink-400">per {p.base_unit}</span>
                      <span className="ml-auto">
                        <StatusPill tone={marginTone(marginOf(p.sell_price, costOf(p)))} dot={false}>
                          {Math.round(marginOf(p.sell_price, costOf(p)) * 100)}% margin
                        </StatusPill>
                      </span>
                    </div>
                    <p className="mt-1 text-[13px] text-ink-500">
                      Cost <span className="font-semibold tabular text-ink-700">{fmtKES(costOf(p))}</span> / {p.base_unit} from open batches
                    </p>
                  </>
                )}

                <div className="mt-4 border-t border-ink-100 pt-3">
                  <div className="flex items-center justify-between text-xs font-semibold">
                    <span className={cn(low ? 'text-danger-600' : 'text-ink-500')}>
                      {counted ? '~' : ''}
                      {fmtNum(p.total_stock)} {p.base_unit} on hand
                    </span>
                    {low ? (
                      <span className="rounded-full bg-danger-50 px-2 py-0.5 font-bold text-danger-700">Low stock</span>
                    ) : (
                      <span className="text-ink-400">threshold {fmtNum(p.reorder_threshold)}</span>
                    )}
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
                    <div
                      className={cn('h-full rounded-full transition-all', low ? 'bg-danger-600' : 'bg-brand-600')}
                      style={{ width: `${Math.max(2, barPct)}%` }}
                    />
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.id ? `Edit ${form.name}` : 'Add product'}
        description={form?.id ? 'Changes apply to the catalogue immediately.' : 'A new line for the shelf and the till.'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={submit}>
              {form?.id ? 'Save changes' : 'Add product'}
            </Button>
          </>
        }
      >
        {form && (
          <form onSubmit={submit} className="space-y-4">
            <TextField
              label="Product name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Red Onions"
              autoFocus
            />

            <Segmented<PricingMode>
              id="pricing-mode"
              label="How is it sold?"
              value={form.pricingMode}
              onChange={(v) => setForm({ ...form, pricingMode: v })}
              options={MODE_OPTIONS}
              disabled={modeLocked}
            />
            {modeLocked && (
              <p className="rounded-lg bg-warning-50 px-3 py-2 text-xs font-semibold text-warning-700">
                This product has open stock on hand — close the open batches (Inventory → Stock batches)
                before changing how it is sold or its base unit.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                label="Category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
                options={CATEGORY_OPTIONS}
              />
              <div>
                <Segmented<Unit>
                  id="base-unit"
                  label="Base unit"
                  value={form.baseUnit}
                  onChange={(v) => setForm({ ...form, baseUnit: v })}
                  options={UNIT_OPTIONS}
                  disabled={unitLocked}
                />
                {form.pricingMode === 'counted' && (
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
                    Sold by count — pick <span className="font-semibold">piece</span> and each option's amount is the number of pieces it takes from stock.
                  </p>
                )}
              </div>
            </div>

            {/* Price buttons — fixed prices on the till */}
            <div className="space-y-2 rounded-xl border border-ink-200 p-3">
              <div>
                <p className="text-[13px] font-semibold text-ink-700">
                  Price buttons <span className="font-medium text-ink-400">(optional for weighed)</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-500">
                  {form.pricingMode === 'counted'
                    ? 'Fixed prices the attendant taps — e.g. “1 @ KSh5”, “3 @ KSh10”. Each option’s amount is the stock it consumes (e.g. 3 pieces), so sales deduct exactly what was sold.'
                    : 'Shortcuts for the till — e.g. “1/4 kg” at KSh40. The exact amount keeps cost/profit math accurate. Leave empty to sell at the flat rate above.'}
                </p>
              </div>

              {form.buttons.length > 0 && (
                <div className="space-y-2">
                  {form.buttons.map((button, i) => (
                    <div
                      key={i}
                      className={cn('grid grid-cols-1 gap-2 sm:items-end sm:grid-cols-[minmax(0,1fr)_6.5rem_6rem_2.5rem]')}
                    >
                      <TextField
                        label={i === 0 ? 'Label' : undefined}
                        placeholder={form.pricingMode === 'counted' ? 'e.g. “1 @ KSh5”' : 'e.g. “1/4 kg”'}
                        value={button.label}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            buttons: form.buttons.map((t, j) => (j === i ? { ...t, label: e.target.value } : t)),
                          })
                        }
                      />
                      <TextField
                        label={
                          i === 0 ? (form.pricingMode === 'counted' ? 'Amount (pieces)' : `Amount (${form.baseUnit})`) : undefined
                        }
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        placeholder="0"
                        value={button.kgAmount}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            buttons: form.buttons.map((t, j) => (j === i ? { ...t, kgAmount: e.target.value } : t)),
                          })
                        }
                      />
                      <TextField
                        label={i === 0 ? 'Price (KES)' : undefined}
                        type="number"
                        min="0"
                        step="0.5"
                        inputMode="decimal"
                        placeholder="0"
                        value={button.price}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            buttons: form.buttons.map((t, j) => (j === i ? { ...t, price: e.target.value } : t)),
                          })
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, buttons: form.buttons.filter((_, j) => j !== i) })}
                        aria-label={`Remove price button ${button.label || i + 1}`}
                        className="flex h-10 w-10 items-center justify-center self-end justify-self-start rounded-lg border border-ink-200 text-ink-400 transition-colors hover:border-danger-200 hover:bg-danger-50 hover:text-danger-600 sm:justify-self-auto"
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() =>
                  setForm({ ...form, buttons: [...form.buttons, { label: '', kgAmount: '', price: '' }] })
                }
                className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-ink-300 text-[13px] font-semibold text-ink-600 transition-colors hover:border-brand-500 hover:bg-brand-50 hover:text-brand-700"
              >
                <Plus className="size-4" aria-hidden />
                Add price button
              </button>
            </div>

            <div className={cn('grid gap-4', form.pricingMode === 'weighed' ? 'grid-cols-2' : 'grid-cols-1')}>
              {form.pricingMode === 'weighed' && (
                <TextField
                  label="Selling price (KES)"
                  required
                  type="number"
                  min="0"
                  step="0.5"
                  inputMode="decimal"
                  value={form.sellPrice}
                  onChange={(e) => setForm({ ...form, sellPrice: e.target.value })}
                  placeholder="0"
                />
              )}
              <TextField
                label="Low-stock alert threshold"
                required
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={form.lowStockThreshold}
                onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
                placeholder="0"
              />
            </div>
            <p className="rounded-lg bg-ink-50 px-3 py-2 text-[13px] text-ink-500">
              {form.pricingMode === 'counted'
                ? 'Every option takes its exact amount from stock — record a batch under Inventory when a delivery arrives so cost and stock stay accurate.'
                : 'Stock on hand is tracked through stock batches — record a new batch under Inventory when a delivery arrives.'}
            </p>
            {formError && (
              <p className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold text-danger-700" role="alert">
                {formError}
              </p>
            )}
          </form>
        )}
      </Modal>
    </div>
  )
}
