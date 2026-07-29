// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const adminListCoupons = vi.fn()
vi.mock('../../../api/app', () => ({
  adminListCoupons: () => adminListCoupons(),
  adminCreateCoupon: vi.fn(),
  adminUpdateCoupon: vi.fn(),
  adminListGrants: vi.fn(),
  adminIssueCouponBatch: vi.fn(),
  adminRevokeUserCoupon: vi.fn(),
}))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import AdminCouponsPage from './index'

describe('AdminCouponsPage smoke', () => {
  beforeEach(() => {
    adminListCoupons.mockReset().mockResolvedValue({ items: [] })
  })

  it('renders the coupon-template management page and loads templates', async () => {
    renderWithProviders(<AdminCouponsPage />)
    expect(screen.getByText('优惠券模板管理')).toBeInTheDocument()
    await waitFor(() => expect(adminListCoupons).toHaveBeenCalled())
  })
})
