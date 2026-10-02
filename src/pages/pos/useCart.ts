import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiPriceButton, ApiProduct } from '../../lib/api'
import type { CartLine } from '../../components/pos/CartPanel'
import { lineBaseQty, lineTotal } from '../../components/pos/posMeta'
import { maxCountIn, type CartLineState } from './posHelpers'

/** In-memory cart: stock-capped add/change operations plus derived lines and total. */
export function useCart(products: ApiProduct[]) {
  const [cart, setCart] = useState<CartLineState[]>([])
  const nextLineId = useRef(0)

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

  const cartTotal = lines.reduce(
    (s, l) => s + lineTotal(lineBaseQty(l.count, l.button), l.product.sell_price, l.button, l.product.pricing_mode),
    0,
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

  const clearCart = useCallback(() => setCart([]), [])

  const hasProduct = (productId: number) => cart.some((l) => l.productId === productId)

  const baseQtyOf = (productId: number) =>
    cart.filter((l) => l.productId === productId).reduce((s, l) => s + lineBaseQty(l.count, l.button), 0)

  // Count per price button for a product — one consolidated cart line per
  // button, so the picker reflects and edits the cart live.
  const buttonCounts = (productId: number): Record<number, number> => {
    const m: Record<number, number> = {}
    for (const l of cart) {
      if (l.productId === productId && l.button) m[l.button.id] = l.count
    }
    return m
  }

  const maxCountFor = (product: ApiProduct, button: ApiPriceButton) => maxCountIn(cart, product, button)

  const findButtonLine = (productId: number, buttonId: number) =>
    cart.find((l) => l.productId === productId && l.button?.id === buttonId)

  return {
    lines,
    cartCount: lines.length,
    cartTotal,
    addLine,
    changeQty,
    clearCart,
    hasProduct,
    baseQtyOf,
    buttonCounts,
    maxCountFor,
    findButtonLine,
  }
}
