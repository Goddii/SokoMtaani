/**
 * SokoMtaani — API client
 * Thin fetch wrapper that automatically injects the JWT from localStorage
 * and returns parsed JSON. All calls hit /api/* which Vite proxies to Flask.
 */

const BASE = '/api'

/**
 * Endpoints that legitimately return 401 (wrong PIN). A 401 here must NOT be
 * treated as a dead session — otherwise a mistyped PIN at the till would log
 * the attendant out mid-shift.
 */
const AUTH_401_OK = ['/auth/login', '/auth/verify-pin']

/**
 * One redirect per page load — a burst of parallel 401s (e.g. every page
 * firing its data fetch at once) must not navigate repeatedly.
 */
let sessionExpiredRedirected = false

function getToken(): string | null {
  return localStorage.getItem('soko-jwt')
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ data: T; ok: boolean; status: number; error?: string }> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  let data: T
  try {
    data = await res.json()
  } catch {
    data = {} as T
  }

  if (!res.ok) {
    // Dead session (expired/invalid token): clear it and land on the login
    // screen. Full reload is fine — the offline sale queue lives in
    // localStorage ('soko-mtaani/v2') and is untouched.
    if (res.status === 401 && !AUTH_401_OK.includes(path) && !sessionExpiredRedirected) {
      sessionExpiredRedirected = true
      // Mirror auth.ts's clearSession() (TOKEN_KEY / USER_KEY) without importing
      // it — importing would create an api.ts <-> auth.ts circular dependency.
      localStorage.removeItem('soko-jwt')
      localStorage.removeItem('soko-user')
      window.location.assign('/')
    }
    const body = data as Record<string, unknown>
    const firstError = (msg: unknown): string =>
      typeof msg === 'string' ? msg : Array.isArray(msg) ? String(msg[0] ?? '') : ''
    const errors = body?.errors
    const errMsg =
      (body?.error as string) ||
      (errors && typeof errors === 'object' ? firstError(Object.values(errors as Record<string, unknown>)[0]) : '') ||
      `HTTP ${res.status}`
    return { data, ok: false, status: res.status, error: errMsg }
  }

  return { data, ok: true, status: res.status }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (attendant_id: number, pin: string) =>
    request<{ access_token: string; attendant: ApiAttendant }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ attendant_id, pin }),
    }),
  me: () => request<ApiAttendant>('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  verifyPin: (attendant_id: number, pin: string) =>
    request<{ ok: boolean; attendant_id: number }>('/auth/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ attendant_id, pin }),
    }),
}

