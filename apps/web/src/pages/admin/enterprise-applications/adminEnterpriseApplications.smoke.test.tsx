// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), patch: vi.fn() },
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminEnterpriseApplicationsPage from './index'

describe('AdminEnterpriseApplicationsPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  it('renders the enterprise-application review page and loads applications', async () => {
    renderWithProviders(<AdminEnterpriseApplicationsPage />)
    expect(screen.getByText('企业申请')).toBeInTheDocument()
    await waitFor(() =>
      expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/admin/enterprise/applications'))).toBe(true),
    )
  })
})
