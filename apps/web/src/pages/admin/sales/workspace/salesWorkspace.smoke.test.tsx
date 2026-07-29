// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() },
}))
vi.mock('../../../../contexts/PermissionContext', () => ({
  usePermission: () => ({ isAdmin: true, isSuperAdmin: false, roles: [], hasPermission: () => true, loading: false }),
}))
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: '1', role: 'admin' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }),
}))
// Stub the four reused sales sub-pages so this test targets the tab container.
vi.mock('../../../sales-dashboard', () => ({ default: () => <div>工作台内容</div> }))
vi.mock('../../../sales-profile', () => ({ default: () => <div>资料内容</div> }))
vi.mock('../../../sales-material', () => ({ default: () => <div>素材内容</div> }))
vi.mock('../../../sales-data', () => ({ default: () => <div>数据内容</div> }))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import AdminSalesWorkspacePage from './index'

describe('AdminSalesWorkspacePage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({}) // profile exists (200)
  })

  it('renders the promotion workspace tabs once a sales profile is present', async () => {
    renderWithProviders(<AdminSalesWorkspacePage />)
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/app/sales/profile'))
    expect(await screen.findByRole('tab', { name: '工作台' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '推广素材' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '订单数据' })).toBeInTheDocument()
  })
})
