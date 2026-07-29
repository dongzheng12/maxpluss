// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a) } }))
vi.mock('../../../contexts/PermissionContext', () => ({
  usePermission: () => ({ isAdmin: true, isSuperAdmin: true, roles: [], hasPermission: () => true, loading: false }),
}))
vi.mock('../../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { nickName: '管理员' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminDashboard from './index'

describe('AdminDashboard smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [] })
  })

  it('renders the admin data overview and loads dashboard data', async () => {
    renderWithProviders(<AdminDashboard />)
    expect(await screen.findByText('数据概览')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalled())
  })
})
