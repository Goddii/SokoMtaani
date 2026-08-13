import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-xl border border-ink-200 bg-white', className)}
      {...rest}
    />
  )
}

export type PillTone = 'success' | 'warning' | 'danger' | 'neutral' | 'brand'

const PILL_TONES: Record<PillTone, string> = {
  success: 'bg-success-50 text-success-700 ring-success-600/20',
  warning: 'bg-warning-50 text-warning-700 ring-warning-600/25',
  danger: 'bg-danger-50 text-danger-700 ring-danger-600/20',
  neutral: 'bg-ink-100 text-ink-600 ring-ink-500/15',
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/25',
}

const DOT_TONES: Record<PillTone, string> = {
  success: 'bg-success-600',
  warning: 'bg-warning-400',
  danger: 'bg-danger-600',
  neutral: 'bg-ink-400',
  brand: 'bg-brand-600',
}

interface PillProps {
  tone: PillTone
  children: ReactNode
  dot?: boolean
  pulse?: boolean
  className?: string
}

export function StatusPill({ tone, children, dot = true, pulse, className }: PillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        PILL_TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn('size-1.5 rounded-full', DOT_TONES[tone], pulse && 'animate-pulse')}
          aria-hidden
        />
      )}
      {children}
    </span>
  )
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn('border-ink-200', className)} />
}
