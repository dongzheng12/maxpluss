// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({ nodeApi: { get: vi.fn().mockResolvedValue({}), post: vi.fn() } }))
vi.mock('../../api/app', () => ({ login: vi.fn() }))
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => ({ user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, screen } from '../../test/utils'
import SalesJoinPage from './index'

describe('SalesJoinPage smoke', () => {
  it('shows the invite-code-missing error page without a code', async () => {
    renderWithProviders(<SalesJoinPage />, { route: '/sales/join' })
    expect(await screen.findByText('邀请码缺失')).toBeInTheDocument()
  })
})
