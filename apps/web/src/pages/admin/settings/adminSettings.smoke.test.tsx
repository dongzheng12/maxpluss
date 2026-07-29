// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), put: vi.fn(), post: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminSettingsPage from './index'

describe('AdminSettingsPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ settings: {} }) })
  it('renders the system-settings page and loads settings', async () => {
    renderWithProviders(<AdminSettingsPage />)
    expect(await screen.findByRole('heading', { name: /系统设置/ })).toBeInTheDocument()
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/settings'))
  })
})
