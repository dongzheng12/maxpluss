/**
 * 管理后台 — 销售推广管理
 * 列表 + 新增 / 编辑 / 停用 / 复制链接 / 预览 / 统计
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Card, Table, Button, Modal, Form, Input, Select, Space, Tag, Typography,
  message, Popconfirm, Row, Col, Statistic, Checkbox,
  Alert, Switch, Tabs, Upload, Drawer, Descriptions, Tooltip,
} from 'antd'
import SalesInvites from './SalesInvites'
import type { UploadFile } from 'antd/es/upload/interface'
import {
  PlusOutlined, StopOutlined, CheckOutlined,
  CopyOutlined, EyeOutlined, UploadOutlined, DownloadOutlined, DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const STATUS_TAG: Record<string, { label: string; color: string }> = {
  ENABLED: { label: '已启用', color: 'success' },
  DISABLED: { label: '已停用', color: 'default' },
}

interface SalesItem {
  id: string
  salesCode: string
  realName: string
  companyName: string | null
  positionTitle: string | null
  avatar: string | null
  bio: string | null
  wechat: string | null
  phone: string | null
  qrcode: string | null
  contactVisible: boolean
  displayProducts: Array<{ code: string; sort: number }>
  status: string
  createdAt: string
  stats: {
    registerCount: number
    paidCount: number
    paidAmount: number
    lastRegisterAt: string | null
    lastPaidAt: string | null
  }
}

const PRODUCT_OPTIONS = [
  { code: 'xiaozhi', name: '标准小智AI' },
  { code: 'guan', name: '标准管理' },
  { code: 'bian', name: '标准编写' },
  { code: 'kong', name: '标准监测' },
]

export default function AdminSalesPage() {
  const [items, setItems] = useState<SalesItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [createForm] = Form.useForm()
  const [importOpen, setImportOpen] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importFile, setImportFile] = useState<UploadFile | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [importResult, setImportResult] = useState<any>(null)
  // P1-B 详情侧抽屉
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailItem, setDetailItem] = useState<SalesItem | null>(null)
  const [detailTab, setDetailTab] = useState<'registrations' | 'orders'>('registrations')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detailRegs, setDetailRegs] = useState<{ total: number; items: any[] }>({ total: 0, items: [] })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detailOrders, setDetailOrders] = useState<{ total: number; items: any[] }>({ total: 0, items: [] })
  const [detailLoading, setDetailLoading] = useState(false)
  // P1-B 创建表单 phone 实时检查
  const [phoneCheck, setPhoneCheck] = useState<{ exists: boolean; role: string | null; hasSalesProfile: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = { page: String(page), pageSize: '20' }
      if (keyword) params.keyword = keyword
      if (statusFilter) params.status = statusFilter
      const qs = new URLSearchParams(params).toString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/sales?${qs}`)
      setItems(res.items || [])
      setTotal(res.total || 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }, [page, keyword, statusFilter])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCreate = async (values: any) => {
    setCreateLoading(true)
    try {
      const body = {
        phone: values.phone,
        password: values.password,
        realName: values.realName,
        companyName: values.companyName || undefined,
        positionTitle: values.positionTitle || undefined,
        bio: values.bio || undefined,
        wechat: values.wechat || undefined,
        contactPhone: values.contactPhone || values.phone,
        contactVisible: values.contactVisible !== false,
        displayProducts: (values.displayProducts || []).map((code: string, i: number) => ({ code, sort: i + 1 })),
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/sales', body)
      message.success(`销售主页已创建，salesCode = ${res.salesCode}`)
      setCreateOpen(false)
      createForm.resetFields()
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '创建失败')
    }
    setCreateLoading(false)
  }

  const handleToggleStatus = async (item: SalesItem) => {
    const next = item.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'
    try {
      await nodeApi.patch(`/api/admin/sales/${item.id}/status`, { status: next })
      message.success(next === 'DISABLED' ? '已停用' : '已启用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
  }

  // P1-B：打开销售详情 Drawer，并发拉 registrations / orders
  const openDetail = async (item: SalesItem) => {
    setDetailItem(item)
    setDetailOpen(true)
    setDetailTab('registrations')
    setDetailLoading(true)
    try {
      const [regs, orders] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeApi.get(`/api/admin/sales/${item.id}/registrations?page=1&pageSize=20`) as Promise<any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        nodeApi.get(`/api/admin/sales/${item.id}/orders?page=1&pageSize=20`) as Promise<any>,
      ])
      setDetailRegs({ total: regs.total, items: regs.items })
      setDetailOrders({ total: orders.total, items: orders.items })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '详情加载失败')
    }
    setDetailLoading(false)
  }

  // P1-B：phone 实时检查（创建表单 onBlur 调用）
  const handlePhoneCheck = async (phone: string) => {
    if (!/^1[3-9]\d{9}$/.test(phone)) { setPhoneCheck(null); return }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/sales/check-phone?phone=${phone}`)
      setPhoneCheck(res)
    } catch {
      setPhoneCheck(null)
    }
  }

  const handleDelete = async (item: SalesItem) => {
    try {
      await nodeApi.delete(`/api/admin/sales/${item.id}`)
      message.success('已删除')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '删除失败')
    }
  }

  const handleImport = async () => {
    if (!importFile) { message.error('请先选择 CSV 文件'); return }
    setImportLoading(true)
    setImportResult(null)
    try {
      const formData = new FormData()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formData.append('file', importFile as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/sales/import', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setImportResult(res)
      message.success(`导入完成：成功 ${res.success} / 跳过 ${res.skipped} / 失败 ${res.failed}`)
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '导入失败')
    }
    setImportLoading(false)
  }

  const landingUrl = (code: string) => `${window.location.origin}/s/${code}`

  const columns = [
    {
      title: '销售',
      key: 'sales',
      width: 220,
      ellipsis: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <div style={{ overflow: 'hidden' }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <Text strong>{r.realName}</Text>
          </div>
          {r.companyName && (
            <Tooltip title={r.companyName} placement="topLeft">
              <Text type="secondary" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.companyName}
              </Text>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: 'salesCode',
      dataIndex: 'salesCode',
      key: 'salesCode',
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: '专属链接',
      key: 'link',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(landingUrl(r.salesCode))
              message.success('已复制')
            }}
          >复制</Button>
          <Button
            size="small"
            type="link"
            icon={<EyeOutlined />}
            onClick={() => window.open(landingUrl(r.salesCode), '_blank')}
          >预览</Button>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        const cfg = STATUS_TAG[v] || { label: v, color: 'default' }
        return <Tag color={cfg.color}>{cfg.label}</Tag>
      },
    },
    {
      title: '注册数',
      key: 'registerCount',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <div>
          <Text strong>{r.stats.registerCount}</Text>
          {r.stats.lastRegisterAt && (
            <div style={{ fontSize: 11, color: '#8c9bac' }}>
              {dayjs(r.stats.lastRegisterAt).format('MM-DD HH:mm')}
            </div>
          )}
        </div>
      ),
    },
    {
      title: '付费人数',
      key: 'paidCount',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <div>
          <Text strong style={{ color: '#1677ff' }}>{r.stats.paidCount}</Text>
        </div>
      ),
    },
    {
      title: '付费金额',
      key: 'paidAmount',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <div>
          <Text strong style={{ color: '#52c41a' }}>
            ¥{(r.stats.paidAmount / 100).toFixed(2)}
          </Text>
          {r.stats.lastPaidAt && (
            <div style={{ fontSize: 11, color: '#8c9bac' }}>
              {dayjs(r.stats.lastPaidAt).format('MM-DD HH:mm')}
            </div>
          )}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'action',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesItem) => (
        <Space size={4} wrap>
          <Button size="small" icon={<EyeOutlined />} onClick={() => window.open(`/s/${r.salesCode}`, '_blank')}>
            主页
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openDetail(r)}>
            详情
          </Button>
          <Popconfirm
            title={r.status === 'ENABLED' ? '确定停用？停用后链接对外失效' : '确定启用？'}
            onConfirm={() => handleToggleStatus(r)}
            okText="确定"
            cancelText="取消"
          >
            <Button size="small" danger={r.status === 'ENABLED'} icon={r.status === 'ENABLED' ? <StopOutlined /> : <CheckOutlined />}>
              {r.status === 'ENABLED' ? '停用' : '启用'}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={
              <div>
                <div>确定删除「{r.realName}」？</div>
                <div style={{ fontSize: 12, color: '#8c9bac', marginTop: 4 }}>
                  有业务数据时将停用并存档；无业务数据时永久删除
                </div>
              </div>
            }
            onConfirm={() => handleDelete(r)}
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 概览统计（当前页聚合）
  const totalRegister = items.reduce((s, i) => s + i.stats.registerCount, 0)
  const totalAmount = items.reduce((s, i) => s + i.stats.paidAmount, 0)

  return (
    <div>
      <Title level={3}>销售推广管理</Title>
      <Tabs
        defaultActiveKey="list"
        items={[
          {
            key: 'list',
            label: '销售列表',
            children: (
              <div>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col xs={8}><Card size="small"><Statistic title="销售数" value={total} /></Card></Col>
        <Col xs={8}><Card size="small"><Statistic title="当页注册数合计" value={totalRegister} /></Card></Col>
        <Col xs={8}><Card size="small"><Statistic title="当页付费金额合计" value={(totalAmount/100).toFixed(2)} prefix="¥" /></Card></Col>
      </Row>

      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Input.Search
            placeholder="姓名 / salesCode / 手机号"
            allowClear
            onSearch={(v) => { setKeyword(v); setPage(1) }}
            style={{ width: 260 }}
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 120 }}
            onChange={(v) => { setStatusFilter(v || ''); setPage(1) }}
            options={[
              { label: '已启用', value: 'ENABLED' },
              { label: '已停用', value: 'DISABLED' },
            ]}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新增销售
          </Button>
          <Button icon={<UploadOutlined />} onClick={() => {
            setImportFile(null); setImportResult(null); setImportOpen(true)
          }}>
            批量导入
          </Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={async () => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const resp = await nodeApi.get('/api/admin/sales/template', { responseType: 'blob' }) as any
                const blob = new Blob([resp], { type: 'text/csv;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url; a.download = 'sales_import_template.csv'
                a.click()
                URL.revokeObjectURL(url)
              } catch {
                message.error('模板下载失败')
              }
            }}
          >
            下载模板
          </Button>
        </Space>

        <Table
          rowKey="id"
          dataSource={items}
          columns={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            columns as any
          }
          loading={loading}
          pagination={{
            current: page, pageSize: 20, total, onChange: setPage, showSizeChanger: false,
          }}
          scroll={{ x: 1000 }}
        />
      </Card>

      {/* 创建弹窗 */}
      <Modal
        open={createOpen}
        title="新增销售"
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        footer={null}
        width={560}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="登录手机号" name="phone" rules={[
                { required: true, message: '请输入手机号' },
                { pattern: /^1[3-9]\d{9}$/, message: '手机号格式错误' },
              ]}>
                <Input
                  placeholder="销售登录用"
                  onBlur={(e) => handlePhoneCheck(e.target.value.trim())}
                />
              </Form.Item>
              {phoneCheck && (
                <div style={{ marginTop: -16, marginBottom: 12, fontSize: 12 }}>
                  {!phoneCheck.exists && <Text type="success">✓ 新账号，下方密码必填</Text>}
                  {phoneCheck.exists && phoneCheck.role === 'user' && !phoneCheck.hasSalesProfile && (
                    <Text style={{ color: '#1677ff' }}>ℹ 已有账号，绑定后自动升级为销售；密码可留空</Text>
                  )}
                  {phoneCheck.exists && phoneCheck.role === 'admin' && (
                    <Text type="danger">✗ 该号码是管理员账号，不可转销售</Text>
                  )}
                  {phoneCheck.exists && phoneCheck.hasSalesProfile && (
                    <Text type="danger">✗ 该号码已是销售，无法重复创建</Text>
                  )}
                </div>
              )}
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                label="初始密码"
                name="password"
                rules={[
                  // 已注册用户可不填；新用户提交时后端会拒绝（CLAUDE.md 测试已覆盖 400）
                  { min: 6, max: 64, message: '密码至少 6 位' },
                ]}
                extra={phoneCheck?.exists && phoneCheck.role === 'user'
                  ? '已有账号，可不填密码'
                  : '手机号未注册时为必填'}
              >
                <Input.Password placeholder={phoneCheck?.exists && phoneCheck.role === 'user' ? '可留空（升级路径）' : '至少 6 位'} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="销售姓名" name="realName" rules={[{ required: true, max: 30 }]}>
                <Input placeholder="张三" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="公司 / 部门" name="companyName" rules={[{ max: 60 }]}>
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="职位 / 身份标签" name="positionTitle" rules={[{ max: 40 }]} extra={'留空默认"标准智能平台顾问"'}>
            <Input placeholder="标准智能平台顾问" maxLength={40} />
          </Form.Item>
          <Form.Item label="个人介绍" name="bio" rules={[{ max: 300 }]}>
            <Input.TextArea rows={3} maxLength={300} showCount />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label="微信号" name="wechat" rules={[{ max: 50 }]}>
                <Input />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="对外展示手机号" name="contactPhone" rules={[{ max: 20 }]} extra="留空默认用登录手机号">
                <Input />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="公开联系方式" name="contactVisible" valuePropName="checked" initialValue={true} extra="关闭后推广页不展示手机号/微信号/二维码">
            <Switch checkedChildren="公开" unCheckedChildren="隐藏" />
          </Form.Item>
          <Form.Item label="默认展示产品（最多 4 个）" name="displayProducts">
            <Checkbox.Group>
              <Row gutter={[8, 8]}>
                {PRODUCT_OPTIONS.map(p => (
                  <Col xs={12} key={p.code}><Checkbox value={p.code}>{p.name}</Checkbox></Col>
                ))}
              </Row>
            </Checkbox.Group>
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={createLoading}>创建</Button>
              <Button onClick={() => setCreateOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量导入 Modal */}
      <Modal
        open={importOpen}
        title="批量导入销售"
        onCancel={() => setImportOpen(false)}
        footer={null}
        width={640}
      >
        <Alert
          message="CSV 格式要求"
          description={
            <div style={{ fontSize: 13 }}>
              <div>· 必填列：<code>手机号</code>、<code>姓名</code>（表头支持中文或英文 phone/name）</div>
              <div>· 手机号已注册的行会被跳过，不报错</div>
              <div>· 所有新销售默认公司 = <b>通标中研标准化技术研究院</b>，初始密码 = <code>Sales@2026</code></div>
              <div>· 单次最多导入 500 条</div>
              <div>· salesCode 由系统自动生成，销售登录后可在「我的推广主页」补充头像/介绍/二维码/产品勾选</div>
            </div>
          }
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />

        <Upload
          accept=".csv,text/csv"
          beforeUpload={(file) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            setImportFile(file as any)
            setImportResult(null)
            return false // 阻止自动上传
          }}
          onRemove={() => { setImportFile(null); setImportResult(null) }}
          fileList={importFile ? [importFile] : []}
          maxCount={1}
        >
          <Button icon={<UploadOutlined />}>选择 CSV 文件</Button>
        </Upload>

        <div style={{ marginTop: 16, marginBottom: 16 }}>
          <Space>
            <Button type="primary" loading={importLoading} disabled={!importFile} onClick={handleImport}>
              开始导入
            </Button>
            <Button onClick={() => setImportOpen(false)}>关闭</Button>
          </Space>
        </div>

        {importResult && (
          <Card size="small" title="导入结果" style={{ marginTop: 12 }}>
            <Row gutter={16}>
              <Col xs={8}><Statistic title="成功" value={importResult.success} valueStyle={{ color: '#52c41a' }} /></Col>
              <Col xs={8}><Statistic title="跳过" value={importResult.skipped} valueStyle={{ color: '#faad14' }} /></Col>
              <Col xs={8}><Statistic title="失败" value={importResult.failed} valueStyle={{ color: '#ff4d4f' }} /></Col>
            </Row>
            {importResult.hint && (
              <Alert style={{ marginTop: 12 }} type="warning" message={importResult.hint} showIcon />
            )}
            {Array.isArray(importResult.details) && importResult.details.length > 0 && (
              <Table
                style={{ marginTop: 12 }}
                rowKey={(
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  r: any
                ) => `${r.row}_${r.phone}`}
                dataSource={importResult.details}
                size="small"
                pagination={{ pageSize: 10 }}
                columns={[
                  { title: '行号', dataIndex: 'row', width: 60 },
                  { title: '手机号', dataIndex: 'phone', width: 130 },
                  {
                    title: '结果', dataIndex: 'status', width: 80,
                    render: (v: string) => {
                      const cfg: Record<string, { c: string; t: string }> = {
                        SUCCESS: { c: 'success', t: '成功' },
                        SKIPPED: { c: 'warning', t: '跳过' },
                        FAILED: { c: 'error', t: '失败' },
                      }
                      const it = cfg[v] || { c: 'default', t: v }
                      return <Tag color={it.c}>{it.t}</Tag>
                    },
                  },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  { title: 'salesCode / 原因', render: (_: any, r: any) => r.salesCode || r.reason || '-' },
                ]}
              />
            )}
          </Card>
        )}
      </Modal>
              </div>
            ),
          },
          {
            key: 'invites',
            label: '邀请码管理',
            children: <SalesInvites />,
          },
        ]}
      />

      {/* P1-B 销售详情 Drawer */}
      <Drawer
        title={detailItem ? `销售详情 — ${detailItem.realName}` : '销售详情'}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={600}
        destroyOnClose
      >
        {detailItem && (
          <>
            <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="姓名">{detailItem.realName}</Descriptions.Item>
              <Descriptions.Item label="salesCode">
                <Tag color="blue">{detailItem.salesCode}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="公司">{detailItem.companyName || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={detailItem.status === 'ENABLED' ? 'success' : 'default'}>
                  {detailItem.status === 'ENABLED' ? '已启用' : '已停用'}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="注册数" span={1}>{detailItem.stats.registerCount}</Descriptions.Item>
              <Descriptions.Item label="付费人数" span={1}>{detailItem.stats.paidCount}</Descriptions.Item>
              <Descriptions.Item label="归因金额" span={2}>
                <Text strong style={{ color: '#52c41a' }}>¥{(detailItem.stats.paidAmount / 100).toFixed(2)}</Text>
              </Descriptions.Item>
            </Descriptions>

            <Tabs
              activeKey={detailTab}
              onChange={(k) =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                setDetailTab(k as any)
              }
              items={[
                {
                  key: 'registrations',
                  label: `归因注册用户（${detailRegs.total}）`,
                  children: (
                    <Table
                      rowKey="id"
                      dataSource={detailRegs.items}
                      loading={detailLoading}
                      pagination={false}
                      size="small"
                      columns={[
                        { title: '手机号', dataIndex: 'phone', render: (v: string) => v || '-' },
                        { title: '注册时间', dataIndex: 'createdAt', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
                        {
                          title: '是否付费',
                          dataIndex: 'hasPaid',
                          render: (v: boolean) => v ? <Tag color="green">已付费</Tag> : <Tag>未付费</Tag>,
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: 'orders',
                  label: `归因订单（${detailOrders.total}）`,
                  children: (
                    <Table
                      rowKey="orderNo"
                      dataSource={detailOrders.items}
                      loading={detailLoading}
                      pagination={false}
                      size="small"
                      columns={[
                        { title: '客户手机号', dataIndex: 'phone', render: (v: string) => v || '-' },
                        { title: '套餐', dataIndex: 'planName' },
                        { title: '金额', dataIndex: 'amount', render: (v: number) => `¥${(v / 100).toFixed(2)}` },
                        { title: '付款时间', dataIndex: 'paidAt', render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-' },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </>
        )}
      </Drawer>
    </div>
  )
}
