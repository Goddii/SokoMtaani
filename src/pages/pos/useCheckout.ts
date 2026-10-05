import { useState } from 'react'
import { useStore } from '../../lib/store'
import { pushSaleToServer } from '../../lib/sync'
import { newSaleId } from '../../lib/id'
import type { PaymentMethod } from '../../lib/types'
import type { CartLine } from '../../components/pos/CartPanel'
import { lineBaseQty, lineUnitPrice } from '../../components/pos/posMeta'
import { loadLastAttendant, saveLastAttendant } from './posHelpers'
import type { CheckoutToast } from './useCheckoutToast'

interface CheckoutArgs {
  lines: CartLine[]
  total: number
  payment: PaymentMethod
  offline: boolean
  loadData: () => Promise<void>
  showToast: (t: CheckoutToast) => void
  /** Runs once the sale is recorded locally (clear the cart, close the sheet). */
  onRecorded: () => void
}

const nowIso = () => new Date().toISOString()

/** Records a sale locally, then pushes it to the server when online. */
export function useCheckout({ lines, total, payment, offline, loadData, showToast, onRecorded }: CheckoutArgs) {
  const { state, dispatch } = useStore()
  const [lastAttendant, setLastAttendant] = useState<number | null>(loadLastAttendant)

  const completeCharge = (attendantId: number) => {
    const items = lines.map((l) => {
      const qty = lineBaseQty(l.count, l.button)
      const counted = l.product.pricing_mode === 'counted'
      return {
        productId: l.product.id,
        qty,
        unit: l.product.base_unit,
        unitPrice: lineUnitPrice(l.product.sell_price, l.button, l.product.pricing_mode),
        // Display only — the backend computes cost/profit from qty + unitPrice.
        tierLabel: l.button?.label,
        // A counted option with an exact amount consumes real stock — flag the
        // line so the backend routes it through FIFO like a weighed sale.
        amountInBaseUnit: counted && l.button?.kg_amount != null ? qty : undefined,
        // Times the selling button was sold — survives the offline queue and
        // is snapshotted server-side so history can show "3 × 1 tomato".
        count: l.button ? l.count : undefined,
      }
    })
    const itemCount = lines.length
    const id = newSaleId()
    const createdAt = nowIso()

    dispatch({
      type: 'CHECKOUT',
      id,
      sale: { items, total, attendantId, createdAt, payment },
    })

    setLastAttendant(attendantId)
    saveLastAttendant(attendantId)
    onRecorded()

    // OFFLINE: the sale is now persisted locally as pending — the success
    // state is honest immediately ("saved offline, will sync").
    if (offline) {
      showToast({ kind: 'offline', total, itemCount })
      return
    }

    // ONLINE: push to the server right away. The success toast appears ONLY
    // when the server acknowledges — never merely because the PIN was entered.
    // On a network failure the sale stays pending locally (same offline
    // wording applies — it will sync later); on a server rejection nothing
    // success-like is shown, the reason lands in My Sales.
    const queued = {
      id,
      saleNumber: state.nextSaleNumber,
      items,
      total,
      attendantId,
      createdAt,
      payment,
      syncStatus: 'pending' as const,
    }
    pushSaleToServer(queued).then((outcome) => {
      if (outcome.ok) {
        dispatch({ type: 'REMOVE_SALE', id })
        loadData() // refresh stock + prices after the sale lands
        showToast({ kind: 'online', total, itemCount })
      } else if (outcome.errors.length === 0) {
        // Unreachable — no verdict; the sale waits in the queue for retry.
        showToast({ kind: 'offline', total, itemCount })
      } else {
        // Rejected — reason shown in My Sales; no success toast.
        const reason = outcome.errors[0]
        if (reason !== undefined) {
          dispatch({ type: 'MARK_PENDING', id, reason })
        }
      }
    })
  }

  return { completeCharge, lastAttendant }
}
