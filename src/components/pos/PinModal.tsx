import { useEffect, useRef, useState } from 'react'
import { Delete, ShieldCheck } from 'lucide-react'
import { authApi, type ApiAttendant } from '../../lib/api'
import { fmtKES } from '../../lib/format'
import { initialsOf } from '../../lib/utils'
import { Modal } from '../ui/Modal'
import { cn } from '../../lib/utils'

interface Props {
  open: boolean
  total: number
  itemCount: number
  attendants: ApiAttendant[]
  defaultAttendantId?: number | null
  offline?: boolean
  onClose: () => void
  /** Completes the sale. Returns immediately; the POS shows its own success toast. */
  onComplete: (attendantId: number) => void
}

type Step = 'attendant' | 'pin'

const DOTS = [0, 1, 2, 3]

export function PinModal({ open, total, itemCount, attendants, defaultAttendantId, offline = false, onClose, onComplete }: Props) {
  const [step, setStep] = useState<Step>('attendant')
  const [attendant, setAttendant] = useState<ApiAttendant | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const verifyingRef = useRef(false)

  // Reset state each time the modal opens for a new charge.
  useEffect(() => {
    if (open) {
      const def = attendants.find((a) => a.id === defaultAttendantId) ?? null
      setAttendant(def)
      setStep(def ? 'pin' : 'attendant')
      setPin('')
      setError(false)
      setVerifying(false)
    }
  }, [open, defaultAttendantId, attendants])

  // Verify the PIN against the shop records when online. Offline, the PIN
  // can't be checked (the server hashes them and never returns them), so a
  // complete 4-digit entry is accepted and the sale queues for sync.
  const submitPin = async (value: string) => {
    if (!attendant) return
    if (value.length !== 4 || verifyingRef.current) return

    if (offline) {
      onComplete(attendant.id)
      onClose()
      return
    }

    verifyingRef.current = true
    setVerifying(true)
    const res = await authApi.verifyPin(attendant.id, value)
    verifyingRef.current = false
    setVerifying(false)
    if (!res.ok) {
      setError(true)
      setPin('')
      window.setTimeout(() => setError(false), 450)
      return
    }
    onComplete(attendant.id)
    onClose()
  }

  const pressKey = (k: string) => {
    if (step !== 'pin') return
    if (k === 'back') {
      setPin((p) => p.slice(0, -1))
      return
    }
    setPin((p) => {
      const next = p.length < 4 ? p + k : p
      // verify when full
      window.setTimeout(() => submitPin(next), 60)
      return next
    })
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back']

  const dialogTitle = step === 'pin' ? 'Enter PIN' : 'Who is selling?'

  return (
    <Modal open={open} onClose={onClose} size="sm" title={dialogTitle}>
      {step === 'attendant' && (
        <div>
          <p className="mb-1 text-2xl font-extrabold tracking-tight tabular text-ink-900">{fmtKES(total)}</p>
          <p className="text-sm text-ink-500">
            {itemCount} item{itemCount === 1 ? '' : 's'} — select the attendant completing this sale.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {attendants.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  setAttendant(a)
                  setStep('pin')
                }}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-3.5 transition-all hover:border-brand-600 hover:ring-2 hover:ring-brand-600/20 active:scale-[0.98]"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">
                  {initialsOf(a.name)}
                </span>
                <span className="text-[13px] font-semibold text-ink-900">{a.name}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 w-full rounded-lg py-2 text-sm font-semibold text-ink-500 transition-colors hover:bg-ink-100"
          >
            Cancel
          </button>
        </div>
      )}

      {step === 'pin' && attendant && (
        <div className={cn(error && 'animate-[shake-x_320ms_ease-out]')}>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-800">
                {initialsOf(attendant.name)}
              </span>
              <div>
                <p className="text-sm font-bold text-ink-900">{attendant.name}</p>
                <button
                  type="button"
                  onClick={() => setStep('attendant')}
                  className="text-xs font-semibold text-brand-700 hover:underline"
                >
                  Change
                </button>
              </div>
            </div>
            <p className="text-right">
              <span className="block text-[11px] font-medium text-ink-400">To charge</span>
              <span className="block text-lg font-extrabold tabular text-ink-900">{fmtKES(total)}</span>
            </p>
          </div>

          <div className="mx-auto mb-5 flex w-fit gap-3" aria-label="PIN digits" role="img">
            {DOTS.map((i) => (
              <span
                key={i}
                className={cn(
                  'size-3.5 rounded-full border-2 transition-colors duration-100',
                  error
                    ? 'border-danger-600 bg-danger-600'
                    : i < pin.length
                      ? 'border-brand-700 bg-brand-700'
                      : 'border-ink-300 bg-white',
                )}
              />
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            {keys.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  if (k === 'clear') setPin('')
                  else pressKey(k)
                }}
                aria-label={k === 'back' ? 'Delete digit' : k === 'clear' ? 'Clear PIN' : `Digit ${k}`}
                className={cn(
                  'flex h-13 items-center justify-center rounded-xl text-lg font-bold transition-all active:scale-[0.95]',
                  k === 'back' || k === 'clear'
                    ? 'text-ink-500 hover:bg-ink-100'
                    : 'bg-ink-50 text-ink-900 hover:bg-ink-100',
                )}
              >
                {k === 'back' ? <Delete className="size-5" aria-hidden /> : k === 'clear' ? 'C' : k}
              </button>
            ))}
          </div>
          {error && (
            <p className="mt-3 text-center text-[13px] font-bold text-danger-600" role="alert">
              Wrong PIN — try again
            </p>
          )}
          {verifying && (
            <p className="mt-3 text-center text-[13px] font-semibold text-ink-500" role="status">
              Checking PIN…
            </p>
          )}
          {!error && !verifying && (
            <p className="mt-3 text-center text-xs text-ink-400">
              <ShieldCheck className="mr-1 inline size-3.5" aria-hidden />
              Sale will be recorded under {attendant.name}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
