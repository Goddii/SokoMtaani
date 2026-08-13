import { createContext, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from 'react'
import type { AppState, OfflineSale } from './types'

const STORAGE_KEY = 'soko-mtaani/v2'

type Action =
  | { type: 'CHECKOUT'; id: string; sale: Omit<OfflineSale, 'id' | 'saleNumber' | 'syncStatus' | 'syncedAt'> }
  | { type: 'MARK_PENDING'; id: string; reason?: string }
  | { type: 'REMOVE_SALE'; id: string }
  | { type: 'SYNC_ALL'; now: string }
  | { type: 'CLEAR_SYNCED' }

function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'CHECKOUT': {
      const sale: OfflineSale = {
        id: action.id,
        saleNumber: state.nextSaleNumber,
        items: action.sale.items,
        total: action.sale.total,
        attendantId: action.sale.attendantId,
        createdAt: action.sale.createdAt,
        payment: action.sale.payment,
        // Always pending until the server ACKs the sync. An online checkout is
        // pushed immediately, but the local record only leaves the queue once
        // the backend confirms (REMOVE_SALE). If the phone dies while the
        // request is in flight, the sale stays pending and retries on the next
        // sync — it can never be marked synced without a server acknowledgement.
        syncStatus: 'pending' as const,
      }
      return {
        ...state,
        sales: [...state.sales, sale],
        nextSaleNumber: state.nextSaleNumber + 1,
      }
    }

    case 'MARK_PENDING': {
      return {
        ...state,
        // reason is the server's verdict when it REJECTED the sale. It is
        // only ever recorded from a real rejection; a network failure (no
        // verdict) leaves any prior reason untouched, so a blocked sale's
        // explanation survives a connection blip. SYNC_ALL is the only thing
        // that clears it (on a successful sync).
        sales: state.sales.map((s) => {
          if (s.id !== action.id) return s
          const next = { ...s, syncStatus: 'pending' as const, syncedAt: undefined }
          return action.reason !== undefined ? { ...next, syncError: action.reason } : next
        }),
      }
    }

    case 'REMOVE_SALE': {
      return {
        ...state,
        sales: state.sales.filter((s) => s.id !== action.id),
      }
    }

    case 'SYNC_ALL': {
      const hasPending = state.sales.some((s) => s.syncStatus === 'pending')
      if (!hasPending) return state
      return {
        ...state,
        sales: state.sales.map((s) =>
          s.syncStatus === 'pending'
            ? { ...s, syncStatus: 'synced', syncedAt: action.now, syncError: undefined }
            : s,
        ),
      }
    }

    case 'CLEAR_SYNCED': {
      return {
        ...state,
        sales: state.sales.filter((s) => s.syncStatus === 'pending'),
      }
    }

    default:
      return state
  }
}

function loadInitial(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppState
      if (parsed && Array.isArray(parsed.sales)) return parsed
    }
  } catch {
    // fall through
  }
  return { sales: [], nextSaleNumber: 1001 }
}

interface StoreValue {
  state: AppState
  dispatch: Dispatch<Action>
  hydrated: boolean
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  const [state, dispatch] = useReducer(reduce, undefined, loadInitial)

  useEffect(() => {
    const t = setTimeout(() => setHydrated(true), 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // storage full
    }
  }, [state, hydrated])

  const value = useMemo(() => ({ state, dispatch, hydrated }), [state, hydrated])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
