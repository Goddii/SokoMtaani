import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { pushSaleToServer } from '../../lib/sync'

/**
 * When the connection returns, push any sales queued while offline.
 * The server dedups by client_uuid, so a concurrent manual sync is safe.
 * Returns how many sales are still pending.
 */
export function useOfflineSync(offline: boolean, loadData: () => Promise<void>) {
  const { state, dispatch } = useStore()
  const syncInFlight = useRef(false)
  const syncAgain = useRef(false)
  const [syncTick, setSyncTick] = useState(0)

  useEffect(() => {
    if (offline) return
    const pendingSales = state.sales.filter((s) => s.syncStatus === 'pending')
    if (!pendingSales.length) return
    // One push at a time: every dispatch below changes state.sales and
    // re-fires this effect. If a push is already running, note that and
    // re-run once it finishes so a sale queued meanwhile is not stranded.
    if (syncInFlight.current) {
      syncAgain.current = true
      return
    }
    syncInFlight.current = true
    Promise.all(pendingSales.map((sale) => pushSaleToServer(sale))).then((outcomes) => {
      if (outcomes.every((o) => o.ok)) {
        dispatch({ type: 'SYNC_ALL', now: new Date().toISOString() })
        dispatch({ type: 'CLEAR_SYNCED' })
        loadData()
        return
      }
      // Record the server's verdict on each rejected sale so My Sales can
      // explain it. Only a rejection carries a verdict — network failures
      // (empty errors) leave the sale and any prior reason untouched. And
      // skip unchanged reasons: that keeps this effect from re-firing on its
      // own dispatch and hammering the server in a retry loop (a genuinely
      // blocked sale keeps the same reason, so after one dispatch the state
      // matches and the loop stops).
      pendingSales.forEach((sale, i) => {
        const reason = outcomes[i].errors[0]
        if (reason !== undefined && sale.syncError !== reason) {
          dispatch({ type: 'MARK_PENDING', id: sale.id, reason })
        }
      })
    })
      // A thrown network error leaves the sales pending; the next state change
      // or reconnect retries them.
      .catch(() => {})
      .finally(() => {
        syncInFlight.current = false
        if (syncAgain.current) {
          syncAgain.current = false
          setSyncTick((t) => t + 1)
        }
      })
  }, [offline, state.sales, dispatch, loadData, syncTick])

  return { pendingCount: state.sales.filter((s) => s.syncStatus === 'pending').length }
}
