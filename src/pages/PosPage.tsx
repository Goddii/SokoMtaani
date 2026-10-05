import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, BarChart3, Check, LogOut, Receipt, Search, ShoppingBag, X, WifiOff } from 'lucide-react'
import { useOffline } from '../hooks/useOffline'
import { isOwner } from '../lib/auth'
import { fmtKES } from '../lib/format'
import type { ApiProduct } from '../lib/api'
import type { PaymentMethod } from '../lib/types'
import { CartPanel } from '../components/pos/CartPanel'
import { ProductTile } from '../components/pos/ProductTile'
import { PinModal } from '../components/pos/PinModal'
import { ButtonPicker } from '../components/pos/ButtonPicker'
import { MySalesPanel } from '../components/pos/MySalesPanel'
import { OfflinePill } from '../components/pos/OfflinePill'
import { stepFor } from '../components/pos/posMeta'
import { cn } from '../lib/utils'
import { CAT_FILTERS, type CatFilter } from './pos/posHelpers'
import { useCart } from './pos/useCart'
import { useCheckout } from './pos/useCheckout'
import { useCheckoutToast } from './pos/useCheckoutToast'
import { useOfflineSync } from './pos/useOfflineSync'
import { usePosData } from './pos/usePosData'

export function PosPage({ onLogout }: { onLogout?: () => void }) {
  const { offline } = useOffline()
  const navigate = useNavigate()

  const { products, attendants, loading, loadData } = usePosData()
  const { pendingCount } = useOfflineSync(offline, loadData)
  const cart = useCart(products)
  const { toast, showToast } = useCheckoutToast()

  const [payment, setPayment] = useState<PaymentMethod>('mpesa')
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState<CatFilter>('all')
  const [cartOpen, setCartOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [buttonProduct, setButtonProduct] = useState<ApiProduct | null>(null)
  const [mySalesOpen, setMySalesOpen] = useState(false)
  const [nowMs] = useState(() => Date.now())

  const { completeCharge, lastAttendant } = useCheckout({
    lines: cart.lines,
    total: cart.cartTotal,
    payment,
    offline,
    loadData,
    showToast,
    onRecorded: () => {
      cart.clearCart()
      setCartOpen(false)
    },
  })

  const visibleProducts = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products
      .filter((p) => catFilter === 'all' || p.category === catFilter)
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [products, catFilter, query])

  const tapProduct = (p: ApiProduct) => {
    if (p.total_stock <= 0) return
    // Products with fixed-price buttons open the picker instead of adding at
    // a flat rate — counted produce and weighed products alike.
    if ((p.price_buttons?.length ?? 0) > 0) {
      setButtonProduct(p)
      return
    }
    cart.addLine(p, undefined, stepFor(p.base_unit))
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
              {new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short' }).format(nowMs)}
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
            <>
              <button
                type="button"
                onClick={() => navigate('/sales')}
                className="hidden items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition-colors hover:bg-ink-100 lg:flex"
              >
                <BarChart3 className="size-4" aria-hidden />
                Sales
              </button>
              <button
                type="button"
                onClick={() => navigate('/')}
                className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition-colors hover:bg-ink-100 lg:block"
              >
                Dashboard
              </button>
            </>
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
                    selected={cart.hasProduct(p.id)}
                    inCartQty={cart.baseQtyOf(p.id)}
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
            lines={cart.lines}
            payment={payment}
            onPaymentChange={setPayment}
            onQtyChange={cart.changeQty}
            onRemove={(id) => cart.changeQty(id, 0)}
            onClear={cart.clearCart}
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
              {cart.cartCount === 0 ? 'Cart is empty' : `View cart · ${cart.cartCount}`}
            </span>
            <span className="text-[15px] font-extrabold tabular">{fmtKES(cart.cartTotal)}</span>
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
                  lines={cart.lines}
                  payment={payment}
                  onPaymentChange={setPayment}
                  onQtyChange={cart.changeQty}
                  onRemove={(id) => cart.changeQty(id, 0)}
                  onClear={cart.clearCart}
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
        total={cart.cartTotal}
        itemCount={cart.cartCount}
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
        counts={buttonProduct ? cart.buttonCounts(buttonProduct.id) : {}}
        maxCountFor={(button) => (buttonProduct ? cart.maxCountFor(buttonProduct, button) : null)}
        onAdd={(button, count) => {
          if (buttonProduct) cart.addLine(buttonProduct, button, count)
        }}
        onChangeCount={(button, count) => {
          if (!buttonProduct) return
          const line = cart.findButtonLine(buttonProduct.id, button.id)
          if (!line) {
            if (count > 0) cart.addLine(buttonProduct, button, count)
            return
          }
          // 0 removes the line (existing cart convention); otherwise the
          // count is capped at stock in changeQty.
          cart.changeQty(line.id, count)
        }}
        onClose={() => setButtonProduct(null)}
      />

      {mySalesOpen && <MySalesPanel onClose={() => setMySalesOpen(false)} />}
    </div>
  )
}
