/**
 * 管理后台 — 销售赠送管理
 * Tab 1: 赠送记录（列表 + 创建 + 批量导入 + 模板下载 + 导出）
 * Tab 2: 统计看板（概览 + 按销售人 + 按月份）
 */
import { useState, useEffect, useCallback } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import {
  Card, Table, Button, Modal, Form, Input, Select, DatePicker, Upload,
  Tag, Space, Typography, message, Popconfirm, Tooltip, Descriptions,
  Tabs, Statistic, Row, Col, Progress,
} from 'antd'
import {
  GiftOutlined, PlusOutlined, CopyOutlined, StopOutlined,
  ExclamationCircleOutlined, EyeOutlined, UploadOutlined,
  DownloadOutlined, BarChartOutlined, TeamOutlined,
} from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title, Text } = Typography

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  PENDING:  { label: '未领取', color: 'processing' },
  CLAIMED:  { label: '已领取', color: 'success' },
  EXPIRED:  { label: '已过期', color: 'default' },
  REVOKED:  { label: '已作废', color: 'error' },
}

// 与后端 services/api/src/giftRoutes.ts GIFT_TIERS 对齐：
// personal 允许 7 / 30 / 365；pro 仅允许 365。改后端时同步本文件。
const PLAN_OPTIONS = [
  { label: '个人版', value: 'personal' },
  { label: '专业版', value: 'pro' },
]

const DURATION_OPTIONS_PERSONAL = [
  { label: '7天体验', value: 7 },
  { label: '30天体验', value: 30 },
  { label: '1年 (365天)', value: 365 },
]

const DURATION_OPTIONS_PRO = [
  { label: '1年 (365天)', value: 365 },
]

function getDurationOptions(planId: string | undefined) {
  return planId === 'pro' ? DURATION_OPTIONS_PRO : DURATION_OPTIONS_PERSONAL
}


