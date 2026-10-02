import { cn } from '../../lib/utils'

export function OfflinePill({ offline, pending }: { offline: boolean; pending: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset',
        offline
          ? 'bg-warning-50 text-warning-700 ring-warning-600/25'
          : 'bg-success-50 text-success-700 ring-success-600/20',
      )}
      aria-live="polite"
    >
      <span className={cn('size-1.5 rounded-full', offline ? 'bg-warning-400' : 'bg-success-600')} aria-hidden />
      {offline ? 'Offline' : 'Online'}
      {!offline && pending > 0 && <span className="font-bold tabular">{pending} queued</span>}
    </span>
  )
}
