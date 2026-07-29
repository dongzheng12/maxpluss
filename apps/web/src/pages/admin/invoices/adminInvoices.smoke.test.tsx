// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() },
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminInvoicesPage from './index'

describe('AdminInvoicesPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [] })
  })

  it('renders the invoice-management page and loads invoices', async () => {
    renderWithProviders(<AdminInvoicesPage />)
    expect(screen.getByText('发票管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/invoices'))
  })
})
