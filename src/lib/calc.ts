// Cost/margin helpers for API-driven product data.
// Costs come from the backend (current_cost_per_unit, cached from open batches).
import type { ApiProduct } from './api'

/** Unit cost of a product (KSh per base unit) — 0 when no open batch exists. */
export function costOf(product: ApiProduct): number {
  return product.current_cost_per_unit ?? 0
}

export function marginOf(sell: number, cost: number): number {
  if (cost <= 0) return 1 // 100% margin if cost is zero/unknown
  return (sell - cost) / sell
}
