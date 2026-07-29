// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrders = vi.fn()
const cancelOrder = vi.fn()
vi.mock('../../api/app', () => ({
  listOrders: () => listOrders(),
  cancelOrder: (...a: unknown[]) => cancelOrder(...a),
}))
vi.mock('../../components/PaymentModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="payment-modal-open" /> : null),
}))

let mockAuth: { user: { id: string } | null; isLoggedIn: boolean; login: () => void; logout: () => void } = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => mockAuth,
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import OrdersPage from './index'

describe('OrdersPage smoke', () => {
  beforeEach(() => {
    mockAuth = { user: { id: '1' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
    listOrders.mockReset().mockResolvedValue({
      items: [
        { orderNo: 'ORD-P', title: '个人会员', productType: 'MEMBERSHIP', status: 'PENDING', amount: 9900 },
      ],
    })
    cancelOrder.mockReset().mockResolvedValue({})
  })

  it('shows a 403 prompt when the visitor is not logged in', () => {
    mockAuth = { user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }
    renderWithProviders(<OrdersPage />)
    expect(screen.getByText('请先登录')).toBeInTheDocument()
    expect(listOrders).not.toHaveBeenCalled()
  })

  it('renders orders with the status translated to Chinese', async () => {
    renderWithProviders(<OrdersPage />)
    await waitFor(() => expect(listOrders).toHaveBeenCalled())
    expect(await screen.findByText('个人会员')).toBeInTheDocument()
    // PENDING → 待支付; raw enum never shown.
    expect(screen.getByText('待支付')).toBeInTheDocument()
    expect(screen.queryByText('PENDING')).not.toBeInTheDocument()
  })

  it('opens the payment modal to continue paying a pending order', async () => {
    renderWithProviders(<OrdersPage />)
    await screen.findByText('个人会员')
    await userEvent.click(screen.getByRole('button', { name: /微信支付|继续支付/ }))
    expect(await screen.findByTestId('payment-modal-open')).toBeInTheDocument()
  })
})
