// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() },
}))
vi.mock('../../../../contexts/PermissionContext', () => ({
  usePermission: () => ({ isAdmin: true, isSuperAdmin: true, roles: [], hasPermission: () => true, loading: false }),
}))

import { renderWithProviders, screen, waitFor } from '../../../../test/utils'
import AdminSalesOverviewPage from './index'

describe('AdminSalesOverviewPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({
      summary: { salesCount: 3, totalRegistered: 120, totalPaidUsers: 18 },
      items: [],
    })
  })

  it('renders the sales dashboard with the summary statistics', async () => {
    renderWithProviders(<AdminSalesOverviewPage />)
    expect(screen.getByText('销售数据看板')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/sales/overview'))
    expect(screen.getByText('销售数量')).toBeInTheDocument()
    expect(screen.getByText('总注册用户')).toBeInTheDocument()
    expect(screen.getByText('总付费用户')).toBeInTheDocument()
  })
})
