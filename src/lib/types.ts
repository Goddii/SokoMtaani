export type Unit = 'kg' | 'piece' | 'litre'
export type Category = 'produce' | 'dry' | 'packaging'
export type PaymentMethod = 'cash' | 'mpesa'

export interface SaleItem {
  productId: number
  qty: number
  unit: string
  unitPrice: number
  // Receipt/history display only — does not affect the money math.
  // Set when the line was sold through a price button (e.g. "1 @ KSh5",
  // "1/4 kg").
  tierLabel?: string
  // Set for counted options that carry an exact amount (e.g. "3 tomatoes" →
  // 3 pieces): tells the backend this line consumes real stock through FIFO.
  amountInBaseUnit?: number
  // How many times the selling button was sold (the till's count control,
  // e.g. "1 tomato @ KSh5" x3). Present only on button lines. Persisted in
  // the offline queue so a count survives reload, and snapshotted server-side
  // so history shows "3 × 1 tomato" rather than collapsing into the button's
  // amount.
  count?: number
}

// Kept only for the offline queue in localStorage
export interface OfflineSale {
  id: string
  saleNumber: number
  items: SaleItem[]
  total: number
  attendantId: number
  createdAt: string
  payment: PaymentMethod
  syncStatus: 'synced' | 'pending'
  syncedAt?: string
  // Why a queued sale couldn't sync — the server's reason (e.g. insufficient
  // stock, offline sync conflict). Set only when the backend actually rejected
  // the sale; absent for plain network failures (it'll retry silently). Shown
  // in My Sales and the connection badge so the attendant knows to ask the
  // owner instead of retrying forever.
  syncError?: string
}

export interface AppState {
  sales: OfflineSale[]
  nextSaleNumber: number
}
