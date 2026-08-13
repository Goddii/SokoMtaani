import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { AlertTriangle, ClipboardList } from 'lucide-react'
import { costOf } from '../lib/calc'
import { fmtDate, fmtKES, fmtNum } from '../lib/format'
import { wastageApi, productsApi, type ApiWastage, type ApiProduct } from '../lib/api'
import { WASTAGE_REASONS } from '../lib/constants'
import { Card } from '../components/ui/Card'
import { StatusPill, type PillTone } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { TextField, SelectField } from '../components/ui/Form'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../lib/utils'

interface WastageForm {
  productId: string
  qty: string
  reason: string
  date: string
}

function todayInput(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function reasonTone(reason: string): PillTone {
  if (reason === 'spoilage') return 'warning'
  if (reason === 'damage') return 'danger'
  return 'neutral'
}

export function WastagePage() {
  const [entries, setEntries] = useState<ApiWastage[]>([])
  const [products, setProducts] = useState<ApiProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<WastageForm | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    const [wRes, pRes] = await Promise.all([wastageApi.list(), productsApi.list()])
    if (wRes.ok) setEntries(wRes.data)
    if (pRes.ok) setProducts(pRes.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const sorted = useMemo(() => [...entries].sort((a, b) => b.date.localeCompare(a.date)), [entries])

  const summary = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const recent = sorted.filter((e) => new Date(e.date).getTime() >= cutoff.getTime())
    const value = recent.reduce((s, e) => s + e.quantity * (productById.get(e.product_id) ? costOf(productById.get(e.product_id)!) : 0), 0)
    const reasons = new Map<string, number>()
    for (const e of recent) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + e.quantity)
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]
    return { count: recent.length, value, totalQty: recent.reduce((s, e) => s + e.quantity, 0), top }
  }, [sorted, productById])

  const productOptions = products
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: String(p.id), label: p.name }))

  const openForm = () => {
    setFormError(null)
    setForm({ productId: products[0] ? String(products[0].id) : '', qty: '', reason: 'spoilage', date: todayInput() })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    const product = products.find((p) => p.id === Number(form.productId))
    const qty = parseFloat(form.qty)
    if (!product) return setFormError('Choose a product.')
    if (!Number.isFinite(qty) || qty <= 0) return setFormError('Quantity must be more than 0.')
    if (!form.reason) return setFormError('Choose a reason.')
    if (!form.date) return setFormError('Choose the date.')

    setSaving(true)
    setFormError(null)
    // The backend derives who recorded this from the JWT identity.
    const res = await wastageApi.create({
      product_id: product.id,
      quantity: qty,
      reason: form.reason,
      date: new Date(`${form.date}T09:00:00`).toISOString(),
    })
    setSaving(false)
    if (!res.ok) {
      setFormError(res.error || 'Could not record the loss.')
      return
    }
    setForm(null)
    loadData()
  }

  const selectedProduct = form ? productById.get(Number(form.productId)) : undefined
  const estValue =
    form && Number.isFinite(parseFloat(form.qty)) && selectedProduct ? parseFloat(form.qty) * costOf(selectedProduct) : null

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-md bg-ink-100" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="h-96 animate-pulse rounded-xl bg-ink-100" />
          <div className="h-72 animate-pulse rounded-xl bg-ink-100 xl:col-span-2" />
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Inventory', to: '/products' }, { label: 'Wastage' }]}
        title="Wastage"
        subtitle="Spoilage, breakage and spills — what the shop loses and what it costs."
        actions={
          <Button variant="primary" icon={<ClipboardList className="size-4" aria-hidden />} onClick={openForm}>
            Record wastage
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* Form */}
        <Card className="h-fit p-5 xl:sticky xl:top-20">
          <h2 className="text-[15px] font-bold text-ink-900">Record a loss</h2>
          <p className="mb-4 text-[13px] text-ink-500">Stock is deducted as soon as you save.</p>
          {form ? (
            <form onSubmit={submit} className="space-y-4">
              <SelectField
                label="Product"
                required
                value={form.productId}
                onChange={(e) => setForm({ ...form, productId: e.target.value })}
                options={productOptions}
              />
              <TextField
                label={`Quantity wasted (${selectedProduct?.base_unit ?? 'unit'})`}
                required
                type="number"
                min="0"
                step="0.25"
                inputMode="decimal"
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
                placeholder="0"
              />
              <SelectField
                label="Reason"
                required
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                options={WASTAGE_REASONS.map((r) => ({ value: r.value, label: r.label }))}
              />
              <TextField
                label="Date"
                required
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
              {estValue !== null && (
                <div className="flex items-center justify-between rounded-lg bg-warning-50 px-3.5 py-2.5">
                  <span className="text-[13px] font-semibold text-warning-700">Loss at cost</span>
                  <span className="font-mono text-[15px] font-bold tabular text-warning-700">{fmtKES(estValue)}</span>
                </div>
              )}
              {formError && (
                <p className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold text-danger-700" role="alert">
                  {formError}
                </p>
              )}
              <div className="flex gap-3">
                <Button variant="secondary" className="flex-1" onClick={() => setForm(null)}>
                  Cancel
                </Button>
                <Button variant="primary" className="flex-1" loading={saving} onClick={submit}>
                  Save loss
                </Button>
              </div>
            </form>
          ) : (
            <EmptyState
              className="py-8"
              icon={<ClipboardList className="size-5" aria-hidden />}
              title="Nothing recorded yet"
              body="Recorded losses appear here, valued at their current batch cost."
              action={<Button variant="primary" onClick={openForm}>Record wastage</Button>}
            />
          )}
        </Card>

        <div className="space-y-4 xl:col-span-2">
          {/* Summary */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SummaryChip label="Last 30 days" value={fmtKES(summary.value)} detail={`${summary.count} record${summary.count === 1 ? '' : 's'}`} accent />
            <SummaryChip label="Quantity lost" value={`${fmtNum(summary.totalQty)}`} detail="Across all products" />
            <SummaryChip
              label="Top reason"
              value={summary.top?.[0] ?? '—'}
              detail={summary.top ? `${fmtNum(summary.top[1])} units lost` : 'No losses recorded'}
            />
          </div>

          {/* Table */}
          <Card className="overflow-hidden">
            {sorted.length === 0 ? (
              <EmptyState
                icon={<AlertTriangle className="size-5" aria-hidden />}
                title="No wastage logged"
                body="Keep the log honest — every loss recorded here protects the profit numbers."
              />
            ) : (
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full min-w-[640px] text-left">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50/60 text-xs font-bold uppercase tracking-wider text-ink-400">
                      <th className="px-5 py-3">Date</th>
                      <th className="px-3 py-3">Product</th>
                      <th className="px-3 py-3 text-right">Qty</th>
                      <th className="px-3 py-3">Reason</th>
                      <th className="px-3 py-3 text-right">Loss at cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {sorted.map((e) => {
                      const product = productById.get(e.product_id)
                      const value = e.quantity * (product ? costOf(product) : 0)
                      return (
                        <tr key={e.id} className="transition-colors hover:bg-ink-50/60">
                          <td className="px-5 py-3 text-sm font-medium text-ink-600">{fmtDate(e.date)}</td>
                          <td className="px-3 py-3">
                            <p className="text-sm font-bold text-ink-900">{e.product_name ?? 'Unknown'}</p>
                            <p className="text-xs text-ink-500">{product?.base_unit}</p>
                          </td>
                          <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-700">
                            {fmtNum(e.quantity)} <span className="text-xs font-medium text-ink-400">{product?.base_unit}</span>
                          </td>
                          <td className="px-3 py-3">
                            <StatusPill tone={reasonTone(e.reason)} dot={false}>
                              {WASTAGE_REASONS.find((r) => r.value === e.reason)?.label ?? e.reason}
                            </StatusPill>
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-[13px] font-bold tabular text-danger-700">
                            {fmtKES(value)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>

    </div>
  )
}

function SummaryChip({ label, value, detail, accent }: { label: string; value: string; detail: string; accent?: boolean }) {
  return (
    <Card className={cn('px-4 py-3.5', accent && 'bg-brand-900 border-brand-900')}>
      <p className={cn('text-[11px] font-bold uppercase tracking-wider', accent ? 'text-brand-300/80' : 'text-ink-400')}>
        {label}
      </p>
      <p className={cn('mt-0.5 text-lg font-extrabold tracking-tight tabular', accent ? 'text-white' : 'text-ink-900')}>
        {value}
      </p>
      <p className={cn('text-xs', accent ? 'text-brand-300/70' : 'text-ink-500')}>{detail}</p>
    </Card>
  )
}
