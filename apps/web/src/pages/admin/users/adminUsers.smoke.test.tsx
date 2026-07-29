// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), patch: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminUsersPage from './index'

describe('AdminUsersPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [], total: 0 })
  })

  it('renders the user-management page and loads users', async () => {
    renderWithProviders(<AdminUsersPage />)
    expect(screen.getByText('用户管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/admin/users'))).toBe(true))
  })
})
