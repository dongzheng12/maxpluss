/**
 * 企业成员管理
 * 展示企业内所有成员（手机号 + 昵称 + 企业角色），支持搜索、添加、改角色和移除。
 */
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Table, Input, Space, message, Button, Modal, Form, Select, Popconfirm, Alert, Drawer, Tag, Typography } from 'antd'
import { UserAddOutlined, DeleteOutlined, KeyOutlined, CopyOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  enterpriseMe, seListEnterpriseMembers, seAddEnterpriseMember,
  seUpdateEnterpriseMemberRole, seResetEnterpriseMemberPassword, seRemoveEnterpriseMember,
  type EnterpriseMember,
} from '../../../api/standardExecution'
import { changePassword } from '../../../api/app'

const { Text } = Typography

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '企业管理员',
  MANAGER: '部门负责人',
  REVIEWER: '审核人',
  EMPLOYEE: '员工',
}

const ROLE_OPTIONS = [
  { value: 'ADMIN',    label: '企业管理员' },
  { value: 'MANAGER',  label: '部门负责人' },
  { value: 'REVIEWER', label: '审核人' },
  { value: 'EMPLOYEE', label: '员工' },
]

const pageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}

const fieldLabelStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 6,
}

const roleCardStyle: CSSProperties = {
  minHeight: 116,
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  padding: '16px 18px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  minWidth: 0,
  overflow: 'hidden',
  boxSizing: 'border-box',
}

const tableShellStyle: CSSProperties = {
  width: '100%',
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}

const ROLE_CARD_CONFIG = [
  { role: 'ADMIN', desc: '管理全部模块', bg: '#dbeafe', color: '#1d4ed8' },
  { role: 'MANAGER', desc: '创建和指派任务', bg: '#e0f2fe', color: '#0369a1' },
  { role: 'REVIEWER', desc: '处理提交审核', bg: '#ffedd5', color: '#c2410c' },
  { role: 'EMPLOYEE', desc: '执行并提交任务', bg: '#f1f5f9', color: '#475569' },
]

type MemberRow = EnterpriseMember & { lastLoginAt?: string | null }

