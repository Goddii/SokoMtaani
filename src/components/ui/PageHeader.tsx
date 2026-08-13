import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Home } from 'lucide-react'

export interface Crumb {
  label: string
  to?: string
}

export function PageHeader({
  crumbs,
  title,
  subtitle,
  actions,
}: {
  crumbs?: Crumb[]
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3">
          <ol className="flex items-center gap-1 text-[13px] font-medium text-ink-500">
            <li>
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 rounded transition-colors hover:text-brand-700"
              >
                <Home className="size-3.5" aria-hidden />
                Home
              </Link>
            </li>
            {crumbs.map((c) => (
              <Fragment key={c.label}>
                <li aria-hidden className="text-ink-300">
                  <ChevronRight className="size-3.5" />
                </li>
                <li>
                  {c.to ? (
                    <Link to={c.to} className="rounded transition-colors hover:text-brand-700">
                      {c.label}
                    </Link>
                  ) : (
                    <span className="text-ink-700">{c.label}</span>
                  )}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">{title}</h1>
          {subtitle && <p className="mt-1.5 max-w-xl text-sm text-ink-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
    </div>
  )
}
