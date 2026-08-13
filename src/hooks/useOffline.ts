import { useEffect, useState } from 'react'

const TOGGLE_KEY = 'soko-mtaani/demo-offline'

export function useOffline() {
  const [navigatorOnline, setNavigatorOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  const [demoOffline, setDemoOffline] = useState(() => {
    try {
      return localStorage.getItem(TOGGLE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const on = () => setNavigatorOnline(true)
    const off = () => setNavigatorOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const offline = !navigatorOnline || demoOffline

  const setDemoOfflineState = (v: boolean) => {
    setDemoOffline(v)
    try {
      if (v) localStorage.setItem(TOGGLE_KEY, '1')
      else localStorage.removeItem(TOGGLE_KEY)
    } catch {
      // ignore
    }
  }

  return {
    offline,
    online: !offline,
    navigatorOnline,
    demoOffline,
    setDemoOfflineState,
  }
}
