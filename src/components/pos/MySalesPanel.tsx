import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Receipt, X } from 'lucide-react'
import { salesApi } from '../../lib/api'
import { getStoredUser, isOwner } from '../../lib/auth'
import { useStore } from '../../lib/store'
import { fmtKES, fmtTime, todayKey } from '../../lib/format'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { cn } from '../../lib/utils'

const VOID_WINDOW_MS = 15 * 60 * 1000

interface MySaleRow {
  key: string
  createdAt: string
  time: string
  itemCount: number
  total: number
  status: 'synced' | 'pending'
  // Why a queued sale couldn't sync — shown to the attendant instead of a
  // bare "Queued" so they know to ask the owner rather than retry forever.
  syncError?: string
  productName: string | null
  saleId: number | null
  localId: string | null
  attendantId: number
}

interface Props {
  onClose: () => void
}

/**
 * "My Sales" — the logged-in attendant's sales for today, pulled from the
 * server (synced) and merged with any sales still queued on this phone.
 * Synced rows within the void window (or any row, for the owner) can be
 * voided; queued rows are simply removed from this phone.
 */
export function MySalesPanel({ onClose }: Props) {
  const { state, dispatch } = useStore()
  const userId = getStoredUser()?.id
  const [loading, setLoading] = useState(true)
  const [synced, setSynced] = useState<MySaleRow[]>([])
  const [refreshTick, setRefreshTick] = useState(0)
  const [confirmSale, setConfirmSale] = useState<MySaleRow | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [voidError, setVoidError] = useState<string | null>(null)
  const [voidedToast, setVoidedToast] = useState<string | null>(null)
  // Ticks so the 15-minute void window expires live while the panel is open.
  const [nowMs, setNowMs] = useState(() => Date.now())

  // Fetch synced sales on open, and re-fetch whenever the local queue changes
  // or a sale has been voided, so the list stays honest.
  useEffect(() => {
    if (!userId) {
      setLoading(false)
      return
    }
    let cancelled = false
    salesApi.list({ attendant_id: userId, date: todayKey() }).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setSynced(
          res.data.map((s) => ({
            key: `api-${s.id}`,
            createdAt: s.created_at,
            time: fmtTime(s.created_at),
            itemCount: 1,
            total: s.revenue,
            status: 'synced' as const,
            productName: s.product_name,
            saleId: s.id,
            localId: null,
            attendantId: s.attendant_id,
          })),
        )
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [state.sales, userId, refreshTick])

  // Escape closes the panel (matches the AppShell drawer behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Auto-dismiss the voided toast.
  useEffect(() => {
    if (!voidedToast) return
    const t = window.setTimeout(() => setVoidedToast(null), 2600)
    return () => window.clearTimeout(t)
  }, [voidedToast])

  // Refresh the clock every 30s so void buttons expire once the window passes.
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 30000)
    return () => window.clearInterval(t)
  }, [])

  const pending: MySaleRow[] = useMemo(() => {
    if (!userId) return []
    return state.sales
      .filter((s) => s.attendantId === userId && s.syncStatus === 'pending')
      .map((s) => ({
        key: `local-${s.id}`,
        createdAt: s.createdAt,
        time: fmtTime(s.createdAt),
        itemCount: s.items.length,
        total: s.total,
        status: 'pending' as const,
        syncError: s.syncError,
        productName: null,
        saleId: null,
        localId: s.id,
        attendantId: s.attendantId,
      }))
  }, [state.sales, userId])

  const rows = useMemo(
    () => [...synced, ...pending].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [synced, pending],
  )

  const totalToday = useMemo(() => rows.reduce((s, r) => s + r.total, 0), [rows])
  const count = rows.length

  // Voidable: any queued sale, any sale for the owner, or an own sale still
  // inside the 15-minute window.
  const canVoid = useCallback(
    (r: MySaleRow) => {
      if (r.status === 'pending') return true
      if (isOwner()) return true
      return r.attendantId === userId && nowMs - new Date(r.createdAt).getTime() <= VOID_WINDOW_MS
    },
    [userId, nowMs],
  )

  const requestVoid = (r: MySaleRow) => {
    if (r.status === 'pending' && r.localId) {
      if (window.confirm('Remove this queued sale from this phone?')) {
        dispatch({ type: 'REMOVE_SALE', id: r.localId })
        setVoidedToast('Queued sale removed from this phone')
      }
      return
    }
    setVoidError(null)
    setConfirmSale(r)
  }

  const confirmVoid = async () => {
    if (!confirmSale || confirmSale.saleId == null) return
    setVoiding(true)
    setVoidError(null)
    const res = await salesApi.void(confirmSale.saleId)
    setVoiding(false)
    if (!res.ok) {
      setVoidError(res.error || 'Could not void the sale.')
      return
    }
    setVoidedToast(`${fmtKES(confirmSale.total)} voided — stock restored`)
    setConfirmSale(null)
    setRefreshTick((t) => t + 1)
  }

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="My Sales">
      <div className="absolute inset-0 bg-ink-950/40" onClick={onClose} aria-hidden />

      {/* Mobile: bottom sheet · Desktop: right slide-over */}
      <div className="absolute inset-x-0 bottom-0 flex max-h-[86dvh] animate-[sheet-up_240ms_cubic-bezier(0.16,1,0.3,1)] flex-col overflow-hidden rounded-t-2xl bg-white shadow-docked lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[380px] lg:animate-[sheet-in_240ms_cubic-bezier(0.16,1,0.3,1)] lg:rounded-l-2xl lg:rounded-tr-none">
        <div className="flex justify-center pt-2.5 lg:hidden">
          <span className="h-1 w-10 rounded-full bg-ink-200" aria-hidden />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3.5">
          <div>
            <h2 className="text-[15px] font-bold leading-tight text-ink-900">My Sales</h2>
            <p className="text-xs font-medium text-ink-500">Today</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close My Sales"
            className="rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-100"
          >
            <X className="size-4.5" aria-hidden />
          </button>
        </div>

        {/* Success toast */}
        {voidedToast && (
          <div className="flex items-center gap-2.5 border-b border-success-600/15 bg-success-50 px-4 py-2.5" role="status">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success-600 text-white">
              <Check className="size-3" strokeWidth={3} aria-hidden />
            </span>
            <p className="text-[13px] font-semibold text-success-700">{voidedToast}</p>
          </div>
        )}

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {loading ? (
            <div className="space-y-3 p-4" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5">
                  <div className="space-y-1.5">
                    <div className="h-3 w-16 animate-pulse rounded bg-ink-100" />
                    <div className="h-3 w-24 animate-pulse rounded bg-ink-100" />
                  </div>
                  <div className="h-6 w-20 animate-pulse rounded-full bg-ink-100" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-ink-100 text-ink-400">
                <Receipt className="size-5" aria-hidden />
              </div>
              <p className="text-sm font-semibold text-ink-700">No sales yet today</p>
              <p className="max-w-[220px] text-[13px] leading-relaxed text-ink-500">
                Ring up your first one and it will show up here.
              </p>
            </div>
          ) : (
            <ul className="px-3 py-2">
              {rows.map((r) => (
                <li
                  key={r.key}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-ink-50"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink-900">{r.time}</p>
                    {r.status === 'synced' ? (
                      <p className="truncate text-xs text-ink-500">{r.productName ?? 'Sale'}</p>
                    ) : r.syncError ? (
                      <p className="text-xs font-semibold leading-snug text-danger-600">{r.syncError}</p>
                    ) : (
                      <p className="truncate text-xs text-ink-500">Queued on this phone</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="text-right">
                      <p className="text-sm font-extrabold tabular text-ink-900">{fmtKES(r.total)}</p>
                      <p className="text-xs font-medium text-ink-500">
                        {r.itemCount} item{r.itemCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
                        r.status === 'synced'
                          ? 'bg-success-50 text-success-700 ring-success-600/20'
                          : r.syncError
                            ? 'bg-danger-50 text-danger-700 ring-danger-600/25'
                            : 'bg-warning-50 text-warning-700 ring-warning-600/25',
                      )}
                    >
                      {r.status === 'synced' ? 'Synced' : r.syncError ? 'Blocked' : 'Queued'}
                    </span>
                    {canVoid(r) && (
                      <button
                        type="button"
                        onClick={() => requestVoid(r)}
                        className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold text-ink-400 transition-colors hover:bg-danger-50 hover:text-danger-600"
                      >
                        Void
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-ink-200 px-4 py-3.5">
          <p className="text-sm font-semibold text-ink-700">
            {count} sale{count === 1 ? '' : 's'} ·{' '}
            <span className="font-extrabold tabular text-ink-900">{fmtKES(totalToday)}</span> today
          </p>
        </div>

        <style>{`@keyframes sheet-in { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
      </div>

      {/* Void confirmation */}
      <Modal
        open={confirmSale !== null}
        onClose={() => {
          if (!voiding) setConfirmSale(null)
        }}
        size="sm"
        title="Void this sale?"
        description="The stock goes back into the batch and the sale is marked voided."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmSale(null)} disabled={voiding}>
              Keep it
            </Button>
            <Button variant="danger" loading={voiding} onClick={confirmVoid}>
              Void sale
            </Button>
          </>
        }
      >
        {confirmSale && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-base font-extrabold tabular text-ink-900">{fmtKES(confirmSale.total)}</p>
              <p className="text-xs font-medium text-ink-500">
                {confirmSale.time} · {confirmSale.itemCount} item{confirmSale.itemCount === 1 ? '' : 's'}
              </p>
            </div>
            <p className="text-right text-xs font-semibold text-ink-500">
              {confirmSale.productName ?? 'Sale'}
            </p>
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
