import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, Boxes, MoreHorizontal, PackagePlus } from 'lucide-react'
import { fmtDate, fmtKES, fmtNum } from '../lib/format'
import { batchesApi, productsApi, type ApiBatch, type ApiProduct } from '../lib/api'
import { Card } from '../components/ui/Card'
import { StatusPill } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Menu } from '../components/ui/Menu'
import { TextField, SelectField } from '../components/ui/Form'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../lib/utils'

type Filter = 'all' | 'open' | 'closed'

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
]

interface BatchForm {
  productId: string
  bulkQty: string
  bulkCost: string
  dateReceived: string
}

function todayInput(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function BatchesPage() {
  const navigate = useNavigate()
  const [batches, setBatches] = useState<ApiBatch[]>([])
  const [products, setProducts] = useState<ApiProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [closing, setClosing] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [form, setForm] = useState<BatchForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const loadBatches = useCallback(async () => {
    const [bRes, pRes] = await Promise.all([batchesApi.list(), productsApi.list()])
    if (bRes.ok) setBatches(bRes.data)
    if (pRes.ok) setProducts(pRes.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadBatches()
  }, [loadBatches])

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const visibleBatches = useMemo(() => {
    const list = [...batches].sort((a, b) => b.date_received.localeCompare(a.date_received))
    return list.filter((b) => filter === 'all' || b.status === filter)
  }, [batches, filter])

  const openBatches = batches.filter((b) => b.status === 'open')
  const openValue = openBatches.reduce((s, b) => s + b.total_cost, 0)
  const openQty = openBatches.reduce((s, b) => s + b.quantity_remaining, 0)
  const totalStock = products.reduce((s, p) => s + p.total_stock, 0)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    const product = products.find((p) => p.id === Number(form.productId))
    const qty = parseFloat(form.bulkQty)
    const cost = parseFloat(form.bulkCost)
    if (!product) return setFormError('Choose a product.')
    if (!Number.isFinite(qty) || qty <= 0) return setFormError('Bulk quantity must be more than 0.')
    if (!Number.isFinite(cost) || cost <= 0) return setFormError('Bulk cost must be more than 0.')
    if (!form.dateReceived) return setFormError('Choose the date the stock arrived.')

    const res = await batchesApi.create({
      product_id: product.id,
      bulk_quantity: qty,
      bulk_unit: product.base_unit,
      total_cost: cost,
      date_received: new Date(`${form.dateReceived}T08:00:00`).toISOString(),
    })
    if (!res.ok) {
      setFormError(res.error || 'Could not save the batch.')
      return
    }
    setForm(null)
    loadBatches()
  }

  const closeBatch = async (b: ApiBatch) => {
    setClosing(true)
    const res = await batchesApi.close(b.id)
    setClosing(false)
    if (res.ok) loadBatches()
  }

  const qtyPreview =
    form && Number.isFinite(parseFloat(form.bulkQty)) && Number.isFinite(parseFloat(form.bulkCost)) && parseFloat(form.bulkQty) > 0
      ? parseFloat(form.bulkCost) / parseFloat(form.bulkQty)
      : null

  const productOptions = products
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      value: String(p.id),
      label: `${p.name}${p.pricing_mode === 'counted' ? ' — sold by piece' : ` (${p.base_unit})`}`,
    }))

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-8 w-64 animate-pulse rounded-md bg-ink-100" />
        <div className="h-28 animate-pulse rounded-xl bg-ink-100" />
        <div className="h-72 animate-pulse rounded-xl bg-ink-100" />
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Inventory', to: '/products' }, { label: 'Stock batches' }]}
        title="Stock batches"
        subtitle="Every delivery as a batch — what came in, what it cost, and how much is still on the shelf."
        actions={
          <Button
            variant="primary"
            icon={<PackagePlus className="size-4" aria-hidden />}
            onClick={() => {
              setFormError(null)
              setForm({ productId: products[0] ? String(products[0].id) : '', bulkQty: '', bulkCost: '', dateReceived: todayInput() })
            }}
          >
            Add batch
          </Button>
        }
      />

      {/* Summary strip */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryChip label="Open batches" value={String(openBatches.length)} detail={`${fmtNum(openQty)} units still in the cost base`} />
        <SummaryChip label="Stock on hand" value={`${fmtNum(totalStock)} units`} detail="Across all active products" />
        <SummaryChip label="Open batch value" value={fmtKES(openValue)} detail="What's sitting on the shelf, at cost" />
      </div>

      {/* Filter tabs */}
      <div className="mb-4 inline-flex rounded-lg bg-ink-100 p-0.5" role="tablist" aria-label="Filter batches">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={cn(
              'h-8 rounded-md px-4 text-[13px] font-semibold transition-all',
              filter === f.value ? 'bg-white text-ink-900 shadow-sm ring-1 ring-ink-200' : 'text-ink-500 hover:text-ink-800',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        {visibleBatches.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-5" aria-hidden />}
            title={`No ${filter === 'all' ? '' : filter} batches`}
            body="Record a delivery to start tracking cost per unit for your products."
            action={
              <Button
                variant="primary"
                onClick={() => setForm({ productId: products[0] ? String(products[0].id) : '', bulkQty: '', bulkCost: '', dateReceived: todayInput() })}
              >
                Add batch
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-xs font-bold uppercase tracking-wider text-ink-400">
                  <th className="px-5 py-3">Batch</th>
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3 text-right">Received</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Cost / unit</th>
                  <th className="px-3 py-3 text-right">Remaining</th>
                  <th className="px-3 py-3">Received on</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {visibleBatches.map((b) => {
                  const product = productById.get(b.product_id)
                  const active = b.status === 'open'
                  const counted = product?.pricing_mode === 'counted'
                  return (
                    <Fragment key={b.id}>
                      <tr className="transition-colors hover:bg-ink-50/60">
                        <td className="px-5 py-3">
                          <p className="font-mono text-[13px] font-semibold text-ink-900">BT-{b.id}</p>
                          <p className="text-xs text-ink-400">{active ? (counted ? 'open crate' : 'in cost base') : 'locked'}</p>
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-sm font-bold text-ink-900">{b.product_name ?? 'Unknown'}</p>
                          <p className="text-xs text-ink-500">
                            {product ? (counted ? 'Sold by piece' : product.category === 'produce' ? 'Produce' : product.category === 'dry' ? 'Dry goods' : 'Packaging') : '—'}
                          </p>
                        </td>
                        <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-700">
                          {fmtNum(b.bulk_quantity)}
                          <span className="text-xs font-medium text-ink-400"> {b.bulk_unit}</span>
                        </td>
                        <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-700">{fmtKES(b.total_cost)}</td>
                        <td className="px-3 py-3 text-right">
                          <span className="font-mono text-[13px] font-bold tabular text-brand-800">{fmtKES(b.cost_per_base_unit)}</span>
                          <span className="text-xs text-ink-400"> / {product?.base_unit}</span>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <p className="text-sm font-semibold tabular text-ink-900">
                            {fmtNum(b.quantity_remaining)}
                            <span className="text-xs font-medium text-ink-400"> {product?.base_unit ?? b.bulk_unit}</span>
                          </p>
                          {b.bulk_unit === product?.base_unit && (
                            <p className="text-xs font-medium text-ink-400">
                              {fmtNum(Math.max(0, b.bulk_quantity - b.quantity_remaining))} consumed
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3 text-sm font-medium text-ink-600">{fmtDate(b.date_received)}</td>
                        <td className="px-3 py-3">
                          {active ? <StatusPill tone="success">Open</StatusPill> : <StatusPill tone="neutral">Closed</StatusPill>}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <Menu
                            align="right"
                            trigger={(open) => (
                              <button
                                type="button"
                                aria-label={`Actions for batch BT-${b.id}`}
                                aria-expanded={open}
                                className="rounded-md p-1.5 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
                              >
                                <MoreHorizontal className="size-4.5" aria-hidden />
                              </button>
                            )}
                            items={
                              active
                                ? [
                                    {
                                      label: counted ? 'Mark this batch done' : 'Close batch',
                                      icon: <Archive className="size-4" aria-hidden />,
                                      disabled: closing,
                                      onClick: () => closeBatch(b),
                                    },
                                    {
                                      label: 'View product',
                                      icon: <Boxes className="size-4" aria-hidden />,
                                      onClick: () => navigate('/products'),
                                    },
                                  ]
                                : [
                                    {
                                      label: 'View product',
                                      icon: <Boxes className="size-4" aria-hidden />,
                                      onClick: () => navigate('/products'),
                                    },
                                  ]
                            }
                          />
                        </td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title="Add stock batch"
        description={
          productById.get(Number(form?.productId ?? 0))?.pricing_mode === 'counted'
            ? 'A delivery arrives — record roughly how many pieces it is and what it cost. Cost per piece is worked out from these.'
            : 'A delivery arrives with a bulk quantity and bulk cost — the unit cost is computed from these.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit}>
              Save batch
            </Button>
          </>
        }
      >
        {form && (
          <form onSubmit={submit} className="space-y-4">
            <SelectField
              label="Product"
              required
              value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value })}
              options={productOptions}
            />
            <div className="grid grid-cols-2 gap-4">
              <TextField
                label={productById.get(Number(form.productId))?.pricing_mode === 'counted' ? 'Approx. size (for your reference)' : 'Bulk quantity'}
                required
                type="number"
                min="0"
                step="0.5"
                inputMode="decimal"
                value={form.bulkQty}
                onChange={(e) => setForm({ ...form, bulkQty: e.target.value })}
                placeholder="0"
                hint={
                  productById.get(Number(form.productId))
                    ? productById.get(Number(form.productId))!.pricing_mode === 'counted'
                      ? 'An estimate of the delivery size — cost per piece is total cost ÷ this size.'
                      : `In ${productById.get(Number(form.productId))!.base_unit}s`
                    : undefined
                }
              />
              <TextField
                label="Bulk cost (KES)"
                required
                type="number"
                min="0"
                inputMode="decimal"
                value={form.bulkCost}
                onChange={(e) => setForm({ ...form, bulkCost: e.target.value })}
                placeholder="0"
              />
            </div>
            <TextField
              label="Date received"
              required
              type="date"
              value={form.dateReceived}
              onChange={(e) => setForm({ ...form, dateReceived: e.target.value })}
            />
            {qtyPreview !== null && productById.get(Number(form.productId))?.pricing_mode !== 'counted' && (
              <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3.5 py-2.5">
                <span className="text-[13px] font-semibold text-brand-800">
                  Cost per {productById.get(Number(form.productId))?.base_unit}
                </span>
                <span className="font-mono text-[15px] font-bold tabular text-brand-800">{fmtKES(qtyPreview)}</span>
              </div>
            )}
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

function SummaryChip({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="text-[11px] font-bold uppercase tracking-wider text-ink-400">{label}</p>
      <p className="mt-0.5 text-lg font-extrabold tracking-tight tabular text-ink-900">{value}</p>
      <p className="text-xs text-ink-500">{detail}</p>
    </Card>
  )
}

