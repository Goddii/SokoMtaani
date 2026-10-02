import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MoreHorizontal, Package, PackagePlus, Pencil, Search, X } from 'lucide-react'
import { costOf, marginOf } from '../lib/calc'
import { fmtKES, fmtNum } from '../lib/format'
import { productsApi, type ApiProduct } from '../lib/api'
import type { Category } from '../lib/types'
import { Card } from '../components/ui/Card'
import { StatusPill, type PillTone } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { LoadError, LOAD_ERROR_FALLBACK } from '../components/ui/LoadError'
import { Button } from '../components/ui/Button'
import { Menu } from '../components/ui/Menu'
import { CATEGORY_META } from '../components/pos/posMeta'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../lib/utils'
import { ProductFormModal } from './products/ProductFormModal'
import { CATEGORY_OPTIONS, EMPTY_FORM, buildProductBody, formFromProduct, type ProductForm } from './products/productForm'

function marginTone(margin: number): PillTone {
  if (margin < 0.12) return 'danger'
  if (margin < 0.25) return 'warning'
  return 'success'
}

export function ProductsPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''

  const [products, setProducts] = useState<ApiProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState(q)
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all')
  const [sort, setSort] = useState<'name' | 'stock' | 'margin'>('name')
  const [form, setForm] = useState<ProductForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const loadProducts = useCallback(async () => {
    try {
      const res = await productsApi.list()
      if (res.ok) setProducts(res.data)
      setLoadError(res.ok ? null : (res.error ?? LOAD_ERROR_FALLBACK))
    } catch {
      setLoadError(LOAD_ERROR_FALLBACK)
    } finally {
      setLoading(false)
    }
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
    setForm(formFromProduct(p))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    const built = buildProductBody(form)
    if (!built.ok) return setFormError(built.error)

    setSaving(true)
    setFormError(null)

    const body = built.body
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

      {loadError && <LoadError message={loadError} onRetry={loadProducts} />}

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

      <ProductFormModal
        form={form}
        onChange={setForm}
        onClose={() => setForm(null)}
        onSubmit={submit}
        saving={saving}
        error={formError}
        locked={modeLocked}
      />
    </div>
  )
}
