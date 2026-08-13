import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useOffline } from '../../hooks/useOffline'
import { useStore } from '../../lib/store'
import { cn } from '../../lib/utils'
import { pushSaleToServer } from '../../lib/sync'

export function OfflineIndicator({ className }: { className?: string }) {
  const { offline, setDemoOfflineState } = useOffline()
  const { state, dispatch } = useStore()
  const pending = state.sales.filter((s) => s.syncStatus === 'pending').length
  // Sales the server actually rejected — these need the owner, not another retry.
  const blocked = state.sales.filter((s) => s.syncStatus === 'pending' && s.syncError)
  const [open, setOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  async function handleSync() {
    const pendingSales = state.sales.filter((s) => s.syncStatus === 'pending')
    if (!pendingSales.length) return
    setSyncing(true)
    try {
      // Push each queued sale; every line item must be accepted for the sale
      // to be considered synced. Failures stay pending for the next retry.
      const outcomes = await Promise.all(pendingSales.map((sale) => pushSaleToServer(sale)))
      if (outcomes.every((o) => o.ok)) {
        dispatch({ type: 'SYNC_ALL', now: new Date().toISOString() })
        dispatch({ type: 'CLEAR_SYNCED' })
        setOpen(false) // everything landed — close the popover
      } else {
        // Persist each server rejection so My Sales can explain it. Only a
        // rejection carries a verdict; network failures leave the sale and
        // any prior reason untouched. Skipping unchanged reasons avoids
        // pointless dispatches (same guard as the POS auto-sync effect).
        pendingSales.forEach((sale, i) => {
          const reason = outcomes[i].errors[0]
          if (reason !== undefined && sale.syncError !== reason) {
            dispatch({ type: 'MARK_PENDING', id: sale.id, reason })
          }
        })
        // Keep the popover open on failure so the attendant immediately sees
        // the "N can't sync" note and the reason instead of missing it.
      }
    } catch {
      // Network error — leave as pending, user can retry
    } finally {
      setSyncing(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Connection status"
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset transition-colors',
          offline
            ? 'bg-warning-50 text-warning-700 ring-warning-600/25'
            : 'bg-success-50 text-success-700 ring-success-600/20',
        )}
      >
        {offline ? <WifiOff className="size-3.5" aria-hidden /> : <Wifi className="size-3.5" aria-hidden />}
        <span className="hidden sm:inline">{offline ? 'Offline' : 'Online'}</span>
        {pending > 0 && (
          <span className="rounded-full bg-warning-600 px-1.5 text-[11px] font-bold text-white">
            {pending}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Connection settings"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-xl bg-white p-4 shadow-pop"
        >
          <div className="flex items-center gap-2 text-sm font-bold text-ink-900">
            {offline ? (
              <WifiOff className="size-4 text-warning-600" aria-hidden />
            ) : (
              <Wifi className="size-4 text-success-600" aria-hidden />
            )}
            {offline ? 'You are offline' : 'Connected'}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-500">
            {offline
              ? 'Sales made now will queue on this phone and sync automatically once the connection returns.'
              : pending > 0
                ? `${pending} sale${pending === 1 ? '' : 's'} queued and ready to sync.`
                : 'All sales are saved to this device and synced.'}
          </p>

          {blocked.length > 0 && (
            <p className="mt-2 rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold leading-relaxed text-danger-700" role="alert">
              {blocked.length} sale{blocked.length === 1 ? '' : 's'} can’t sync: {blocked[0].syncError} —
              open My Sales on the till for details.
            </p>
          )}

          {pending > 0 && !offline && (
            <button
              id="sync-now-btn"
              type="button"
              disabled={syncing}
              onClick={handleSync}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-800 disabled:opacity-60"
            >
              <RefreshCw className={cn('size-4', syncing && 'animate-spin')} aria-hidden />
              {syncing ? 'Syncing…' : `Sync ${pending} queued sale${pending === 1 ? '' : 's'}`}
            </button>
          )}

          <div className="mt-3 border-t border-ink-100 pt-3">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-ink-700">Demo: simulate offline</span>
              <button
                type="button"
                role="switch"
                aria-checked={offline}
                onClick={() => setDemoOfflineState(!offline)}
                className={cn(
                  'relative h-5.5 w-10 rounded-full transition-colors',
                  offline ? 'bg-warning-600' : 'bg-ink-200',
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 size-4.5 rounded-full bg-white shadow transition-all',
                    offline ? 'left-5' : 'left-0.5',
                  )}
                />
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-400">Try the queue: switch off, make a sale, sync later.</p>
          </div>
        </div>
      )}
    </div>
  )
}
