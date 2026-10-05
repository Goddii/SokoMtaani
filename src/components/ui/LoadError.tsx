export const LOAD_ERROR_FALLBACK = 'Could not load data. Check your connection and try again.'

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-danger-50 px-3 py-2 text-[13px] font-semibold text-danger-700"
      role="alert"
    >
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="shrink-0 underline underline-offset-2">
        Retry
      </button>
    </div>
  )
}
