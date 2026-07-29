/**
 * PC Web 用户端 — 专家投票详情页（P0-2B-1，只读）
 *
 * ?action=pay 时自动打开 PaymentModal（提交完成跳过来后用）
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import {
  Card, Tag, Typography, Space, Button, Descriptions, Spin, Empty, Alert, Tooltip, message, Modal,
} from 'antd'
import { ArrowLeftOutlined, CalendarOutlined, DownloadOutlined, DeleteOutlined, StopOutlined } from '@ant-design/icons'
import { getExpertVote, cancelExpertVote, deleteExpertVoteDraft } from '../../api/app'
import { nodeApi } from '../../api/client'
import PaymentModal, { type PaymentRequest } from '../../components/PaymentModal'
import { getExpertVoteStatusColor, getExpertVoteStatusLabel } from '../../utils/expertVoteUi'
import { formatCnyFromCents } from '../../utils/format'

const { Title, Text } = Typography

const SLOT_LABEL: Record<string, string> = {
  MORNING: '上午', AFTERNOON: '下午', EVENING: '晚上', ANY: '全天均可',
}

export default function ExpertVoteDetailPage() {
  const { no } = useParams<{ no: string }>()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [payOpen, setPayOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = async () => {
    if (!no) return
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await getExpertVote(no)
      setData(d)
      // ?action=pay 自动开支付
      if (search.get('action') === 'pay' && d?.status === 'PAYING' && d?.orderNo) {
        setPayOpen(true)
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load() }, [no])

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
  if (!data) return <Empty description="申请不存在" />

  const status: string = data.status
  // 主按钮：仅 MEETING_SCHEDULED 把"查看会议"作为 primary
  const showMeetingPrimary = status === 'MEETING_SCHEDULED'
  // 次链接：会议已定 / 会后整理 / 整理完成 / 确认中 / 已完成 都允许作为历史记录查看
  const showMeetingHistory = ['VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(status)
  const hasFinalFile = !!(data.finalDeliverableReady || data.finalDeliverablePath || data.signedPdfPath)
  const finalDeliverableFileName = data.finalDeliverableFileName || `${data.requestNo}_专家评审最终交付文件`
  const showDownloadPrimary = status === 'COMPLETED' && hasFinalFile

  // EXPERT_VOTE 不在 createOrderSchema 白名单里（见 services/api/src/appRoutes.ts:2644-2652）。
  // 专家评审订单由 POST /api/app/expert-votes 提交时一并创建，前端拿到 orderNo 走 existingOrderNo
  // 直接发起支付（PaymentModal 在 existingOrderNo 存在时跳过 createOrder）。
  // productType 仅作前端标签用途，不会发到 /api/app/orders。
  const paymentReq: PaymentRequest | null = (status === 'PAYING' && data.orderNo) ? {
    productType: 'EXPERT_VOTE',
    productRef: data.requestNo,
    title: `专家评审投票 · ${data.projectName}`,
    amount: data.totalAmount,  // 分
  } : null

  const handleDownloadFinal = async () => {
    setDownloading(true)
    try {
      const resp = await nodeApi.get(`/api/app/expert-votes/${no}/download-final`, { responseType: 'blob' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = resp instanceof Blob ? resp : new Blob([resp as any])
      const ext = blob.type.includes('pdf') ? '.pdf' : '.docx'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${no}_专家评审最终交付文件${ext}`
      a.click()
      URL.revokeObjectURL(url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '下载失败，请稍后重试')
    }
    setDownloading(false)
  }

  const handleCancel = () => {
    Modal.confirm({
      title: '确认取消申请',
      content: '取消后将退款（订单进入取消流程），确认取消吗？',
      okText: '确认取消',
      okButtonProps: { danger: true },
      cancelText: '暂不取消',
      onOk: async () => {
        setCancelling(true)
        try {
          await cancelExpertVote(no!)
          message.success('申请已取消')
          setTimeout(load, 400)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '取消失败')
        }
        setCancelling(false)
      },
    })
  }

  const handleDelete = () => {
    Modal.confirm({
      title: '确认删除申请',
      content: '删除后数据不可恢复，确认删除吗？',
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        try {
          await deleteExpertVoteDraft(no!)
          message.success('申请已删除')
          navigate('/expert-vote', { replace: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '删除失败')
          setDeleting(false)
        }
      },
    })
  }

  const handleOpenPay = () => {
    if (!paymentReq) return
    setPayOpen(true)
  }
  const handlePaySuccess = () => {
    setPayOpen(false)
    // 清掉 ?action=pay
    const next = new URLSearchParams(search)
    next.delete('action'); next.delete('orderNo')
    setSearch(next, { replace: true })
    setTimeout(load, 600)
  }

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/expert-vote')}>返回列表</Button>
          <Title level={4} style={{ margin: 0 }}>{data.projectName}</Title>
          <Tag color={getExpertVoteStatusColor(status)}>{getExpertVoteStatusLabel(status)}</Tag>
        </Space>
        <Space>
          {status === 'DRAFT' && (
            <Link to={`/expert-vote/new?no=${no}`}>
              <Button type="primary">继续填写</Button>
            </Link>
          )}
          {status === 'PAYING' && data.orderNo && (
            <Button type="primary" onClick={handleOpenPay}>去支付</Button>
          )}
          {status === 'PAYING' && (
            <Button danger icon={<StopOutlined />} loading={cancelling} onClick={handleCancel}>
              取消申请
            </Button>
          )}
          {showMeetingPrimary && (
            <Link to={`/expert-vote/${no}/meeting`}>
              <Button type="primary" icon={<CalendarOutlined />}>查看会议</Button>
            </Link>
          )}
          {showDownloadPrimary && (
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloading}
              onClick={handleDownloadFinal}
            >
              下载最终交付文件
            </Button>
          )}
          {showMeetingHistory && (
            <Link to={`/expert-vote/${no}/meeting`}>
              <Button icon={<CalendarOutlined />}>会议信息</Button>
            </Link>
          )}
          {(status === 'CANCELLED' || status === 'COMPLETED') && (
            <Button danger icon={<DeleteOutlined />} loading={deleting} onClick={handleDelete}>
              删除记录
            </Button>
          )}
        </Space>
      </Space>

      <Text type="secondary">申请编号：<Text code>{data.requestNo}</Text></Text>

      {status === 'PAYING' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="warning"
          message="申请尚未支付，支付完成后平台才会组织专家。" />
      )}
      {status === 'EXPERT_ARRANGING' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="info"
          message="平台正在为您组织专家并安排会议，会议确认后您将收到站内消息。" />
      )}
      {status === 'MEETING_SCHEDULED' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="info"
          message="会议已安排，请查看会议详情并按时参会。" />
      )}
      {status === 'VOTING' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="info"
          message="会议已结束，专家意见与投票结果正在整理中，请耐心等待。" />
      )}
      {status === 'VOTED' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="info"
          message="结果整理完成，确认文件正在处理中。" />
      )}
      {status === 'SIGNING' && (
        <Alert style={{ marginTop: 16, marginBottom: 16 }} type="info"
          message="确认文件正在处理中，完成后可下载最终交付文件。" />
      )}
      {status === 'COMPLETED' && (
        <Alert
          style={{ marginTop: 16, marginBottom: 16 }}
          type="success"
          showIcon
          message="专家评审意见与投票结果确认文件已完成"
          description={hasFinalFile ? `最终交付文件已上传：${finalDeliverableFileName}` : '最终交付文件暂未上传，请等待平台交付。'}
          action={
            hasFinalFile ? (
              <Button size="small" icon={<DownloadOutlined />} loading={downloading} onClick={handleDownloadFinal}>
                下载最终交付文件
              </Button>
            ) : (
              <Tooltip title="最终交付文件暂未上传">
                <Button size="small" icon={<DownloadOutlined />} disabled>
                  下载最终交付文件
                </Button>
              </Tooltip>
            )
          }
        />
      )}
      {status === 'REFUNDED' && (
        <Alert
          style={{ marginTop: 16, marginBottom: 16 }}
          type="warning"
          showIcon
          message="本申请已退款，金额已原路退回，预计 1-3 个工作日到账。"
        />
      )}

      <Card title="申请基础信息" style={{ marginBottom: 16, marginTop: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
          <Descriptions.Item label="评审项目">{data.projectName}</Descriptions.Item>
          <Descriptions.Item label="标准/项目">{data.targetName}</Descriptions.Item>
          <Descriptions.Item label="项目类型">{data.projectType}</Descriptions.Item>
          <Descriptions.Item label="标准类型">{data.standardType}</Descriptions.Item>
          <Descriptions.Item label="标准状态">{data.standardStatus}</Descriptions.Item>
          <Descriptions.Item label="所属行业">
            {Array.isArray(data.industries) && data.industries.length ? data.industries.join('、') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="专业关键词" span={3}>{data.keywords || '-'}</Descriptions.Item>
          <Descriptions.Item label="起草单位" span={3}>{data.draftingOrgs || '-'}</Descriptions.Item>
          <Descriptions.Item label="参与单位" span={3}>{data.participatingOrgs || '-'}</Descriptions.Item>
          <Descriptions.Item label="项目背景" span={3}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{data.backgroundDesc}</div>
          </Descriptions.Item>
          <Descriptions.Item label="争议点 / 需专家判断" span={3}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{data.disputePoints || '-'}</div>
          </Descriptions.Item>
          <Descriptions.Item label="期望完成时间">
            {data.expectedFinishAt ? new Date(data.expectedFinishAt).toLocaleDateString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="是否涉密" span={2}>
            {data.confidentialLevel === 'NONE' ? '否' : data.confidentialLevel === 'SENSITIVE' ? '一般敏感' : data.confidentialLevel === 'STRICT' ? '严格保密' : '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="专家需求" style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
          <Descriptions.Item label="专家来源">
            {data.expertSourceType === 'PLATFORM' ? '平台匹配' : '用户指定'}
          </Descriptions.Item>
          <Descriptions.Item label="专家数量">{data.expertCount} 位</Descriptions.Item>
          <Descriptions.Item label="专家类别">
            {Array.isArray(data.expertCategories) && data.expertCategories.length ? data.expertCategories.join('、') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="职称要求">
            {Array.isArray(data.titleRequirements) ? data.titleRequirements.join('、') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="单位背景">
            {Array.isArray(data.orgBackgroundRequirements) ? data.orgBackgroundRequirements.join('、') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="期望日期">
            {data.desiredDate ? new Date(data.desiredDate).toLocaleDateString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="期望时间段">{SLOT_LABEL[data.desiredSlot] || data.desiredSlot || '-'}</Descriptions.Item>
          <Descriptions.Item label="是否接受调剂">{data.acceptReschedule ? '是' : '否'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title={`上传材料（${(data.attachments || []).length}）`} style={{ marginBottom: 16 }}>
        {(data.attachments || []).length === 0 ? (
          <Empty description="暂无材料" />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {(data.attachments || []).map((a: any) => (
              <div key={a.id}>
                <Tag>{a.category === 'MAIN' ? '主要材料' : '辅助材料'}</Tag>
                <Text>{a.originalName}</Text>
                <Text type="secondary"> · {(a.size / 1024).toFixed(1)} KB</Text>
              </div>
            ))}
          </Space>
        )}
      </Card>

      <Card title="订单信息" style={{ marginBottom: 16 }}>
        <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
          <Descriptions.Item label="订单号"><Text code>{data.orderNo || '未生成'}</Text></Descriptions.Item>
          <Descriptions.Item label="金额">
            {formatCnyFromCents(data.totalAmount)}
          </Descriptions.Item>
          <Descriptions.Item label="提交时间">
            {data.submittedAt ? new Date(data.submittedAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label="支付时间">
            {data.paidAt ? new Date(data.paidAt).toLocaleString('zh-CN') : '-'}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <PaymentModal
        open={payOpen}
        payment={paymentReq}
        existingOrderNo={data.orderNo || undefined}
        onClose={() => setPayOpen(false)}
        onSuccess={handlePaySuccess}
      />
    </div>
  )
}