// ── Products ──────────────────────────────────────────────────────────────────
export const productsApi = {
  list: () => request<ApiProduct[]>('/products'),
  create: (body: ApiProductInput) =>
    request<ApiProduct>('/products', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: number, body: Partial<ApiProductInput>) =>
    request<ApiProduct>(`/products/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  stock: (id: number) => request<ApiProductStock>(`/products/${id}/stock`),
}

// ── Batches ───────────────────────────────────────────────────────────────────
export const batchesApi = {
  list: (params?: { product_id?: number; status?: string }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
    return request<ApiBatch[]>(`/batches${qs}`)
  },
  create: (body: {
    product_id: number
    bulk_quantity: number
    bulk_unit: string
    total_cost: number
    date_received?: string
  }) => request<ApiBatch>('/batches', { method: 'POST', body: JSON.stringify(body) }),
  close: (id: number) =>
    request<ApiBatch>(`/batches/${id}/close`, { method: 'PUT' }),
}

// ── Attendants ────────────────────────────────────────────────────────────────
export const attendantsApi = {
  list: () => request<ApiAttendant[]>('/attendants'),
  resetPin: (id: number, pin: string) =>
    request(`/attendants/${id}/reset-pin`, { method: 'POST', body: JSON.stringify({ pin }) }),
}

// ── Sales ─────────────────────────────────────────────────────────────────────
export const salesApi = {
  sync: (sales: SyncSaleItem[]) =>
    request<{ results: SyncResult[] }>('/sales/sync', {
      method: 'POST',
      body: JSON.stringify({ sales }),
    }),
  list: (params?: { date?: string; attendant_id?: number; product_id?: number }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
    return request<ApiSale[]>(`/sales${qs}`)
  },
  page: (params?: {
    from?: string
    to?: string
    attendant_id?: number
    product_id?: number
    page?: number
    per_page?: number
  }) => {
    const qs = toQueryString(params)
    return request<ApiSalesPage>(`/sales/page${qs}`)
  },
  dailySummary: (params?: { date?: string; from?: string; to?: string; attendant_id?: number; product_id?: number }) => {
    const qs = toQueryString(params)
    return request<ApiDailySummary>(`/sales/daily-summary${qs}`)
  },
  void: (id: number) => request<ApiSale>(`/sales/${id}/void`, { method: 'POST' }),
  /**
   * CSV export of the current Sales view (same filters + role scoping as
   * /sales/page). Returns the raw CSV text for the caller to download.
   */
  export: async (params?: {
    from?: string
    to?: string
    attendant_id?: number
    product_id?: number
  }): Promise<{ ok: boolean; text?: string; error?: string }> => {
    const token = getToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const qs = toQueryString(params)
    const res = await fetch(`${BASE}/sales/export${qs}`, { headers })
    if (!res.ok) {
      return { ok: false, error: `Export failed (HTTP ${res.status}).` }
    }
    return { ok: true, text: await res.text() }
  },
}

// ── Wastage ───────────────────────────────────────────────────────────────────
export const wastageApi = {
  list: (params?: { product_id?: number; attendant_id?: number; date?: string }) => {
    const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
    return request<ApiWastage[]>(`/wastage${qs}`)
  },
  create: (body: {
    product_id: number
    quantity: number
    reason?: string
    date?: string
    // recorded_by is intentionally absent — the backend derives the acting
    // attendant from the JWT identity, never from the client.
  }) => request<ApiWastage>('/wastage', { method: 'POST', body: JSON.stringify(body) }),
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export const dashboardApi = {
  summary: () => request<ApiDashboardSummary>('/dashboard/summary'),
  series: (days: number) => request<ApiSeriesResponse>(`/dashboard/series?days=${days}`),
}

/** Serialize params, dropping undefined/empty values (never "undefined" strings). */
function toQueryString(params?: Record<string, unknown>): string {
  if (!params) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

// ── API Types ─────────────────────────────────────────────────────────────────

export interface ApiAttendant {
  id: number
  name: string
  shop_role: 'attendant' | 'owner'
  active: boolean
}

export interface ApiPriceButton {
  id: number
  label: string
  /**
   * Amount of the product's base unit this option consumes from stock.
   * Set for weighed portions (0.25 kg) and tracked counted options (3 pieces);
   * null only on legacy counted options that never deducted stock.
   * The wire/database name keeps the historical "kg_amount" for compatibility.
   */
  kg_amount: number | null
  price: number
  sort_order: number
}

/** Payload shape for creating/updating a price button (id is server-assigned). */
export interface ApiPriceButtonInput {
  label: string
  kg_amount: number | null
  price: number
  sort_order: number
}

export type PricingMode = 'weighed' | 'counted'

/** Payload shape for creating a product. */
export interface ApiProductInput {
  name: string
  category: ApiProduct['category']
  base_unit: ApiProduct['base_unit']
  pricing_mode?: PricingMode
  avg_piece_weight?: number | null
  sell_price: number
  reorder_threshold: number
  price_buttons?: ApiPriceButtonInput[]
}

export interface ApiProduct {
  id: number
  name: string
  category: 'produce' | 'dry' | 'packaging'
  base_unit: 'kg' | 'piece' | 'litre'
  /** 'weighed' — sold by weight/measure (default). 'counted' — sold by piece/bunch. */
  pricing_mode: PricingMode
  avg_piece_weight: number | null
  sell_price: number
  current_cost_per_unit: number | null
  reorder_threshold: number
  created_at: string
  total_stock: number
  is_low_stock: boolean
  // Fixed-price buttons on the till; empty when the product sells at flat sell_price
  price_buttons: ApiPriceButton[]
}

export interface ApiProductStock {
  product_id: number
  product_name: string
  base_unit: string
  total_stock: number
  is_low_stock: boolean
  reorder_threshold: number
}

export interface ApiBatch {
  id: number
  product_id: number
  product_name: string | null
  bulk_quantity: number
  bulk_unit: string
  total_cost: number
  cost_per_base_unit: number
  quantity_remaining: number
  date_received: string
  status: 'open' | 'closed'
  closed_at: string | null
  // Batch-level P&L for 'counted' products: money in vs money out so far
  revenue_so_far: number
  profit_loss: number
}

export interface ApiSale {
  id: number
  client_uuid: string
  product_id: number
  product_name: string | null
  batch_id: number
  attendant_id: number
  attendant_name: string | null
  quantity_sold: number
  unit_sold_in: string
  price_charged: number
  cost_at_sale: number
  profit: number
  revenue: number
  margin_pct: number
  sync_status: 'pending' | 'synced'
  created_at: string
  synced_at: string | null
  voided_at?: string | null
  // Transaction grouping + historical snapshots (null on legacy rows)
  sale_uuid: string | null
  product_name_snapshot: string | null
  button_label_snapshot: string | null
  quantity_base: number | null
  // Times the selling button was sold (the count control). NULL on legacy rows.
  button_count_snapshot: number | null
}

export interface SyncSaleItem {
  client_uuid: string
  product_id: number
  attendant_id: number
  quantity_sold: number
  unit_sold_in: string
  price_charged: number
  created_at: string
  // Transaction grouping + selling-option metadata (snapshotted server-side)
  sale_uuid?: string
  button_label?: string
  // Present for counted options with an exact amount — routes the line
  // through FIFO on the backend.
  amount_in_base_unit?: number
  // How many times the selling button was sold — snapshotted so history can
  // reconstruct "3 × 1 tomato". Never used for money math.
  count?: number
}

export interface SyncResult {
  client_uuid: string
  status: 'synced' | 'duplicate' | 'error'
  sale_id?: number
  reason?: string
}

export interface ApiWastage {
  id: number
  product_id: number
  product_name: string | null
  batch_id: number
  quantity: number
  reason: string
  date: string
  recorded_by: number
  attendant_name: string | null
}

export interface ApiDailySummary {
  date: string
  date_to?: string | null
  sale_count: number
  total_revenue: number
  total_cost: number
  total_profit: number
  margin_pct: number
}

export interface ApiSalesPage {
  items: ApiSale[]
  total: number
  page: number
  per_page: number
  has_more: boolean
}

export interface ApiSeriesPoint {
  date: string
  revenue: number
  profit: number
  sale_count: number
}

export interface ApiSeriesResponse {
  days: number
  series: ApiSeriesPoint[]
}

export interface ApiDashboardSummary {
  date: string
  low_margin_threshold: number
  today: {
    sale_count: number
    revenue: number
    cost: number
    profit: number
    margin_pct: number
  }
  per_product: Array<{
    product_id: number
    product_name: string
    revenue: number
    cost: number
    profit: number
    // null for 'counted' (sold by piece) products — no per-unit margin math
    margin_pct: number | null
    low_margin: boolean
  }>
  low_margin_sales: Array<{
    sale_id: number
    client_uuid: string
    product_id: number
    product_name: string | null
    attendant_name: string | null
    revenue: number
    profit: number
    margin_pct: number
    created_at: string
  }>
  low_stock_products: Array<{
    product_id: number
    product_name: string
    base_unit: string
    total_stock: number
    reorder_threshold: number
  }>
}
