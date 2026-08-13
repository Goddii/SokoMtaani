import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Check, LogOut, Receipt, Search, ShoppingBag, X, WifiOff } from 'lucide-react'
import { useStore } from '../lib/store'
import { useOffline } from '../hooks/useOffline'
import { isOwner } from '../lib/auth'
import { pushSaleToServer } from '../lib/sync'
import { fmtKES } from '../lib/format'
import { productsApi, attendantsApi, type ApiAttendant, type ApiPriceButton, type ApiProduct } from '../lib/api'
import { newSaleId } from '../lib/id'
import type { Category, PaymentMethod } from '../lib/types'
import { CartPanel, type CartLine } from '../components/pos/CartPanel'
import { ProductTile } from '../components/pos/ProductTile'
import { PinModal } from '../components/pos/PinModal'
import { ButtonPicker } from '../components/pos/ButtonPicker'
import { MySalesPanel } from '../components/pos/MySalesPanel'
import { CATEGORY_META, lineBaseQty, lineTotal, lineUnitPrice, stepFor } from '../components/pos/posMeta'
import { cn } from '../lib/utils'

type CatFilter = 'all' | Category

const CAT_FILTERS: Array<{ value: CatFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'produce', label: CATEGORY_META.produce.label },
  { value: 'dry', label: CATEGORY_META.dry.label },
  { value: 'packaging', label: CATEGORY_META.packaging.label },
]

