import { NavLink } from 'react-router-dom'
import { Store } from 'lucide-react'
import { navForRole, SHOP_NAME, SHOP_SUB, type NavSection } from './nav'
import { isOwner } from '../../lib/auth'
import { cn } from '../../lib/utils'

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand-800 text-white shadow-sm">
        <Store className="size-5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] font-bold tracking-tight text-ink-900">{SHOP_NAME}</span>
        <span className="block truncate text-[11px] font-medium text-ink-500">{SHOP_SUB}</span>
      </span>
    </div>
  )
}

function NavList({ nav, onNavigate }: { nav: NavSection[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 pb-4 scrollbar-thin">
      {nav.map((section) => (
        <div key={section.section}>
          <p className="mb-1.5 px-2 text-[11px] font-bold uppercase tracking-wider text-ink-400">
            {section.section}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    cn(
                      'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors',
                      isActive
                        ? 'bg-brand-50 text-brand-800'
                        : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                    )
                  }
                >
                  <item.icon className="size-4.5 shrink-0" aria-hidden />
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const nav = navForRole(isOwner() ? 'owner' : 'attendant')
  return (
    <div className="flex h-full flex-col border-r border-ink-200 bg-white">
      <div className="px-4 pb-5 pt-5">
        <Brand />
      </div>
      <NavList nav={nav} onNavigate={onNavigate} />
      <div className="border-t border-ink-100 p-3">
        <p className="px-2.5 py-1 text-[11px] leading-relaxed text-ink-400">
          Data lives in the shop records and stays in sync across the till.
        </p>
      </div>
    </div>
  )
}
