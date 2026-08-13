/**
 * Auth helpers — login/logout/session management.
 * JWT is stored in localStorage under 'soko-jwt'.
 * Current user info is stored under 'soko-user'.
 */
import { authApi, type ApiAttendant } from './api'

const TOKEN_KEY = 'soko-jwt'
const USER_KEY = 'soko-user'

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getStoredUser(): ApiAttendant | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export async function login(
  attendant_id: number,
  pin: string,
): Promise<{ success: boolean; user?: ApiAttendant; error?: string }> {
  const res = await authApi.login(attendant_id, pin)
  if (!res.ok || !res.data.access_token) {
    return { success: false, error: res.error || 'Login failed.' }
  }
  localStorage.setItem(TOKEN_KEY, res.data.access_token)
  localStorage.setItem(USER_KEY, JSON.stringify(res.data.attendant))
  return { success: true, user: res.data.attendant }
}

export async function logout() {
  try {
    await authApi.logout()
  } catch {
    // ignore network errors on logout
  }
  clearSession()
}

export function isLoggedIn(): boolean {
  return !!getStoredToken()
}

export function isOwner(): boolean {
  return getStoredUser()?.shop_role === 'owner'
}
