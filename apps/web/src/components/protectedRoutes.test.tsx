// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Route, Routes, useLocation } from 'react-router-dom'
import { ProtectedRoute } from './ProtectedRoute'
import { EnterpriseRoute } from './EnterpriseRoute'
import { renderWithProviders, screen, waitFor } from '../test/utils'
import { nodeApi } from '../api/client'

vi.mock('../api/client', () => ({
  nodeApi: {
    get: vi.fn(),
  },
}))

const authState = vi.hoisted(() => ({
  value: {
    user: null as null | { id: string; role?: 'user' | 'admin' | 'sales' },
    isLoggedIn: false,
    isAdmin: false,
    loading: false,
    logout: vi.fn(),
  },
}))

const permissionState = vi.hoisted(() => ({
  value: {
    loading: false,
    hasAdminAccess: false,
    isAdmin: false,
    isSales: false,
    isStaff: false,
    menuPaths: [] as string[],
    actionKeys: [] as string[],
  },
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState.value,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../contexts/PermissionContext', () => ({
  usePermission: () => permissionState.value,
}))

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

function renderProtectedAdmin(route = '/admin/users') {
  return renderWithProviders(
    <Routes>
      <Route
        path="/admin/users"
        element={(
          <ProtectedRoute requiredRole="admin">
            <div>admin allowed</div>
          </ProtectedRoute>
        )}
      />
      <Route path="/admin/login" element={<LocationProbe />} />
      <Route path="/admin/sales/workspace" element={<LocationProbe />} />
      <Route path="/" element={<LocationProbe />} />
    </Routes>,
    { route, withAuth: false },
  )
}

function renderEnterprise(route = '/enterprise/workbench?tab=tasks') {
  return renderWithProviders(
    <Routes>
      <Route element={<EnterpriseRoute />}>
        <Route path="/enterprise/workbench" element={<div>enterprise allowed</div>} />
      </Route>
      <Route path="/login" element={<LocationProbe />} />
    </Routes>,
    { route, withAuth: false },
  )
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    authState.value = {
      user: null,
      isLoggedIn: false,
      isAdmin: false,
      loading: false,
      logout: vi.fn(),
    }
    permissionState.value = {
      loading: false,
      hasAdminAccess: false,
      isAdmin: false,
      isSales: false,
      isStaff: false,
      menuPaths: [],
      actionKeys: [],
    }
    vi.mocked(nodeApi.get).mockReset()
  })

  it('redirects anonymous admin access to admin login', () => {
    renderProtectedAdmin()

    expect(screen.getByTestId('location')).toHaveTextContent('/admin/login')
  })

  it('allows platform admins into admin routes', () => {
    authState.value = {
      user: { id: 'admin', role: 'admin' },
      isLoggedIn: true,
      isAdmin: true,
      loading: false,
      logout: vi.fn(),
    }

    renderProtectedAdmin()

    expect(screen.getByText('admin allowed')).toBeInTheDocument()
  })

  it('redirects sales users away from non-sales admin paths without menu coverage', () => {
    authState.value = {
      user: { id: 'sales', role: 'sales' },
      isLoggedIn: true,
      isAdmin: false,
      loading: false,
      logout: vi.fn(),
    }

    renderProtectedAdmin()

    expect(screen.getByTestId('location')).toHaveTextContent('/admin/sales/workspace')
  })

  it('allows RBAC staff with admin access into admin routes', () => {
    authState.value = {
      user: { id: 'staff', role: 'user' },
      isLoggedIn: true,
      isAdmin: false,
      loading: false,
      logout: vi.fn(),
    }
    permissionState.value = {
      loading: false,
      hasAdminAccess: true,
      isAdmin: false,
      isSales: false,
      isStaff: true,
      menuPaths: ['/admin/users'],
      actionKeys: [],
    }

    renderProtectedAdmin()

    expect(screen.getByText('admin allowed')).toBeInTheDocument()
  })
})

describe('EnterpriseRoute', () => {
  beforeEach(() => {
    authState.value = {
      user: null,
      isLoggedIn: false,
      isAdmin: false,
      loading: false,
      logout: vi.fn(),
    }
    permissionState.value = {
      loading: false,
      hasAdminAccess: false,
      isAdmin: false,
      isSales: false,
      isStaff: false,
      menuPaths: [],
      actionKeys: [],
    }
    vi.mocked(nodeApi.get).mockReset()
  })

  it('redirects anonymous users to enterprise login with original redirect', async () => {
    renderEnterprise()

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/login?tab=enterprise&redirect=%2Fenterprise%2Fworkbench%3Ftab%3Dtasks')
    })
  })

  it('redirects logged-in users without enterprise role', async () => {
    authState.value = {
      user: { id: 'user', role: 'user' },
      isLoggedIn: true,
      isAdmin: false,
      loading: false,
      logout: vi.fn(),
    }
    vi.mocked(nodeApi.get).mockResolvedValue({ enterpriseRole: null, isAdminBypass: false })

    renderEnterprise('/enterprise/workbench')

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/login?tab=enterprise&redirect=%2Fenterprise%2Fworkbench&reason=no-enterprise-role')
    })
  })

  it('allows admin bypass users', async () => {
    authState.value = {
      user: { id: 'admin', role: 'admin' },
      isLoggedIn: true,
      isAdmin: true,
      loading: false,
      logout: vi.fn(),
    }
    vi.mocked(nodeApi.get).mockResolvedValue({ enterpriseRole: null, isAdminBypass: true })

    renderEnterprise('/enterprise/workbench')

    expect(await screen.findByText('enterprise allowed')).toBeInTheDocument()
  })

  it('logs out when enterprise profile returns 401', async () => {
    const logout = vi.fn()
    authState.value = {
      user: { id: 'user', role: 'user' },
      isLoggedIn: true,
      isAdmin: false,
      loading: false,
      logout,
    }
    vi.mocked(nodeApi.get).mockRejectedValue({ response: { status: 401 } })

    renderEnterprise('/enterprise/workbench')

    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1)
    })
  })
})
