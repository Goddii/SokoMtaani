import { lazy, Suspense, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { AppShell } from './components/layout/AppShell'
import { RequireOwner } from './components/layout/RequireOwner'
import { Skeleton } from './components/ui/EmptyState'
import LoginPage from './pages/LoginPage'
import { isLoggedIn, logout, getStoredUser, isOwner } from './lib/auth'
import type { ApiAttendant } from './lib/api'

const PosPage = lazy(() => import('./pages/PosPage').then((m) => ({ default: m.PosPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })))
const ProductsPage = lazy(() => import('./pages/ProductsPage').then((m) => ({ default: m.ProductsPage })))
const BatchesPage = lazy(() => import('./pages/BatchesPage').then((m) => ({ default: m.BatchesPage })))
const AttendantsPage = lazy(() => import('./pages/AttendantsPage').then((m) => ({ default: m.AttendantsPage })))
const WastagePage = lazy(() => import('./pages/WastagePage').then((m) => ({ default: m.WastagePage })))
const SalesPage = lazy(() => import('./pages/SalesPage').then((m) => ({ default: m.SalesPage })))

function RouteFallback() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-28 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  )
}

/** Home screen for the logged-in role — unknown URLs land here. */
function HomeRoute() {
  return <Navigate to={isOwner() ? '/' : '/pos'} replace />
}

export default function App() {
  const [user, setUser] = useState<ApiAttendant | null>(() => getStoredUser())
  const navigate = useNavigate()

  function handleLogin(u: ApiAttendant) {
    setUser(u)
    navigate(u.shop_role === 'owner' ? '/' : '/pos', { replace: true })
  }

  async function handleLogout() {
    await logout()
    setUser(null)
  }

  // Not logged in → show login page regardless of route
  if (!user || !isLoggedIn()) {
    return <LoginPage onLogin={handleLogin} />
  }

  return (
    <Routes>
      <Route
        path="/pos"
        element={
          <Suspense fallback={<Skeleton className="fixed inset-0" />}>
            <PosPage onLogout={handleLogout} />
          </Suspense>
        }
      />
      <Route element={<AppShell onLogout={handleLogout} currentUser={user} />}>
        <Route
          path="/"
          element={
            <RequireOwner>
              <Suspense fallback={<RouteFallback />}>
                <DashboardPage />
              </Suspense>
            </RequireOwner>
          }
        />
        <Route
          path="/products"
          element={
            <RequireOwner>
              <Suspense fallback={<RouteFallback />}>
                <ProductsPage />
              </Suspense>
            </RequireOwner>
          }
        />
        <Route
          path="/batches"
          element={
            <RequireOwner>
              <Suspense fallback={<RouteFallback />}>
                <BatchesPage />
              </Suspense>
            </RequireOwner>
          }
        />
        <Route
          path="/attendants"
          element={
            <RequireOwner>
              <Suspense fallback={<RouteFallback />}>
                <AttendantsPage />
              </Suspense>
            </RequireOwner>
          }
        />
        <Route
          path="/wastage"
          element={
            <Suspense fallback={<RouteFallback />}>
              <WastagePage />
            </Suspense>
          }
        />
        <Route
          path="/sales"
          element={
            <RequireOwner>
              <Suspense fallback={<RouteFallback />}>
                <SalesPage />
              </Suspense>
            </RequireOwner>
          }
        />
      </Route>
      <Route path="*" element={<HomeRoute />} />
    </Routes>
  )
}