export default function AdminGiftsPage() {
  const isMobile = useIsMobile()
  const [activeTab, setActiveTab] = useState('list')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [searchPhone, setSearchPhone] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [batchResult, setBatchResult] = useState<any>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detailData, setDetailData] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [createdResult, setCreatedResult] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [stats, setStats] = useState<any>(null)
  const [form] = Form.useForm()

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { page, pageSize: 20 }
      if (statusFilter) params.status = statusFilter
      if (searchPhone) params.phone = searchPhone
      const qs = new URLSearchParams(params).toString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/gifts?${qs}`)
      setData(res.items || [])
      setTotal(res.total || 0)
    } catch { message.error('加载失败') }
    setLoading(false)
  }, [page, statusFilter, searchPhone])

  const loadStats = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/gifts/stats')
      setStats(res)
    } catch { /* ignore */ }
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadData() }, [loadData])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (activeTab === 'stats') loadStats() }, [activeTab, loadStats])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCreate = async (values: any) => {
    setCreateLoading(true)
    try {
      const payload = {
        phone: values.phone, planId: values.planId, durationDays: values.durationDays,
        expiresAt: values.expiresAt?.toISOString(), note: values.note,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/gifts', payload)
      setCreatedResult(res)
      if (res.warning) message.warning(res.warning)
      else message.success('创建成功')
      form.resetFields()
      loadData()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '创建失败')
    }
    setCreateLoading(false)
  }

  const handleBatchUpload = async (file: File) => {
    setBatchLoading(true)
    setBatchResult(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/gifts/batch', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setBatchResult(res)
      message.success(`导入完成：成功 ${res.success} 条，失败 ${res.failed} 条`)
      loadData()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '导入失败')
    }
    setBatchLoading(false)
    return false // prevent antd auto upload
  }

  const handleExport = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any = {}
    if (statusFilter) params.status = statusFilter
    if (searchPhone) params.phone = searchPhone
    const qs = new URLSearchParams(params).toString()
    window.open(`/node-api/api/admin/gifts/export?${qs}`, '_blank')
  }

  const handleDownloadTemplate = () => {
    window.open('/node-api/api/admin/gifts/template', '_blank')
  }

  const handleRevoke = async (id: string) => {
    try {
      await nodeApi.post(`/api/admin/gifts/${id}/revoke`, { reason: '管理员手动作废' })
      message.success('已作废')
      loadData()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  const handleRevokeMembership = async (id: string) => {
    try {
      await nodeApi.post(`/api/admin/gifts/${id}/revoke-membership`, { reason: '管理员撤销权益' })
      message.success('已撤销权益')
      loadData()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '操作失败') }
  }

  const showDetail = async (id: string) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/gifts/${id}`)
      setDetailData(res)
      setDetailOpen(true)
    } catch { message.error('加载详情失败') }
  }

  const fallbackCopy = (text: string, tip = '已复制') => {
    const el = document.createElement('textarea')
    el.value = text; el.style.position = 'fixed'; el.style.opacity = '0'
    document.body.appendChild(el); el.select(); document.execCommand('copy')
    document.body.removeChild(el); message.success(tip)
  }
  const PUBLIC_URL = import.meta.env.VITE_PUBLIC_URL || window.location.origin
  const copyLink = (code: string) => {
    const url = `${PUBLIC_URL}/claim/${code}`
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => message.success('链接已复制')).catch(() => fallbackCopy(url))
    else fallbackCopy(url)
  }

  const columns = [
    {
      title: '赠送码', dataIndex: 'code', width: 120,
      render: (code: string) => (
        <Space>
          <Text code style={{ fontSize: 12 }}>{code}</Text>
          <Tooltip title="复制领取链接">
            <CopyOutlined style={{ cursor: 'pointer', color: '#1677ff' }} onClick={() => copyLink(code)} />
          </Tooltip>
        </Space>
      ),
    },
    { title: '客户手机', dataIndex: 'phone', width: 130 },
    { title: '权益', dataIndex: 'planId', width: 100, hidden: isMobile, render: (v: string) => v === 'pro' ? '专业版' : '个人版' },
    { title: '时长(天)', dataIndex: 'durationDays', width: 80, hidden: isMobile },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (s: string) => { const m = STATUS_MAP[s] || { label: s, color: 'default' }; return <Tag color={m.color}>{m.label}</Tag> },
    },
    { title: '发放人', dataIndex: 'createdByName', width: 100, hidden: isMobile },
    { title: '创建时间', dataIndex: 'createdAt', width: 160, hidden: isMobile, render: (t: string) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-' },
    { title: '领取时间', dataIndex: 'claimedAt', width: 160, hidden: isMobile, render: (t: string) => t ? dayjs(t).format('YYYY-MM-DD HH:mm') : '-' },
    {
      title: '操作', width: 160, fixed: 'right' as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, row: any) => (
        <Space size={4}>
          <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => showDetail(row.id)}>详情</Button>
          {row.status === 'PENDING' && (
            <Popconfirm title="确定作废该赠送码？" onConfirm={() => handleRevoke(row.id)}>
              <Button type="link" size="small" danger icon={<StopOutlined />}>作废</Button>
            </Popconfirm>
          )}
          {row.status === 'CLAIMED' && (
            <Popconfirm title="确定撤销该用户的权益？" onConfirm={() => handleRevokeMembership(row.id)}>
              <Button type="link" size="small" danger icon={<ExclamationCircleOutlined />}>撤销</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ].filter(c => !('hidden' in c && (c as any).hidden))

  // ── 统计看板 ──
  const renderStats = () => {
    if (!stats) return <Card loading />
    const { overview, salesRanking, monthlyStats } = stats
    return (
      <div>
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={4}><Card><Statistic title="总赠送" value={overview.total} valueStyle={{ color: '#1677ff' }} /></Card></Col>
          <Col span={4}><Card><Statistic title="未领取" value={overview.pending} valueStyle={{ color: '#faad14' }} /></Card></Col>
          <Col span={4}><Card><Statistic title="已领取" value={overview.claimed} valueStyle={{ color: '#52c41a' }} /></Card></Col>
          <Col span={4}><Card><Statistic title="已过期" value={overview.expired} /></Card></Col>
          <Col span={4}><Card><Statistic title="已作废" value={overview.revoked} valueStyle={{ color: '#ff4d4f' }} /></Card></Col>
          <Col span={4}><Card><Statistic title="领取率" value={overview.claimRate} suffix="%" valueStyle={{ color: overview.claimRate >= 50 ? '#52c41a' : '#faad14' }} /></Card></Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Card title={<><TeamOutlined /> 按销售人统计</>}>
              <Table scroll={{ x: "max-content" }}
                rowKey="name" dataSource={salesRanking} pagination={false} size="small"
                columns={[
                  { title: '销售人', dataIndex: 'name', width: 100 },
                  { title: '总赠送', dataIndex: 'total', width: 80 },
                  { title: '已领取', dataIndex: 'claimed', width: 80 },
                  { title: '待领取', dataIndex: 'pending', width: 80 },
                  {
                    title: '领取率', dataIndex: 'claimRate', width: 120,
                    render: (v: number) => <Progress percent={v} size="small" status={v >= 50 ? 'success' : 'normal'} />,
                  },
                ]}
              />
            </Card>
          </Col>
          <Col span={12}>
            <Card title={<><BarChartOutlined /> 按月趋势（近12个月）</>}>
              <Table scroll={{ x: "max-content" }}
                rowKey="month" dataSource={monthlyStats} pagination={false} size="small"
                columns={[
                  { title: '月份', dataIndex: 'month', width: 100 },
                  { title: '创建', dataIndex: 'created', width: 80 },
                  { title: '领取', dataIndex: 'claimed', width: 80 },
                  {
                    title: '领取率', width: 120,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    render: (_: any, r: any) => {
                      const rate = r.created > 0 ? Math.round(r.claimed / r.created * 100) : 0
                      return <Progress percent={rate} size="small" status={rate >= 50 ? 'success' : 'normal'} />
                    },
                  },
                ]}
              />
            </Card>
          </Col>
        </Row>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}><GiftOutlined /> 销售赠送管理</Title>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: 'list',
          label: '赠送记录',
          children: (
            <>
              {/* 工具栏 */}
              <Card style={{ marginBottom: 16 }}>
                <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Space wrap>
                    <Select placeholder="状态筛选" value={statusFilter || undefined}
                      onChange={v => { setStatusFilter(v || ''); setPage(1) }}
                      allowClear style={{ width: 140 }}
                      options={[
                        { label: '全部', value: '' }, { label: '未领取', value: 'PENDING' },
                        { label: '已领取', value: 'CLAIMED' }, { label: '已过期', value: 'EXPIRED' },
                        { label: '已作废', value: 'REVOKED' },
                      ]}
                    />
                    <Input.Search placeholder="搜索手机号"
                      onSearch={v => { setSearchPhone(v); setPage(1) }}
                      allowClear style={{ width: 200 }} />
                  </Space>
                  <Space>
                    <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>导入模板</Button>
                    <Button icon={<UploadOutlined />} onClick={() => { setBatchOpen(true); setBatchResult(null) }}>批量导入</Button>
                    <Button icon={<DownloadOutlined />} onClick={handleExport}>导出 Excel</Button>
                    <Button type="primary" icon={<PlusOutlined />}
                      onClick={() => { setCreateOpen(true); setCreatedResult(null) }}>
                      创建赠送
                    </Button>
                  </Space>
                </Space>
              </Card>

              {/* 列表 */}
              <Card>
                <Table
                  rowKey="id" columns={columns} dataSource={data} loading={loading}
                  pagination={{ current: page, pageSize: 20, total, onChange: setPage, showTotal: t => `共 ${t} 条` }}
                  scroll={{ x: 1200 }}
                />
              </Card>
            </>
          ),
        },
        {
          key: 'stats',
          label: '统计看板',
          children: renderStats(),
        },
      ]} />

      {/* 创建弹窗 */}
      <Modal title="创建赠送资格" open={createOpen}
        onCancel={() => { setCreateOpen(false); setCreatedResult(null) }}
        footer={createdResult ? [<Button key="close" onClick={() => { setCreateOpen(false); setCreatedResult(null) }}>关闭</Button>] : undefined}
        onOk={() => form.submit()} confirmLoading={createLoading} okText="创建并生成链接"
      >
        {createdResult ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <GiftOutlined style={{ fontSize: 40, color: '#52c41a', marginBottom: 12 }} />
            <Title level={5}>创建成功</Title>
            <div style={{ margin: '16px auto', padding: '12px 16px', background: '#f6f6f6', borderRadius: 8, fontFamily: 'monospace', fontSize: 14, wordBreak: 'break-all' }}>
              {PUBLIC_URL}/claim/{createdResult.code}
            </div>
            <Button type="primary" icon={<CopyOutlined />} onClick={() => copyLink(createdResult.code)}>复制领取链接</Button>
            <div style={{ marginTop: 12, fontSize: 12, color: '#999' }}>请将链接发送给客户</div>
          </div>
        ) : (
          <Form form={form} layout="vertical" onFinish={handleCreate} initialValues={{ durationDays: 7, planId: 'personal' }}>
            <Form.Item name="phone" label="客户手机号" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1[3-9]\d{9}$/, message: '请输入有效手机号' }]}>
              <Input placeholder="11位手机号" maxLength={11} />
            </Form.Item>
            <Form.Item name="planId" label="权益类型" rules={[{ required: true }]}>
              <Select
                options={PLAN_OPTIONS}
                onChange={(planId) => {
                  // 切换权益类型时，把时长重置为该类型下的第一档（pro 只剩 365）
                  const allowed = getDurationOptions(planId)
                  const current = form.getFieldValue('durationDays')
                  if (!allowed.some(o => o.value === current)) {
                    form.setFieldValue('durationDays', allowed[0].value)
                  }
                }}
              />
            </Form.Item>
            <Form.Item shouldUpdate={(prev, cur) => prev.planId !== cur.planId} noStyle>
              {({ getFieldValue }) => (
                <Form.Item name="durationDays" label="赠送时长" rules={[{ required: true }]}>
                  <Select options={getDurationOptions(getFieldValue('planId'))} />
                </Form.Item>
              )}
            </Form.Item>
            <Form.Item name="expiresAt" label="领取有效期（默认30天后）">
              <DatePicker style={{ width: '100%' }} disabledDate={d => d && d.isBefore(dayjs(), 'day')} />
            </Form.Item>
            <Form.Item name="note" label="备注"><Input.TextArea rows={2} placeholder="内部备注" /></Form.Item>
          </Form>
        )}
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal title="批量导入赠送" open={batchOpen}
        onCancel={() => { setBatchOpen(false); setBatchResult(null) }}
        footer={<Button onClick={() => { setBatchOpen(false); setBatchResult(null) }}>关闭</Button>}
      >
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary">
            请先下载<a onClick={handleDownloadTemplate} style={{ cursor: 'pointer' }}>导入模板</a>，按模板填写后上传 Excel 文件。
          </Text>
        </div>
        <Upload.Dragger
          accept=".xlsx,.xls"
          showUploadList={false}
          customRequest={({ file }) => handleBatchUpload(file as File)}
          disabled={batchLoading}
        >
          <p className="ant-upload-drag-icon"><UploadOutlined style={{ fontSize: 32, color: '#1677ff' }} /></p>
          <p>{batchLoading ? '导入中...' : '点击或拖拽 Excel 文件到此处'}</p>
        </Upload.Dragger>
        {batchResult && (
          <Card size="small" style={{ marginTop: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text>总计 {batchResult.total} 条，成功 <Text type="success">{batchResult.success}</Text> 条，失败 <Text type="danger">{batchResult.failed}</Text> 条</Text>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {batchResult.results?.filter((r: any) => r.error).map((r: any, i: number) => (
                <Text key={i} type="danger" style={{ fontSize: 12 }}>{r.phone}: {r.error}</Text>
              ))}
            </Space>
          </Card>
        )}
      </Modal>

      {/* 详情弹窗 */}
      <Modal title="赠送详情" open={detailOpen} onCancel={() => setDetailOpen(false)}
        footer={<Button onClick={() => setDetailOpen(false)}>关闭</Button>}>
        {detailData && (
          <div>
            <Descriptions column={2} bordered size="small">
              <Descriptions.Item label="赠送码">{detailData.code}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={STATUS_MAP[detailData.status]?.color}>{STATUS_MAP[detailData.status]?.label}</Tag></Descriptions.Item>
              <Descriptions.Item label="客户手机">{detailData.phone}</Descriptions.Item>
              <Descriptions.Item label="客户邮箱">{detailData.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="权益类型">{detailData.planId === 'pro' ? '专业版' : '个人版'}</Descriptions.Item>
              <Descriptions.Item label="赠送时长">{detailData.durationDays}天</Descriptions.Item>
              <Descriptions.Item label="领取截止">{dayjs(detailData.expiresAt).format('YYYY-MM-DD')}</Descriptions.Item>
              <Descriptions.Item label="发放人">{detailData.createdByName || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{dayjs(detailData.createdAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="领取时间">{detailData.claimedAt ? dayjs(detailData.claimedAt).format('YYYY-MM-DD HH:mm') : '-'}</Descriptions.Item>
              <Descriptions.Item label="领取用户">{detailData.claimedBy || '-'}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detailData.note || '-'}</Descriptions.Item>
            </Descriptions>
            {detailData.logs?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Text strong>操作日志</Text>
                <div style={{ marginTop: 8 }}>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {detailData.logs.map((log: any, i: number) => (
                    <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid #f0f0f0', fontSize: 13 }}>
                      <Tag style={{ fontSize: 11 }}>{log.action}</Tag>
                      <Text type="secondary">{dayjs(log.time).format('YYYY-MM-DD HH:mm')}</Text>
                      {log.note && <Text style={{ marginLeft: 8 }}>{log.note}</Text>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
