/**
 * Offline-sale sync helpers — push queued sales to the backend.
 * The server dedups by client_uuid, so retries are safe.
 */
import { salesApi } from './api'
import { getStoredUser } from './auth'
import type { OfflineSale } from './types'

export function saleToSyncItems(sale: OfflineSale) {
  const user = getStoredUser()
  const attendant_id = sale.attendantId || user?.id || 0
  return sale.items.map((item, i) => ({
    // One uuid PER LINE: a cart can hold several fixed-price lines for the
    // same product (e.g. two "1 @ KSh5" tomato taps, or "1 @ KSh5" + "3 @
    // KSh20"). Without the line index these collide and the backend's
    // idempotency check would silently drop the duplicates. The index is
    // stable across retries because items order never changes.
    client_uuid: `${sale.id}-${item.productId}-${i}`,
    product_id: item.productId,
    attendant_id,
    quantity_sold: item.qty,
    unit_sold_in: item.unit,
    price_charged: item.unitPrice,
    created_at: sale.createdAt,
    // Transaction grouping + selling-option metadata (snapshotted server-side).
    sale_uuid: sale.id,
    button_label: item.tierLabel,
    // Present for counted options with an exact amount — routes the line
    // through FIFO on the backend. Undefined keys are dropped by JSON.stringify.
    amount_in_base_unit: item.amountInBaseUnit,
    // Times the selling button was sold — snapshotted server-side for history.
    count: item.count,
  }))
}

export interface SyncOutcome {
  /** True when every line item was accepted (synced or a genuine retry duplicate). */
  ok: boolean
  /**
   * Human-readable reasons from the server for lines it rejected — e.g.
   * "Insufficient stock…" or a client_uuid collision. Empty for network
   * failures (no verdict reached) and for full success.
   */
  errors: string[]
}

/**
 * Push one queued sale to the backend.
 *
 * Distinguishes a *rejection* (the server answered and refused the line — the
 * reason must reach the attendant) from a *network failure* (no verdict — the
 * sale simply stays queued for the next retry).
 */
export async function pushSaleToServer(sale: OfflineSale): Promise<SyncOutcome> {
  try {
    const res = await salesApi.sync(saleToSyncItems(sale))
    if (!res.ok) return { ok: false, errors: [res.error || 'The server rejected this sale.'] }
    const results = res.data?.results ?? []
    const failed = results.filter((r) => r.status === 'error')
    if (failed.length === 0) return { ok: true, errors: [] }
    // Dedupe repeated reasons — a multi-line sale can fail several lines the
    // same way (e.g. the same product out of stock twice).
    const errors = [...new Set(failed.map((r) => r.reason).filter((x): x is string => Boolean(x)))]
    return {
      ok: false,
      errors: errors.length ? errors : ['The server rejected part of this sale.'],
    }
  } catch {
    // Network failure — no verdict from the server; the caller keeps it
    // queued and retries later.
    return { ok: false, errors: [] }
  }
}
