// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() },
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminOrdersPage from './index'

describe('AdminOrdersPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  it('renders the order-management page and loads orders', async () => {
    renderWithProviders(<AdminOrdersPage />)
    expect(screen.getByText('订单管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/orders'))
  })
})
