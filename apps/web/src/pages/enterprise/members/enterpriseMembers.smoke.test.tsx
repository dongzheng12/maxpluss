// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seListEnterpriseMembers = vi.fn()
const enterpriseMeMock = vi.fn()
const seResetEnterpriseMemberPassword = vi.fn()
vi.mock('../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/standardExecution')>()),
  seListEnterpriseMembers: () => seListEnterpriseMembers(),
  enterpriseMe: () => enterpriseMeMock(),
  seAddEnterpriseMember: vi.fn(),
  seUpdateEnterpriseMemberRole: vi.fn(),
  seResetEnterpriseMemberPassword: (id: string) => seResetEnterpriseMemberPassword(id),
  seRemoveEnterpriseMember: vi.fn(),
}))
vi.mock('../../../api/app', () => ({ changePassword: vi.fn() }))

import { renderWithProviders, screen, waitFor } from '../../../test/utils'
import EnterpriseMembersPage from './index'

describe('EnterpriseMembersPage smoke', () => {
  beforeEach(() => {
    seListEnterpriseMembers.mockReset().mockResolvedValue({ data: [] })
    seResetEnterpriseMemberPassword.mockReset().mockResolvedValue({ ok: true, temporaryPassword: 'Abcd1234', passwordMustChange: true })
    enterpriseMeMock.mockReset().mockResolvedValue({
      user: { id: 'u-admin', role: 'user' },
      enterpriseRole: 'ADMIN',
      enterpriseId: 'e1',
      isAdminBypass: false,
    })
  })
  it('loads the enterprise member list', async () => {
    renderWithProviders(<EnterpriseMembersPage />, { route: '/enterprise/members' })
    await waitFor(() => expect(seListEnterpriseMembers).toHaveBeenCalled())
  })

  it('shows member management actions to ADMIN', async () => {
    renderWithProviders(<EnterpriseMembersPage />, { route: '/enterprise/members' })
    await waitFor(() => expect(screen.getByText('添加成员')).toBeInTheDocument())
  })

  it('hides member management actions from MANAGER', async () => {
    seListEnterpriseMembers.mockResolvedValueOnce({
      data: [
        { id: 'u-admin', phone: '13900000001', nickName: '管理员', enterpriseRole: 'ADMIN' },
        { id: 'u-emp', phone: '13900000002', nickName: '员工', enterpriseRole: 'EMPLOYEE' },
      ],
    })
    enterpriseMeMock.mockResolvedValueOnce({
      user: { id: 'u-manager', role: 'user' },
      enterpriseRole: 'MANAGER',
      enterpriseId: 'e1',
      isAdminBypass: false,
    })

    renderWithProviders(<EnterpriseMembersPage />, { route: '/enterprise/members' })
    await waitFor(() => expect(enterpriseMeMock).toHaveBeenCalled())
    expect(screen.queryByText('添加成员')).not.toBeInTheDocument()
    expect(screen.queryByText('重置密码')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('shows reset password action to ADMIN for other members', async () => {
    seListEnterpriseMembers.mockResolvedValueOnce({
      data: [
        { id: 'u-admin', phone: '13900000001', nickName: '管理员', enterpriseRole: 'ADMIN' },
        { id: 'u-emp', phone: '13900000002', nickName: '员工', enterpriseRole: 'EMPLOYEE', passwordMustChange: true },
      ],
    })
    renderWithProviders(<EnterpriseMembersPage />, { route: '/enterprise/members' })
    await waitFor(() => expect(screen.getByText('重置密码')).toBeInTheDocument())
    expect(screen.getByText('待修改')).toBeInTheDocument()
  })
})
