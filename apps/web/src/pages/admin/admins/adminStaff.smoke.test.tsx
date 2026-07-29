// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminAdminsPage from './index'

describe('AdminAdminsPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [], roles: [], templates: [] }) })
  it('renders the staff-permission management page and loads staff', async () => {
    renderWithProviders(<AdminAdminsPage />)
    expect(screen.getByText('人员权限管理')).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/admin/staff'))).toBe(true))
  })
})
