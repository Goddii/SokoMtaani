import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { isOwner } from '../../lib/auth'

/**
 * Route guard for owner-only screens. Attendants are sent straight back to the
 * POS — their home screen — and never render the guarded page.
 */
export function RequireOwner({ children }: { children: ReactNode }) {
  if (!isOwner()) {
    return <Navigate to="/pos" replace />
  }
  return <>{children}</>
}
