import { useCallback, useEffect, useRef, useState } from 'react'

const TOAST_MS = 1400

export interface CheckoutToast {
  kind: 'online' | 'offline'
  total: number
  itemCount: number
}

/**
 * Checkout confirmation toast — ONLINE shows only after the server ACKs the
 * sale; OFFLINE shows as soon as the sale is persisted locally as pending.
 */
export function useCheckoutToast() {
  const [toast, setToast] = useState<CheckoutToast | null>(null)
  const timer = useRef<number | null>(null)

  const showToast = useCallback((t: CheckoutToast) => {
    setToast(t)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  return { toast, showToast }
}
