const ksh = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  maximumFractionDigits: 0,
})

const ksh2 = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const num = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

export function fmtKES(n: number): string {
  if (!Number.isFinite(n)) return 'KSh —'
  return ksh.format(n)
}

export function fmtKES2(n: number): string {
  if (!Number.isFinite(n)) return 'KSh —'
  return ksh2.format(n)
}

export function fmtNum(n: number): string {
  return num.format(n)
}

export function fmtQty(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return num.format(rounded)
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-KE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d)
}

export function fmtDateShort(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-KE', { month: 'short', day: 'numeric' }).format(d)
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-KE', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

export function fmtDateTime(iso: string): string {
  return `${fmtDateShort(iso)}, ${fmtTime(iso)}`
}

export function dayKey(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Today's business date in the device's local time (Kenya/EAT on the till). */
export function todayKey(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function unitLabel(unit: string): string {
  return unit === 'kg' ? 'kg' : unit === 'litre' ? 'L' : 'pc'
}
