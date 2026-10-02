import { useCallback, useEffect, useState } from 'react'
import { productsApi, attendantsApi, type ApiAttendant, type ApiProduct } from '../../lib/api'

/** Loads the till's products and active attendants; `loadData` refreshes both. */
export function usePosData() {
  const [products, setProducts] = useState<ApiProduct[]>([])
  const [attendants, setAttendants] = useState<ApiAttendant[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    const [pRes, aRes] = await Promise.all([productsApi.list(), attendantsApi.list()])
    if (pRes.ok) setProducts(pRes.data)
    if (aRes.ok) setAttendants(aRes.data.filter((a) => a.active))
    setLoading(false)
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  return { products, attendants, loading, loadData }
}
