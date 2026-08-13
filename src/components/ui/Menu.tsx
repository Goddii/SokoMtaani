import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '../../lib/utils'

export interface MenuItem {
  label: string
  icon?: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
}

export function Menu({
  trigger,
  items,
  align = 'right',
  label = 'More actions',
}: {
  trigger: (open: boolean) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      {trigger(open)}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-full z-40 mt-1 min-w-44 rounded-xl bg-white py-1.5 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick?.()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm font-medium transition-colors',
                item.danger ? 'text-danger-600 hover:bg-danger-50' : 'text-ink-700 hover:bg-ink-50',
                item.disabled && 'opacity-40',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
