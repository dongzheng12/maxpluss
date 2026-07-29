import { useState, useEffect, useCallback } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Table, Card, Tag, Typography, Button, Space, Empty, Result, Modal, message } from 'antd'
import { ReloadOutlined, FileTextOutlined, LoginOutlined } from '@ant-design/icons'
import { listOrders, cancelOrder } from '../../api/app'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import PaymentModal, { type PaymentRequest } from '../../components/PaymentModal'

const { Title } = Typography

const statusMap: Record<string, { color: string; text: string }> = {
  PENDING: { color: 'orange', text: '待支付' },
  PAYING: { color: 'blue', text: '支付中' },
  PENDING_VERIFY: { color: 'geekblue', text: '待确认' },
  PAID: { color: 'green', text: '已支付' },
  CANCELLED: { color: 'default', text: '已取消' },
  FAILED: { color: 'red', text: '支付失败' },
  REFUNDED: { color: 'red', text: '已退款' },
}

export default function OrdersPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [orders, setOrders] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const nav = useNavigate()
  const { isLoggedIn } = useAuth()

  // PaymentModal 状态
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [paymentReq, setPaymentReq] = useState<PaymentRequest | null>(null)
  const [paymentOrderNo, setPaymentOrderNo] = useState<string | undefined>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await listOrders()
      setOrders(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isLoggedIn) load()
  }, [isLoggedIn, load])

  // 取消订单
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCancel = (order: any) => {
    Modal.confirm({
      title: '确认取消订单？',
      content: `订单「${order.title}」将被取消，取消后如需购买请重新下单。`,
      okText: '确认取消',
      cancelText: '暂不取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await cancelOrder(order.orderNo)
          message.success('订单已取消')
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '取消失败')
        }
      },
    })
  }

  // 继续支付：用 PaymentModal 重新发起（传 existingOrderNo 避免重复创建和误取消）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlePay = (order: any) => {
    setPaymentReq({
      productType: order.productType,
      planId: order.planId,
      productRef: order.productRef,
      title: order.title,
      amount: order.amount,
    })
    setPaymentOrderNo(order.orderNo)
    setPaymentOpen(true)
  }

  const handlePaySuccess = () => {
    message.success('支付成功！')
    load()
  }

  const handlePayClose = () => {
    setPaymentOpen(false)
    setPaymentReq(null)
    setPaymentOrderNo(undefined)
    load()
  }

  // 发票可申请判断：支付成功满 7 天后
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canInvoice = (order: any) => {
    if (order.status !== 'PAID' || !order.paidAt || order.amount <= 0) return false
    if (order.invoiceStatus !== 'NOT_REQUESTED') return false
    const paidMs = new Date(order.paidAt).getTime()
    return Date.now() - paidMs >= 7 * 24 * 60 * 60 * 1000
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoiceCountdownText = (order: any) => {
    if (order.status !== 'PAID' || !order.paidAt || order.amount <= 0) return ''
    if (order.invoiceStatus !== 'NOT_REQUESTED') return ''
    const paidMs = new Date(order.paidAt).getTime()
    const remainMs = (paidMs + 7 * 24 * 60 * 60 * 1000) - Date.now()
    if (remainMs <= 0) return ''
    const days = Math.floor(remainMs / (24 * 60 * 60 * 1000))
    return `支付成功满 7 天后可申请发票（还需 ${days + 1} 天）`
  }

  if (!isLoggedIn) {
    return (
      <Result
        status="403"
        title="请先登录"
        subTitle="登录后可查看您的订单记录"
        extra={<Button type="primary" icon={<LoginOutlined />} onClick={() => nav('/login')}>去登录</Button>}
      />
    )
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>我的订单</Title>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="orderNo"
          dataSource={orders}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无订单" /> }}
          columns={[
            { title: '订单号', dataIndex: 'orderNo', width: isMobile ? 140 : 200, ellipsis: true, hidden: isMobile },
            { title: '商品', dataIndex: 'title' },
            {
              title: '类型', dataIndex: 'productType', width: 130, hidden: isMobile,
              render: (v: string) => {
                const map: Record<string, { text: string; color: string }> = {
                  MEMBERSHIP: { text: '会员开通', color: 'blue' },
                  COMPARE_REPORT: { text: '比对报告', color: 'purple' },
                  COMPARE_EXPORT: { text: '报告导出', color: 'cyan' },
                }
                const m = map[v] || { text: v, color: 'default' }
                return <Tag color={m.color}>{m.text}</Tag>
              },
            },
            { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => `¥${(v / 100).toFixed(2)}` },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (s: string) => {
                const m = statusMap[s] || { color: 'default', text: s }
                return <Tag color={m.color}>{m.text}</Tag>
              },
            },
            {
              title: '创建时间', dataIndex: 'createdAt', width: 180, hidden: isMobile,
              render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-',
            },
            {
              title: '操作', width: isMobile ? 140 : 240,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              render: (_: any, row: any) => (
                <Space>
                  {(row.status === 'PENDING' || row.status === 'PAYING') && (
                    <>
                      <Button size="small" type="primary" onClick={() => handlePay(row)}>
                        {row.status === 'PAYING' ? '继续支付' : '微信支付'}
                      </Button>
                      <Button size="small" danger onClick={() => handleCancel(row)}>
                        取消
                      </Button>
                    </>
                  )}
                  {row.status === 'PAID' && (
                    <>
                      {canInvoice(row) && (
                        <Button size="small" icon={<FileTextOutlined />} onClick={() => nav(`/invoices?orderNo=${row.orderNo}`)}>
                          开票
                        </Button>
                      )}
                      {!canInvoice(row) && row.invoiceStatus === 'NOT_REQUESTED' && row.amount > 0 && (
                        <span style={{ fontSize: 11, color: '#8b99a8' }}>
                          {invoiceCountdownText(row)}
                        </span>
                      )}
                      {row.invoiceStatus === 'REQUESTED' && (
                        <Tag color="processing">发票申请中</Tag>
                      )}
                      {row.invoiceStatus === 'ISSUED' && (
                        <Tag color="success">已开票</Tag>
                      )}
                    </>
                  )}
                  {row.status === 'FAILED' && (
                    <Tag color="red">支付失败</Tag>
                  )}
                  {row.status === 'REFUNDED' && (
                    <Tag color="red">已退款</Tag>
                  )}
                </Space>
              ),
            },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ].filter(c => !('hidden' in c && (c as any).hidden))}
        />
      </Card>

      <PaymentModal
        open={paymentOpen}
        payment={paymentReq}
        existingOrderNo={paymentOrderNo}
        onClose={handlePayClose}
        onSuccess={handlePaySuccess}
      />
    </div>
  )
}
