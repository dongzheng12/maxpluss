import { useState, useEffect, useMemo } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Typography, Button, Space, Select, Input, DatePicker, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'

const { Title } = Typography
const { RangePicker } = DatePicker

const STATUS_OPTIONS = [
  { value: '',     label: '全部' },
  { value: '待联系', label: '待联系' },
  { value: '已联系', label: '已联系' },
  { value: '已完成', label: '已完成' },
  { value: '已取消', label: '已取消' },
]

export default function AdminBookingsPage() {
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
      const res: any = await nodeApi.get('/api/admin/bookings')
      setItems(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    return items.filter((i) => {
      const status = i.status || '待联系'
      if (statusFilter && status !== statusFilter) return false
      if (dateRange) {
        const t = dayjs(i.createdAt)
        if (t.isBefore(dateRange[0], 'day') || t.isAfter(dateRange[1], 'day')) return false
      }
      if (keyword) {
        const k = keyword.toLowerCase()
        const hit =
          (i.name         || '').toLowerCase().includes(k) ||
          (i.phone        || '').toLowerCase().includes(k) ||
          (i.organization || '').toLowerCase().includes(k)
        if (!hit) return false
      }
      return true
    })
  }, [items, statusFilter, keyword, dateRange])

  const changeStatus = async (bookingNo: string, status: string) => {
    try {
      await nodeApi.patch(`/api/admin/bookings/${bookingNo}/status`, { status })
      message.success('状态已更新')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Title level={4} style={{ margin: 0 }}>服务预约</Title>
        <Space wrap>
          <Input.Search
            placeholder="搜索联系人 / 手机号 / 单位"
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
            placeholder={['预约起', '预约止']}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Space>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="bookingNo"
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: '预约号', dataIndex: 'bookingNo', width: 180, hidden: isMobile },
            { title: '联系人', dataIndex: 'name', width: 100 },
            { title: '手机号', dataIndex: 'phone', width: 130 },
            { title: '单位', dataIndex: 'organization', hidden: isMobile },
            { title: '需求类型', dataIndex: 'demandType', width: 100, hidden: isMobile },
            { title: '需求描述', dataIndex: 'demandDesc', ellipsis: true, hidden: isMobile },
            {
              title: '状态',
              dataIndex: 'status',
              width: 120,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (status: string, row: any) => (
                <Select
                  size="small"
                  value={status || '待联系'}
                  style={{ width: 100 }}
                  onChange={(v) => changeStatus(row.bookingNo, v)}
                  options={[
                    { label: '待联系', value: '待联系' },
                    { label: '已联系', value: '已联系' },
                    { label: '已完成', value: '已完成' },
                    { label: '已取消', value: '已取消' },
                  ]}
                />
              ),
            },
            { title: '时间', dataIndex: 'createdAt', width: 170, hidden: isMobile,
              render: (v: string) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
            },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
