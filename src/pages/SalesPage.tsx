import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Download, Receipt, RotateCcw } from 'lucide-react'
import { attendantsApi, productsApi, salesApi, type ApiDailySummary, type ApiSale } from '../lib/api'
import { fmtKES, fmtDateShort, fmtNum, fmtTime, todayKey } from '../lib/format'
import { Card, StatusPill } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { SelectField, TextField } from '../components/ui/Form'
import { EmptyState } from '../components/ui/EmptyState'
import { cn } from '../lib/utils'

const PER_PAGE = 50

interface Filters {
  from: string
  to: string
  attendantId: string
  productId: string
}

const EMPTY_FILTERS: Filters = { from: todayKey(), to: todayKey(), attendantId: '', productId: '' }

/**
 * Group key for a sale row. New rows share a server-stored sale_uuid (the
 * phone's cart id); legacy rows group by their client_uuid prefix
 * ("<cartId>-<productId>-<lineIndex>").
 */
function transactionKeyOf(s: ApiSale): string {
  if (s.sale_uuid) return s.sale_uuid
  const parts = s.client_uuid.split('-')
  return parts.length > 2 ? parts.slice(0, -2).join('-') : s.client_uuid
}

interface Group {
  key: string
  lines: ApiSale[]
  createdAt: string
  attendantName: string | null
  revenue: number
  cost: number
  profit: number
}