export default function EnterpriseMembersPage() {
  const [items, setItems] = useState<EnterpriseMember[]>([])
  const [filtered, setFiltered] = useState<EnterpriseMember[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [canManageMembers, setCanManageMembers] = useState(false)
  const [addForm] = Form.useForm()
  const [addOpen, setAddOpen] = useState(false)
  const [changePwdOpen, setChangePwdOpen] = useState(false)
  const [pwdForm] = Form.useForm()
  const [temporaryPassword, setTemporaryPassword] = useState<{ title: string; value: string } | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const forceChangePassword = searchParams.get('forceChangePassword') === '1'

  const load = async () => {
    setLoading(true)
    try {
      const res = await seListEnterpriseMembers()
      setItems(res.data)
      setFiltered(res.data)
    } catch {
      message.error('加载成员列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    enterpriseMe()
      .then((res) => {
        setCurrentUserId(res.user?.id ?? null)
        setCanManageMembers(res.enterpriseRole === 'ADMIN' || res.isAdminBypass === true)
      })
      .catch(() => {
        setCurrentUserId(null)
        setCanManageMembers(false)
      })
  }, [])

  useEffect(() => {
    if (forceChangePassword) {
      pwdForm.resetFields()
      setChangePwdOpen(true)
    }
  }, [forceChangePassword, pwdForm])

  const handleAdd = async () => {
    try {
      const values = await addForm.validateFields()
      const res = await seAddEnterpriseMember(values)
      message.success('成员已添加')
      setAddOpen(false)
      addForm.resetFields()
      if (res.temporaryPassword) {
        setTemporaryPassword({ title: '成员临时密码', value: res.temporaryPassword })
      }
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const handleRemove = async (id: string) => {
    try {
      await seRemoveEnterpriseMember(id)
      message.success('已移除')
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '操作失败')
    }
  }

  const handleRoleChange = async (id: string, role: string) => {
    try {
      await seUpdateEnterpriseMemberRole(id, role)
      message.success('角色已更新')
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '操作失败')
    }
  }

  const handleResetPassword = async (row: EnterpriseMember) => {
    setResettingId(row.id)
    try {
      const res = await seResetEnterpriseMemberPassword(row.id)
      setTemporaryPassword({ title: `${row.nickName || row.phone} 的临时密码`, value: res.temporaryPassword })
      message.success('临时密码已生成')
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '重置失败')
    } finally {
      setResettingId(null)
    }
  }

  const handleSearch = (val: string) => {
    setKeyword(val)
    if (!val.trim()) {
      setFiltered(items)
    } else {
      const kw = val.toLowerCase()
      setFiltered(items.filter((m) =>
        m.phone?.toLowerCase().includes(kw) ||
        m.nickName?.toLowerCase().includes(kw)
      ))
    }
  }

  const roleMetrics = useMemo(() => ROLE_OPTIONS.map((role) => ({
    ...role,
    count: items.filter((member) => (member.enterpriseRole || 'EMPLOYEE') === role.value).length,
  })), [items])

  // 仅当前登录用户改自己的密码（不是管理员改别人）
  const handleChangePwd = async () => {
    try {
      const values = await pwdForm.validateFields()
      await changePassword(values.oldPassword, values.newPassword)
      message.success('密码修改成功')
      setChangePwdOpen(false)
      try {
        const raw = localStorage.getItem('bxz_user')
        if (raw) {
          const user = JSON.parse(raw)
          localStorage.setItem('bxz_user', JSON.stringify({ ...user, passwordMustChange: false }))
        }
      } catch {
        // ignore malformed local cache; route guard refetch will still enforce server state
      }
      window.dispatchEvent(new Event('bxz-password-changed'))
      if (forceChangePassword) setSearchParams({})
      pwdForm.resetFields()
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  return (
      <div style={pageStyle}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, marginBottom: 24 }}>
        {ROLE_CARD_CONFIG.map((item) => (
          <div key={item.role} style={{ ...roleCardStyle, background: item.bg }}>
            <div>
              <div style={{ color: item.color, fontSize: 15, fontWeight: 700, marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {ROLE_LABEL[item.role]}
              </div>
              <div style={{ color: '#64748b', fontSize: 12, lineHeight: 1.45, minHeight: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.desc}</div>
            </div>
            <div style={{ color: '#0f172a', fontSize: 24, fontWeight: 800, lineHeight: 1, marginTop: 'auto', paddingTop: 12 }}>
              {roleMetrics.find((role) => role.value === item.role)?.count ?? 0}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <div style={fieldLabelStyle}>搜索成员</div>
          <Input.Search
            placeholder="手机号或姓名/昵称"
            value={keyword}
            onChange={(e) => handleSearch(e.target.value)}
            onSearch={handleSearch}
            style={{ width: 260 }}
            allowClear
          />
        </div>
        {canManageMembers && (
          <Space>
            <Button type="primary" icon={<UserAddOutlined />} onClick={() => { addForm.resetFields(); setAddOpen(true) }}>添加成员</Button>
          </Space>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={tableShellStyle}>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={filtered}
            size="small"
            scroll={{ x: 780 }}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            columns={[
              {
                title: '姓名/昵称',
                dataIndex: 'nickName',
                width: 140,
                render: (v: string | null) => <span style={{ color: '#0f172a', fontSize: 12, fontWeight: 500 }}>{v || '-'}</span>,
              },
              { title: '手机号', dataIndex: 'phone', width: 125, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{v}</span> },
              {
                title: '企业角色',
                dataIndex: 'enterpriseRole',
                width: 120,
                render: (v: string | null, row: EnterpriseMember) => {
                  const role = v || 'EMPLOYEE'
                  if (!canManageMembers || !currentUserId || row.id === currentUserId) {
                    return <Tag style={{ marginInlineEnd: 0 }}>{ROLE_LABEL[role] || role}</Tag>
                  }
                  return (
                    <Select
                      size="small"
                      value={role}
                      options={ROLE_OPTIONS}
                      style={{ width: 112 }}
                      showSearch
                      optionFilterProp="label"
                      onChange={(nextRole) => handleRoleChange(row.id, nextRole)}
                    />
                  )
                },
              },
              {
                title: '最近登录',
                dataIndex: 'lastLoginAt',
                width: 115,
                render: (v: string | null | undefined, row: MemberRow) => {
                  const value = v ?? row.lastLoginAt
                  return <span style={{ color: '#475569', fontSize: 12 }}>{value ? dayjs(value).format('MM-DD HH:mm') : '-'}</span>
                },
              },
              {
                title: '密码状态',
                dataIndex: 'passwordMustChange',
                width: 96,
                render: (v: boolean | undefined) => v
                  ? <Tag color="gold" style={{ marginInlineEnd: 0 }}>待修改</Tag>
                  : <Tag color="green" style={{ marginInlineEnd: 0 }}>正常</Tag>,
              },
              {
                title: '操作',
                width: 168,
                render: (_: unknown, row: EnterpriseMember) => (
                  <Space size={0} split={<span style={{ color: '#cbd5e1' }}>/</span>}>
                    {row.id === currentUserId && (
                      <Button size="small" type="link" onClick={() => { pwdForm.resetFields(); setChangePwdOpen(true) }}>改密</Button>
                    )}
                    {canManageMembers && row.id !== currentUserId && currentUserId && (
                      <Button
                        size="small"
                        type="link"
                        icon={<KeyOutlined />}
                        loading={resettingId === row.id}
                        onClick={() => handleResetPassword(row)}
                      >
                        重置密码
                      </Button>
                    )}
                    {canManageMembers && row.id !== currentUserId && currentUserId && (
                      <Popconfirm
                        title="确认移除该成员？"
                        okText="移除"
                        cancelText="取消"
                        onConfirm={() => handleRemove(row.id)}
                      >
                        <Button size="small" danger type="link" icon={<DeleteOutlined />}>移除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </div>
      </div>

      <Drawer
        title="添加成员"
        open={addOpen}
        width={360}
        onClose={() => { setAddOpen(false); addForm.resetFields() }}
        destroyOnHidden
      >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16, borderRadius: 6 }}
            message="新成员会生成 8 位临时密码，仅本次显示；成员首次登录后需修改密码。"
          />
          <Form form={addForm} layout="vertical" initialValues={{ enterpriseRole: 'EMPLOYEE' }}>
            <Form.Item
              name="phone"
              label="手机号"
              rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '手机号格式错误' },
              ]}
            >
              <Input placeholder="请输入手机号" />
            </Form.Item>
            <Form.Item name="name" label="姓名/昵称">
              <Input placeholder="选填，用于列表展示" />
            </Form.Item>
            <Form.Item
              name="enterpriseRole"
              label="角色"
              rules={[{ required: true, message: '请选择企业角色' }]}
            >
              <Select showSearch optionFilterProp="label" options={ROLE_OPTIONS} />
            </Form.Item>
            <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
              <Button autoInsertSpace={false} onClick={() => { setAddOpen(false); addForm.resetFields() }}>取消</Button>
              <Button autoInsertSpace={false} type="primary" onClick={handleAdd}>添加</Button>
            </Space>
          </Form>
      </Drawer>

      <Modal
        title={forceChangePassword ? '首次登录请修改密码' : '修改密码'}
        open={changePwdOpen}
        okText="确认修改"
        cancelText="取消"
        onOk={handleChangePwd}
        onCancel={() => {
          if (forceChangePassword) return
          setChangePwdOpen(false)
          pwdForm.resetFields()
        }}
        closable={!forceChangePassword}
        maskClosable={!forceChangePassword}
        cancelButtonProps={forceChangePassword ? { style: { display: 'none' } } : undefined}
      >
        {forceChangePassword && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16, borderRadius: 6 }}
            message="当前账号使用临时密码登录，请先修改密码后继续使用企业版。"
          />
        )}
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}>
            <Input.Password placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 6, message: '密码至少 6 位' }]}>
            <Input.Password placeholder="至少 6 位" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={temporaryPassword?.title || '临时密码'}
        open={!!temporaryPassword}
        okText="我已记录"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setTemporaryPassword(null)}
        onCancel={() => setTemporaryPassword(null)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16, borderRadius: 6 }}
          message="临时密码仅本次显示，请立即告知成员。成员首次登录后会被要求修改密码。"
        />
        <Input
          readOnly
          value={temporaryPassword?.value || ''}
          addonAfter={
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                if (!temporaryPassword?.value) return
                await navigator.clipboard?.writeText(temporaryPassword.value)
                message.success('已复制')
              }}
            />
          }
        />
        <Text type="secondary" style={{ display: 'block', marginTop: 10, fontSize: 12 }}>
          关闭后无法再次查看该明文密码，可通过“重置密码”重新生成。
        </Text>
      </Modal>
    </div>
  )
}
