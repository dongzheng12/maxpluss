import { useCallback, useEffect, useState } from 'react'
import {
  Card, Table, Button, Space, Tag, Typography, message, Popconfirm,
  Select, Row, Col, Modal, InputNumber,
} from 'antd'
import { PlusOutlined, CopyOutlined, StopOutlined, DeleteOutlined, ReloadOutlined, QrcodeOutlined, EyeOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import QRCode from 'qrcode'
import { nodeApi } from '../../../api/client'

const { Text } = Typography

interface Invite {
  id: string
  inviteCode: string
  status: 'UNUSED' | 'USED' | 'DISABLED' | 'EXPIRED'
  usedBy: string | null
  usedAt: string | null
  expiresAt: string | null
  createdAt: string
  inviteUrl: string
  usedByUser: {
    id: string
    phone: string
    name: string
    salesCode?: string | null      // P1-A：使用者绑定的销售推广码
    landingUrl?: string | null      // 公开推广页 URL
  } | null
}

const STATUS_COLOR: Record<string, string> = {
  UNUSED: 'blue',
  USED: 'success',
  DISABLED: 'default',
  EXPIRED: 'warning',
}
const STATUS_LABEL: Record<string, string> = {
  UNUSED: '未使用',
  USED: '已使用',
  DISABLED: '已禁用',
  EXPIRED: '已过期',
}

export default function SalesInvites() {
  const [items, setItems] = useState<Invite[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [batchCount, setBatchCount] = useState(1)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<React.Key[]>([])
  const [bulking, setBulking] = useState(false)

  // 兜底：后端没配 VITE_PUBLIC_URL 时返回相对路径，前端自动拼 origin
  const toFullUrl = (u: string) => u.startsWith('http') ? u : `${window.location.origin}${u}`

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params: Record<string, string> = { page: String(page), pageSize: '20' }
      if (statusFilter) params.status = statusFilter
      const qs = new URLSearchParams(params).toString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/sales-invites?${qs}`)
      setItems(res.items || [])
      setTotal(res.total || 0)
      setSelectedIds([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }, [page, statusFilter])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/sales-invites', { count: batchCount })

      if (batchCount === 1) {
        // 单个：弹窗展示链接
        const fullUrl = toFullUrl(res.inviteUrl)
        Modal.success({
          title: '邀请码生成成功',
          content: (
            <div>
              <div style={{ margin: '12px 0' }}>
                <Text strong>邀请码：</Text>
                <Text code copyable style={{ fontSize: 15 }}>{res.inviteCode}</Text>
              </div>
              <div>
                <Text strong>注册链接：</Text>
                <br />
                <Text copyable style={{ fontSize: 12, color: '#1677ff', wordBreak: 'break-all' }}>{fullUrl}</Text>
              </div>
            </div>
          ),
          width: 520,
        })
      } else {
        // 批量：显示生成数量，列表刷新后可在表格里复制
        message.success(`已生成 ${res.count} 个邀请码，可在列表中复制链接`)
      }
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '生成失败')
    }
    setGenerating(false)
  }

  const handleDisable = async (id: string) => {
    try {
      await nodeApi.post(`/api/admin/sales-invites/${id}/disable`, {})
      message.success('已禁用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '禁用失败')
    }
  }

  const handleBulk = async (action: 'DISABLE' | 'DELETE') => {
    if (selectedIds.length === 0) { message.warning('请先勾选邀请码'); return }
    setBulking(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.post('/api/admin/sales-invites/bulk', {
        ids: selectedIds,
        action,
      })
      const label = action === 'DISABLE' ? '禁用' : '删除'
      message.success(`批量${label}：成功 ${res.affected} / 跳过 ${res.skipped}`)
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
    setBulking(false)
  }

  // 已选中的邀请码中可执行的数量（给按钮加提示）
  const selectedInvites = items.filter(i => selectedIds.includes(i.id))
  const canDisableCount = selectedInvites.filter(i => i.status === 'UNUSED').length
  const canDeleteCount = selectedInvites.filter(i => i.status !== 'USED').length

  const columns = [
    {
      title: '邀请码',
      dataIndex: 'inviteCode',
      width: 120,
      render: (v: string) => <Text code strong style={{ fontSize: 13 }}>{v}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => <Tag color={STATUS_COLOR[v] || 'default'}>{STATUS_LABEL[v] || v}</Tag>,
    },
    {
      title: '邀请链接',
      dataIndex: 'inviteUrl',
      ellipsis: true,
      render: (v: string) => {
        const full = toFullUrl(v)
        return (
          <Space>
            <Text style={{ fontSize: 12, color: '#8c9bac' }}>{full}</Text>
            <Button
              size="small"
              type="link"
              icon={<CopyOutlined />}
              onClick={() => { navigator.clipboard.writeText(full); message.success('已复制完整链接') }}
            />
          </Space>
        )
      },
    },
    {
      title: '使用者',
      dataIndex: 'usedByUser',
      width: 240,
      render: (u: Invite['usedByUser']) => u ? (
        <div>
          <div><Text strong>{u.name}</Text></div>
          <Text type="secondary" style={{ fontSize: 12 }}>{u.phone}</Text>
          {u.landingUrl && (
            <div style={{ marginTop: 4 }}>
              <Button
                size="small"
                type="link"
                icon={<EyeOutlined />}
                onClick={() => window.open(toFullUrl(u.landingUrl!), '_blank')}
                style={{ padding: 0, fontSize: 12 }}
              >查看推广页 ↗</Button>
            </div>
          )}
        </div>
      ) : <Text type="secondary">-</Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '到期时间',
      dataIndex: 'expiresAt',
      width: 150,
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '操作',
      width: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, r: Invite) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            icon={<QrcodeOutlined />}
            onClick={() => handleDownloadQR(r)}
          >二维码</Button>
          {r.status === 'UNUSED' && (
            <Popconfirm title="确定禁用此邀请码？" onConfirm={() => handleDisable(r.id)}>
              <Button type="link" danger size="small" icon={<StopOutlined />}>禁用</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  /** P1-A：下载邀请码二维码（PNG，调 qrcode toDataURL）*/
  async function handleDownloadQR(r: Invite) {
    const fullUrl = toFullUrl(r.inviteUrl)
    try {
      const dataUrl = await QRCode.toDataURL(fullUrl, {
        width: 320, margin: 2,
        color: { dark: '#1a2235', light: '#ffffff' },
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `邀请码-${r.inviteCode}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      message.error('二维码生成失败：' + (err?.message || ''))
    }
  }

  return (
    <Card>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col flex="auto">
          <Space wrap>
            <Select
              allowClear
              placeholder="状态筛选"
              style={{ width: 140 }}
              value={statusFilter || undefined}
              onChange={(v) => { setStatusFilter(v || ''); setPage(1) }}
              options={[
                { value: 'UNUSED', label: '未使用' },
                { value: 'USED', label: '已使用' },
                { value: 'DISABLED', label: '已禁用' },
                { value: 'EXPIRED', label: '已过期' },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            {selectedIds.length > 0 && (
              <>
                <Text type="secondary">已选 {selectedIds.length} 项</Text>
                <Popconfirm
                  title={`确定批量禁用？仅对 ${canDisableCount} 个未使用的生效`}
                  onConfirm={() => handleBulk('DISABLE')}
                  disabled={canDisableCount === 0}
                >
                  <Button icon={<StopOutlined />} loading={bulking} disabled={canDisableCount === 0}>
                    批量禁用
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={`确定批量删除？不可恢复，仅对 ${canDeleteCount} 个非已使用的生效`}
                  onConfirm={() => handleBulk('DELETE')}
                  okButtonProps={{ danger: true }}
                  disabled={canDeleteCount === 0}
                >
                  <Button danger icon={<DeleteOutlined />} loading={bulking} disabled={canDeleteCount === 0}>
                    批量删除
                  </Button>
                </Popconfirm>
              </>
            )}
          </Space>
        </Col>
        <Col>
          <Space>
            <InputNumber
              min={1}
              max={50}
              value={batchCount}
              onChange={(v) => setBatchCount(v || 1)}
              style={{ width: 70 }}
              title="生成数量（1~50）"
            />
            <Button type="primary" icon={<PlusOutlined />} loading={generating} onClick={handleGenerate}>
              {batchCount > 1 ? `批量生成 ${batchCount} 个` : '生成邀请码'}
            </Button>
          </Space>
        </Col>
      </Row>

      <Table
        rowKey="id"
        dataSource={items}
        columns={
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          columns as any
        }
        loading={loading}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: setSelectedIds,
          getCheckboxProps: (r: Invite) => ({
            // USED 行不允许选（不能删除有审计关系的数据）
            disabled: false, // 全可选，后端会按 action 分别过滤
            name: r.inviteCode,
          }),
        }}
        pagination={{
          current: page, pageSize: 20, total,
          onChange: setPage, showSizeChanger: false,
        }}
        scroll={{ x: 1100 }}
      />
    </Card>
  )
}