function loadLastAttendant(): number | null {
  try {
    const raw = localStorage.getItem('soko-mtaani/last-attendant')
    const n = raw ? parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function saveLastAttendant(id: number) {
  try {
    localStorage.setItem('soko-mtaani/last-attendant', String(id))
  } catch {
    // ignore
  }
}

/**
 * One row in the in-memory cart — sold at flat rate or via a fixed-price button.
 *
 * `count` means:
 * - button line: how many times that selling button is being sold ("1 tomato
 *   @ KSh5" x3). The base-unit qty it consumes is `amount × count`. A line
 *   never exists below count 1 — decrementing to 0 removes it.
 * - flat-rate line: the quantity in the product's base unit.
 */
interface CartLineState {
  id: number
  productId: number
  count: number
  button?: ApiPriceButton
}

/**
 * Max times a button can be sold against a cart snapshot: stock on hand minus
 * what every OTHER line of the product already holds (each sold at its own
 * base-unit qty), divided by the button's amount. null for legacy buttons
 * without an amount — they never deduct stock, so there is no cap.
 */
function maxCountIn(
  cart: CartLineState[],
  product: ApiProduct,
  button: ApiPriceButton,
  excludeButtonId?: number,
): number | null {
  const amount = button.kg_amount
  if (amount == null) return null
  const otherBase = cart
    .filter((l) => l.productId === product.id && l.button?.id !== (excludeButtonId ?? button.id))
    .reduce((s, l) => s + lineBaseQty(l.count, l.button), 0)
  const remaining = Math.max(0, product.total_stock - otherBase)
  return Math.floor(remaining / amount)
}

export function PosPage({ onLogout }: { onLogout?: () => void }) {
  const { state, dispatch } = useStore()
  const { offline } = useOffline()
  const navigate = useNavigate()

  const [products, setProducts] = useState<ApiProduct[]>([])
  const [attendants, setAttendants] = useState<ApiAttendant[]>([])
  const [loading, setLoading] = useState(true)

  const [cart, setCart] = useState<CartLineState[]>([])
  const [payment, setPayment] = useState<PaymentMethod>('mpesa')
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState<CatFilter>('all')
  const [cartOpen, setCartOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [buttonProduct, setButtonProduct] = useState<ApiProduct | null>(null)
  const [mySalesOpen, setMySalesOpen] = useState(false)
  const [lastAttendant, setLastAttendant] = useState<number | null>(loadLastAttendant)
  const nextLineId = useRef(0)

  // Checkout confirmation toast — ONLINE shows only after the server ACKs the
  // sale; OFFLINE shows as soon as the sale is persisted locally as pending.
  const [toast, setToast] = useState<{ kind: 'online' | 'offline'; total: number; itemCount: number } | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((t: NonNullable<typeof toast>) => {
    setToast(t)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1400)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  const loadData = useCallback(async () => {
    const [pRes, aRes] = await Promise.all([productsApi.list(), attendantsApi.list()])
    if (pRes.ok) setProducts(pRes.data)
    if (aRes.ok) setAttendants(aRes.data.filter((a) => a.active))
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // When the connection returns, push any sales queued while offline.
  // The server dedups by client_uuid, so a concurrent manual sync is safe.
  useEffect(() => {
    if (offline) return
    const pendingSales = state.sales.filter((s) => s.syncStatus === 'pending')
    if (!pendingSales.length) return
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
  }, [offline, state.sales, dispatch, loadData])

  const visibleProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products
      .filter((p) => catFilter === 'all' || p.category === catFilter)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [products, catFilter, query])

  const lines: CartLine[] = useMemo(
    () =>
      cart
        .map((l): CartLine | null => {
          const product = products.find((p) => p.id === l.productId)
          if (!product) return null
          return {
            id: l.id,
            product,
            count: l.count,
            ...(l.button ? { button: l.button } : {}),
          }
        })
        .filter((l): l is CartLine => l !== null),
    [cart, products],
  )

  const cartCount = lines.length
  const cartTotal = lines.reduce(
    (s, l) => s + lineTotal(lineBaseQty(l.count, l.button), l.product.sell_price, l.button, l.product.pricing_mode),
    0,
  )
  const pendingCount = state.sales.filter((s) => s.syncStatus === 'pending').length

  // Count per price button for the product the picker is showing — one
  // consolidated cart line per button, so the picker reflects and edits the
  // cart live.
  const pickerCounts = useMemo<Record<number, number>>(() => {
    const m: Record<number, number> = {}
    if (!buttonProduct) return m
    for (const l of cart) {
      if (l.productId === buttonProduct.id && l.button) m[l.button.id] = l.count
    }
    return m
  }, [cart, buttonProduct])

  const pickerMaxCount = useCallback(
    (button: ApiPriceButton): number | null => {
      if (!buttonProduct) return null
      return maxCountIn(cart, buttonProduct, button)
    },
    [cart, buttonProduct],
  )

  const addLine = (p: ApiProduct, button: ApiPriceButton | undefined, count: number) => {
    setCart((c) => {
      if (!button) {
        // Flat-rate lines merge per product (capped at stock).
        const existing = c.find((l) => l.productId === p.id && !l.button)
        if (existing) {
          return c.map((l) =>
            l.id === existing.id ? { ...l, count: Math.min(l.count + count, p.total_stock) } : l,
          )
        }
        return [...c, { id: nextLineId.current++, productId: p.id, count, button: undefined }]
      }
      // Identical selling button taps consolidate into ONE line and the count
      // grows ("1 tomato @ KSh5" tapped twice = count 2, KSh10). Different
      // buttons stay separate lines — they are different pricing rules.
      const existing = c.find((l) => l.productId === p.id && l.button && l.button.id === button.id)
      if (existing) {
        const max = maxCountIn(c, p, button, button.id)
        return c.map((l) =>
          l.id === existing.id
            ? { ...l, count: max != null ? Math.min(l.count + count, max) : l.count + count }
            : l,
        )
      }
      return [...c, { id: nextLineId.current++, productId: p.id, count, button }]
    })
  }

  const tapProduct = (p: ApiProduct) => {
    if (p.total_stock <= 0) return
    // Products with fixed-price buttons open the picker instead of adding at
    // a flat rate — counted produce and weighed products alike.
    if ((p.price_buttons?.length ?? 0) > 0) {
      setButtonProduct(p)
      return
    }
    addLine(p, undefined, stepFor(p.base_unit))
  }

  const changeQty = (lineId: number, qty: number) => {
    setCart((c) => {
      const line = c.find((l) => l.id === lineId)
      if (!line) return c
      // Zero removes the line — the existing cart convention (and the count
      // control's floor: count never exists below 1).
      if (qty <= 0) return c.filter((l) => l.id !== lineId)
      const product = products.find((p) => p.id === line.productId)
      if (!product) return c
      if (line.button) {
        // Button lines: qty is the COUNT (times sold). Tracked buttons cap at
        // what's on the shelf; legacy untracked buttons have no cap.
        const max = maxCountIn(c, product, line.button, line.button.id)
        const next = Math.round(qty)
        const capped = max != null ? Math.min(next, max) : next
        if (capped <= 0) return c.filter((l) => l.id !== lineId)
        return c.map((l) => (l.id === lineId ? { ...l, count: capped } : l))
      }
      // Flat lines: never sell past what's on the shelf — account for other
      // lines of the same product already in the cart.
      const reserved = c
        .filter((l) => l.productId === line.productId && l.id !== lineId)
        .reduce((s, l) => s + lineBaseQty(l.count, l.button), 0)
      const max = Math.max(0, product.total_stock - reserved)
      const next = Math.min(qty, max)
      if (next <= 0) return c // no room — keep the line unchanged
      return c.map((l) => (l.id === lineId ? { ...l, count: next } : l))
    })
  }

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
    const total = cartTotal
    const itemCount = lines.length
    const id = newSaleId()
    const createdAt = new Date().toISOString()
    const online = !offline

    dispatch({
      type: 'CHECKOUT',
      id,
      sale: { items, total, attendantId, createdAt, payment },
    })

    setLastAttendant(attendantId)
    saveLastAttendant(attendantId)
    setCart([])
    setCartOpen(false)

    // OFFLINE: the sale is now persisted locally as pending — the success
    // state is honest immediately ("saved offline, will sync").
    if (!online) {
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

  if (loading) {
    return (
      <div className="flex h-dvh flex-col bg-canvas">
        <div className="flex h-14 items-center border-b border-ink-200 bg-white px-4" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <p className="text-sm font-semibold text-ink-400" aria-busy="true">
            Loading the till…
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      {/* Header */}
      <header className="z-20 border-b border-ink-200 bg-white">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
          {isOwner() && (
            <button
              type="button"
              onClick={() => navigate('/')}
              aria-label="Back to dashboard"
              className="rounded-lg p-2 text-ink-600 transition-colors hover:bg-ink-100 lg:hidden"
            >
              <ArrowLeft className="size-5" aria-hidden />
            </button>
          )}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold leading-tight tracking-tight text-ink-900">Point of Sale</p>
            <p className="truncate text-[11px] font-medium text-ink-500">
              {new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())}
            </p>
          </div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setMySalesOpen(true)}
            aria-label="My sales"
            title="My sales"
            className="rounded-lg p-2 text-ink-600 transition-colors hover:bg-ink-100"
          >
            <Receipt className="size-5" aria-hidden />
          </button>
          {isOwner() ? (
            <button
              type="button"
              onClick={() => navigate('/')}
              className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition-colors hover:bg-ink-100 lg:block"
            >
              Dashboard
            </button>
          ) : (
            <button
              type="button"
              onClick={onLogout}
              aria-label="Log out"
              title="Log out"
              className="rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
            >
              <LogOut className="size-5" aria-hidden />
            </button>
          )}
          <OfflinePill offline={offline} pending={pendingCount} />
        </div>
      </header>

      {offline && (
        <div className="flex items-center justify-center gap-2 bg-warning-50 px-4 py-2 text-[13px] font-semibold text-warning-700">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          Offline — sales will queue on this phone and sync when the connection returns
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="space-y-2.5 px-3 pt-3 sm:px-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4.5 -translate-y-1/2 text-ink-400" aria-hidden />
              <input
                type="search"
                name="search"
                inputMode="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search products…"
                aria-label="Search products"
                className="h-11 w-full rounded-xl border border-ink-200 bg-white pl-10 pr-9 text-[15px] text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-400 hover:bg-ink-100"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>

            <div className="flex gap-1.5 overflow-x-auto pb-0.5 no-scrollbar" role="tablist" aria-label="Product category">
              {CAT_FILTERS.map((f) => {
                const selected = catFilter === f.value
                return (
                  <button
                    key={f.value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setCatFilter(f.value)}
                    className={cn(
                      'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold ring-1 ring-inset transition-colors',
                      selected
                        ? 'bg-brand-700 text-white ring-brand-700'
                        : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50',
                    )}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4 scrollbar-thin">
            {visibleProducts.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
                <Search className="size-6 text-ink-300" aria-hidden />
                <p className="text-sm font-semibold text-ink-700">No products found</p>
                <p className="max-w-xs text-[13px] text-ink-500">
                  Try a different search, or add the product from the Products screen.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
                {visibleProducts.map((p) => (
                  <ProductTile
                    key={p.id}
                    product={p}
                    selected={cart.some((l) => l.productId === p.id)}
                    inCartQty={cart
                      .filter((l) => l.productId === p.id)
                      .reduce((s, l) => s + lineBaseQty(l.count, l.button), 0)}
                    disabled={p.total_stock <= 0}
                    hasButtons={(p.price_buttons?.length ?? 0) > 0}
                    onTap={() => tapProduct(p)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Desktop cart */}
        <aside className="hidden w-[360px] shrink-0 border-l border-ink-200 bg-white lg:block">
          <CartPanel
            lines={lines}
            payment={payment}
            onPaymentChange={setPayment}
            onQtyChange={changeQty}
            onRemove={(id) => changeQty(id, 0)}
            onClear={() => setCart([])}
            onCharge={() => setPinOpen(true)}
            offline={offline}
          />
        </aside>
      </div>

      {/* Mobile cart bar */}
      {!cartOpen && (
        <div className="border-t border-ink-200 bg-white px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 lg:hidden">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex h-13 w-full items-center justify-between rounded-xl bg-brand-700 px-4 text-white shadow-sm active:scale-[0.99]"
          >
            <span className="flex items-center gap-2 text-[15px] font-bold">
              <ShoppingBag className="size-4.5" aria-hidden />
              {cartCount === 0 ? 'Cart is empty' : `View cart · ${cartCount}`}
            </span>
            <span className="text-[15px] font-extrabold tabular">{fmtKES(cartTotal)}</span>
          </button>
        </div>
      )}

      {/* Mobile cart sheet */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Current sale">
          <div className="absolute inset-0 bg-ink-950/40" onClick={() => setCartOpen(false)} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 max-h-[86dvh] animate-[sheet-up_240ms_cubic-bezier(0.16,1,0.3,1)] overflow-hidden rounded-t-2xl bg-white shadow-docked">
            <div className="flex justify-center pt-2.5">
              <span className="h-1 w-10 rounded-full bg-ink-200" aria-hidden />
            </div>
            <div className="flex h-[82dvh] flex-col">
              <div className="min-h-0 flex-1">
                <CartPanel
                  lines={lines}
                  payment={payment}
                  onPaymentChange={setPayment}
                  onQtyChange={changeQty}
                  onRemove={(id) => changeQty(id, 0)}
                  onClear={() => setCart([])}
                  onCharge={() => {
                    setCartOpen(false)
                    setPinOpen(true)
                  }}
                  offline={offline}
                />
              </div>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="h-11 shrink-0 border-t border-ink-200 text-sm font-semibold text-ink-500 transition-colors hover:bg-ink-50"
              >
                Keep shopping
              </button>
            </div>
          </div>
        </div>
      )}

      <PinModal
        open={pinOpen}
        total={cartTotal}
        itemCount={cartCount}
        attendants={attendants}
        defaultAttendantId={lastAttendant}
        offline={offline}
        onClose={() => setPinOpen(false)}
        onComplete={completeCharge}
      />

      {/* Checkout success toast — brief, non-blocking, auto-dismisses. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 top-16 z-[60] flex justify-center px-4"
        >
          <div className="animate-[toast-in_220ms_cubic-bezier(0.16,1,0.3,1)] flex items-center gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 shadow-pop">
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-full text-white',
                toast.kind === 'online' ? 'bg-success-600' : 'bg-warning-600',
              )}
            >
              <Check className="size-5" strokeWidth={3} aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-extrabold leading-tight text-ink-900">
                {toast.kind === 'online' ? 'Sale completed' : 'Sale saved offline'}
              </p>
              <p className="text-[13px] font-semibold text-ink-500">
                {fmtKES(toast.total)} · {toast.itemCount} item{toast.itemCount === 1 ? '' : 's'}
                {toast.kind === 'offline' && <span className="text-warning-700"> — will sync when connection returns</span>}
              </p>
            </div>
          </div>
        </div>
      )}

      <ButtonPicker
        product={buttonProduct}
        // Button → count map for the lines already in the cart (the picker
        // is a live editor: tapping a button adds it at count 1, the count
        // control adjusts it in place, and identical buttons consolidate).
        counts={pickerCounts}
        maxCountFor={pickerMaxCount}
        onAdd={(button, count) => {
          if (buttonProduct) addLine(buttonProduct, button, count)
        }}
        onChangeCount={(button, count) => {
          if (!buttonProduct) return
          const line = cart.find((l) => l.productId === buttonProduct.id && l.button?.id === button.id)
          if (!line) {
            if (count > 0) addLine(buttonProduct, button, count)
            return
          }
          // 0 removes the line (existing cart convention); otherwise the
          // count is capped at stock in changeQty.
          changeQty(line.id, count)
        }}
        onClose={() => setButtonProduct(null)}
      />

      {mySalesOpen && <MySalesPanel onClose={() => setMySalesOpen(false)} />}
    </div>
  )
}

function OfflinePill({ offline, pending }: { offline: boolean; pending: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset',
        offline
          ? 'bg-warning-50 text-warning-700 ring-warning-600/25'
          : 'bg-success-50 text-success-700 ring-success-600/20',
      )}
      aria-live="polite"
    >
      <span className={cn('size-1.5 rounded-full', offline ? 'bg-warning-400' : 'bg-success-600')} aria-hidden />
      {offline ? 'Offline' : 'Online'}
      {!offline && pending > 0 && <span className="font-bold tabular">{pending} queued</span>}
    </span>
  )
}
