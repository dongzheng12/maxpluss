// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), put: vi.fn() } }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminContentConfigPage from './index'

describe('AdminContentConfigPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [] }) })
  it('renders the content-config page and loads config', async () => {
    renderWithProviders(<AdminContentConfigPage />)
    await waitFor(() => expect(nodeApiGet).toHaveBeenCalledWith('/api/admin/content-config'))
    expect(await screen.findByText(/暂无展示内容配置/)).toBeInTheDocument()
  })
})
