// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), delete: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminAnnouncementsPage from './index'

describe('AdminAnnouncementsPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the announcement-management page and loads announcements', async () => {
    renderWithProviders(<AdminAnnouncementsPage />)
    expect(await screen.findByRole('heading', { name: /公告/ })).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/announcements'))
  })
})
