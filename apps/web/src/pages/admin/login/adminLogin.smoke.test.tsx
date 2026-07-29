// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiLogin = vi.fn()
vi.mock('../../../api/app', () => ({ login: (...a: unknown[]) => apiLogin(...a) }))
vi.mock('../../../api/client', () => ({ nodeApi: { get: vi.fn().mockResolvedValue({ isAdmin: true }) } }))
vi.mock('../../../contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/AuthContext')>()),
  useAuth: () => ({ user: null, isLoggedIn: false, login: vi.fn(), logout: vi.fn() }),
}))

import { renderWithProviders, screen, userEvent, waitFor } from '../../../test/utils'
import AdminLoginPage from './index'

describe('AdminLoginPage smoke', () => {
  beforeEach(() => { apiLogin.mockReset().mockResolvedValue({ token: 't', user: { id: '1', role: 'admin' } }) })

  it('renders the admin console login form', () => {
    renderWithProviders(<AdminLoginPage />, { route: '/admin/login' })
    expect(screen.getByText('管理后台')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('手机号')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('密码')).toBeInTheDocument()
  })

  it('submits the admin credentials', async () => {
    renderWithProviders(<AdminLoginPage />, { route: '/admin/login' })
    await userEvent.type(screen.getByPlaceholderText('手机号'), '13800138000')
    await userEvent.type(screen.getByPlaceholderText('密码'), 'secret123')
    await userEvent.click(screen.getByRole('button', { name: /登\s*录/ }))
    await waitFor(() => expect(apiLogin).toHaveBeenCalledWith('13800138000', 'secret123'))
  })
})
