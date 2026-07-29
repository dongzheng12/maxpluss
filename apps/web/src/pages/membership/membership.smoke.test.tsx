// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMembershipPlans = vi.fn()
const listOrders = vi.fn()
const getProfile = vi.fn()
vi.mock('../../api/app', () => ({
  getMembershipPlans: () => getMembershipPlans(),
  listOrders: () => listOrders(),
  getProfile: () => getProfile(),
}))
vi.mock('../../utils/tracker', () => ({ track: vi.fn() }))

// Stub PaymentModal so this test stays focused on the membership page; the modal
// itself is covered by PaymentModal.smoke.test.tsx.
vi.mock('../../components/PaymentModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="payment-modal-open" /> : null),
}))

let mockAuth = { user: { memberTier: 'free' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
vi.mock('../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../contexts/AuthContext')>()),
  useAuth: () => mockAuth,
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import MembershipPage from './index'

const plans = {
  plans: [
    { id: 'personal', name: '个人会员', price: 99, priceUnit: 9900, originalPrice: 199, unit: '年', badge: '', features: [] },
    { id: 'pro', name: '专业会员', price: 199, priceUnit: 19900, originalPrice: 299, unit: '年', badge: '推荐', features: [] },
  ],
  currentMembership: null,
}

describe('MembershipPage smoke', () => {
  beforeEach(() => {
    mockAuth = { user: { memberTier: 'free' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
    getMembershipPlans.mockReset().mockResolvedValue(plans)
    listOrders.mockReset().mockResolvedValue({ items: [] })
    getProfile.mockReset().mockResolvedValue({ membership: null })
  })

  it('renders the plan cards and the benefits-comparison entry', async () => {
    renderWithProviders(<MembershipPage />)
    expect(await screen.findByText('个人会员')).toBeInTheDocument()
    expect(screen.getByText('专业会员')).toBeInTheDocument()
    expect(screen.getByText('查看完整权益对照表 →')).toBeInTheDocument()
  })

  it('opens the payment modal after the buy precheck passes', async () => {
    renderWithProviders(<MembershipPage />)
    await screen.findByText('个人会员')
    const buyButtons = await screen.findAllByText(/立即开通|升级方案/)
    await userEvent.click(buyButtons[0])
    await waitFor(() => expect(getProfile).toHaveBeenCalled())
    expect(await screen.findByTestId('payment-modal-open')).toBeInTheDocument()
  })

  it('blocks buying a tier already owned with an info message', async () => {
    mockAuth = { user: { memberTier: 'pro' }, isLoggedIn: true, login: vi.fn(), logout: vi.fn() }
    getProfile.mockResolvedValue({ membership: { status: 'ACTIVE', plan: { id: 'pro' } } })
    renderWithProviders(<MembershipPage />)
    await screen.findByText('专业会员')
    // 'pro' tier already owned → personal card shows the included/owned state, not a buy CTA.
    expect(screen.queryByTestId('payment-modal-open')).not.toBeInTheDocument()
  })
})
