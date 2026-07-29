/**
 * 销售数据看板（admin / superAdmin only）
 *
 * 顶部汇总卡片 + 销售明细表 + 「查看订单明细」抽屉
 *
 * 数据来源：GET /api/admin/sales/overview
 *           GET /api/admin/sales/overview/:salesCode/orders
 *
 * 权限：requireAdmin（后端拒绝 sales）；前端 sales 访问由 ProtectedRoute 兜底重定向到 workspace
 */
import { useEffect, useState } from 'react'
import {
  Card, Typography, Table, Statistic, Row, Col, Space, Button, Drawer, Tag, message, Empty,
} from 'antd'
import { ReloadOutlined, ProfileOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../../api/client'
import { usePermission } from '../../../../contexts/PermissionContext'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'

const { Title, Text } = Typography

interface OverviewItem {
  profileId: string
  salesCode: string
  realName: string
  companyName: string | null
  status: string
  isPublic: boolean
  registerCount: number
  paidUserCount: number
  paidAmount: number          // 分
  lastRegisterAt: string | null
  lastPaidAt: string | null
}

interface OverviewResponse {
  summary: {
    salesCount: number
    totalRegistered: number
    totalPaidUsers: number
    totalPaidAmount: number   // 分
  }
  items: OverviewItem[]
}

interface OrderRow {
  orderNo: string
  productType: string
  title: string
  amount: number
  paidAt: string | null
  createdAt: string
  user: { phone: string | null; name: string | null }
}

export default function AdminSalesOverviewPage() {
  const perm = usePermission()
  const nav = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<OverviewResponse | null>(null)

  // 销售 redirect 兜底：万一 ProtectedRoute 漏拦,这里再判一次（前端二道防线，后端 403 是最终保护）
  // 三信号识别（含 AdminUserRole 销售 / SalesProfile），覆盖 role=user 但分配了销售角色的 staff
  useEffect(() => {
    if (perm.isSales) {
      nav('/admin/sales/workspace', { replace: true })
    }
  }, [perm.isSales, nav])

  const [orderDrawer, setOrderDrawer] = useState<{
    open: boolean; salesCode: string; realName: string; loading: boolean; items: OrderRow[]
  }>({
    open: false, salesCode: '', realName: '', loading: false, items: [],
  })

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/sales/overview')
      setData(res)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  const openOrders = async (item: OverviewItem) => {
    setOrderDrawer({ open: true, salesCode: item.salesCode, realName: item.realName, loading: true, items: [] })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get(`/api/admin/sales/overview/${encodeURIComponent(item.salesCode)}/orders`)
      setOrderDrawer((s) => ({ ...s, loading: false, items: res?.items || [] }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载订单失败')
      setOrderDrawer((s) => ({ ...s, loading: false }))
    }
  }

  const fmtMoney = (cents: number) => `¥${(cents / 100).toFixed(2)}`
  const fmtDate = (d: string | null) => d ? dayjs(d).format('YYYY-MM-DD HH:mm') : '-'

  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>销售数据看板</Title>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
      </Space>

      {/* 顶部汇总 */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={24}>
          <Col xs={12} sm={6}>
            <Statistic title="销售数量" value={data?.summary.salesCount ?? 0} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="总注册用户" value={data?.summary.totalRegistered ?? 0} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic title="总付费用户" value={data?.summary.totalPaidUsers ?? 0} valueStyle={{ color: '#52c41a' }} />
          </Col>
          <Col xs={12} sm={6}>
            <Statistic
              title="总付费金额"
              value={data?.summary.totalPaidAmount ? data.summary.totalPaidAmount / 100 : 0}
              precision={2}
              prefix="¥"
              valueStyle={{ color: '#cf1322' }}
            />
          </Col>
        </Row>
        <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
          佣金字段暂未配置。注册数 = AppUser.salesCode 命中；付费用户 = AppOrder.status=PAID 去重；金额单位为分。
        </Text>
      </Card>

      {/* 明细表 */}
      <Card>
        <Table<OverviewItem>
          rowKey="profileId"
          dataSource={data?.items || []}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无销售数据" /> }}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个销售` }}
          columns={[
            { title: '销售姓名', key: 'name', render: (_, r) => (
              <div>
                <div><Text strong>{r.realName}</Text></div>
                {r.companyName && <Text type="secondary" style={{ fontSize: 12 }}>{r.companyName}</Text>}
              </div>
            ) },
            { title: '推广码', dataIndex: 'salesCode', render: (v) => <Tag color="blue">{v}</Tag> },
            { title: '状态', dataIndex: 'status', render: (s, r) => (
              <Space size={4}>
                <Tag color={s === 'ENABLED' ? 'green' : 'default'}>{s === 'ENABLED' ? '启用' : '停用'}</Tag>
                {!r.isPublic && <Tag>未发布</Tag>}
              </Space>
            ) },
            { title: '注册数', dataIndex: 'registerCount', sorter: (a, b) => a.registerCount - b.registerCount },
            { title: '付费人数', dataIndex: 'paidUserCount', sorter: (a, b) => a.paidUserCount - b.paidUserCount },
            { title: '付费金额', dataIndex: 'paidAmount', sorter: (a, b) => a.paidAmount - b.paidAmount,
              render: (v) => <Text strong style={{ color: '#cf1322' }}>{fmtMoney(v)}</Text> },
            { title: '最近注册', dataIndex: 'lastRegisterAt', render: fmtDate },
            { title: '操作', key: 'actions', render: (_, r) => (
              <Button size="small" icon={<ProfileOutlined />} onClick={() => openOrders(r)}>
                查看订单明细
              </Button>
            ) },
          ]}
        />
      </Card>

      {/* 订单明细抽屉 */}
      <Drawer
        title={`订单明细 — ${orderDrawer.realName}（${orderDrawer.salesCode}）`}
        open={orderDrawer.open}
        onClose={() => setOrderDrawer({ ...orderDrawer, open: false })}
        size="large"
      >
        <Table<OrderRow>
          rowKey="orderNo"
          dataSource={orderDrawer.items}
          loading={orderDrawer.loading}
          pagination={false}
          size="small"
          columns={[
            { title: '订单号', dataIndex: 'orderNo', ellipsis: true },
            { title: '商品', dataIndex: 'title' },
            { title: '类型', dataIndex: 'productType', render: (t) => {
              const map: Record<string, string> = { MEMBERSHIP: '会员', COMPARE_REPORT: '比对报告', STANDARD_DOWNLOAD: '标准下载', COMPARE_EXPORT: '导出' }
              return map[t] || t
            } },
            { title: '金额', dataIndex: 'amount', render: fmtMoney },
            { title: '用户', key: 'user', render: (_, r) => <span>{r.user.name || '-'}<br /><Text type="secondary" style={{ fontSize: 12 }}>{r.user.phone || ''}</Text></span> },
            { title: '支付时间', dataIndex: 'paidAt', render: fmtDate },
          ]}
        />
      </Drawer>
    </div>
  )
}
