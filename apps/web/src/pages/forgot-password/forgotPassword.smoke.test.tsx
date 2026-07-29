// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getCaptcha = vi.fn()
vi.mock('../../api/app', () => ({
  getCaptcha: () => getCaptcha(),
  sendVerifyCode: vi.fn(),
  resetPassword: vi.fn(),
}))

import { renderWithProviders, screen, waitFor } from '../../test/utils'
import ForgotPasswordPage from './index'

describe('ForgotPasswordPage smoke', () => {
  beforeEach(() => { getCaptcha.mockReset().mockResolvedValue({ token: 't', svg: '' }) })
  it('renders the reset-password form and loads a captcha', async () => {
    renderWithProviders(<ForgotPasswordPage />)
    expect(screen.getByText('重置密码')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('注册手机号')).toBeInTheDocument()
    await waitFor(() => expect(getCaptcha).toHaveBeenCalled())
  })
})
