// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../../api/client', () => ({
  nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() },
}))

import { renderWithProviders, waitFor } from '../../../test/utils'
import AdminGiftsPage from './index'

describe('AdminGiftsPage smoke', () => {
  beforeEach(() => {
    nodeApiGet.mockReset().mockResolvedValue({ items: [], total: 0, stats: {} })
  })

  it('mounts and loads the gift records', async () => {
    renderWithProviders(<AdminGiftsPage />)
    await waitFor(() =>
      expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/admin/gifts'))).toBe(true),
    )
  })
})
