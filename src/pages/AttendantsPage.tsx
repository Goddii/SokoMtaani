import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Users } from 'lucide-react'
import { attendantsApi, salesApi, type ApiAttendant, type ApiSale } from '../lib/api'
import { fmtKES } from '../lib/format'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { initialsOf } from '../lib/utils'
import { cn } from '../lib/utils'

type Period = 'today' | '7d' | '30d'

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

function periodRange(period: Period): { start: Date; end: Date } {
  const end = new Date()
  const start = new Date()
  if (period === 'today') {
    start.setHours(0, 0, 0, 0)
  } else {
    start.setDate(end.getDate() - (period === '7d' ? 7 : 30))
  }
  return { start, end }
}

export function AttendantsPage() {
  const [attendants, setAttendants] = useState<ApiAttendant[]>([])
  const [sales, setSales] = useState<ApiSale[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('today')
  const [resetTarget, setResetTarget] = useState<ApiAttendant | null>(null)
  const [newPin, setNewPin] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinDone, setPinDone] = useState(false)

  const loadData = useCallback(async () => {
    const [aRes, sRes] = await Promise.all([attendantsApi.list(), salesApi.list()])
    if (aRes.ok) setAttendants(aRes.data)
    if (sRes.ok) setSales(sRes.data)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const { start, end } = useMemo(() => periodRange(period), [period])

  const rows = useMemo(() => {
    const per = new Map<number, { count: number; total: number; profit: number }>()
    for (const s of sales) {
      const t = new Date(s.created_at).getTime()
      if (t < start.getTime() || t >= end.getTime()) continue
      const cur = per.get(s.attendant_id) ?? { count: 0, total: 0, profit: 0 }
      cur.count += 1
      cur.total += s.revenue
      cur.profit += s.profit
      per.set(s.attendant_id, cur)
    }
    return attendants
      .map((a) => ({ attendant: a, stats: per.get(a.id) ?? { count: 0, total: 0, profit: 0 } }))
      .sort((a, b) => b.stats.total - a.stats.total)
  }, [attendants, sales, start, end])

  const maxTotal = Math.max(1, ...rows.map((r) => r.stats.total))

  const openReset = (a: ApiAttendant) => {
    setResetTarget(a)
    setNewPin('')
    setPinError(null)
    setPinDone(false)
  }

  const submitPin = async () => {
    if (!resetTarget) return
    const pin = newPin.trim()
    if (!/^\d{4}$/.test(pin)) {
      setPinError('PIN must be exactly 4 digits.')
      return
    }
    setPinBusy(true)
    setPinError(null)
    const res = await attendantsApi.resetPin(resetTarget.id, pin)
    setPinBusy(false)
    if (!res.ok) {
      setPinError(res.error || 'Could not reset the PIN.')
      return
    }
    setPinDone(true)
    window.setTimeout(() => setResetTarget(null), 1200)
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-8 w-56 animate-pulse rounded-md bg-ink-100" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl bg-ink-100" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        crumbs={[{ label: 'Team', to: '/' }, { label: 'Attendants' }]}
        title="Attendants"
        subtitle="The people behind the counter — their PINs and how they're selling."
      />

      {/* Attendant cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {attendants.map((a) => {
          const todayStart = new Date()
          todayStart.setHours(0, 0, 0, 0)
          const todaySales = sales.filter(
            (s) => s.attendant_id === a.id && new Date(s.created_at).getTime() >= todayStart.getTime(),
          )
          const todayTotal = todaySales.reduce((s, x) => s + x.revenue, 0)
          return (
            <Card key={a.id} className="flex flex-col p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">
                  {initialsOf(a.name)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-bold text-ink-900">{a.name}</p>
                  <p className="text-xs text-ink-500">
                    {a.shop_role === 'owner' ? 'Owner' : 'Attendant'} · {a.active ? 'Active' : 'Inactive'}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-600">
                  <KeyRound className="size-3.5 text-ink-400" aria-hidden />
                  PIN-protected at the till
                </span>
                <span className="font-mono text-sm font-semibold tracking-widest text-ink-400">••••</span>
              </div>

              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-xs font-medium text-ink-500">Sold today</span>
                <span className="text-sm font-extrabold tabular text-ink-900">{fmtKES(todayTotal)}</span>
              </div>
              <p className="text-right text-xs text-ink-400">
                {todaySales.length} sale{todaySales.length === 1 ? '' : 's'}
              </p>

              <div className="mt-auto pt-3">
                <Button variant="secondary" size="sm" className="w-full" onClick={() => openReset(a)} disabled={a.shop_role === 'owner'}>
                  Reset PIN
                </Button>
              </div>
            </Card>
          )
        })}
      </div>

      {/* Sales report */}
      <Card className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div>
            <h2 className="text-[15px] font-bold text-ink-900">Sales by attendant</h2>
            <p className="text-[13px] text-ink-500">Total tilled, per person — ranked by value.</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5" role="tablist" aria-label="Report period">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                role="tab"
                aria-selected={period === p.value}
                onClick={() => setPeriod(p.value)}
                className={cn(
                  'h-7 rounded-md px-3 text-xs font-semibold transition-all',
                  period === p.value ? 'bg-white text-ink-900 shadow-sm ring-1 ring-ink-200' : 'text-ink-500 hover:text-ink-800',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <ul className="space-y-3 px-5 py-5">
          {rows.map(({ attendant: a, stats }) => (
            <li key={a.id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-bold text-ink-900">
                  <span className="flex size-7 items-center justify-center rounded-full bg-brand-50 text-[11px] font-bold text-brand-800">
                    {initialsOf(a.name)}
                  </span>
                  {a.name}
                </span>
                <span className="text-sm font-extrabold tabular text-ink-900">{fmtKES(stats.total)}</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full rounded-full bg-brand-600 transition-all duration-300"
                    style={{ width: `${Math.max(1.5, (stats.total / maxTotal) * 100)}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right text-xs font-medium tabular text-ink-500">
                  {stats.count} sale{stats.count === 1 ? '' : 's'} · {fmtKES(stats.profit)} profit
                </span>
              </div>
            </li>
          ))}
        </ul>
        {rows.every((r) => r.stats.count === 0) && (
          <p className="px-5 pb-5 text-center text-sm text-ink-500">
            No sales in this period yet — they'll appear here as the till runs.
          </p>
        )}
      </Card>

      <Modal
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        size="sm"
        title={resetTarget ? `Reset ${resetTarget.name}'s PIN` : 'Reset PIN'}
        description="The attendant uses this 4-digit PIN to authorise sales at the till."
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={pinBusy} onClick={submitPin}>
              Save new PIN
            </Button>
          </>
        }
      >
        {resetTarget && (
          <div>
            <label htmlFor="new-pin" className="mb-1.5 block text-[13px] font-semibold text-ink-700">
              New 4-digit PIN
            </label>
            <input
              id="new-pin"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{4}"
              maxLength={4}
              autoComplete="off"
              value={newPin}
              onChange={(e) => {
                setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                setPinError(null)
                setPinDone(false)
              }}
              placeholder="••••"
              aria-label="New 4-digit PIN"
              className={cn(
                'h-11 w-full rounded-lg border bg-white px-3 text-center font-mono text-xl font-bold tracking-[0.5em] text-ink-900 placeholder:text-ink-300',
                'focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none',
                pinError ? 'border-danger-600' : 'border-ink-300',
              )}
            />
            {pinError && (
              <p className="mt-1.5 text-[13px] font-semibold text-danger-600" role="alert">
                {pinError}
              </p>
            )}
            {pinDone && (
              <p className="mt-1.5 text-[13px] font-semibold text-success-700" role="status">
                PIN updated — {resetTarget.name} can use it at the till now.
              </p>
            )}
            <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-400">
              <Users className="size-3.5" aria-hidden />
              PINs are stored hashed in the shop records.
            </p>
          </div>
        )}
      </Modal>
    </div>
  )
}
