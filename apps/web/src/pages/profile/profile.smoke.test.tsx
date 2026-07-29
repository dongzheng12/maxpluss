// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nodeApiGet = vi.fn()
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), put: vi.fn() } }))

type AuthUser = { phone?: string; nickName?: string; memberTier?: string } | null
let mockAuth: { user: AuthUser; isLoggedIn: boolean; login: () => void; logout: () => void } = {
  user: { phone: '13800138000', nickName: '小明', memberTier: 'pro' },
  isLoggedIn: true,
  login: vi.fn(),
  logout: vi.fn(),
}
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => mockAuth,
}))

import { renderWithProviders, screen } from '../../test/utils'
import ProfilePage from './index'

describe('ProfilePage smoke', () => {
  beforeEach(() => {
    mockAuth = {
      user: { phone: '13800138000', nickName: '小明', memberTier: 'pro' },
      isLoggedIn: true,
      login: vi.fn(),
      logout: vi.fn(),
    }
    nodeApiGet.mockReset().mockResolvedValue({ membership: { plan: { id: 'pro' } } })
  })

  it('prompts to log in when signed out', () => {
    mockAuth = { user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }
    renderWithProviders(<ProfilePage />)
    expect(screen.getByText('请先登录')).toBeInTheDocument()
  })

  it('shows the profile with phone and membership tier translated', () => {
    renderWithProviders(<ProfilePage />)
    expect(screen.getByText('13800138000')).toBeInTheDocument()
    // memberTier 'pro' → Pro 会员 label, never the raw tier id.
    expect(screen.getAllByText('Pro 会员').length).toBeGreaterThan(0)
    expect(screen.queryByText('pro')).not.toBeInTheDocument()
  })
})
