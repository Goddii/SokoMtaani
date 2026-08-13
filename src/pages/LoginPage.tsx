import { useState } from 'react'
import { LogIn, ShieldCheck, AlertCircle } from 'lucide-react'
import { login } from '../lib/auth'
import type { ApiAttendant } from '../lib/api'

interface LoginPageProps {
  onLogin: (user: ApiAttendant) => void
}

/** Seed attendant IDs — shown as a quick-login hint. Remove in production. */
const SEED_ATTENDANTS = [
  { id: 1, name: 'Wanjiku Kamau', role: 'owner', pin: '1240' },
  { id: 2, name: 'Otieno Ochieng', role: 'attendant', pin: '3168' },
  { id: 3, name: 'Achieng Adhiambo', role: 'attendant', pin: '2057' },
  { id: 4, name: 'Maina Kariuki', role: 'attendant', pin: '4821' },
]

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [attendantId, setAttendantId] = useState<string>('1')
  const [pin, setPin] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const id = parseInt(attendantId)
    if (!id || pin.length !== 4) {
      setError('Enter a valid attendant ID and 4-digit PIN.')
      return
    }
    setLoading(true)
    const res = await login(id, pin)
    setLoading(false)
    if (!res.success) {
      setError(res.error || 'Login failed.')
      setPin('')
    } else if (res.user) {
      onLogin(res.user)
    }
  }

  function quickLogin(a: typeof SEED_ATTENDANTS[number]) {
    setAttendantId(String(a.id))
    setPin(a.pin)
    setError(null)
  }

  return (
    <div className="min-h-screen bg-[#0f1a0f] flex items-center justify-center p-4">
      {/* Background pattern */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #22c55e 0, #22c55e 1px, transparent 0, transparent 50%)',
          backgroundSize: '30px 30px',
        }}
      />

      <div className="relative w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#16a34a] mb-4 shadow-lg shadow-green-900/40">
            <ShieldCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">SokoMtaani</h1>
          <p className="text-sm text-green-400/70 mt-1">Sign in to continue</p>
        </div>

        {/* Card */}
        <div className="bg-[#162016] border border-green-900/40 rounded-2xl p-6 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-green-300/70 mb-1.5">
                Attendant ID
              </label>
              <input
                id="attendant-id"
                type="number"
                min={1}
                value={attendantId}
                onChange={(e) => setAttendantId(e.target.value)}
                className="w-full bg-[#0f1a0f] border border-green-900/50 rounded-lg px-3 py-2.5 text-white text-sm placeholder:text-green-900 focus:outline-none focus:ring-2 focus:ring-green-600/50 focus:border-green-600 transition"
                placeholder="e.g. 1"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-green-300/70 mb-1.5">
                4-Digit PIN
              </label>
              <input
                id="pin-input"
                type="password"
                inputMode="numeric"
                pattern="\d{4}"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                className="w-full bg-[#0f1a0f] border border-green-900/50 rounded-lg px-3 py-2.5 text-white text-sm tracking-[0.5em] placeholder:text-green-900 placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-green-600/50 focus:border-green-600 transition"
                placeholder="••••"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 bg-red-950/50 border border-red-800/40 rounded-lg px-3 py-2.5">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}

            <button
              id="login-btn"
              type="submit"
              disabled={loading || pin.length !== 4}
              className="w-full flex items-center justify-center gap-2 bg-[#16a34a] hover:bg-[#15803d] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <LogIn className="w-4 h-4" />
              )}
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          {/* Quick login hints — remove in production */}
          <div className="mt-5 pt-5 border-t border-green-900/30">
            <p className="text-[10px] text-green-600/60 uppercase tracking-wider font-medium mb-2.5">
              Demo accounts
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {SEED_ATTENDANTS.map((a) => (
                <button
                  key={a.id}
                  id={`quick-login-${a.id}`}
                  type="button"
                  onClick={() => quickLogin(a)}
                  className="text-left bg-[#0f1a0f] hover:bg-green-950/60 border border-green-900/30 rounded-lg px-2.5 py-2 transition-colors"
                >
                  <p className="text-xs font-medium text-green-200 truncate">{a.name.split(' ')[0]}</p>
                  <p className="text-[10px] text-green-600/70">
                    {a.role} · ID {a.id}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="text-center text-[11px] text-green-900 mt-4">
          SokoMtaani · Duka lako, faida yako
        </p>
      </div>
    </div>
  )
}
