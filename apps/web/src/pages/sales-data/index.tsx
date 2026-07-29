import { useEffect, useState } from 'react'
import { Card, Table, Typography, Tag, message } from 'antd'
import dayjs from 'dayjs'
import { nodeApi } from '../../api/client'

const { Title, Text } = Typography

interface OrderItem {
  id: string
  orderNo: string
  title: string
  amount: number
  status: string
  createdAt: string
  paidAt: string | null
  planId: string | null
  planName: string | null
  customerPhone: string | null
}

export default function SalesDataPage() {
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<OrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20

  const load = async (p = page) => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/app/sales/data/me?page=${p}&pageSize=${pageSize}`)
      setItems(res.items || [])
      setTotal(res.total || 0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(1) }, [])

  const columns = [
    {
      title: '客户手机号（脱敏）',
      dataIndex: 'customerPhone',
      render: (v: string | null) => v || <Text type="secondary">-</Text>,
    },
    {
      title: '套餐',
      dataIndex: 'planName',
      render: (v: string | null, r: OrderItem) => v || r.title,
    },
    {
      title: '金额',
      dataIndex: 'amount',
      render: (v: number) => <Text strong>¥{(v / 100).toFixed(2)}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (v: string) => <Tag color={v === 'PAID' ? 'green' : 'default'}>{v}</Tag>,
    },
    {
      title: '下单时间',
      dataIndex: 'createdAt',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: '付款时间',
      dataIndex: 'paidAt',
      render: (v: string | null) => v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-',
    },
    {
      title: '订单号',
      dataIndex: 'orderNo',
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
    },
  ]

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>归因订单</Title>
        <Text type="secondary">通过你的推广链接产生的已付款订单</Text>
      </div>

      <Card>
        <Table
          rowKey="id"
          dataSource={items}
          columns={columns}
          loading={loading}
          pagination={{
            current: page, pageSize, total,
            onChange: (p) => { setPage(p); load(p) },
            showSizeChanger: false,
          }}
          scroll={{ x: 900 }}
        />
      </Card>
    </div>
  )
}
