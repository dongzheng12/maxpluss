// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRegister = vi.fn()
const getCaptcha = vi.fn()
const sendVerifyCode = vi.fn()
const nodeApiGet = vi.fn()
vi.mock('../../api/app', () => ({
  register: (...a: unknown[]) => apiRegister(...a),
  getCaptcha: () => getCaptcha(),
  sendVerifyCode: (...a: unknown[]) => sendVerifyCode(...a),
}))
vi.mock('../../api/client', () => ({ nodeApi: { get: (...a: unknown[]) => nodeApiGet(...a), post: vi.fn() } }))
vi.mock('../../utils/tracker', () => ({ track: vi.fn() }))

import { renderWithProviders, screen, userEvent, waitFor } from '../../test/utils'
import RegisterPage from './index'

describe('RegisterPage smoke', () => {
  beforeEach(() => {
    apiRegister.mockReset()
    getCaptcha.mockReset().mockResolvedValue({ token: 'cap-token', svg: '<svg></svg>' })
    sendVerifyCode.mockReset().mockResolvedValue({})
    nodeApiGet.mockReset().mockRejectedValue?.(new Error('no sales'))
  })

  it('loads a captcha on mount and renders the core registration fields', async () => {
    renderWithProviders(<RegisterPage />)
    await waitFor(() => expect(getCaptcha).toHaveBeenCalled())
    expect(screen.getByPlaceholderText('手机号')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('图形验证码')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('短信验证码（6位）')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('设置密码（至少6位）')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('确认密码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /注\s*册/ })).toBeInTheDocument()
    expect(screen.getByText('已有账号？去登录')).toBeInTheDocument()
  })

  it('warns when sending SMS without a phone number', async () => {
    renderWithProviders(<RegisterPage />)
    await waitFor(() => expect(getCaptcha).toHaveBeenCalled())
    await userEvent.click(screen.getByRole('button', { name: '获取验证码' }))
    expect(await screen.findByText('请先填写手机号')).toBeInTheDocument()
    expect(sendVerifyCode).not.toHaveBeenCalled()
  })

  it('blocks submit when the two passwords differ', async () => {
    renderWithProviders(<RegisterPage />)
    await waitFor(() => expect(getCaptcha).toHaveBeenCalled())
    await userEvent.type(screen.getByPlaceholderText('手机号'), '13800138000')
    await userEvent.type(screen.getByPlaceholderText('图形验证码'), 'ab12')
    await userEvent.type(screen.getByPlaceholderText('短信验证码（6位）'), '123456')
    await userEvent.type(screen.getByPlaceholderText('设置密码（至少6位）'), 'secret123')
    await userEvent.type(screen.getByPlaceholderText('确认密码'), 'different9')
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(screen.getByRole('button', { name: /注\s*册/ }))
    expect(await screen.findByText('两次密码不一致')).toBeInTheDocument()
    expect(apiRegister).not.toHaveBeenCalled()
  })
})