export function SalesPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(1)

  const [rows, setRows] = useState<ApiSale[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<ApiDailySummary | null>(null)
  const [attendants, setAttendants] = useState<Array<{ value: string; label: string }>>([])
  const [products, setProducts] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(true)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [voidGroup, setVoidGroup] = useState<Group | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    attendantsApi.list().then((res) => {
      if (res.ok) setAttendants(res.data.map((a) => ({ value: String(a.id), label: a.name })))
    })
    productsApi.list().then((res) => {
      if (res.ok) setProducts(res.data.map((p) => ({ value: String(p.id), label: p.name })))
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const params = {
      from: filters.from || undefined,
      to: filters.to || undefined,
      attendant_id: filters.attendantId ? Number(filters.attendantId) : undefined,
      product_id: filters.productId ? Number(filters.productId) : undefined,
      page,
      per_page: PER_PAGE,
    }
    const [pRes, sRes] = await Promise.all([
      salesApi.page(params),
      salesApi.dailySummary({
        from: params.from,
        to: params.to,
        attendant_id: params.attendant_id,
        product_id: params.product_id,
      }),
    ])
    if (pRes.ok) {
      setRows(pRes.data.items)
      setTotal(pRes.data.total)
    }
    if (sRes.ok) setSummary(sRes.data)
    setLoading(false)
  }, [filters, page])

  useEffect(() => {
    load()
  }, [load])

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, ApiSale[]>()
    for (const s of rows) {
      const k = transactionKeyOf(s)
      map.set(k, [...(map.get(k) ?? []), s])
    }
    return [...map.entries()].map(([key, lines]) => ({
      key,
      lines,
      createdAt: lines[0].created_at,
      attendantName: lines[0].attendant_name,
      revenue: lines.reduce((s, l) => s + l.revenue, 0),
      cost: lines.reduce((s, l) => s + l.cost_at_sale * l.quantity_sold, 0),
      profit: lines.reduce((s, l) => s + l.profit, 0),
    }))
  }, [rows])

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const confirmVoid = async () => {
    if (!voidGroup) return
    setVoiding(true)
    setVoidError(null)
    for (const line of voidGroup.lines) {
      const res = await salesApi.void(line.id)
      if (!res.ok) {
        setVoidError(res.error || 'Could not void the sale.')
        setVoiding(false)
        return
      }
    }
    setVoiding(false)
    setVoidGroup(null)
    load()
  }

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE))

  const exportCsv = async () => {
    setExporting(true)
    const res = await salesApi.export({
      from: filters.from || undefined,
      to: filters.to || undefined,
      attendant_id: filters.attendantId ? Number(filters.attendantId) : undefined,
      product_id: filters.productId ? Number(filters.productId) : undefined,
    })
    setExporting(false)
    if (!res.ok || res.text == null) {
      alert(res.error || 'Could not export sales.')
      return
    }
    // Download as a .csv file (Excel-friendly, BOM already added by the server).
    const blob = new Blob([res.text], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sokomtaani-sales-${filters.from ?? 'all'}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Sales' }]}
        title="Sales"
        subtitle="Every transaction, what it cost, and what it earned."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Download className="size-4" aria-hidden />}
              loading={exporting}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
            <Button
              variant="secondary"
              icon={<RotateCcw className="size-4" aria-hidden />}
              onClick={() => {
                setFilters(EMPTY_FILTERS)
                setPage(1)
              }}
            >
              Reset filters
            </Button>
          </div>
        }
      />

      {/* Filters */}
      <Card className="mb-5 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <TextField
            label="From"
            type="date"
            value={filters.from}
            onChange={(e) => {
              setFilters((f) => ({ ...f, from: e.target.value }))
              setPage(1)
            }}
          />
          <TextField
            label="To"
            type="date"
            value={filters.to}
            onChange={(e) => {
              setFilters((f) => ({ ...f, to: e.target.value }))
              setPage(1)
            }}
          />
          <SelectField
            label="Attendant"
            value={filters.attendantId}
            onChange={(e) => {
              setFilters((f) => ({ ...f, attendantId: e.target.value }))
              setPage(1)
            }}
            options={[{ value: '', label: 'All attendants' }, ...attendants]}
          />
          <SelectField
            label="Product"
            value={filters.productId}
            onChange={(e) => {
              setFilters((f) => ({ ...f, productId: e.target.value }))
              setPage(1)
            }}
            options={[{ value: '', label: 'All products' }, ...products]}
          />
        </div>
      </Card>

      {/* Summary */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryChip label="Revenue" value={fmtKES(summary?.total_revenue ?? 0)} detail={`${summary?.sale_count ?? 0} line${(summary?.sale_count ?? 0) === 1 ? '' : 's'}`} accent />
        <SummaryChip label="Cost" value={fmtKES(summary?.total_cost ?? 0)} detail="At FIFO cost consumed" />
        <SummaryChip label="Profit" value={fmtKES(summary?.total_profit ?? 0)} detail="After cost" />
        <SummaryChip label="Margin" value={summary && summary.total_revenue > 0 ? `${Math.round(summary.margin_pct * 100)}%` : '—'} detail="Revenue minus cost" />
      </div>

      {/* Transactions */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-4" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-ink-100" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-5" aria-hidden />}
            title="No sales found"
            body="Try widening the date range or clearing a filter."
          />
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/60 text-xs font-bold uppercase tracking-wider text-ink-400">
                  <th className="w-10 px-3 py-3" />
                  <th className="px-3 py-3">When</th>
                  <th className="px-3 py-3">Attendant</th>
                  <th className="px-3 py-3 text-right">Items</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Profit</th>
                  <th className="px-3 py-3 text-right">Total</th>
                  <th className="px-5 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {groups.map((g) => {
                  const open = expanded.has(g.key)
                  const voided = g.lines.every((l) => l.voided_at)
                  return (
                    <FragmentRow
                      key={g.key}
                      group={g}
                      open={open}
                      voided={voided}
                      onToggle={() => toggleExpanded(g.key)}
                      onVoid={() => {
                        setVoidError(null)
                        setVoidGroup(g)
                      }}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-[13px] font-semibold text-ink-500">
          {total} line{total === 1 ? '' : 's'} · page {page} of {totalPages}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="size-4" aria-hidden /> Prev
          </Button>
          <Button variant="secondary" disabled={!loadMoreAvailable(page, total, PER_PAGE)} onClick={() => setPage((p) => p + 1)}>
            Next <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Void confirmation */}
      <Modal
        open={voidGroup !== null}
        onClose={() => {
          if (!voiding) setVoidGroup(null)
        }}
        size="sm"
        title="Void this sale?"
        description="The stock goes back into its batches and the sale is marked voided."
        footer={
          <>
            <Button variant="secondary" onClick={() => setVoidGroup(null)} disabled={voiding}>
              Keep it
            </Button>
            <Button variant="danger" loading={voiding} onClick={confirmVoid}>
              Void sale
            </Button>
          </>
        }
      >
        {voidGroup && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-base font-extrabold tabular text-ink-900">{fmtKES(voidGroup.revenue)}</p>
              <p className="text-xs font-medium text-ink-500">
                {fmtDateShort(voidGroup.createdAt)} · {fmtTime(voidGroup.createdAt)} · {voidGroup.lines.length} item
                {voidGroup.lines.length === 1 ? '' : 's'}
              </p>
            </div>
            <p className="text-right text-xs font-semibold text-ink-500">{voidGroup.attendantName ?? 'Sale'}</p>
          </div>
        )}
        {voidError && (
          <p className="mt-3 rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold text-danger-700" role="alert">
            {voidError}
          </p>
        )}
      </Modal>
    </div>
  )
}

