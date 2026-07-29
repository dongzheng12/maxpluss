// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// SE flag on so the enterprise tab renders; mock API/util modules so no network.
vi.mock('../../config/featureFlags', () => ({ SE_UI_ENABLED: true, SE_WORKBENCH_LEGACY: false }))
const login = vi.fn()
const enterpriseMe = vi.fn()
const nodeApiPost = vi.fn()
vi.mock('../../api/app', () => ({ login: (...args: unknown[]) => login(...args) }))
vi.mock('../../api/standardExecution', () => ({ enterpriseMe: () => enterpriseMe() }))
vi.mock('../../api/client', () => ({ nodeApi: { post: (...a: unknown[]) => nodeApiPost(...a), get: vi.fn() } }))
vi.mock('../../utils/referral', () => ({ consumePendingReferral: vi.fn() }))
vi.mock('../../utils/tracker', () => ({ track: vi.fn() }))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import LoginPage from './index'

describe('LoginPage smoke', () => {
  beforeEach(() => {
    login.mockReset()
    enterpriseMe.mockReset()
    nodeApiPost.mockReset()
  })

  it('shows the personal login form with register/forgot links by default', () => {
    renderWithProviders(<LoginPage />)
    expect(screen.getByPlaceholderText('手机号')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument()
    expect(screen.getByText('立即注册')).toBeInTheDocument()
    expect(screen.getByText('忘记密码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /登\s*录/ })).toBeInTheDocument()
  })

  it('submits the personal login with the entered credentials', async () => {
    login.mockResolvedValue({ token: 't', user: { id: '1', phone: '13800138000', role: 'user' } })
    renderWithProviders(<LoginPage />)
    await userEvent.type(screen.getByPlaceholderText('手机号'), '13800138000')
    await userEvent.type(screen.getByPlaceholderText('密码'), 'secret123')
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }))
    await waitFor(() => expect(login).toHaveBeenCalledWith('13800138000', 'secret123'))
  })

  it('switches to the enterprise tab and exposes the apply flow', async () => {
    renderWithProviders(<LoginPage />)
    await userEvent.click(screen.getByRole('button', { name: '企业版' }))
    expect(screen.getByText('企业版登录')).toBeInTheDocument()

    await userEvent.click(screen.getByText('申请企业版'))
    expect(screen.getByText('申请企业版', { selector: 'h2' })).toBeInTheDocument()
    expect(screen.getByPlaceholderText('请输入企业全称')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提交申请' })).toBeInTheDocument()
  })

  it('blocks enterprise login when the account has no enterprise role', async () => {
    login.mockResolvedValue({ token: 't', user: { id: '1', phone: '13800138000', role: 'user' } })
    enterpriseMe.mockResolvedValue({ enterpriseId: null, enterpriseRole: null, isAdminBypass: false })
    renderWithProviders(<LoginPage />, { route: '/login?tab=enterprise' })
    await userEvent.click(screen.getByRole('button', { name: '企业版' }))
    await userEvent.type(screen.getByPlaceholderText('手机号'), '13800138000')
    await userEvent.type(screen.getByPlaceholderText('密码'), 'secret123')
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }))
    await waitFor(() => expect(enterpriseMe).toHaveBeenCalled())
    // Token is cleared on the access-denied path.
    await waitFor(() => expect(localStorage.getItem('bxz_token')).toBeNull())
  })
})
