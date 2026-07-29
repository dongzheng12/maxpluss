// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Every payment API is mocked — tests NEVER hit a real payment backend.
const createOrder = vi.fn()
const payOrder = vi.fn()
const getOrderStatus = vi.fn()
const cancelOrder = vi.fn()
const getApplicableCoupons = vi.fn()
vi.mock('../api/app', () => ({
  createOrder: (...a: unknown[]) => createOrder(...a),
  payOrder: (...a: unknown[]) => payOrder(...a),
  getOrderStatus: (...a: unknown[]) => getOrderStatus(...a),
  cancelOrder: (...a: unknown[]) => cancelOrder(...a),
  getApplicableCoupons: (...a: unknown[]) => getApplicableCoupons(...a),
}))
vi.mock('../utils/tracker', () => ({ track: vi.fn() }))

import { render, screen, userEvent, waitFor } from '../test/utils'
import PaymentModal, { type PaymentRequest } from './PaymentModal'

const membership: PaymentRequest = { productType: 'MEMBERSHIP', planId: 'personal', title: '个人会员', amount: 9900 }

describe('PaymentModal smoke', () => {
  beforeEach(() => {
    createOrder.mockReset().mockResolvedValue({ orderNo: 'ORD-1', title: '个人会员', amount: 9900 })
    payOrder.mockReset()
    getOrderStatus.mockReset()
    cancelOrder.mockReset().mockResolvedValue({})
    getApplicableCoupons.mockReset().mockResolvedValue({ items: [] })
  })

  it('auto-completes on the mock-paid path and reports the order back', async () => {
    payOrder.mockResolvedValue({ payMode: 'mock-paid', status: 'PAID' })
    const onSuccess = vi.fn()
    render(<PaymentModal open payment={membership} onClose={() => {}} onSuccess={onSuccess} />)

    expect(await screen.findByText('您的会员权益已自动开通，感谢您的支持！')).toBeInTheDocument()
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(payOrder).toHaveBeenCalledWith('ORD-1', 'WECHAT')

    await userEvent.click(screen.getByRole('button', { name: /完\s*成/ }))
    expect(onSuccess).toHaveBeenCalledWith('ORD-1')
  })

  it('shows the coupon step for membership orders and passes the chosen coupon', async () => {
    getApplicableCoupons.mockResolvedValue({
      items: [{ id: 'c1', name: '新人券', calculatedDiscount: 1000, minAmount: 0, applicable: true, expiresAt: '2030-01-01' }],
    })
    payOrder.mockResolvedValue({ payMode: 'mock-paid', status: 'PAID' })
    render(<PaymentModal open payment={membership} onClose={() => {}} />)

    expect(await screen.findByText('选择优惠券')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /确认下单/ }))
    await waitFor(() => expect(createOrder).toHaveBeenCalled())
    expect(createOrder.mock.calls[0][0]).toMatchObject({ userCouponId: 'c1' })
  })

  it('cancels the freshly created order when closed before payment', async () => {
    payOrder.mockResolvedValue({ payMode: 'native', codeUrl: 'weixin://wxpay/mock' })
    render(<PaymentModal open payment={membership} onClose={() => {}} />)

    expect(await screen.findByText('请使用微信扫描二维码完成支付')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(cancelOrder).toHaveBeenCalledWith('ORD-1'))
  })

  it('pays an existing order directly without creating a new one', async () => {
    payOrder.mockResolvedValue({ payMode: 'mock-paid', status: 'PAID' })
    render(<PaymentModal open payment={membership} existingOrderNo="ORD-EXIST" onClose={() => {}} />)

    expect(await screen.findByText('您的会员权益已自动开通，感谢您的支持！')).toBeInTheDocument()
    expect(createOrder).not.toHaveBeenCalled()
    expect(payOrder).toHaveBeenCalledWith('ORD-EXIST', 'WECHAT')
  })
})
