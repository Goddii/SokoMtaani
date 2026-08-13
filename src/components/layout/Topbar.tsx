import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Bell, LogOut, Menu, Search, SearchX } from 'lucide-react'
import { OfflineIndicator } from './OfflineIndicator'
import { dashboardApi, type ApiAttendant, type ApiDashboardSummary } from '../../lib/api'
import { fmtNum } from '../../lib/format'

interface TopbarProps {
  onOpenMenu: () => void
  onLogout?: () => void
  currentUser?: ApiAttendant | null
}

export function Topbar({ onOpenMenu, onLogout, currentUser }: TopbarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [summary, setSummary] = useState<ApiDashboardSummary | null>(null)
  const [bellOpen, setBellOpen] = useState(false)
  const bellRef = useRef<HTMLDivElement>(null)

  // Alerts come from the backend dashboard summary — refresh on navigation so
  // stock movements (sales, batches, wastage) show up quickly.
  useEffect(() => {
    let cancelled = false
    dashboardApi.summary().then((res) => {
      if (!cancelled && res.ok) setSummary(res.data)
    })
    return () => {
      cancelled = true
    }
  }, [location.pathname])

  useEffect(() => {
    if (!bellOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [bellOpen])

  const lowStock = summary?.low_stock_products ?? []
  const lowMargin = (summary?.per_product ?? []).filter((p) => p.low_margin)
  const alertCount = lowStock.length + lowMargin.length

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault()
    navigate(`/products?q=${encodeURIComponent(query.trim())}`)
  }

  return (
    <header className="sticky top-0 z-30 border-b border-ink-200 bg-canvas/90 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          className="rounded-lg p-2 text-ink-600 transition-colors hover:bg-ink-100 lg:hidden"
        >
          <Menu className="size-5" aria-hidden />
        </button>

        <form onSubmit={submitSearch} role="search" className="relative hidden max-w-md flex-1 sm:block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
          <input
            type="search"
            name="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            aria-label="Search products"
            className="h-9 w-full rounded-lg border border-ink-200 bg-white pl-9 pr-3 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15 focus:outline-none"
          />
        </form>

        <div className="flex-1 sm:hidden" />

        <OfflineIndicator />

        <div ref={bellRef} className="relative">
          <button
            type="button"
            onClick={() => setBellOpen((v) => !v)}
            aria-label={`Notifications${alertCount > 0 ? `, ${alertCount} alerts` : ''}`}
            className="relative rounded-lg p-2 text-ink-600 transition-colors hover:bg-ink-100"
          >
            <Bell className="size-5" aria-hidden />
            {alertCount > 0 && (
              <span className="absolute right-1 top-1 flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger-600/60" />
                <span className="relative inline-flex size-2 rounded-full bg-danger-600" />
              </span>
            )}
          </button>
          {bellOpen && (
            <div
              role="dialog"
              aria-label="Alerts"
              className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl bg-white p-2 shadow-pop"
            >
              <div className="px-3 pb-2 pt-2.5">
                <p className="text-sm font-bold text-ink-900">Alerts</p>
                <p className="text-xs text-ink-500">
                  {alertCount === 0
                    ? 'All clear — nothing needs attention.'
                    : `${alertCount} item${alertCount === 1 ? '' : 's'} need attention.`}
                </p>
              </div>
              {alertCount === 0 && (
                <div className="flex items-center gap-2.5 px-3 py-4 text-ink-400">
                  <SearchX className="size-4" aria-hidden />
                  <span className="text-[13px]">No low stock or low margin alerts.</span>
                </div>
              )}
              <div className="max-h-72 overflow-y-auto scrollbar-thin">
                {lowStock.map((p) => (
                  <button
                    key={p.product_id}
                    type="button"
                    onClick={() => {
                      setBellOpen(false)
                      navigate('/products')
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-ink-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-ink-800">{p.product_name}</span>
                      <span className="block text-xs text-ink-500">Low stock</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-danger-50 px-2 py-0.5 text-xs font-bold text-danger-700">
                      {fmtNum(p.total_stock)} {p.base_unit}
                    </span>
                  </button>
                ))}
                {lowMargin.map((p) => (
                  <button
                    key={`m-${p.product_id}`}
                    type="button"
                    onClick={() => {
                      setBellOpen(false)
                      navigate('/products')
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-ink-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-ink-800">{p.product_name}</span>
                      <span className="block text-xs text-ink-500">Low margin</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-warning-50 px-2 py-0.5 text-xs font-bold text-warning-700">
                      {Math.round((p.margin_pct ?? 0) * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {currentUser ? (
          <div className="flex items-center gap-2">
            <span
              className="hidden h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-[13px] font-bold text-white sm:flex"
              title={currentUser.name}
              aria-label={currentUser.name}
            >
              {currentUser.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()}
            </span>
            {onLogout && (
              <button
                id="logout-btn"
                type="button"
                onClick={onLogout}
                aria-label="Log out"
                className="rounded-lg p-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-800"
                title="Log out"
              >
                <LogOut className="size-4" aria-hidden />
              </button>
            )}
          </div>
        ) : (
          <span
            className="hidden h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-[13px] font-bold text-white sm:flex"
            aria-hidden
          >
            SM
          </span>
        )}
      </div>
    </header>
  )
}
