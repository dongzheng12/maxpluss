import { useCallback, useEffect, useState } from 'react'
import {
  Card, Row, Col, Typography, Button, Space, Spin, Empty, Progress, Statistic,
  Tag, message, Table, Modal, Input, Popconfirm, Form,
} from 'antd'
import {
  LinkOutlined, CopyOutlined, EyeOutlined, EditOutlined,
  TeamOutlined, DollarOutlined, ShoppingCartOutlined, CheckCircleOutlined,
  QrcodeOutlined, StopOutlined, DownloadOutlined, DeleteOutlined,
  RocketOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { nodeApi } from '../../api/client'

const { Title, Text } = Typography

interface DashboardData {
  salesCode: string
  landingUrl: string
  isPublic: boolean
  status: string
  profile: {
    completeness: number
    filledCount: number
    totalCount: number
    missingFields: string[]
  }
  stats: {
    visitCount: number
    registerCount: number
    paidCount: number
    paidAmount: number
  }
}

interface SalesCodeItem {
  id: string
  salesCode: string
  label: string | null
  status: 'ACTIVE' | 'DISABLED'
  createdAt: string
  landingUrl: string
  isPrimary: boolean
}

const FIELD_LABELS: Record<string, string> = {
  avatar: '头像',
  realName: '姓名',
  companyName: '公司',
  positionTitle: '职位',
  bio: '个人介绍',
  phone: '联系手机号',
  wechat: '微信号',
  qrcode: '微信二维码',
}

const toFullUrl = (u?: string | null) => {
  if (!u) return window.location.origin
  return u.startsWith('http') ? u : `${window.location.origin}${u}`
}

export default function SalesDashboardPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<DashboardData | null>(null)
  const [codes, setCodes] = useState<SalesCodeItem[]>([])
  const [codesLoading, setCodesLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [createForm] = Form.useForm()
  const [qrOpen, setQrOpen] = useState(false)
  const [qrTarget, setQrTarget] = useState<SalesCodeItem | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [publishLoading, setPublishLoading] = useState(false)
  const nav = useNavigate()

  const loadDashboard = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/app/sales/dashboard/me')
      setData(res)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载工作台失败')
    }
  }, [])

  const loadCodes = useCallback(async () => {
    setCodesLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/app/sales/codes')
      setCodes(res.items || [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载推广码失败')
    }
    setCodesLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([loadDashboard(), loadCodes()]).finally(() => setLoading(false))
  }, [loadCodes, loadDashboard])

  // 一键发布推广页：从工作台 tag 旁边触发，避免销售必须翻到资料页底部找 isPublic Switch
  const handlePublish = () => {
    Modal.confirm({
      title: '确认发布推广页',
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <p>发布后，访问者通过推广链接 <Text code>/s/{data?.salesCode}</Text> 可以看到您的资料和联系方式。</p>
          <p style={{ color: '#8c9bac', fontSize: 13 }}>
            如果资料尚未填完，建议先到「推广资料」补全后再发布；发布后随时可在资料页底部切换「启用我的推广页」开关下线。
          </p>
        </div>
      ),
      okText: '确认发布',
      okType: 'primary',
      cancelText: '取消',
      onOk: async () => {
        setPublishLoading(true)
        try {
          await nodeApi.put('/api/app/sales/profile/me', { isPublic: true })
          message.success('推广页已发布')
          await loadDashboard()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '发布失败')
        }
        setPublishLoading(false)
      },
    })
  }

  // 打开二维码弹窗后用 toDataURL 生成 PNG（避开 canvas ref 挂载时序问题）
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!qrOpen || !qrTarget) { setQrDataUrl(''); return }
    const fullUrl = toFullUrl(qrTarget.landingUrl)
    QRCode.toDataURL(fullUrl, {
      width: 280,
      margin: 2,
      color: { dark: '#1a2235', light: '#ffffff' },
    }).then(setQrDataUrl).catch((err) => {
      message.error('二维码生成失败：' + err?.message)
    })
  }, [qrOpen, qrTarget])

  const handleCreate = async (values: { label?: string }) => {
    setCreateLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/app/sales/codes', { label: values.label || null })
      message.success(`推广码生成成功：${res.salesCode}`)
      setCreateOpen(false)
      createForm.resetFields()
      loadCodes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '生成失败')
    }
    setCreateLoading(false)
  }

  const handleDisable = async (id: string) => {
    try {
      await nodeApi.patch(`/api/app/sales/codes/${id}/disable`, {})
      message.success('已禁用')
      loadCodes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '禁用失败')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await nodeApi.delete(`/api/app/sales/codes/${id}`)
      message.success('已删除')
      loadCodes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const backendMsg = e?.response?.data?.error || ''
      if (backendMsg.includes('归因订单') || backendMsg.includes('订单')) {
        message.error('该码已有订单记录，建议禁用而非删除')
      } else {
        message.error(backendMsg || '删除失败')
      }
    }
  }

  const handleDownloadQR = () => {
    if (!qrDataUrl || !qrTarget) return
    const a = document.createElement('a')
    a.href = qrDataUrl
    a.download = `推广码-${qrTarget.salesCode}${qrTarget.label ? `-${qrTarget.label}` : ''}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(toFullUrl(url))
    message.success('已复制链接')
  }

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
  if (!data) return <div style={{ padding: 48 }}><Empty description="未开通销售推广主页" /></div>

  const mainUrl = codes.find(c => c.isPrimary)?.landingUrl || data.landingUrl || '/'
  const mainFullUrl = toFullUrl(mainUrl)
  const profile = data.profile ?? { completeness: 0, filledCount: 0, totalCount: 0, missingFields: [] }
  const stats = data.stats ?? { visitCount: 0, registerCount: 0, paidCount: 0, paidAmount: 0 }

  const codeColumns = [
    {
      title: '推广码',
      dataIndex: 'salesCode',
      width: 130,
      render: (v: string, r: SalesCodeItem) => (
        <Space direction="vertical" size={0}>
          <Text code strong style={{ fontSize: 13 }}>{v}</Text>
          {r.isPrimary && <Tag color="gold" style={{ fontSize: 10, padding: '0 4px', marginInlineEnd: 0 }}>主码</Tag>}
        </Space>
      ),
    },
    {
      title: '备注',
      dataIndex: 'label',
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: '推广链接',
      dataIndex: 'landingUrl',
      ellipsis: true,
      render: (v: string) => (
        <Text style={{ fontSize: 12, color: '#8c9bac' }} ellipsis>{toFullUrl(v)}</Text>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (v: string) => <Tag color={v === 'ACTIVE' ? 'green' : 'default'}>{v === 'ACTIVE' ? '启用' : '禁用'}</Tag>,
    },
    {
      title: '操作',
      width: 320,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: SalesCodeItem) => (
        <Space size={4} wrap>
          <Button size="small" icon={<CopyOutlined />} onClick={() => copyLink(r.landingUrl)}>复制</Button>
          <Button size="small" icon={<QrcodeOutlined />} onClick={() => { setQrTarget(r); setQrOpen(true) }}>二维码</Button>
          <Button size="small" icon={<EyeOutlined />} onClick={() => window.open(toFullUrl(r.landingUrl), '_blank')}>预览</Button>
          {!r.isPrimary && r.status === 'ACTIVE' && (
            <Popconfirm title="确定禁用此码？" onConfirm={() => handleDisable(r.id)}>
              <Button size="small" icon={<StopOutlined />}>禁用</Button>
            </Popconfirm>
          )}
          {!r.isPrimary && (
            <Popconfirm
              title="删除推广码"
              description="删除后该推广链接将失效，确认删除？"
              onConfirm={() => handleDelete(r.id)}
              okButtonProps={{ danger: true }}
              okText="确认删除"
              cancelText="取消"
            >
              <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0 }}>销售工作台</Title>
        <Text type="secondary">管理你的推广页与数据</Text>
      </div>

      <Row gutter={[16, 16]}>
        {/* ① 推广码列表 */}
        <Col xs={24}>
          <Card
            title={<Space><LinkOutlined /> 我的推广码</Space>}
            extra={
              <Space>
                <Tag color={data.status === 'ENABLED' && data.isPublic ? 'green' : 'orange'}>
                  {data.status !== 'ENABLED' ? '管理员已停用' : (data.isPublic ? '推广页已发布' : '推广页未发布')}
                </Tag>
                {data.status === 'ENABLED' && !data.isPublic && (
                  <Button
                    type="primary"
                    icon={<RocketOutlined />}
                    loading={publishLoading}
                    onClick={handlePublish}
                  >
                    立即发布
                  </Button>
                )}
              </Space>
            }
          >
            <Table
              rowKey="id"
              dataSource={codes.filter(c => c.isPrimary)}
              columns={
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                codeColumns as any
              }
              loading={codesLoading}
              pagination={false}
              size="small"
              scroll={{ x: 900 }}
            />
            <div style={{ marginTop: 12, fontSize: 12, color: '#8c9bac' }}>
              提示：主推广码用于您的资料归因与访客统计。
            </div>
          </Card>
        </Col>

        {/* ② 资料完成度 */}
        <Col xs={24} md={12}>
          <Card
            title={<Space><CheckCircleOutlined /> 资料完成度</Space>}
            extra={<Button type="link" onClick={() => nav('/sales/profile')}>去完善 →</Button>}
          >
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Progress
                percent={profile.completeness}
                status={profile.completeness >= 80 ? 'success' : 'active'}
              />
              <Text type="secondary" style={{ fontSize: 13 }}>
                已填 {profile.filledCount} / {profile.totalCount} 项
              </Text>
              {profile.missingFields.length > 0 && (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>未填：</Text>
                  <Space size={4} wrap style={{ marginTop: 6 }}>
                    {profile.missingFields.map(f => (
                      <Tag key={f} color="orange">{FIELD_LABELS[f] || f}</Tag>
                    ))}
                  </Space>
                </div>
              )}
            </Space>
          </Card>
        </Col>

        {/* ③ 数据概览 */}
        <Col xs={24} md={12}>
          <Card title={<Space><TeamOutlined /> 数据概览</Space>}>
            <Row gutter={[12, 12]}>
              <Col xs={12}>
                <Statistic title="访问量" value={stats.visitCount} valueStyle={{ color: '#8c9bac' }} />
                <Text type="secondary" style={{ fontSize: 11 }}>暂未统计</Text>
              </Col>
              <Col xs={12}>
                <Statistic title="注册数" value={stats.registerCount} prefix={<TeamOutlined />} valueStyle={{ color: '#1677ff' }} />
              </Col>
              <Col xs={12}>
                <Statistic title="付费人数" value={stats.paidCount} prefix={<ShoppingCartOutlined />} valueStyle={{ color: '#52c41a' }} />
              </Col>
              <Col xs={12}>
                <Statistic
                  title="归因金额"
                  value={(stats.paidAmount / 100).toFixed(2)}
                  prefix={<DollarOutlined />}
                  suffix="元"
                  valueStyle={{ color: '#722ed1' }}
                />
              </Col>
            </Row>
            <div style={{ marginTop: 12, textAlign: 'right' }}>
              <Button type="link" onClick={() => nav('/sales/data')}>查看订单明细 →</Button>
            </div>
          </Card>
        </Col>

        {/* ④ 快捷操作 */}
        <Col xs={24}>
          <Card title="快捷操作">
            <Space wrap>
              <Button type="primary" icon={<EyeOutlined />} onClick={() => window.open(mainFullUrl, '_blank')}>查看我的推广页</Button>
              <Button icon={<CopyOutlined />} onClick={() => copyLink(mainUrl)}>复制主推广链接</Button>
              <Button icon={<EditOutlined />} onClick={() => nav('/sales/profile')}>编辑资料</Button>
              <Button icon={<ShoppingCartOutlined />} onClick={() => nav('/sales/data')}>查看订单</Button>
            </Space>
          </Card>
        </Col>
      </Row>

      {/* 生成推广码弹窗 */}
      <Modal
        open={createOpen}
        title="生成新推广码"
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        footer={null}
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item
            label="备注（选填）"
            name="label"
            rules={[{ max: 40 }]}
            extra="如：展会专用、抖音号专用，便于自己区分渠道"
          >
            <Input placeholder="展会专用" maxLength={40} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={createLoading}>生成</Button>
            <Button onClick={() => { setCreateOpen(false); createForm.resetFields() }}>取消</Button>
          </Space>
        </Form>
      </Modal>

      {/* 二维码弹窗 */}
      <Modal
        open={qrOpen}
        title={`推广码二维码 — ${qrTarget?.salesCode || ''}`}
        onCancel={() => setQrOpen(false)}
        footer={null}
        width={360}
        destroyOnClose
      >
        {qrTarget && (
          <div style={{ textAlign: 'center' }}>
            {qrTarget.label && <Text type="secondary">{qrTarget.label}</Text>}
            <div style={{ margin: '16px 0', minHeight: 280 }}>
              {qrDataUrl
                ? <img src={qrDataUrl} alt="二维码" style={{ width: 280, height: 280 }} />
                : <Spin />}
            </div>
            <div style={{
              background: '#f5f7fa', padding: 8, borderRadius: 6,
              fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all',
              marginBottom: 12, color: '#52606d',
            }}>
              {toFullUrl(qrTarget.landingUrl)}
            </div>
            <Space>
              <Button icon={<CopyOutlined />} onClick={() => copyLink(qrTarget.landingUrl)}>复制链接</Button>
              <Button type="primary" icon={<DownloadOutlined />} onClick={handleDownloadQR}>下载图片</Button>
            </Space>
          </div>
        )}
      </Modal>
    </div>
  )
}
