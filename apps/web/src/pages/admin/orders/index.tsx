/**
 * 管理后台 — 订单管理
 * 功能：日期范围筛选、状态筛选、批量确认/驳回、二次确认弹窗
 */
import { useState, useEffect, useCallback } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Tag, Typography, Button, Space, Select, Modal, Image, message, Badge, DatePicker, Tooltip, Input } from 'antd'
import { ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined, EyeOutlined, ExclamationCircleOutlined, RollbackOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'
import dayjs from 'dayjs'
import { canRefundOrder } from '../../../utils/expertVoteUi'
import { formatCnyFromCents, formatDateTime } from '../../../utils/format'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

const STATUS_OPTIONS = [
  { label: '全部', value: '' },
  { label: '待支付', value: 'PENDING' },
  { label: '支付中', value: 'PAYING' },
  { label: '待确认凭证', value: 'PENDING_VERIFY' },
  { label: '已支付', value: 'PAID' },
  { label: '已取消', value: 'CANCELLED' },
  { label: '支付失败', value: 'FAILED' },
  { label: '已退款', value: 'REFUNDED' },
]

const STATUS_COLOR: Record<string, string> = {
  PAID: 'green', PENDING: 'orange', PAYING: 'blue',
  PENDING_VERIFY: 'geekblue', CANCELLED: 'default', FAILED: 'red', REFUNDED: 'purple',
}

const STATUS_TEXT: Record<string, string> = {
  PAID: '已支付', PENDING: '待支付', PAYING: '支付中',
  PENDING_VERIFY: '待确认', CANCELLED: '已取消', FAILED: '支付失败', REFUNDED: '已退款',
}

interface AdminOrder {
  orderNo: string
  status: string
  productType?: string | null
  expertVoteRequestStatus?: string | null
  amount?: number | null
  title?: string | null
  createdAt?: string | null
  receiptImage?: string | null
  user?: {
    name?: string | null
    phone?: string | null
  } | null
}

interface ApiErrorLike {
  response?: {
    data?: {
      error?: string
    }
  }
}

function getErrorMessage(e: unknown, fallback: string) {
  const err = e as ApiErrorLike
  return err?.response?.data?.error || fallback
}

export default function AdminOrdersPage() {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<AdminOrder[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [receiptModal, setReceiptModal] = useState<{ open: boolean; orderNo: string; url: string }>({ open: false, orderNo: '', url: '' })
  const [confirming, setConfirming] = useState('')
  const [rejecting, setRejecting] = useState('')
  const [refunding, setRefunding] = useState('')
  const [refundTarget, setRefundTarget] = useState<{ open: boolean; orders: AdminOrder[] }>({ open: false, orders: [] })
  const [refundReason, setRefundReason] = useState('')
  const [refundReasonError, setRefundReasonError] = useState('')
  const [batchLoading, setBatchLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/orders')
      setItems(res?.items || [])
      setSelectedRowKeys([])
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  // 筛选逻辑
  const filtered = items.filter((i) => {
    if (filter && i.status !== filter) return false
    if (dateRange) {
      const t = dayjs(i.createdAt)
      if (t.isBefore(dateRange[0], 'day') || t.isAfter(dateRange[1], 'day')) return false
    }
    if (keyword) {
      const k = keyword.toLowerCase()
      const hit =
        (i.orderNo || '').toLowerCase().includes(k) ||
        (i.user?.name || '').toLowerCase().includes(k) ||
        (i.user?.phone || '').toLowerCase().includes(k)
      if (!hit) return false
    }
    return true
  })

  const pendingVerifyCount = items.filter(i => i.status === 'PENDING_VERIFY').length

  const viewReceipt = async (orderNo: string) => {
    setReceiptModal({ open: true, orderNo, url: '' })
    try {
      const resp = await nodeApi.get(`/api/admin/orders/${orderNo}/receipt`, { responseType: 'blob' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = resp instanceof Blob ? resp : new Blob([resp as any])
      setReceiptModal((prev) => ({ ...prev, url: URL.createObjectURL(blob) }))
    } catch { message.error('凭证图片加载失败') }
  }

  // 二次确认弹窗包装
  const confirmReceiptWithModal = (orderNo: string) => {
    Modal.confirm({
      title: '确认支付',
      icon: <ExclamationCircleOutlined />,
      content: `确认将订单 ${orderNo} 标记为已支付？此操作将为用户开通对应权益，请确保已核实凭证真实性。`,
      okText: '确认支付',
      okType: 'primary',
      cancelText: '取消',
      onOk: () => doConfirm(orderNo),
    })
  }

  const doConfirm = async (orderNo: string) => {
    setConfirming(orderNo)
    try {
      await nodeApi.post(`/api/admin/orders/${orderNo}/confirm`)
      message.success('已确认支付')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '确认失败') }
    setConfirming('')
  }

  const rejectReceiptWithModal = (orderNo: string) => {
    Modal.confirm({
      title: '驳回凭证',
      icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
      content: `确认驳回订单 ${orderNo} 的支付凭证？订单将恢复为待支付状态。`,
      okText: '驳回',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => doReject(orderNo),
    })
  }

  const doReject = async (orderNo: string) => {
    setRejecting(orderNo)
    try {
      await nodeApi.post(`/api/admin/orders/${orderNo}/reject-receipt`)
      message.success('已驳回凭证')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { message.error(e?.response?.data?.error || '驳回失败') }
    setRejecting('')
  }

  const openRefundModal = (orders: AdminOrder[]) => {
    setRefundTarget({ open: true, orders })
    setRefundReason('')
    setRefundReasonError('')
  }

  const closeRefundModal = () => {
    if (refunding) return
    setRefundTarget({ open: false, orders: [] })
    setRefundReason('')
    setRefundReasonError('')
  }

  const submitRefund = async () => {
    const reason = refundReason.trim()
    if (!reason) {
      setRefundReasonError('请填写退款原因')
      return
    }
    const orders = refundTarget.orders.filter(canRefundOrder)
    if (orders.length === 0) {
      setRefundReasonError('当前选择中没有可退款订单')
      return
    }
    const isBatch = orders.length > 1
    setRefunding(isBatch ? '__batch__' : orders[0].orderNo)
    setBatchLoading(isBatch)
    let ok = 0
    let fail = 0
    for (const order of orders) {
      try {
        await nodeApi.post(`/api/admin/orders/${order.orderNo}/refund`, { reason })
        ok++
      } catch (e: unknown) {
        fail++
        if (!isBatch) message.error(getErrorMessage(e, '退款失败'))
      }
    }
    if (isBatch) {
      message.success(`批量退款完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`)
    } else if (ok === 1) {
      message.success('退款成功')
    }
    setRefunding('')
    setBatchLoading(false)
    setRefundTarget({ open: false, orders: [] })
    setRefundReason('')
    setRefundReasonError('')
    load()
  }

  // 批量操作
  const selectedPendingVerify = selectedRowKeys.filter(key =>
    items.find(i => i.orderNo === key && i.status === 'PENDING_VERIFY')
  )
  const selectedRefundable = selectedRowKeys.filter(key =>
    canRefundOrder(items.find(i => i.orderNo === key))
  )
  const selectedPaidTotal = items
    .filter(i => selectedRefundable.includes(i.orderNo))
    .reduce((sum, i) => sum + (i.amount || 0), 0)

  const batchConfirm = () => {
    if (selectedPendingVerify.length === 0) return message.warning('请选择待确认的订单')
    Modal.confirm({
      title: '批量确认支付',
      icon: <ExclamationCircleOutlined />,
      content: `确认将选中的 ${selectedPendingVerify.length} 个订单标记为已支付？此操作不可撤销。`,
      okText: `确认 ${selectedPendingVerify.length} 个`,
      okType: 'primary',
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true)
        let ok = 0, fail = 0
        for (const orderNo of selectedPendingVerify) {
          try {
            await nodeApi.post(`/api/admin/orders/${orderNo}/confirm`)
            ok++
          } catch { fail++ }
        }
        message.success(`批量确认完成：${ok} 成功${fail ? `，${fail} 失败` : ''}`)
        setBatchLoading(false)
        load()
      },
    })
  }

  const batchReject = () => {
    if (selectedPendingVerify.length === 0) return message.warning('请选择待确认的订单')
    Modal.confirm({
      title: '批量驳回凭证',
      icon: <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />,
      content: `确认驳回选中的 ${selectedPendingVerify.length} 个订单的凭证？订单将恢复为待支付状态。`,
      okText: `驳回 ${selectedPendingVerify.length} 个`,
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setBatchLoading(true)
        let ok = 0, fail = 0
        for (const orderNo of selectedPendingVerify) {
          try {
            await nodeApi.post(`/api/admin/orders/${orderNo}/reject-receipt`)
            ok++
          } catch { fail++ }
        }
        message.success(`批量驳回完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`)
        setBatchLoading(false)
        load()
      },
    })
  }

  const batchRefund = () => {
    const orders = items.filter(i => selectedRefundable.includes(i.orderNo))
    if (orders.length === 0) return message.warning('请选择可退款的已支付订单')
    openRefundModal(orders)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Title level={4} style={{ margin: 0 }}>订单管理</Title>
          {pendingVerifyCount > 0 && (
            <Badge count={pendingVerifyCount} style={{ backgroundColor: '#1677ff' }}>
              <Button size="small" type="link" onClick={() => setFilter('PENDING_VERIFY')}>待审核凭证</Button>
            </Badge>
          )}
        </Space>
        <Space wrap>
          <Input.Search
            placeholder="搜索订单号 / 用户姓名 / 手机号"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            style={{ width: 240 }}
          />
          <RangePicker
            value={dateRange}
            onChange={(v) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              setDateRange(v as any)
            }
            placeholder={['开始日期', '结束日期']}
            allowClear
          />
          <Select
            placeholder="筛选状态" allowClear
            value={filter || undefined}
            onChange={(v) => setFilter(v || '')}
            style={{ width: 140 }}
            options={STATUS_OPTIONS.filter(o => o.value !== '')}
          />
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Space>

      {/* 批量操作栏 */}
      {selectedRowKeys.length > 0 && (
        <Card size="small" style={{ marginBottom: 12, background: '#f0f5ff', border: '1px solid #d6e4ff' }}>
          <Space>
            <Text>已选 <Text strong>{selectedRowKeys.length}</Text> 项</Text>
            {selectedPendingVerify.length > 0 && (
              <>
                <Button type="primary" size="small" icon={<CheckCircleOutlined />}
                  loading={batchLoading} onClick={batchConfirm}>
                  批量确认 ({selectedPendingVerify.length})
                </Button>
                <Button danger size="small" icon={<CloseCircleOutlined />}
                  loading={batchLoading} onClick={batchReject}>
                  批量驳回 ({selectedPendingVerify.length})
                </Button>
              </>
            )}
            {selectedRefundable.length > 0 && (
              <Button danger size="small" icon={<RollbackOutlined />}
                loading={batchLoading} onClick={batchRefund}>
                批量退款 ({selectedRefundable.length}) {formatCnyFromCents(selectedPaidTotal)}
              </Button>
            )}
            <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
          </Space>
        </Card>
      )}

      <Card>
        <Table
          rowKey="orderNo"
          dataSource={filtered}
          loading={loading}
          size="middle"
          scroll={{ x: 1200 }}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
          }}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          columns={[
            { title: '订单号', dataIndex: 'orderNo', width: 180, ellipsis: true, hidden: isMobile },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { title: '用户', dataIndex: ['user', 'phone'], width: 120, render: (phone: string, r: any) => (
              <span>{r.user?.name || '-'}<br /><Text type="secondary" style={{ fontSize: 12 }}>{phone}</Text></span>
            )},
            { title: '商品', dataIndex: 'title', width: 180, ellipsis: { showTitle: false }, hidden: isMobile,
              render: (v: string) => v ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip> : '-',
            },
            { title: '类型', dataIndex: 'productType', width: 110, hidden: isMobile, render: (t: string) => {
              const map: Record<string, string> = { MEMBERSHIP: '会员', COMPARE_REPORT: '比对报告', STANDARD_DOWNLOAD: '标准下载', COMPARE_EXPORT: '导出', EXPERT_VOTE: '专家评审' }
              return map[t] || t
            }},
            { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => <strong style={{ color: '#cf1322' }}>{formatCnyFromCents(v)}</strong> },
            { title: '渠道', dataIndex: 'channel', width: 80, hidden: isMobile, render: (c: string) => c === 'WECHAT' ? '微信' : c === 'ALIPAY' ? '支付宝' : c || '-' },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => (
              <Tag color={STATUS_COLOR[s] || 'default'}>{STATUS_TEXT[s] || s}</Tag>
            )},
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { title: '凭证', width: 80, hidden: isMobile, render: (_: any, r: any) => r.receiptImage ? (
              <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => viewReceipt(r.orderNo)}>查看</Button>
            ) : <Text type="secondary">-</Text> },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { title: '操作', width: 180, fixed: 'right' as const, render: (_: any, r: any) => {
              if (r.status === 'PENDING_VERIFY') {
                return (
                  <Space>
                    <Button type="primary" size="small" icon={<CheckCircleOutlined />}
                      loading={confirming === r.orderNo}
                      onClick={() => confirmReceiptWithModal(r.orderNo)}>
                      确认
                    </Button>
                    <Button danger size="small" icon={<CloseCircleOutlined />}
                      loading={rejecting === r.orderNo}
                      onClick={() => rejectReceiptWithModal(r.orderNo)}>
                      驳回
                    </Button>
                  </Space>
                )
              }
              if (r.status === 'PAID') {
                if (r.productType === 'EXPERT_VOTE' && !canRefundOrder(r)) return null
                return (
                  <Button
                    danger
                    size="small"
                    icon={<RollbackOutlined />}
                    loading={refunding === r.orderNo}
                    onClick={() => openRefundModal([r])}
                  >
                    退款
                  </Button>
                )
              }
              return null
            }},
            { title: '创建时间', dataIndex: 'createdAt', width: 170, hidden: isMobile,
              render: (v: string) => formatDateTime(v),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              sorter: (a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
              defaultSortOrder: 'descend' as const,
            },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ].filter(c => !('hidden' in c && (c as any).hidden))}
        />
      </Card>

      <Modal open={receiptModal.open} title={`支付凭证 - ${receiptModal.orderNo}`}
        onCancel={() => setReceiptModal({ open: false, orderNo: '', url: '' })} footer={null} width={520}>
        {receiptModal.url && (
          <div style={{ textAlign: 'center' }}>
            <Image src={receiptModal.url} alt="支付凭证" style={{ maxWidth: '100%', maxHeight: 600 }}
              fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='120'%3E%3Crect fill='%23f5f5f5' width='200' height='120'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999'%3E图片加载失败%3C/text%3E%3C/svg%3E" />
          </div>
        )}
      </Modal>

      <Modal
        open={refundTarget.open}
        title={refundTarget.orders.length > 1 ? '批量退款' : '确认退款'}
        okText={refundTarget.orders.length > 1 ? `退款 ${refundTarget.orders.length} 笔` : '确认退款'}
        okType="danger"
        cancelText="取消"
        onCancel={closeRefundModal}
        onOk={submitRefund}
        okButtonProps={{ loading: !!refunding }}
        cancelButtonProps={{ disabled: !!refunding }}
      >
        {refundTarget.orders.length > 0 && (
          <div>
            {refundTarget.orders.length === 1 ? (
              <>
                <p>订单 <strong>{refundTarget.orders[0].orderNo}</strong></p>
                <p>商品：{refundTarget.orders[0].title}</p>
                <p>金额：<strong style={{ color: '#cf1322' }}>{formatCnyFromCents(refundTarget.orders[0].amount ?? 0)}</strong>（全额退款）</p>
              </>
            ) : (
              <p>选中 <strong>{refundTarget.orders.length}</strong> 笔可退款订单，合计金额 <strong style={{ color: '#cf1322' }}>{formatCnyFromCents(refundTarget.orders.reduce((sum, i) => sum + (i.amount || 0), 0))}</strong></p>
            )}
            <p style={{ color: '#ff4d4f' }}>退款后将撤销对应权益，此操作不可撤销。</p>
            <Input.TextArea
              rows={3}
              maxLength={500}
              showCount
              value={refundReason}
              disabled={!!refunding}
              placeholder="请填写退款原因"
              onChange={(e) => {
                setRefundReason(e.target.value)
                if (e.target.value.trim()) setRefundReasonError('')
              }}
            />
            {refundReasonError && <Text type="danger" style={{ display: 'block', marginTop: 8 }}>{refundReasonError}</Text>}
          </div>
        )}
      </Modal>
    </div>
  )
}
