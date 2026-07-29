// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn(), put: vi.fn() } }))
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => ({ user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, waitFor } from '../../test/utils'
import SalesProfilePage from './index'

describe('SalesProfilePage smoke', () => {
  beforeEach(() => { nodeApiGet.mockReset().mockResolvedValue({ items: [], products: [] }) })
  it('loads the sales profile data', async () => {
    renderWithProviders(<SalesProfilePage />)
    await waitFor(() => expect(nodeApiGet.mock.calls.some((c) => String(c[0]).includes('/api/app/sales/'))).toBe(true))
  })
})
