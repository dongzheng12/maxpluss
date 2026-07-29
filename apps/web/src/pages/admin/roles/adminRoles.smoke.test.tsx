// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminRolesPage from './index'

describe('AdminRolesPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [], roles: [] }) })
  it('renders the role-management page and loads roles', async () => {
    renderWithProviders(<AdminRolesPage />)
    expect(screen.getByText('角色管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/roles'))
  })
})
