import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  WifiOff,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useStore } from '../lib/store'
import { useOffline } from '../hooks/useOffline'
import { dashboardApi, salesApi, type ApiDashboardSummary, type ApiSale, type ApiSeriesPoint } from '../lib/api'
import { fmtKES, fmtNum, fmtDateShort, fmtTime } from '../lib/format'
import { Card, StatusPill } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { cn } from '../lib/utils'

interface TipPoint {
  name?: string | number
  value?: number | string
  color?: string
}

function ChartTip({ active, payload, label }: { active?: boolean; payload?: TipPoint[]; label?: string | number }) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-3 py-2 shadow-pop">
      <p className="text-xs font-bold text-ink-900">{label}</p>
      <div className="mt-1 space-y-0.5">
        {payload.map((p, i) => (
          <p key={i} className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-700">
            <span className="size-2 rounded-sm" style={{ background: p.color }} aria-hidden />
            <span className="tabular">{fmtKES(Number(p.value))}</span>
          </p>
        ))}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const { state } = useStore()
  const { offline } = useOffline()
  const navigate = useNavigate()

  const [summary, setSummary] = useState<ApiDashboardSummary | null>(null)
  const [series, setSeries] = useState<ApiSeriesPoint[]>([])
  const [recentSales, setRecentSales] = useState<ApiSale[]>([])
  const [range, setRange] = useState(14)
  const [marginAsc, setMarginAsc] = useState(true)

  // Server-side aggregation only — the dashboard never downloads bulk sale
  // history. The chart comes from /dashboard/series (N aggregate points) and
  // the recent-sales card from a tiny paginated page fetch.
  useEffect(() => {
    dashboardApi.summary().then((res) => {
      if (res.ok) setSummary(res.data)
    })
    salesApi.page({ per_page: 8 }).then((res) => {
      if (res.ok) setRecentSales(res.data.items)
    })
  }, [])

  useEffect(() => {
    dashboardApi.series(range).then((res) => {
      if (res.ok) setSeries(res.data.series)
    })
  }, [range])

  const pending = state.sales.filter((s) => s.syncStatus === 'pending').length

  const chartData = series.map((p) => ({
    date: p.date,
    label: new Date(`${p.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    revenue: p.revenue,
    profit: p.profit,
  }))
  const periodProfit = series.reduce((s, p) => s + p.profit, 0)
  const periodRevenue = series.reduce((s, p) => s + p.revenue, 0)

  const todayProfit = summary?.today.profit || 0
  const todayRevenue = summary?.today.revenue || 0
  const saleCount = summary?.today.sale_count || 0
  const avgTicket = saleCount > 0 ? todayRevenue / saleCount : 0

  // Today vs the previous business day, from the aggregated series.
  const todayPoint = series[series.length - 1]
  const yesterdayPoint = series[series.length - 2]
  const profitDelta =
    todayPoint && yesterdayPoint && yesterdayPoint.profit > 0
      ? (todayPoint.profit - yesterdayPoint.profit) / yesterdayPoint.profit
      : 0

  // Counted products (sold by piece) have no per-unit margin (margin_pct is
  // null) — sort weighed products by margin, then list counted products last.
  const rawMargins = summary?.per_product || []
  const margined = rawMargins.filter((p) => p.margin_pct != null)
  const counted = rawMargins.filter((p) => p.margin_pct == null)
  const margins = [
    ...margined.sort((a, b) =>
      marginAsc ? a.margin_pct! - b.margin_pct! : b.margin_pct! - a.margin_pct!,
    ),
    ...counted,
  ]

  const lowStock = summary?.low_stock_products || []
  const lowMargin = summary?.per_product.filter(p => p.low_margin) || []

  const recentSalesTop = recentSales.slice(0, 5)

  const todayLabel = new Intl.DateTimeFormat('en-KE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Here's how ${todayLabel.toLowerCase()} is shaping up at the shop.`}
        actions={
          <Button variant="primary" icon={<ShoppingCart className="size-4" aria-hidden />} onClick={() => navigate('/pos')}>
            Point of Sale
          </Button>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Drenched daily-profit panel — the brand moment */}
        <section className="rounded-xl bg-brand-900 p-5 text-white xl:col-span-2" aria-label="Today's profit">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold uppercase tracking-wider text-brand-300/80">Today's profit</p>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold tabular',
                profitDelta >= 0 ? 'bg-brand-500/25 text-brand-200' : 'bg-danger-500/25 text-danger-200',
              )}
            >
              {profitDelta >= 0 ? <TrendingUp className="size-3.5" aria-hidden /> : <TrendingDown className="size-3.5" aria-hidden />}
              {profitDelta >= 0 ? '+' : ''}
              {fmtNum(profitDelta * 100)}% vs yesterday
            </span>
          </div>
          <p className="mt-2 text-[34px] font-extrabold leading-none tracking-tight tabular">{fmtKES(todayProfit)}</p>
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-brand-800 pt-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-brand-300/70">Revenue</p>
              <p className="mt-0.5 text-[15px] font-bold tabular">{fmtKES(todayRevenue)}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-brand-300/70">Sales</p>
              <p className="mt-0.5 text-[15px] font-bold tabular">{saleCount}</p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-brand-300/70">Avg ticket</p>
              <p className="mt-0.5 text-[15px] font-bold tabular">{fmtKES(avgTicket)}</p>
            </div>
          </div>
        </section>

        <StatTile
          label="Profit Margin"
          value={`${Math.round((summary?.today.margin_pct || 0) * 100)}%`}
          detail="Today's average margin"
          tone="neutral"
        />
        <StatTile
          label="Needs attention"
          value={(lowStock.length + lowMargin.length).toString()}
          detail={`${lowStock.length} low stock · ${lowMargin.length} low margin`}
          tone={lowStock.length + lowMargin.length > 0 ? 'danger' : 'success'}
          linkTo="/products"
        />
      </div>

      {/* Chart + recent sales */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
            <div>
              <h2 className="text-[15px] font-bold text-ink-900">Profit & revenue</h2>
              <p className="text-[13px] text-ink-500">
                Last {range} days · <span className="font-semibold text-brand-700">{fmtKES(periodProfit)} profit</span> on{' '}
                {fmtKES(periodRevenue)}
              </p>
            </div>
            <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5" role="tablist" aria-label="Chart range">
              {[7, 14, 30].map((r) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={range === r}
                  onClick={() => setRange(r)}
                  className={cn(
                    'h-7 rounded-md px-3 text-xs font-semibold transition-all',
                    range === r ? 'bg-white text-ink-900 shadow-sm ring-1 ring-ink-200' : 'text-ink-500 hover:text-ink-800',
                  )}
                >
                  {r}d
                </button>
              ))}
            </div>
          </div>
          <div className="px-2 pb-2 pt-4">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#16704a" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="#16704a" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0a3d29" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#0a3d29" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#dfe2d9" strokeDasharray="4 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: '#848b7d', fontWeight: 600 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#848b7d', fontWeight: 600 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                    tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                  />
                  <Tooltip content={<ChartTip />} cursor={{ stroke: '#c6cbbf', strokeDasharray: '4 4' }} />
                  <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#16704a" strokeWidth={2} fill="url(#revFill)" />
                  <Area type="monotone" dataKey="profit" name="Profit" stroke="#0a3d29" strokeWidth={2.5} fill="url(#profitFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-4 px-4 pb-1 pt-2 text-xs font-semibold text-ink-500">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-brand-600" aria-hidden /> Revenue
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm bg-brand-900" aria-hidden /> Profit
              </span>
            </div>
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-ink-200 px-5 py-4">
            <div>
              <h2 className="text-[15px] font-bold text-ink-900">Latest sales</h2>
              <p className="text-[13px] text-ink-500">Most recent across the till</p>
            </div>
            <Link to="/sales" className="text-[13px] font-semibold text-brand-700 hover:underline">
              View all
            </Link>
          </div>
          <ul className="divide-y divide-ink-100 px-2 py-1">
            {recentSalesTop.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-ink-900">
                    <span className="font-mono text-xs font-semibold text-ink-400">#{s.id}</span>
                    {s.attendant_name?.split(' ')[0]}
                  </p>
                  <p className="text-xs text-ink-500">
                    {fmtDateShort(s.created_at)} · {fmtTime(s.created_at)}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-extrabold tabular text-ink-900">{fmtKES(s.revenue)}</p>
              </li>
            ))}
          </ul>
          {offline || pending > 0 ? (
            <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg bg-warning-50 px-3 py-2.5 text-xs font-semibold text-warning-700">
              <WifiOff className="size-4 shrink-0" aria-hidden />
              {pending} sale{pending === 1 ? '' : 's'} queued offline — open the connection badge to sync.
            </div>
          ) : null}
        </Card>
      </div>

      {/* Margins + alerts */}
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
            <div>
              <h2 className="text-[15px] font-bold text-ink-900">Per-product margin</h2>
              <p className="text-[13px] text-ink-500">Cost from open batches · sorted {marginAsc ? 'worst first' : 'best first'}</p>
            </div>
            <button
              type="button"
              onClick={() => setMarginAsc((v) => !v)}
              className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-semibold text-ink-700 transition-colors hover:bg-ink-50"
            >
              Sort: {marginAsc ? 'worst → best' : 'best → worst'}
            </button>
          </div>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-ink-100 text-xs font-bold uppercase tracking-wider text-ink-400">
                  <th className="px-5 py-3">Product</th>
                  <th className="px-3 py-3 text-right">Cost</th>
                  <th className="px-3 py-3 text-right">Margin</th>
                  <th className="px-5 py-3 text-right">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {margins.map((m) => {
                  // Counted products don't use per-unit margin math — their
                  // P&L lives on the Stock batches screen.
                  if (m.margin_pct == null) {
                    return (
                      <tr key={m.product_id} className="transition-colors hover:bg-ink-50/60">
                        <td className="px-5 py-3">
                          <p className="text-sm font-bold text-ink-900">{m.product_name}</p>
                          <p className="text-xs text-ink-500">Sold by piece — P&L per batch</p>
                        </td>
                        <td className="px-3 py-3 text-right text-sm font-semibold text-ink-400">—</td>
                        <td colSpan={2} className="px-5 py-3 text-right">
                          <StatusPill tone="neutral" dot={false}>
                            Sold by piece
                          </StatusPill>
                        </td>
                      </tr>
                    )
                  }
                  const tone = m.low_margin ? 'danger' : m.margin_pct < 0.25 ? 'warning' : 'success'
                  return (
                    <tr key={m.product_id} className="transition-colors hover:bg-ink-50/60">
                      <td className="px-5 py-3">
                        <p className="text-sm font-bold text-ink-900">{m.product_name}</p>
                      </td>
                      <td className="px-3 py-3 text-right text-sm font-semibold tabular text-ink-600">{fmtKES(m.cost)}</td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                tone === 'danger' ? 'bg-danger-600' : tone === 'warning' ? 'bg-warning-400' : 'bg-brand-600',
                              )}
                              style={{ width: `${Math.min(100, Math.max(2, m.margin_pct * 100))}%` }}
                            />
                          </div>
                          <span className="w-10 text-xs font-bold tabular text-ink-700">{Math.round(m.margin_pct * 100)}%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <StatusPill tone={tone} dot={false}>
                          {m.low_margin ? 'Low margin' : m.margin_pct < 0.25 ? 'Healthy' : 'Strong'}
                        </StatusPill>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="flex items-center gap-2 border-b border-ink-200 px-5 py-4">
              <AlertTriangle className={cn('size-4', lowStock.length > 0 ? 'text-danger-600' : 'text-ink-300')} aria-hidden />
              <h2 className="text-[15px] font-bold text-ink-900">Low stock</h2>
              {lowStock.length > 0 && (
                <StatusPill tone="danger" dot={false}>
                  {lowStock.length}
                </StatusPill>
              )}
            </div>
            {lowStock.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-500">Nothing running low — shelves are stocked.</p>
            ) : (
              <ul className="divide-y divide-ink-100 px-2 py-1">
                {lowStock.map((p) => (
                  <li key={p.product_id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-ink-900">{p.product_name}</p>
                      <p className="text-xs text-ink-500">
                        Threshold {fmtNum(p.reorder_threshold)} {p.base_unit}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-bold tabular text-danger-700">
                      {fmtNum(p.total_stock)} {p.base_unit}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-ink-100 px-5 py-3">
              <Link to="/batches" className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-700 hover:underline">
                Record a new batch <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </Card>

          <Card>
            <div className="flex items-center gap-2 border-b border-ink-200 px-5 py-4">
              <TrendingDown className={cn('size-4', lowMargin.length > 0 ? 'text-warning-600' : 'text-ink-300')} aria-hidden />
              <h2 className="text-[15px] font-bold text-ink-900">Low margin</h2>
              {lowMargin.length > 0 && (
                <StatusPill tone="warning" dot={false}>
                  {lowMargin.length}
                </StatusPill>
              )}
            </div>
            {lowMargin.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-ink-500">All products clear the margin threshold.</p>
            ) : (
              <ul className="divide-y divide-ink-100 px-2 py-1">
                {lowMargin.map((m) => (
                  <li key={m.product_id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-ink-900">{m.product_name}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-warning-50 px-2 py-0.5 text-xs font-bold tabular text-warning-700">
                      {Math.round((m.margin_pct ?? 0) * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-ink-100 px-5 py-3">
              <Link to="/products" className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-700 hover:underline">
                Review product prices <ArrowUpRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  detail,
  tone,
  linkTo,
}: {
  label: string
  value: string
  detail: string
  tone: 'neutral' | 'success' | 'danger'
  linkTo?: string
}) {
  const inner = (
    <Card className="flex h-full flex-col justify-between p-5 transition-shadow hover:shadow-sm">
      <p className="text-[13px] font-semibold uppercase tracking-wider text-ink-400">{label}</p>
      <div className="mt-1">
        <p
          className={cn(
            'text-[26px] font-extrabold leading-none tracking-tight tabular',
            tone === 'danger' ? 'text-danger-600' : tone === 'success' ? 'text-success-600' : 'text-ink-900',
          )}
        >
          {value}
        </p>
        <p className="mt-1.5 text-xs font-medium text-ink-500">{detail}</p>
      </div>
    </Card>
  )
  if (linkTo)
    return (
      <Link to={linkTo} className="group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 rounded-xl">
        {inner}
      </Link>
    )
  return inner
}
