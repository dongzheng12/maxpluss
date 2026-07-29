/**
 * 人员权限管理（v3 §6 列结构）
 *
 * 列：用户信息 / 账号身份 / 已分配角色 / 销售状态 / 后台状态 / 操作
 *
 * 销售状态三态：
 *   - 未开通：无 SalesProfile + 无销售角色
 *   - 已开通：有 SalesProfile（显示主推码）
 *   - 待初始化：有"销售"角色但 SalesProfile 缺失（点"立即初始化"修复）
 *
 * 接口（不变）：/api/admin/staff /search /set-admin /:id/unset-admin
 *              /:id/set-sales /:id/roles /:id/toggle
 *
 * v3 set-sales 重构后行为：
 *   - 调用即"分配销售角色 + ensure SalesProfile + 主推码"
 *   - 重复调用幂等（200 + created=false）
 *   - 不改 AppUser.role
 */
import { useEffect, useState } from 'react'
import {
  Table, Card, Typography, Button, Space, Tag, Drawer, Input, Form, message,
  Popconfirm, Select, Switch, Modal, Alert,
} from 'antd'
import { PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, UserAddOutlined, TeamOutlined, GiftOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import { useAuth } from '../../../contexts/AuthContext'

const { TextArea } = Input

interface BatchAssignResult {
  assigned: Array<{ id: string; phone: string; name: string | null; salesCode: string }>
  skipped: Array<{ id: string; phone: string; name: string | null; reason: string }>
  notFound: string[]
  invalid: string[]
  failed: Array<{ phone: string; reason: string }>
}

interface BatchIssueResult {
  batchId: string
  coupon: { id: string; code: string; name: string }
  issued: Array<{ id: string; phone: string; name: string | null }>
  skipped: Array<{ id: string; phone: string; name: string | null; reason: string }>
  notFound: string[]
  invalid: string[]
  failed: Array<{ phone: string; reason: string }>
}

interface CouponTemplate {
  id: string
  code: string
  name: string
  discountType: 'FIXED' | 'PERCENT'
  discountValue: number
  applicableScope: string
  validTo: string
}

const SCOPE_LABEL: Record<string, string> = {
  ALL: '全场通用',
  MEMBERSHIP: '会员套餐（全部）',
  MEMBERSHIP_PERSONAL: '仅个人会员',
  MEMBERSHIP_PRO: '仅专业会员',
  STANDARD: '标准全库比对',
}

function formatTplLabel(t: CouponTemplate): string {
  const amount = t.discountType === 'FIXED'
    ? `直减 ¥${(t.discountValue / 100).toFixed(0)}`
    : `${t.discountValue}% 折扣`
  const scope = SCOPE_LABEL[t.applicableScope] || t.applicableScope
  return `${t.name} · ${amount} · ${scope}`
}

const { Title, Text } = Typography

interface AdminRoleEntry { id: string; name: string; status: string; roleStatus: string }
interface StaffItem {
  id: string
  phone: string
  name: string | null
  role: 'admin' | 'sales' | 'user'
  createdAt: string
  salesProfile: { salesCode: string; status: string } | null
  adminRoles: AdminRoleEntry[]
}
interface RoleListItem { id: string; name: string; status: string }

const SALES_BUILT_IN_ROLE_NAME = '销售'

export default function AdminAdminsPage() {
  const { user } = useAuth()
  const [items, setItems] = useState<StaffItem[]>([])
  const [allRoles, setAllRoles] = useState<RoleListItem[]>([])
  const [loading, setLoading] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [searchPhone, setSearchPhone] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [foundUser, setFoundUser] = useState<any>(null)
  // 添加抽屉里：自定义角色多选（排除"销售"内置角色，销售走专属按钮）
  const [addRoleIds, setAddRoleIds] = useState<string[]>([])
  const [addRoleSubmitting, setAddRoleSubmitting] = useState(false)

  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTarget, setAssignTarget] = useState<StaffItem | null>(null)
  const [assignRoleIds, setAssignRoleIds] = useState<string[]>([])

  const [salesOpen, setSalesOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [salesTarget, setSalesTarget] = useState<any>(null)
  const [salesForm] = Form.useForm()

  // 批量分配角色（仅 sales）
  const [batchAssignOpen, setBatchAssignOpen] = useState(false)
  const [batchAssignPhones, setBatchAssignPhones] = useState('')
  const [batchAssignSubmitting, setBatchAssignSubmitting] = useState(false)
  const [batchAssignResult, setBatchAssignResult] = useState<BatchAssignResult | null>(null)

  // 手动下发优惠券
  const [batchIssueOpen, setBatchIssueOpen] = useState(false)
  const [batchIssuePhones, setBatchIssuePhones] = useState('')
  const [batchIssueCouponId, setBatchIssueCouponId] = useState<string | undefined>(undefined)
  const [batchIssueSubmitting, setBatchIssueSubmitting] = useState(false)
  const [couponTemplates, setCouponTemplates] = useState<CouponTemplate[]>([])
  const [batchIssueResult, setBatchIssueResult] = useState<BatchIssueResult | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [staffRes, rolesRes]: any = await Promise.all([
        nodeApi.get('/api/admin/staff'),
        nodeApi.get('/api/admin/roles'),
      ])
      setItems(staffRes?.items || [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setAllRoles((rolesRes?.items || []).filter((r: any) => r.status === 'ACTIVE'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  // ── 工具：是否拥有销售身份的"角色"信号（与后端三信号判断的角色信号一致）
  const hasSalesRoleAssigned = (r: StaffItem) =>
    r.adminRoles.some((ar) => ar.name === SALES_BUILT_IN_ROLE_NAME && ar.status === 'ACTIVE' && ar.roleStatus === 'ACTIVE')

  // ── 销售状态三态
  const salesStatus = (r: StaffItem): { tone: 'normal' | 'ready' | 'pending'; label: string; salesCode?: string } => {
    if (r.salesProfile) {
      return { tone: 'ready', label: '已开通', salesCode: r.salesProfile.salesCode }
    }
    if (hasSalesRoleAssigned(r)) {
      return { tone: 'pending', label: '待初始化' }
    }
    return { tone: 'normal', label: '未开通' }
  }

  // ─── 批量分配销售角色 ─────────────────────────────────
  const openBatchAssign = () => {
    setBatchAssignPhones('')
    setBatchAssignResult(null)
    setBatchAssignOpen(true)
  }

  const submitBatchAssign = async () => {
    const phones = batchAssignPhones.split(/[\s,;\n\r\t]+/).map(s => s.trim()).filter(Boolean)
    if (phones.length === 0) {
      message.warning('请输入至少一个手机号')
      return
    }
    if (phones.length > 100) {
      message.warning('一次最多 100 个手机号')
      return
    }
    setBatchAssignSubmitting(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/roles/batch-assign', {
        phones,
        roleType: 'sales',
      })
      setBatchAssignResult(res)
      message.success(`处理完成：成功 ${res.assigned?.length || 0} 个`)
      // 列表刷新（销售档案/角色变更）
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '批量分配失败')
    }
    setBatchAssignSubmitting(false)
  }

  // ─── 手动下发优惠券 ───────────────────────────────────
  const openBatchIssue = async () => {
    setBatchIssuePhones('')
    setBatchIssueCouponId(undefined)
    setBatchIssueResult(null)
    setBatchIssueOpen(true)
    // 拉模板（每次打开重拉，确保最新）
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/coupons/templates')
      setCouponTemplates(res?.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载券模板失败')
    }
  }

  const submitBatchIssue = async () => {
    const phones = batchIssuePhones.split(/[\s,;\n\r\t]+/).map(s => s.trim()).filter(Boolean)
    if (phones.length === 0) {
      message.warning('请输入至少一个手机号')
      return
    }
    if (phones.length > 100) {
      message.warning('一次最多 100 个手机号')
      return
    }
    if (!batchIssueCouponId) {
      message.warning('请选择优惠券模板')
      return
    }
    setBatchIssueSubmitting(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/coupons/batch-issue', {
        phones,
        couponId: batchIssueCouponId,
      })
      setBatchIssueResult(res)
      message.success(`处理完成：发放 ${res.issued?.length || 0} 张`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '批量发券失败')
    }
    setBatchIssueSubmitting(false)
  }

  const handleSearch = async () => {
    if (!/^1[3-9]\d{9}$/.test(searchPhone.trim())) {
      message.warning('请输入有效手机号')
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/staff/search?phone=${searchPhone.trim()}`)
      const u = res?.user || null
      setFoundUser(u)
      // 初始化抽屉里的角色多选：已分配的非"销售"内置角色 id
      const preset: string[] = (u?.adminRoles || [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((ar: any) => ar.name !== SALES_BUILT_IN_ROLE_NAME)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((ar: any) => ar.id)
      setAddRoleIds(preset)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      setFoundUser(null)
      setAddRoleIds([])
      message.error(e?.response?.data?.error || '未找到用户')
    }
  }

  // 添加抽屉「保存角色分配」：保留用户现有销售内置角色，把选中的自定义角色合入
  const submitAddRoles = async () => {
    if (!foundUser) return
    setAddRoleSubmitting(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const salesRoleId = (foundUser.adminRoles || []).find((ar: any) => ar.name === SALES_BUILT_IN_ROLE_NAME)?.id
      const finalIds = salesRoleId ? Array.from(new Set([salesRoleId, ...addRoleIds])) : addRoleIds
      await nodeApi.patch(`/api/admin/staff/${foundUser.id}/roles`, { roleIds: finalIds })
      message.success('角色已分配')
      setAddOpen(false); setFoundUser(null); setSearchPhone(''); setAddRoleIds([]); load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '分配失败')
    }
    setAddRoleSubmitting(false)
  }

  const handleSetAdmin = async (phone: string) => {
    try {
      await nodeApi.post('/api/admin/staff/set-admin', { phone })
      message.success('已设为超级管理员')
      setAddOpen(false); setFoundUser(null); setSearchPhone(''); load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  const handleUnsetAdmin = async (id: string) => {
    try {
      await nodeApi.delete(`/api/admin/staff/${id}/unset-admin`)
      message.success('已移除超级管理员')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openSetSales = (u: any) => {
    setSalesTarget(u); salesForm.resetFields(); setSalesOpen(true)
  }
  const submitSetSales = async () => {
    try {
      const values = await salesForm.validateFields()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post(`/api/admin/staff/${salesTarget.id}/set-sales`, values)
      if (res?.created === false) {
        message.success(`销售档案已存在（主推码 ${res.salesCode}），仅补齐角色分配`)
      } else {
        message.success(`已开通销售身份，主推码 ${res.salesCode}`)
      }
      setSalesOpen(false); setAddOpen(false); setFoundUser(null); setSearchPhone(''); load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.error || '操作失败')
    }
  }

  // ── 列表内"立即初始化"销售档案：直接调 set-sales（幂等）
  const initSalesProfile = async (r: StaffItem) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post(`/api/admin/staff/${r.id}/set-sales`, { realName: r.name || '销售' })
      message.success(`已初始化销售档案，主推码 ${res.salesCode}`)
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '初始化失败')
    }
  }

  const openAssign = (item: StaffItem) => {
    setAssignTarget(item)
    setAssignRoleIds(item.adminRoles.map((r) => r.id))
    setAssignOpen(true)
  }
  const submitAssign = async () => {
    if (!assignTarget) return
    try {
      await nodeApi.patch(`/api/admin/staff/${assignTarget.id}/roles`, { roleIds: assignRoleIds })
      message.success('角色已更新')
      setAssignOpen(false); load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  const handleToggle = async (id: string, active: boolean) => {
    try {
      await nodeApi.patch(`/api/admin/staff/${id}/toggle`, { active })
      message.success(active ? '已启用' : '已停用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  const columns = [
    {
      title: '用户信息', key: 'identity',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => (
        <div>
          <div>{r.name || <Text type="secondary">未填</Text>}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.phone}</Text>
        </div>
      ),
    },
    {
      title: '账号身份', key: 'identityType',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => r.role === 'admin'
        ? <Tag color="blue">超级管理员</Tag>
        : <Tag>普通用户</Tag>,
    },
    {
      title: '已分配角色', key: 'adminRoles',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => r.adminRoles.length === 0
        ? <Text type="secondary">—</Text>
        : <Space wrap>{r.adminRoles.map((ar) => {
            const isSales = ar.name === SALES_BUILT_IN_ROLE_NAME
            const inactive = ar.status !== 'ACTIVE' || ar.roleStatus !== 'ACTIVE'
            return (
              <Tag key={ar.id} color={inactive ? 'default' : (isSales ? 'green' : 'cyan')}>
                {ar.name}{inactive ? ' (停用)' : ''}
              </Tag>
            )
          })}</Space>,
    },
    {
      title: '销售状态', key: 'salesStatus',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => {
        const s = salesStatus(r)
        if (s.tone === 'ready') {
          return <Tag color="green">已开通 · {s.salesCode}</Tag>
        }
        if (s.tone === 'pending') {
          return (
            <Space size="small">
              <Tag color="orange">待初始化</Tag>
              <Button size="small" onClick={() => initSalesProfile(r)}>立即初始化</Button>
            </Space>
          )
        }
        return <Text type="secondary">未开通</Text>
      },
    },
    {
      title: '后台状态', key: 'staffStatus',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => {
        if (r.role === 'admin') return <Text type="secondary">超管（不停用）</Text>
        if (r.adminRoles.length === 0) return <Text type="secondary">—</Text>
        const allActive = r.adminRoles.every((ar) => ar.status === 'ACTIVE')
        return (
          <Switch
            checked={allActive}
            checkedChildren="启用"
            unCheckedChildren="停用"
            onChange={(v) => handleToggle(r.id, v)}
            disabled={r.id === user?.id}
          />
        )
      },
    },
    {
      title: '操作', key: 'actions',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: StaffItem) => (
        <Space size="small">
          <Button size="small" onClick={() => openAssign(r)}>分配角色</Button>
          {r.role !== 'admin' && (
            <Popconfirm title="确认提升为超级管理员？" onConfirm={() => handleSetAdmin(r.phone)}>
              <Button size="small">设为超管</Button>
            </Popconfirm>
          )}
          {r.role === 'admin' && r.id !== user?.id && (
            <Popconfirm title="确认移除该用户的超级管理员？" onConfirm={() => handleUnsetAdmin(r.id)}>
              <Button size="small" danger>移除超管</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Title level={4}>人员权限管理</Title>
      <Card>
        <Space style={{ marginBottom: 16 }} wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>添加管理人员</Button>
          <Button icon={<TeamOutlined />} onClick={openBatchAssign}>批量分配角色</Button>
          <Button icon={<GiftOutlined />} onClick={openBatchIssue}>手动下发优惠券</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Table rowKey="id" dataSource={items} columns={columns as any} loading={loading} pagination={false} />
      </Card>

      {/* 添加管理人员 Drawer */}
      <Drawer
        title="添加管理人员"
        open={addOpen}
        onClose={() => { setAddOpen(false); setFoundUser(null); setSearchPhone('') }}
        width={420}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Text>按手机号查找已注册用户：</Text>
            <Space.Compact style={{ width: '100%', marginTop: 8 }}>
              <Input placeholder="手机号" value={searchPhone}
                onChange={(e) => setSearchPhone(e.target.value)} onPressEnter={handleSearch} />
              <Button type="primary" onClick={handleSearch}>查找</Button>
            </Space.Compact>
            <Text type="secondary" style={{ fontSize: 12 }}>
              人员管理只针对已注册用户；未注册手机号请先让用户自行注册。
            </Text>
          </div>
          {foundUser && (
            <Card size="small">
              <Space direction="vertical" style={{ width: '100%' }}>
                <div><Text strong>{foundUser.name || '未填姓名'}</Text> · {foundUser.phone}</div>
                <Space wrap>
                  <Tag color={foundUser.role === 'admin' ? 'blue' : 'default'}>
                    {foundUser.role === 'admin' ? '已是超级管理员' : '普通用户'}
                  </Tag>
                  {foundUser.salesProfile && (
                    <Tag color="green">销售 · {foundUser.salesProfile.salesCode}</Tag>
                  )}
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {(foundUser.adminRoles || []).map((ar: any) => {
                    const inactive = ar.status !== 'ACTIVE' || ar.roleStatus !== 'ACTIVE'
                    const isSales = ar.name === SALES_BUILT_IN_ROLE_NAME
                    return (
                      <Tag key={ar.id} color={inactive ? 'default' : (isSales ? 'green' : 'cyan')}>
                        {ar.name}{inactive ? ' (停用)' : ''}
                      </Tag>
                    )
                  })}
                </Space>
                <Space wrap>
                  {foundUser.role !== 'admin' && (
                    <Popconfirm title="确认提升为超级管理员？" onConfirm={() => handleSetAdmin(foundUser.phone)}>
                      <Button type="primary" icon={<SafetyCertificateOutlined />}>设为超级管理员</Button>
                    </Popconfirm>
                  )}
                  {foundUser.role !== 'admin' && (
                    <Button icon={<UserAddOutlined />} onClick={() => openSetSales(foundUser)}>开通销售身份</Button>
                  )}
                </Space>

                {/* 自定义角色分配（排除"销售"内置角色：走专属按钮） */}
                <div>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>分配自定义角色</Text>
                  <Select
                    mode="multiple"
                    style={{ width: '100%' }}
                    placeholder={allRoles.filter(r => r.name !== SALES_BUILT_IN_ROLE_NAME).length === 0
                      ? '暂无可选自定义角色（请先去【角色管理】创建）'
                      : '选择角色（多选）'}
                    value={addRoleIds}
                    onChange={setAddRoleIds}
                    options={allRoles
                      .filter(r => r.name !== SALES_BUILT_IN_ROLE_NAME)
                      .map(r => ({ value: r.id, label: r.name }))}
                  />
                  <Space style={{ marginTop: 8 }}>
                    <Button type="primary" loading={addRoleSubmitting} onClick={submitAddRoles}>
                      保存角色分配
                    </Button>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                    全量替换该用户的自定义角色列表；已有的「销售」内置角色会自动保留。
                  </Text>
                </div>
              </Space>
            </Card>
          )}
        </Space>
      </Drawer>

      {/* 开通销售身份 Drawer */}
      <Drawer
        title={`开通销售身份：${salesTarget?.phone || ''}`}
        open={salesOpen}
        onClose={() => setSalesOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setSalesOpen(false)}>取消</Button>
            <Button type="primary" onClick={submitSetSales}>确认</Button>
          </Space>
        }
      >
        <Form layout="vertical" form={salesForm}>
          <Form.Item label="销售姓名" name="realName" rules={[{ required: true, max: 40 }]}>
            <Input placeholder="对外展示姓名" />
          </Form.Item>
          <Form.Item label="所属公司/部门" name="companyName">
            <Input placeholder="选填" />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ fontSize: 12 }}>
          系统将自动分配"销售"内置角色，并 ensure SalesProfile + 主推码（幂等）。
        </Text>
      </Drawer>

      {/* 分配角色 Drawer */}
      <Drawer
        title={`分配角色：${assignTarget?.name || assignTarget?.phone || ''}`}
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setAssignOpen(false)}>取消</Button>
            <Button type="primary" onClick={submitAssign}>保存</Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text>选择此人持有的角色（多选，全量替换）：</Text>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="选择角色"
            value={assignRoleIds}
            onChange={setAssignRoleIds}
            options={allRoles.map((r) => ({ value: r.id, label: r.name }))}
          />
          {allRoles.length === 0 && (
            <Text type="warning">还没有任何 ACTIVE 角色，请先去"角色管理"创建角色</Text>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            本 Drawer 仅分配角色。如要为分配了"销售"角色的用户初始化档案，请回列表点"立即初始化"。
          </Text>
        </Space>
      </Drawer>

      {/* 批量分配角色 Modal（本期仅销售） */}
      <Modal
        title="批量分配销售角色"
        open={batchAssignOpen}
        onCancel={() => setBatchAssignOpen(false)}
        width={640}
        footer={
          <Space>
            <Button onClick={() => setBatchAssignOpen(false)}>关闭</Button>
            <Button type="primary" loading={batchAssignSubmitting} onClick={submitBatchAssign}>
              确认分配
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="本期仅支持批量分配「销售」角色，最多 100 个手机号；未注册手机号不会自动建用户。"
          />
          <div>
            <Text strong>手机号列表（多行 / 逗号 / 空格分隔）：</Text>
            <TextArea
              rows={8}
              value={batchAssignPhones}
              onChange={(e) => setBatchAssignPhones(e.target.value)}
              placeholder={'13800000001\n13800000002\n13800000003'}
              style={{ marginTop: 8 }}
            />
          </div>
          <BatchResultPanel
            assigned={batchAssignResult ? batchAssignResult.assigned.map(a => ({ phone: a.phone, name: a.name, extra: `推广码 ${a.salesCode}` })) : null}
            assignedTitle="✅ 成功"
            skipped={batchAssignResult?.skipped.map(s => ({ phone: s.phone, name: s.name, extra: s.reason })) || null}
            notFound={batchAssignResult?.notFound || null}
            invalid={batchAssignResult?.invalid || null}
            failed={batchAssignResult?.failed || null}
          />
        </Space>
      </Modal>

      {/* 手动下发优惠券 Modal */}
      <Modal
        title="手动下发优惠券"
        open={batchIssueOpen}
        onCancel={() => setBatchIssueOpen(false)}
        width={640}
        footer={
          <Space>
            <Button onClick={() => setBatchIssueOpen(false)}>关闭</Button>
            <Button type="primary" loading={batchIssueSubmitting} onClick={submitBatchIssue}>
              确认下发
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Text strong>选择优惠券模板：</Text>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="请选择 ACTIVE 模板"
              style={{ width: '100%', marginTop: 8 }}
              value={batchIssueCouponId}
              onChange={setBatchIssueCouponId}
              options={couponTemplates.map((t) => ({
                value: t.id,
                label: formatTplLabel(t),
              }))}
              notFoundContent={couponTemplates.length === 0 ? '暂无 ACTIVE 模板' : undefined}
            />
            {batchIssueCouponId && (() => {
              const t = couponTemplates.find(x => x.id === batchIssueCouponId)
              if (!t) return null
              return (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  有效期至 {new Date(t.validTo).toLocaleDateString('zh-CN')}
                </Text>
              )
            })()}
          </div>
          <Alert
            type="info"
            showIcon
            message="发券对象为已注册用户；同一用户已持有该券（AVAILABLE）将跳过；最多 100 个手机号。"
          />
          <div>
            <Text strong>手机号列表（多行 / 逗号 / 空格分隔）：</Text>
            <TextArea
              rows={8}
              value={batchIssuePhones}
              onChange={(e) => setBatchIssuePhones(e.target.value)}
              placeholder={'13800000001\n13800000002\n13800000003'}
              style={{ marginTop: 8 }}
            />
          </div>
          <BatchResultPanel
            assigned={batchIssueResult ? batchIssueResult.issued.map(i => ({ phone: i.phone, name: i.name })) : null}
            assignedTitle="✅ 已发放"
            skipped={batchIssueResult?.skipped.map(s => ({ phone: s.phone, name: s.name, extra: s.reason })) || null}
            notFound={batchIssueResult?.notFound || null}
            invalid={batchIssueResult?.invalid || null}
            failed={batchIssueResult?.failed || null}
          />
        </Space>
      </Modal>
    </div>
  )
}

// ─── 批量结果展示组件（assigned/skipped/notFound/invalid/failed 五分组）
function BatchResultPanel(props: {
  assigned: Array<{ phone: string; name: string | null; extra?: string }> | null
  assignedTitle: string
  skipped: Array<{ phone: string; name: string | null; extra: string }> | null
  notFound: string[] | null
  invalid: string[] | null
  failed: Array<{ phone: string; reason: string }> | null
}) {
  if (!props.assigned && !props.skipped && !props.notFound && !props.invalid && !props.failed) {
    return null
  }
  const renderUserList = (
    items: Array<{ phone: string; name: string | null; extra?: string }>,
  ) => (
    <div style={{ fontSize: 12, color: '#595959', maxHeight: 120, overflow: 'auto' }}>
      {items.map((u, i) => (
        <div key={i}>
          {u.phone}{u.name ? `（${u.name}）` : ''}{u.extra ? ` — ${u.extra}` : ''}
        </div>
      ))}
    </div>
  )
  return (
    <Card size="small" style={{ background: '#fafafa' }}>
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        {props.assigned && props.assigned.length > 0 && (
          <div>
            <Text strong>{props.assignedTitle}（{props.assigned.length}）</Text>
            {renderUserList(props.assigned)}
          </div>
        )}
        {props.skipped && props.skipped.length > 0 && (
          <div>
            <Text strong style={{ color: '#d48806' }}>⊘ 已跳过（{props.skipped.length}）</Text>
            {renderUserList(props.skipped)}
          </div>
        )}
        {props.notFound && props.notFound.length > 0 && (
          <div>
            <Text strong type="secondary">⚠️ 未注册手机号（{props.notFound.length}）</Text>
            <div style={{ fontSize: 12, color: '#8c8c8c', maxHeight: 80, overflow: 'auto' }}>
              {props.notFound.join('、')}
            </div>
          </div>
        )}
        {props.invalid && props.invalid.length > 0 && (
          <div>
            <Text strong type="danger">✗ 格式不合法（{props.invalid.length}）</Text>
            <div style={{ fontSize: 12, color: '#cf1322', maxHeight: 80, overflow: 'auto' }}>
              {props.invalid.join('、')}
            </div>
          </div>
        )}
        {props.failed && props.failed.length > 0 && (
          <div>
            <Text strong type="danger">✗ 失败（{props.failed.length}）</Text>
            <div style={{ fontSize: 12, color: '#cf1322', maxHeight: 80, overflow: 'auto' }}>
              {props.failed.map((f, i) => (
                <div key={i}>{f.phone} — {f.reason}</div>
              ))}
            </div>
          </div>
        )}
      </Space>
    </Card>
  )
}
