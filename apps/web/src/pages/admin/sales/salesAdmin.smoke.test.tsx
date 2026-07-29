// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminSalesPage from './index'

describe('AdminSalesPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  it('renders the sales-promotion management heading and loads the list', async () => {
    renderWithProviders(<AdminSalesPage />)
    expect(screen.getByText('销售推广管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalled())
    expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/admin/sales'))).toBe(true)
  })
})
