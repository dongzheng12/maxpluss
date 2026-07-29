// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMyCoupons = vi.fn()
vi.mock('../../api/app', () => ({ getMyCoupons: (...a: unknown[]) => getMyCoupons(...a) }))

let mockAuth: { user: { id: string } | null; isLoggedIn: boolean; login: () => void; logout: () => void } = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => mockAuth,
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import MyCouponsPage from './index'

const coupon = {
  id: 'uc1',
  status: 'AVAILABLE',
  expiresAt: '2030-01-01',
  coupon: {
    name: '新人立减券',
    discountType: 'FIXED',
    discountValue: 1000,
    minAmount: 0,
    applicableScope: 'MEMBERSHIP',
  },
}

describe('MyCouponsPage smoke', () => {
  beforeEach(() => {
    mockAuth = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
    getMyCoupons.mockReset().mockResolvedValue({ items: [coupon] })
  })

  it('prompts for login when there is no user', () => {
    mockAuth = { user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }
    renderWithProviders(<MyCouponsPage />)
    expect(screen.getByText('请先登录后查看优惠券')).toBeInTheDocument()
    expect(getMyCoupons).not.toHaveBeenCalled()
  })

  it('renders a coupon with its scope label translated to Chinese', async () => {
    renderWithProviders(<MyCouponsPage />)
    await waitFor(() => expect(getMyCoupons).toHaveBeenCalledWith('AVAILABLE'))
    expect(await screen.findByText('新人立减券')).toBeInTheDocument()
    // MEMBERSHIP scope → 会员套餐, never the raw enum.
    expect(screen.getByText('会员套餐')).toBeInTheDocument()
    expect(screen.queryByText('MEMBERSHIP')).not.toBeInTheDocument()
  })

  it('refetches when switching to another status tab', async () => {
    getMyCoupons.mockResolvedValue({ items: [] })
    renderWithProviders(<MyCouponsPage />)
    await waitFor(() => expect(getMyCoupons).toHaveBeenCalledWith('AVAILABLE'))
    await userEvent.click(screen.getByRole('tab', { name: '已使用' }))
    await waitFor(() => expect(getMyCoupons).toHaveBeenCalledWith('USED'))
  })

  it('shows an empty state with a membership entry on the available tab', async () => {
    getMyCoupons.mockResolvedValue({ items: [] })
    renderWithProviders(<MyCouponsPage />)
    expect(await screen.findByText('暂无可用优惠券')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /去会员中心/ })).toBeInTheDocument()
  })
})