function loadMoreAvailable(page: number, total: number, perPage: number): boolean {
  return page * perPage < total
}

function FragmentRow({
  group,
  open,
  voided,
  onToggle,
  onVoid,
}: {
  group: Group
  open: boolean
  voided: boolean
  onToggle: () => void
  onVoid: () => void
}) {
  return (
    <>
      <tr className="transition-colors hover:bg-ink-50/60">
        <td className="px-3 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={open ? 'Hide sale details' : 'Show sale details'}
            className="rounded-md p-1 text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        </td>
        <td className="px-3 py-3">
          <p className="text-sm font-bold text-ink-900">{fmtDateShort(group.createdAt)}</p>
          <p className="text-xs font-medium text-ink-500">{fmtTime(group.createdAt)}</p>
        </td>
        <td className="px-3 py-3 text-sm font-semibold text-ink-700">{group.attendantName ?? '—'}</td>
        <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-700">{group.lines.length}</td>
        <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-600">{fmtKES(group.cost)}</td>
        <td className="px-3 py-3 text-right text-sm font-extrabold tabular text-ink-900">{fmtKES(group.profit)}</td>
        <td className="px-3 py-3 text-right text-sm font-extrabold tabular text-ink-900">{fmtKES(group.revenue)}</td>
        <td className="px-5 py-3 text-right">
          {voided ? (
            <StatusPill tone="neutral" dot={false}>
              Voided
            </StatusPill>
          ) : (
            <button
              type="button"
              onClick={onVoid}
              className="rounded-md px-2 py-1 text-xs font-semibold text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"
            >
              Void
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-ink-50/40">
          <td colSpan={8} className="px-5 py-2">
            <ul className="divide-y divide-ink-100">
              {group.lines.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <span className="min-w-0 flex-1 text-sm font-semibold text-ink-800">
                    {l.product_name_snapshot ?? l.product_name ?? 'Unknown'}
                    {l.button_label_snapshot && (
                      <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-bold text-ink-500">
                        {l.button_count_snapshot != null && l.button_count_snapshot > 1
                          ? `${l.button_count_snapshot} × ${l.button_label_snapshot}`
                          : l.button_label_snapshot}
                      </span>
                    )}
                  </span>
                  <span className="text-xs font-semibold tabular text-ink-500">
                    {fmtNum(l.quantity_base ?? l.quantity_sold)} {l.unit_sold_in}
                  </span>
                  <span className="w-24 text-right text-xs font-semibold tabular text-ink-500">
                    @ {fmtKES(l.price_charged)}/{l.unit_sold_in}
                  </span>
                  <span className="w-20 text-right text-xs font-semibold tabular text-ink-500">cost {fmtKES(l.cost_at_sale * l.quantity_sold)}</span>
                  <span className="w-24 text-right text-xs font-extrabold tabular text-ink-800">{fmtKES(l.revenue)}</span>
                  {l.voided_at && <StatusPill tone="neutral" dot={false}>Voided</StatusPill>}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
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
