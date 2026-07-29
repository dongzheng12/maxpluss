import { useState, useEffect, useMemo } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Tag, Typography, Button, Space, Modal, Input, message, Select, DatePicker } from 'antd'
import { ReloadOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title } = Typography
const { RangePicker } = DatePicker

const STATUS_OPTIONS = [
  { value: '',         label: '全部' },
  { value: 'PENDING',  label: '待处理' },
  { value: 'ISSUED',   label: '已开具' },
  { value: 'REJECTED', label: '已驳回' },
]

export default function AdminInvoicesPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/invoices')
      setItems(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (statusFilter && i.status !== statusFilter) return false
      if (dateRange) {
        const t = dayjs(i.createdAt)
        if (t.isBefore(dateRange[0], 'day') || t.isAfter(dateRange[1], 'day')) return false
      }
      if (keyword) {
        const k = keyword.toLowerCase()
        const hit =
          (i.invoiceNo || '').toLowerCase().includes(k) ||
          (i.orderNo   || '').toLowerCase().includes(k) ||
          (i.title     || '').toLowerCase().includes(k)
        if (!hit) return false
      }
      return true
    })
  }, [items, statusFilter, keyword, dateRange])

  const handleIssue = async (invoiceNo: string) => {
    Modal.confirm({
      title: '确认开具发票',
      content: `确认开具发票 ${invoiceNo}？`,
      okText: '确认开具',
      okType: 'primary',
      onOk: async () => {
        try {
          await nodeApi.post(`/api/admin/invoices/${invoiceNo}/issue`)
          message.success('发票已开具')
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '操作失败')
        }
      }
    })
  }

  const handleReject = (invoiceNo: string) => {
    let reason = ''
    Modal.confirm({
      title: '驳回发票申请',
      content: (
        <div>
          <p>请输入驳回原因：</p>
          <Input.TextArea rows={3} onChange={(e) => { reason = e.target.value }} placeholder="例如：税号信息不正确" />
        </div>
      ),
      okText: '确认驳回',
      okType: 'danger',
      onOk: async () => {
        try {
          await nodeApi.post(`/api/admin/invoices/${invoiceNo}/reject`, { reason })
          message.success('已驳回')
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '操作失败')
        }
      }
    })
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Title level={4} style={{ margin: 0 }}>发票管理</Title>
        <Space wrap>
          <Input.Search
            placeholder="搜索发票号 / 订单号 / 抬头"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 240 }}
          />
          <Select
            value={statusFilter}
            style={{ width: 140 }}
            onChange={setStatusFilter}
            options={STATUS_OPTIONS}
          />
          <RangePicker
            value={dateRange}
            onChange={(v) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              setDateRange(v as any)
            }
            placeholder={['申请起', '申请止']}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Space>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="invoiceNo"
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: '发票号', dataIndex: 'invoiceNo', width: 180, hidden: isMobile },
            { title: '订单号', dataIndex: 'orderNo', width: 180, hidden: isMobile },
            { title: '抬头', dataIndex: 'title' },
            { title: '类型', dataIndex: 'type', width: 80, hidden: isMobile, render: (v: string) => v === 'SPECIAL' ? '专票' : '普票' },
            { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => `¥${(v / 100).toFixed(2)}` },
            { title: '税号', dataIndex: 'taxNo', width: 180, ellipsis: true, hidden: isMobile },
            { title: '邮箱', dataIndex: 'email', width: 180, ellipsis: true, hidden: isMobile },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => (
              <Tag color={s === 'ISSUED' ? 'green' : s === 'REJECTED' ? 'red' : 'orange'}>
                {s === 'ISSUED' ? '已开具' : s === 'REJECTED' ? '已驳回' : '待处理'}
              </Tag>
            )},
            { title: '驳回原因', dataIndex: 'rejectReason', width: 120, ellipsis: true, hidden: isMobile },
            { title: '申请时间', dataIndex: 'createdAt', width: 170, hidden: isMobile,
              render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { title: '操作', width: 160, render: (_: any, row: any) => row.status === 'PENDING' && (
              <Space>
                <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => handleIssue(row.invoiceNo)}>开具</Button>
                <Button size="small" danger icon={<CloseOutlined />} onClick={() => handleReject(row.invoiceNo)}>驳回</Button>
              </Space>
            )},
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
