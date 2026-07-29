// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() } }))

import { renderWithProviders, waitFor } from '../../test/utils'
import SalesDashboardPage from './index'

describe('SalesDashboardPage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [], codes: [] }) })
  it('loads the sales workspace data', async () => {
    renderWithProviders(<SalesDashboardPage />)
    await waitFor(() => expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/app/sales/'))).toBe(true))
  })
})
