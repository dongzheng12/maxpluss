/**
 * 管理后台 — 优惠券模板管理（阶段三）
 * 列表 / 创建 / 编辑（仅 status+description+validTo）/ 批量发券 / 查看已发 / 撤销
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, Modal, Form, Input, Select, DatePicker, InputNumber,
  Tag, Space, Typography, message, Popconfirm, Drawer, Descriptions,
} from 'antd'
import {
  TagOutlined, PlusOutlined, EditOutlined, SendOutlined, EyeOutlined,
  StopOutlined, ReloadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  adminListCoupons, adminCreateCoupon, adminUpdateCoupon,
  adminListGrants, adminIssueCouponBatch, adminRevokeUserCoupon,
  type AdminCoupon, type AdminGrant,
} from '../../../api/app'

const { Text } = Typography

const SCOPE_OPTIONS = [
  { value: 'ALL', label: '全场通用' },
  { value: 'MEMBERSHIP', label: '会员套餐（全部）' },
  { value: 'MEMBERSHIP_PERSONAL', label: '仅个人会员' },
  { value: 'MEMBERSHIP_PRO', label: '仅专业会员' },
  { value: 'STANDARD', label: '标准全库比对' },
]

function formatDiscount(c: AdminCoupon): string {
  if (c.discountType === 'FIXED') return `直减 ¥${(c.discountValue / 100).toFixed(2)}`
  const cap = c.maxDiscount ? `（封顶 ¥${(c.maxDiscount / 100).toFixed(0)}）` : ''
  return `${c.discountValue}% 折扣${cap}`
}

export default function AdminCouponsPage() {
  const [items, setItems] = useState<AdminCoupon[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<AdminCoupon | null>(null)
  const [issueTarget, setIssueTarget] = useState<AdminCoupon | null>(null)
  const [grantsTarget, setGrantsTarget] = useState<AdminCoupon | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await adminListCoupons()
      setItems(r.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggleStatus = async (c: AdminCoupon) => {
    try {
      await adminUpdateCoupon(c.id, { status: c.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })
      message.success(c.status === 'ACTIVE' ? '已禁用' : '已启用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
  }

  const columns = [
    { title: 'Code', dataIndex: 'code', key: 'code', render: (v: string) => <Text code>{v}</Text> },
    { title: '名称', dataIndex: 'name', key: 'name', ellipsis: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { title: '抵扣', key: 'discount', render: (_: any, c: AdminCoupon) => formatDiscount(c) },
    {
      title: '门槛',
      dataIndex: 'minAmount',
      key: 'minAmount',
      render: (v: number) => v > 0 ? `满 ¥${(v/100).toFixed(0)}` : '无门槛',
    },
    {
      title: '适用',
      dataIndex: 'applicableScope',
      key: 'applicableScope',
      render: (v: string) => SCOPE_OPTIONS.find(o => o.value === v)?.label || v,
    },
    {
      title: '有效期',
      key: 'validRange',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, c: AdminCoupon) => (
        <Text style={{ fontSize: 12 }}>
          {dayjs(c.validFrom).format('MM-DD')} ~ {dayjs(c.validTo).format('YYYY-MM-DD')}
        </Text>
      ),
    },
    {
      title: '配额',
      key: 'quota',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, c: AdminCoupon) => (
        <Text style={{ fontSize: 12 }}>
          {c.totalQuota == null ? `无限 / 已发 ${c.issuedCount}` : `${c.issuedCount} / ${c.totalQuota}`}
        </Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => (
        <Tag color={s === 'ACTIVE' ? 'green' : 'default'}>{s === 'ACTIVE' ? '启用' : '禁用'}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, c: AdminCoupon) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => setEditTarget(c)}>编辑</Button>
          <Button size="small" icon={<SendOutlined />} type="primary" disabled={c.status !== 'ACTIVE'} onClick={() => setIssueTarget(c)}>发券</Button>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setGrantsTarget(c)}>已发</Button>
          <Popconfirm
            title={c.status === 'ACTIVE' ? '禁用此券模板？' : '启用此券模板？'}
            onConfirm={() => handleToggleStatus(c)}
          >
            <Button size="small" icon={<StopOutlined />} danger={c.status === 'ACTIVE'}>
              {c.status === 'ACTIVE' ? '禁用' : '启用'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 16 }}>
      <Card
        title={<><TagOutlined /> 优惠券模板管理</>}
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建券模板</Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          columns={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            columns as any
          }
          dataSource={items}
          loading={loading}
          size="small"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <CreateCouponModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={() => { setCreateOpen(false); load() }}
      />

      <EditCouponModal
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSuccess={() => { setEditTarget(null); load() }}
      />

      <IssueCouponModal
        target={issueTarget}
        onClose={() => setIssueTarget(null)}
        onSuccess={() => { setIssueTarget(null); load() }}
      />

      <GrantsDrawer
        target={grantsTarget}
        onClose={() => setGrantsTarget(null)}
      />
    </div>
  )
}

// ─── 创建券模板 ─────────────────────────────────────
function CreateCouponModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    try {
      const v = await form.validateFields()
      setSubmitting(true)
      await adminCreateCoupon({
        code: v.code.toUpperCase(),
        name: v.name,
        description: v.description,
        discountType: v.discountType,
        discountValue: v.discountType === 'FIXED' ? v.discountValueYuan * 100 : v.discountValuePercent,
        minAmount: v.minAmountYuan ? v.minAmountYuan * 100 : 0,
        maxDiscount: v.maxDiscountYuan ? v.maxDiscountYuan * 100 : undefined,
        applicableScope: v.applicableScope,
        validFrom: v.validRange[0].toISOString(),
        validTo: v.validRange[1].toISOString(),
        totalQuota: v.totalQuota || undefined,
      })
      message.success('创建成功')
      form.resetFields()
      onSuccess()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return // form validation
      message.error(e?.response?.data?.error || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="创建券模板"
      open={open}
      onOk={handleSubmit}
      onCancel={onClose}
      confirmLoading={submitting}
      width={600}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ discountType: 'FIXED', applicableScope: 'MEMBERSHIP' }}>
        <Form.Item label="Code" name="code" rules={[{ required: true, pattern: /^[A-Z0-9_-]{2,32}$/i, message: '2-32 位大写字母/数字/-/_' }]}>
          <Input placeholder="例：NEW_USER_50" />
        </Form.Item>
        <Form.Item label="名称" name="name" rules={[{ required: true, max: 40 }]}>
          <Input placeholder="例：新用户专属 ¥50 直减券" />
        </Form.Item>
        <Form.Item label="描述（可选）" name="description" rules={[{ max: 200 }]}>
          <Input.TextArea rows={2} placeholder="展示给用户的说明文案" />
        </Form.Item>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item label="抵扣类型" name="discountType" rules={[{ required: true }]} style={{ width: 200 }}>
            <Select options={[{ value: 'FIXED', label: '固定金额' }, { value: 'PERCENT', label: '百分比' }]} />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => form.getFieldValue('discountType') === 'FIXED' ? (
              <Form.Item label="抵扣金额（元）" name="discountValueYuan" rules={[{ required: true }]} style={{ flex: 1, marginLeft: 12 }}>
                <InputNumber min={1} max={99999} style={{ width: '100%' }} addonAfter="元" />
              </Form.Item>
            ) : (
              <>
                <Form.Item label="折扣（%）" name="discountValuePercent" rules={[{ required: true, type: 'number', min: 1, max: 99 }]} style={{ flex: 1, marginLeft: 12 }}>
                  <InputNumber min={1} max={99} style={{ width: '100%' }} addonAfter="%" />
                </Form.Item>
                <Form.Item label="封顶（元，可选）" name="maxDiscountYuan" style={{ flex: 1, marginLeft: 12 }}>
                  <InputNumber min={1} style={{ width: '100%' }} addonAfter="元" />
                </Form.Item>
              </>
            )}
          </Form.Item>
        </Space.Compact>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item label="使用门槛（元，0 = 无门槛）" name="minAmountYuan" style={{ flex: 1 }}>
            <InputNumber min={0} style={{ width: '100%' }} addonAfter="元" />
          </Form.Item>
          <Form.Item label="总配额（留空 = 无限）" name="totalQuota" style={{ flex: 1, marginLeft: 12 }}>
            <InputNumber min={1} style={{ width: '100%' }} placeholder="无限" />
          </Form.Item>
        </Space.Compact>
        <Form.Item label="适用范围" name="applicableScope" rules={[{ required: true }]}>
          <Select options={SCOPE_OPTIONS} />
        </Form.Item>
        <Form.Item label="模板有效期" name="validRange" rules={[{ required: true }]}>
          <DatePicker.RangePicker showTime style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── 编辑券模板（仅 status / description / validTo）─────
function EditCouponModal({ target, onClose, onSuccess }: { target: AdminCoupon | null; onClose: () => void; onSuccess: () => void }) {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (target) {
      form.setFieldsValue({
        status: target.status,
        description: target.description || '',
        validTo: dayjs(target.validTo),
      })
    }
  }, [target, form])

  const handleSubmit = async () => {
    if (!target) return
    try {
      const v = await form.validateFields()
      setSubmitting(true)
      await adminUpdateCoupon(target.id, {
        status: v.status,
        description: v.description,
        validTo: v.validTo.toISOString(),
      })
      message.success('保存成功')
      onSuccess()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.error || '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title={`编辑：${target?.name || ''}`}
      open={!!target}
      onOk={handleSubmit}
      onCancel={onClose}
      confirmLoading={submitting}
      destroyOnHidden
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
        模板创建后，code / 抵扣 / 适用范围 / 配额不可改。仅可改状态、描述、过期时间。
      </Text>
      <Form form={form} layout="vertical">
        <Form.Item label="状态" name="status" rules={[{ required: true }]}>
          <Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'DISABLED', label: '禁用' }]} />
        </Form.Item>
        <Form.Item label="描述" name="description" rules={[{ max: 200 }]}>
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item label="过期时间（validTo）" name="validTo" rules={[{ required: true }]}>
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── 批量发券 ─────────────────────────────────────
function IssueCouponModal({ target, onClose, onSuccess }: { target: AdminCoupon | null; onClose: () => void; onSuccess: () => void }) {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ success: number; skipped: number; failed: number; errors: Array<{ userId: string; reason: string }> } | null>(null)

  const handleSubmit = async () => {
    if (!target) return
    try {
      const v = await form.validateFields()
      const userIds = v.userIds.split(/[\s,]+/).map((s: string) => s.trim()).filter(Boolean)
      if (userIds.length === 0) {
        message.warning('请至少输入一个 userId')
        return
      }
      if (userIds.length > 200) {
        message.warning('单次最多 200 个，请分批')
        return
      }
      setSubmitting(true)
      const r = await adminIssueCouponBatch(target.id, {
        userIds,
        expiresAt: v.expiresAt ? v.expiresAt.toISOString() : undefined,
      })
      setResult(r)
      message.success(`完成：成功 ${r.success} / 已存在 ${r.skipped} / 失败 ${r.failed}`)
      onSuccess()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e?.errorFields) return
      message.error(e?.response?.data?.error || '发券失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleClose = () => {
    setResult(null)
    form.resetFields()
    onClose()
  }

  return (
    <Modal
      title={`批量发券：${target?.name || ''}`}
      open={!!target}
      onOk={handleSubmit}
      onCancel={handleClose}
      confirmLoading={submitting}
      okText="发放"
      width={600}
      destroyOnHidden
    >
      {result ? (
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="成功">{result.success}</Descriptions.Item>
          <Descriptions.Item label="已存在（幂等跳过）">{result.skipped}</Descriptions.Item>
          <Descriptions.Item label="失败">{result.failed}</Descriptions.Item>
          {result.errors.length > 0 && (
            <Descriptions.Item label="失败详情">
              {result.errors.slice(0, 10).map((e, i) => (
                <div key={i} style={{ fontSize: 12 }}>
                  <Text code>{e.userId}</Text>: {e.reason}
                </div>
              ))}
              {result.errors.length > 10 && <Text type="secondary">…还有 {result.errors.length - 10} 条</Text>}
            </Descriptions.Item>
          )}
        </Descriptions>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Item label="用户 ID 列表（换行或逗号分隔，单次最多 200 个）" name="userIds" rules={[{ required: true }]}>
            <Input.TextArea rows={6} placeholder="user-id-1&#10;user-id-2&#10;..." />
          </Form.Item>
          <Form.Item label="自定义过期时间（可选，不填用模板 validTo）" name="expiresAt">
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>
            幂等保证：同一 (userId, couponId, ISSUED_ADMIN, batchId) 不重发。已有同 batch 的用户会跳过。
          </Text>
        </Form>
      )}
    </Modal>
  )
}

// ─── 已发券 Drawer ─────────────────────────────────────
function GrantsDrawer({ target, onClose }: { target: AdminCoupon | null; onClose: () => void }) {
  const [grants, setGrants] = useState<AdminGrant[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)

  const load = useCallback(async () => {
    if (!target) return
    setLoading(true)
    try {
      const r = await adminListGrants(target.id, statusFilter)
      setGrants(r.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [target, statusFilter])

  useEffect(() => { if (target) load() }, [target, load])

  const handleRevoke = async (uc: AdminGrant) => {
    const reason = prompt('撤销原因（必填）：')
    if (!reason) return
    try {
      await adminRevokeUserCoupon(uc.id, reason)
      message.success('已撤销')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '撤销失败')
    }
  }

  const cols = [
    { title: 'UserCoupon ID', dataIndex: 'id', key: 'id', render: (v: string) => <Text code style={{ fontSize: 11 }}>{v}</Text> },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { title: '用户', key: 'user', render: (_: any, g: AdminGrant) => g.user?.phone || g.user?.email || g.userId },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (s: string) => {
        const colorMap: Record<string, string> = { AVAILABLE: 'green', LOCKED: 'orange', USED: 'blue', EXPIRED: 'default', REVOKED: 'red' }
        return <Tag color={colorMap[s] || 'default'}>{s}</Tag>
      },
    },
    { title: '来源', dataIndex: 'source', key: 'source', render: (v: string) => <Text style={{ fontSize: 11 }}>{v}</Text> },
    { title: '领取时间', dataIndex: 'issuedAt', key: 'issuedAt', render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
    { title: '过期时间', dataIndex: 'expiresAt', key: 'expiresAt', render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    {
      title: '操作',
      key: 'op',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, g: AdminGrant) => (
        g.status === 'AVAILABLE' ? (
          <Button size="small" danger onClick={() => handleRevoke(g)}>撤销</Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 11 }}>—</Text>
        )
      ),
    },
  ]

  return (
    <Drawer
      title={`已发券：${target?.name || ''}（${grants.length}）`}
      open={!!target}
      onClose={onClose}
      width={900}
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 140 }}
            value={statusFilter}
            onChange={setStatusFilter}
            options={['AVAILABLE', 'LOCKED', 'USED', 'EXPIRED', 'REVOKED'].map(s => ({ value: s, label: s }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        columns={
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cols as any
        }
        dataSource={grants}
        loading={loading}
        size="small"
        pagination={{ pageSize: 50 }}
      />
    </Drawer>
  )
}
