import { useState } from 'react'
import { Eye, EyeOff, ShieldCheck, Maximize2, RefreshCw } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useReducedMotion } from 'motion/react'
import { login } from '../lib/auth'
import type { ApiAttendant } from '../lib/api'
import { Button } from '../components/ui/Button'
import { StatusPill } from '../components/ui/Card'
import { FallingText } from '../components/ui/FallingText'
import { staggerDelay, easing } from '../lib/motion'

interface LoginPageProps {
  onLogin: (user: ApiAttendant) => void
}

/**
 * Seed attendant IDs — shown as a quick-login hint. Remove in production.
 * When empty, the demo section is hidden entirely.
 */
const SEED_ATTENDANTS: Array<{ id: number; name: string; role: string; pin: string }> = [
  { id: 1, name: 'Wanjiku Kamau', role: 'owner', pin: '1240' },
  { id: 2, name: 'Otieno Ochieng', role: 'attendant', pin: '3168' },
  { id: 3, name: 'Achieng Adhiambo', role: 'attendant', pin: '2057' },
  { id: 4, name: 'Maina Kariuki', role: 'attendant', pin: '4821' },
]

export default function LoginPage({ onLogin }: LoginPageProps) {
  const shouldReduceMotion = useReducedMotion()

  const rightPanelVariants = {
    hidden: { opacity: shouldReduceMotion ? 1 : 0, y: shouldReduceMotion ? 0 : 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        staggerChildren: staggerDelay,
        delayChildren: shouldReduceMotion ? 0 : staggerDelay * 6,
        duration: shouldReduceMotion ? 0.01 : 0.4,
        ease: easing.standard,
      },
    },
  }

  const formItemVariants = {
    hidden: { opacity: shouldReduceMotion ? 1 : 0, y: shouldReduceMotion ? 0 : 12 },
    visible: { opacity: 1, y: 0 },
  }

  const [attendantId, setAttendantId] = useState<string>('1')
  const [pin, setPin] = useState<string>('')
  const [showPin, setShowPin] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const id = parseInt(attendantId, 10)
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

  function quickLogin(a: (typeof SEED_ATTENDANTS)[number]) {
    setAttendantId(String(a.id))
    setPin(a.pin)
    setError(null)
  }

  const showDemo = SEED_ATTENDANTS.length > 0

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Floating edge controls */}
      <div className="fixed right-2 top-1/2 z-20 hidden -translate-y-1/2 flex-col gap-2 sm:flex">      
        <button
          type="button"
          className="rounded-lg bg-white/10 p-1.5 text-white/70 hover:bg-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-brand-600"
          aria-label="Fullscreen"
        >
          <Maximize2 className="w-4 h-4" aria-hidden />
        </button>
        <button
          type="button"
          className="rounded-lg bg-white/10 p-1.5 text-white/70 hover:bg-white/20 hover:text-white focus-visible:outline-2 focus-visible:outline-brand-600"
          aria-label="Refresh"
        >
          <RefreshCw className="w-4 h-4" aria-hidden />
        </button>
      </div>

      {/* --- Left panel: market.jpg background + brand + testimonial ---
         The market.jpg image is layered with a dark overlay gradient to ensure
         text meets the 4.5:1 color-contrast ratio (ui-ux-pro-max) */}
      <motion.div
        className="relative flex flex-col items-center text-center text-white lg:w-4/10"
        initial={shouldReduceMotion ? false : { opacity: 0 }}
        animate={shouldReduceMotion ? false : { opacity: 1 }}
        transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
        style={{
          backgroundImage: `linear-gradient(rgba(10, 24, 21, 0.65), rgba(10, 24, 21, 0.45)), url('/market.jpg')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
        }}
      >
        {/* Dark overlay for text contrast (color-contrast rule) */}
        <div className="absolute inset-0 bg-black/20" aria-hidden />

        {/* Brand mark */}
        <motion.div
          className="relative z-10 mt-12 mb-10"
          initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
          animate={shouldReduceMotion ? false : { opacity: 1, y: 0 }}
          transition={{ delay: 0, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
        >
          <motion.div
            className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white/20 mb-4"
            initial={shouldReduceMotion ? false : { scale: 0.8, opacity: 0 }}
            animate={shouldReduceMotion ? false : { scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          >
            <ShieldCheck className="w-8 h-8 text-white" aria-hidden />
          </motion.div>
          <h1 className="text-2xl font-bold">SokoMtaani</h1>
          <p className="text-sm text-brand-100/60 mt-1">Duka lako, faida yako</p>
        </motion.div>

        {/* Value proposition */}
        <motion.div
          className="relative z-10 mb-8 px-8"
          initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
          animate={shouldReduceMotion ? false : { opacity: 1, y: 0 }}
          transition={{ delay: staggerDelay * 2, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
        >
          <p className="text-2xl font-extrabold leading-tight">
            Your shop's profit,<br className="hidden sm:inline" />in real time.
          </p>
          <p className="text-sm text-brand-100/80 mt-2 max-w-sm mx-auto">
            Track sales, manage stock, and see your true daily earnings — all
            from one screen.
          </p>
        </motion.div>

        {/* Testimonial — pinned to bottom */}
        <motion.div
          className="relative z-10 mt-auto mb-12 px-8"
          initial={shouldReduceMotion ? false : { opacity: 0, y: 12 }}
          animate={shouldReduceMotion ? false : { opacity: 1, y: 0 }}
          transition={{ delay: staggerDelay * 4, duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
        >
          <blockquote className="text-sm italic text-brand-100/80 max-w-sm mx-auto">
            "SokoMtaani changed how I run my kiosk — I finally know my true
            profit every day."
          </blockquote>
          <p className="text-xs text-brand-100/60 mt-2"> — Amina Juma, Nairobi</p>
        </motion.div>
      </motion.div>

      {/* --- Right panel: white form --- */}
      <motion.div
        className="flex-1 flex items-center justify-center p-4 sm:p-6 lg:p-8"
        variants={rightPanelVariants}
        initial="hidden"
        animate="visible"
      >
        <div className="w-full max-w-sm">
          {/* Falling welcome text */}
          <motion.div
            className="text-center mb-4"
            variants={formItemVariants}
          >
            <FallingText
              text="Welcome back to your dashboard"
              className="text-sm font-medium text-ink-500"
            />
          </motion.div>

          {/* Header */}
          <motion.div
            className="mb-1 text-center"
            variants={formItemVariants}
          >
            <h2 className="text-2xl font-bold text-ink-900">Sign In</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              Enter your attendant credentials to continue
            </p>
          </motion.div>

          <form onSubmit={handleSubmit} className="space-y-2">
            {/* Attendant ID */}
            <motion.div variants={formItemVariants}>
              <label
                htmlFor="attendant-id"
                className="block text-xs font-medium text-ink-600 mb-0.5"
              >
                Attendant ID
              </label>
              <input
                id="attendant-id"
                type="number"
                min={1}
                value={attendantId}
                onChange={(e) => setAttendantId(e.target.value)}
                className="w-full bg-ink-50 border border-ink-300 rounded-lg px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600/20 focus:border-brand-600 transition-colors"
                placeholder="e.g. 1"
              />
            </motion.div>

            {/* 4-Digit PIN with visibility toggle */}
            <motion.div variants={formItemVariants}>
              <label
                htmlFor="pin-input"
                className="block text-xs font-medium text-ink-600 mb-0.5"
              >
                4-Digit PIN
              </label>
              <div className="relative">
                <input
                  id="pin-input"
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, '').slice(0, 4))
                  }
                  className="w-full bg-ink-50 border border-ink-300 rounded-lg px-3 py-2.5 pr-10 text-sm text-ink-900 tracking-[0.5em] placeholder:text-ink-400 placeholder:tracking-normal focus:outline-none focus:ring-2 focus:ring-brand-600/20 focus:border-brand-600 transition-colors"
                  placeholder="&#8203;••••"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPin((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-ink-700 transition-colors focus:outline-none focus:text-ink-700"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  aria-pressed={showPin}
                >
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={showPin ? 'eye-off' : 'eye'}
                      initial={shouldReduceMotion ? false : { rotate: -180, opacity: 0, scale: 0.8 }}
                      animate={shouldReduceMotion ? false : { rotate: 0, opacity: 1, scale: 1 }}
                      exit={shouldReduceMotion ? undefined : { rotate: 180, opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.25, ease: easing.snappy }}
                      aria-hidden
                    >
                      {showPin ? (
                        <EyeOff className="w-4 h-4" aria-hidden />
                      ) : (
                        <Eye className="w-4 h-4" aria-hidden />
                      )}
                    </motion.div>
                  </AnimatePresence>
                </button>
              </div>
            </motion.div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={shouldReduceMotion ? false : { opacity: 0, y: -8, scale: 0.95 }}
                  animate={shouldReduceMotion ? false : { opacity: 1, y: 0, scale: 1 }}
                  exit={shouldReduceMotion ? undefined : { opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.25, ease: easing.snappy }}
                >
                  <StatusPill
                    tone="danger"
                    dot
                    className="w-full justify-center py-1.5 rounded-lg"
                  >
                    <span className="text-xs">{error}</span>
                  </StatusPill>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Submit */}
            <motion.div variants={formItemVariants}>
              <Button
                id="login-btn"
                variant="primary"
                size="lg"
                type="submit"
                loading={loading}
                icon={<ShieldCheck className="w-4 h-4" aria-hidden />}
                disabled={pin.length !== 4}
                className="w-full"
              >
                {loading ? 'Signing in…' : 'Sign In'}
              </Button>
            </motion.div>
          </form>

          {/* --- Demo quick-login (dev only) --- */}
          {showDemo && (
            <motion.div
              className="mt-3 pt-3 border-t border-ink-200"
              variants={formItemVariants}
            >
              <p className="text-[10px] text-ink-400 uppercase tracking-wider font-medium mb-1">
                Demo accounts
              </p>
              <div className="grid grid-cols-2 gap-1">
                {SEED_ATTENDANTS.map((a) => (
                  <Button
                    key={a.id}
                    id={`quick-login-${a.id}`}
                    variant="ghost"
                    size="sm"
                    onClick={() => quickLogin(a)}
                    className="justify-start"
                  >
                    <span className="flex flex-col items-start">
                      <span className="text-xs font-medium text-ink-700 truncate">
                        {a.name.split(' ')[0]}
                      </span>
                      <span className="text-[10px] text-ink-500">
                        {a.role} · ID {a.id}
                      </span>
                    </span>
                  </Button>
                ))}
              </div>
            </motion.div>
          )}

          {/* Footer */}
          <p className="text-center text-[11px] text-ink-300 mt-3">
            SokoMtaani · Duka lako, faida yako
          </p>
        </div>
      </motion.div>
    </div>
  )
}
