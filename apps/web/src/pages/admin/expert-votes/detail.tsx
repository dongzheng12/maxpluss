/**
 * 后台 — 专家投票详情页
 *
 * 拆为两个区域：
 *   A. 申请信息总览（只读）：摘要卡 + 申请基础 / 专家需求 / 会议时间偏好 / 申请人订单 / 上传材料
 *   B. 业务处理区（可操作）：专家组织 / 腾讯会议安排
 *
 * 会议字段必填精简到 5 个：标题 / 开始 / 结束 / 链接 / 会议号；
 * 主持人 / 联系方式 / 密码 / 注意事项 一律选填。
 */
import { useEffect, useState } from 'react'
import {
  Card, Tag, Typography, Space, Button, Descriptions, Table, Form, Input, DatePicker,
  message, Spin, Empty, Alert, Modal, Popconfirm, Row, Col, Tooltip, Collapse,
} from 'antd'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeftOutlined, DownloadOutlined, PlusOutlined, DeleteOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import {
  adminGetExpertVote,
  adminSaveExpertVoteArrangement,
  adminConfirmExpertVoteMeeting,
  adminDownloadExpertVoteAttachment,
} from '../../../api/admin'
import { getAdminDisplayStatus } from '../../../utils/expertVoteUi'
import { formatCnyFromCents } from '../../../utils/format'
import ExpertVotePostMeetingSection from './PostMeeting'

const { Title, Text, Paragraph } = Typography

const SLOT_LABEL: Record<string, string> = {
  MORNING: '上午', AFTERNOON: '下午', EVENING: '晚上', ANY: '全天均可',
}
const CONFID_LABEL: Record<string, string> = {
  NONE: '否', SENSITIVE: '一般敏感', STRICT: '严格保密',
}

interface ExpertItem {
  id?: string
  expertName: string
  expertOrg?: string
  expertTitle?: string
  expertField?: string
  expertPhone?: string
  expertEmail?: string
  note?: string
}

export default function AdminExpertVoteDetailPage() {
  const { no } = useParams<{ no: string }>()
  const navigate = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [savingArrangement, setSavingArrangement] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null)
  const [experts, setExperts] = useState<ExpertItem[]>([])
  const [meetingForm] = Form.useForm()

  const load = async () => {
    if (!no) return
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await adminGetExpertVote(no)
      setData(res)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setExperts((res?.experts || []).map((e: any) => ({ ...e })))
      meetingForm.setFieldsValue({
        meetingTitle: res?.meetingTitle || '',
        meetingStartAt: res?.meetingStartAt ? dayjs(res.meetingStartAt) : null,
        meetingEndAt: res?.meetingEndAt ? dayjs(res.meetingEndAt) : null,
        tencentMeetingUrl: res?.tencentMeetingUrl || '',
        tencentMeetingId: res?.tencentMeetingId || '',
        tencentMeetingPwd: res?.tencentMeetingPwd || '',
        meetingHost: res?.meetingHost || '',
        meetingHostContact: res?.meetingHostContact || '',
        meetingNotes: res?.meetingNotes || '',
      })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '加载失败')
    }
    setLoading(false)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleDownloadAttachment = async (att: any) => {
    if (!no || !att?.id) return
    setDownloadingAttachmentId(att.id)
    try {
      const resp = await adminDownloadExpertVoteAttachment(no, att.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = resp instanceof Blob ? resp : new Blob([resp as any])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = att.originalName || 'expert-vote-attachment'
      a.click()
      URL.revokeObjectURL(url)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '材料下载失败，请稍后重试')
    } finally {
      setDownloadingAttachmentId(null)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() /* eslint-disable-next-line */ }, [no])

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
  if (!data) return <Empty description="申请不存在" />

  const status: string = data.status
  const statusDisplay = getAdminDisplayStatus(data)
  const expertEditable = ['EXPERT_ARRANGING', 'MEETING_SCHEDULED'].includes(status)
  const meetingEditable = ['EXPERT_ARRANGING', 'MEETING_SCHEDULED'].includes(status)
  const canConfirm = status === 'EXPERT_ARRANGING'

  // 专家位编号：基础位 = 申请数；超出部分 = 追加位
  const baseExpertCount: number = data.expertCount || 0
  const expertsWithBase = (() => {
    const arr = [...experts]
    while (arr.length < baseExpertCount) arr.push({ expertName: '' })
    return arr
  })()
  const filledExpertCount = expertsWithBase.filter((e) => e.expertName?.trim()).length
  const baseFilledOk = filledExpertCount >= baseExpertCount

  // ──── 业务处理 ────
  const askChangeReason = (title: string, content: string): Promise<string | null> => {
    return new Promise((resolve) => {
      let reason = ''
      Modal.confirm({
        title,
        content: (
          <div>
            <p>{content}</p>
            <Input.TextArea
              rows={3}
              placeholder="请填写修改原因"
              onChange={(e) => { reason = e.target.value }}
            />
          </div>
        ),
        okText: '确认修改',
        cancelText: '取消',
        onOk: () => {
          if (!reason.trim()) {
            message.warning('请填写修改原因')
            return Promise.reject()
          }
          resolve(reason.trim())
        },
        onCancel: () => resolve(null),
      })
    })
  }

  const buildMeetingPayload = () => {
    const v = meetingForm.getFieldsValue()
    return {
      meetingTitle: v.meetingTitle?.trim() || undefined,
      meetingStartAt: v.meetingStartAt ? (v.meetingStartAt as Dayjs).toISOString() : undefined,
      meetingEndAt: v.meetingEndAt ? (v.meetingEndAt as Dayjs).toISOString() : undefined,
      tencentMeetingId: v.tencentMeetingId?.trim() || undefined,
      tencentMeetingUrl: v.tencentMeetingUrl?.trim() || undefined,
      tencentMeetingPwd: v.tencentMeetingPwd?.trim() || undefined,
      meetingHost: v.meetingHost?.trim() || undefined,
      meetingHostContact: v.meetingHostContact?.trim() || undefined,
      meetingNotes: v.meetingNotes?.trim() || undefined,
    }
  }

  const buildExpertPayload = () => expertsWithBase.map((e) => ({
    expertName: e.expertName?.trim(),
    expertOrg: e.expertOrg?.trim() || undefined,
    expertTitle: e.expertTitle?.trim() || undefined,
    expertField: e.expertField?.trim() || undefined,
    expertPhone: e.expertPhone?.trim() || undefined,
    expertEmail: e.expertEmail?.trim() || undefined,
    note: e.note?.trim() || undefined,
  }))

  const handleSaveArrangement = async () => {
    if (!no) return
    const expertPayload = buildExpertPayload()
    if (expertPayload.length === 0) return message.warning('请至少录入 1 位专家')
    for (const e of expertPayload) {
      if (!e.expertName) return message.warning('每位专家必须填写姓名')
    }
    let changeReason: string | null = null
    if (status === 'MEETING_SCHEDULED') {
      changeReason = await askChangeReason(
        '当前会议安排已对用户可见，确定保存修改？',
        '修改专家名单或会议字段前，请确认已与申请人沟通。',
      )
      if (!changeReason) return
    }
    setSavingArrangement(true)
    try {
      await adminSaveExpertVoteArrangement(no, expertPayload, buildMeetingPayload(), changeReason || undefined)
      message.success(
        status === 'MEETING_SCHEDULED'
          ? '安排已保存，请按需重新通知用户与专家'
          : '安排草稿已保存（未确认会议）',
      )
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败')
    }
    setSavingArrangement(false)
  }

  const handleConfirmMeeting = () => {
    if (!no) return
    // 前端先校 5 个必填字段
    const v = meetingForm.getFieldsValue()
    const missing: string[] = []
    if (!v.meetingTitle?.trim()) missing.push('会议主题')
    if (!v.meetingStartAt) missing.push('会议开始时间')
    if (!v.meetingEndAt) missing.push('会议结束时间')
    if (!v.tencentMeetingUrl?.trim()) missing.push('腾讯会议链接')
    if (!v.tencentMeetingId?.trim()) missing.push('腾讯会议号')
    if (missing.length) return message.warning(`请补齐：${missing.join(' / ')}`)

    Modal.confirm({
      title: '确认会议安排？',
      content: '点击确认后，状态将由"专家组织中"变为"会议已定"，并向申请人发送站内消息通知。该动作不可撤销。',
      okText: '确认安排',
      cancelText: '取消',
      onOk: async () => {
        setConfirming(true)
        try {
          await adminConfirmExpertVoteMeeting(no, buildMeetingPayload())
          message.success('会议安排已确认，已通知申请人')
          load()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          message.error(e?.response?.data?.error || '确认失败')
        }
        setConfirming(false)
      },
    })
  }

  // 旧摘要卡字段已废弃（commit 3 改为 sticky bar 7 列）

  return (
    <div>
      {/* ════════════ 顶部 sticky bar ════════════ */}
      <div
        style={{
          background: '#fff',
          borderBottom: '1px solid #E5E7EB',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          marginLeft: -24, marginRight: -24, marginTop: -16, padding: '12px 24px',
          marginBottom: 16,
        }}
      >
        <Space style={{ marginBottom: 12 }}>
          <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => navigate('/admin/expert-votes')}>
            返回
          </Button>
          <Title level={5} style={{ margin: 0 }}>后台详情 — 专家评审投票</Title>
        </Space>
        <Row gutter={16} wrap>
          <Col flex="0 0 auto" style={{ minWidth: 180 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>申请编号</Text>
            <div style={{ fontSize: 13, fontWeight: 500, fontFamily: 'monospace' }}>{data.requestNo}</div>
          </Col>
          <Col flex="2 1 240px" style={{ minWidth: 200 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>评审项目</Text>
            <div style={{ fontSize: 14, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={data.projectName}>
              {data.projectName}
            </div>
          </Col>
          <Col flex="0 0 auto" style={{ minWidth: 130 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>申请人</Text>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{data.applicant?.name || '-'}</div>
          </Col>
          <Col flex="0 0 auto" style={{ minWidth: 130 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>联系电话</Text>
            <div style={{ fontSize: 14 }}>{data.applicant?.phone || '-'}</div>
          </Col>
          <Col flex="0 0 auto" style={{ minWidth: 80 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>专家数量</Text>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{data.expertCount} 位</div>
          </Col>
          <Col flex="0 0 auto" style={{ minWidth: 110 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>订单金额</Text>
            <div style={{ fontSize: 14, fontWeight: 500, color: '#10B981' }}>
              {typeof data.totalAmount === 'number' ? `¥${(data.totalAmount / 100).toLocaleString()}` : '-'}
            </div>
          </Col>
          <Col flex="0 0 auto" style={{ minWidth: 100 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>当前状态</Text>
            <div>
              <Tag color={statusDisplay.color}>{statusDisplay.label}</Tag>
            </div>
          </Col>
        </Row>
      </div>

      {status === 'PAYING' && (
        <Alert style={{ marginBottom: 16 }} type="warning"
          message="申请尚未支付，后台仅查看，不组织专家。" />
      )}

      {status === 'REFUNDED' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="本申请已退款，金额已原路退回。"
          description="该申请已进入退款终态，后续业务处理入口已关闭。"
        />
      )}

      {/* ════════════ 申请信息与材料（顶部折叠）════════════ */}
      <Collapse style={{ marginBottom: 24 }}>
        <Collapse.Panel key="appInfo" header={<Text strong>申请信息与材料</Text>}>
          <Card title="申请基础信息" size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
              <Descriptions.Item label="申请人姓名">{data.contactName || '-'}</Descriptions.Item>
              <Descriptions.Item label="申请人电话">{data.contactPhone || '-'}</Descriptions.Item>
              <Descriptions.Item label="评审项目">{data.projectName}</Descriptions.Item>
              <Descriptions.Item label="项目类型">{data.projectType}</Descriptions.Item>
              <Descriptions.Item label="标准类型">{data.standardType}</Descriptions.Item>
              <Descriptions.Item label="标准状态">{data.standardStatus}</Descriptions.Item>
              <Descriptions.Item label="所属行业" span={2}>
                {Array.isArray(data.industries) && data.industries.length ? data.industries.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="专业领域关键词" span={3}>{data.keywords || '-'}</Descriptions.Item>
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
              <Descriptions.Item label="保密级别">{CONFID_LABEL[data.confidentialLevel] || data.confidentialLevel}</Descriptions.Item>
              <Descriptions.Item label="保密要求说明">{data.confidentialRemark || '-'}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="专家需求" size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
              <Descriptions.Item label="专家来源">
                {data.expertSourceType === 'PLATFORM' ? '平台匹配' : '用户指定'}
              </Descriptions.Item>
              <Descriptions.Item label="专家数量">{data.expertCount}</Descriptions.Item>
              <Descriptions.Item label="专家类别">
                {Array.isArray(data.expertCategories) && data.expertCategories.length ? data.expertCategories.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="职称要求">
                {Array.isArray(data.titleRequirements) ? data.titleRequirements.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="单位背景">
                {Array.isArray(data.orgBackgroundRequirements) ? data.orgBackgroundRequirements.join('、') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="其他要求" span={3}>{data.extraExpertNote || '-'}</Descriptions.Item>
              {data.expertSourceType === 'USER_SPECIFIED' && (
                <Descriptions.Item label="指定专家说明" span={3}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{data.userSpecifiedExperts || '-'}</div>
                </Descriptions.Item>
              )}
            </Descriptions>
          </Card>

          <Card title="会议时间偏好" size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
              <Descriptions.Item label="期望日期">
                {data.desiredDate ? new Date(data.desiredDate).toLocaleDateString('zh-CN') : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="期望时间段">{SLOT_LABEL[data.desiredSlot] || data.desiredSlot || '-'}</Descriptions.Item>
              <Descriptions.Item label="是否接受调剂">{data.acceptReschedule ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="备用时间说明" span={3}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{data.backupTimeNote || '-'}</div>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="申请人与订单" size="small" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} bordered size="small">
              <Descriptions.Item label="申请单位">{data.applicant?.organization || '-'}</Descriptions.Item>
              <Descriptions.Item label="联系人">{data.applicant?.name || '-'}</Descriptions.Item>
              <Descriptions.Item label="手机号">{data.applicant?.phone || '-'}</Descriptions.Item>
              <Descriptions.Item label="邮箱" span={3}>{data.applicant?.email || '-'}</Descriptions.Item>
              <Descriptions.Item label="订单号">{data.order?.orderNo || data.orderNo || '未生成'}</Descriptions.Item>
              <Descriptions.Item label="订单金额">
                {formatCnyFromCents(data.order?.amount)}
              </Descriptions.Item>
              <Descriptions.Item label="订单状态">{data.order?.status || '-'}</Descriptions.Item>
              <Descriptions.Item label="支付时间" span={3}>
                {data.order?.paidAt ? new Date(data.order.paidAt).toLocaleString('zh-CN')
                  : data.paidAt ? new Date(data.paidAt).toLocaleString('zh-CN') : '-'}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title={`上传材料（${(data.attachments || []).length}）`} size="small">
            {(data.attachments || []).length === 0 ? (
              <Empty description="暂无材料" />
            ) : (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={data.attachments}
                columns={[
                  { title: '类别', dataIndex: 'category', width: 90,
                    render: (c: string) => c === 'MAIN' ? '主要材料' : c === 'EXTRA' ? '辅助材料' : c },
                  { title: '文件名', dataIndex: 'originalName' },
                  { title: '大小', dataIndex: 'size', width: 110,
                    render: (s: number) => `${(s / 1024).toFixed(1)} KB` },
                  { title: '上传时间', dataIndex: 'createdAt', width: 170,
                    render: (v: string) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  { title: '操作', key: 'action', width: 100, render: (_: any, row: any) => (
                    <Button
                      type="link"
                      size="small"
                      icon={<DownloadOutlined />}
                      loading={downloadingAttachmentId === row.id}
                      onClick={() => handleDownloadAttachment(row)}
                    >
                      下载
                    </Button>
                  ) },
                ]}
              />
            )}
          </Card>
        </Collapse.Panel>
      </Collapse>

      {/* ════════════ 当前处理事项（EXPERT_ARRANGING / MEETING_SCHEDULED 才展示完整业务处理）════════════ */}
      {(expertEditable || meetingEditable) && (
        <Card
          title={<Text strong style={{ fontSize: 18 }}>当前处理事项</Text>}
          style={{ marginBottom: 24 }}
        >
          {/* 专家组织（基础位 + 追加位）*/}
          <div style={{ marginBottom: 24 }}>
            <Row justify="space-between" align="middle" style={{ marginBottom: 12 }}>
              <Col>
                <Text strong style={{ fontSize: 14 }}>专家名单录入</Text>
                <Text style={{ marginLeft: 12, color: baseFilledOk ? '#10B981' : '#F59E0B' }}>
                  已录入 {filledExpertCount} / {baseExpertCount} 位
                  {!baseFilledOk && <span style={{ marginLeft: 8 }}>还需 {baseExpertCount - filledExpertCount} 位</span>}
                </Text>
              </Col>
            </Row>

            {expertsWithBase.map((row, idx) => {
              const isBase = idx < baseExpertCount
              const onChange = (key: keyof ExpertItem, val: string) => {
                const next = [...expertsWithBase]
                next[idx] = { ...row, [key]: val }
                setExperts(next)
              }
              return (
                <div
                  key={row.id || `idx-${idx}`}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '32px 1.5fr 1.5fr 1fr 1.8fr 1.4fr 1.6fr 36px',
                    gap: 8,
                    padding: 8,
                    background: '#F9FAFB',
                    borderRadius: 6,
                    marginBottom: 8,
                    alignItems: 'center',
                  }}
                >
                  <div style={{ textAlign: 'center', fontSize: 12, color: isBase ? '#1677ff' : '#86909c' }}>
                    {idx + 1}{isBase ? '' : '+'}
                  </div>
                  <Input size="small" placeholder="姓名 *" disabled={!expertEditable}
                    value={row.expertName} onChange={(e) => onChange('expertName', e.target.value)} />
                  <Input size="small" placeholder="单位" disabled={!expertEditable}
                    value={row.expertOrg || ''} onChange={(e) => onChange('expertOrg', e.target.value)} />
                  <Input size="small" placeholder="职称" disabled={!expertEditable}
                    value={row.expertTitle || ''} onChange={(e) => onChange('expertTitle', e.target.value)} />
                  <Input size="small" placeholder="专业方向" disabled={!expertEditable}
                    value={row.expertField || ''} onChange={(e) => onChange('expertField', e.target.value)} />
                  <Input size="small" placeholder="电话" disabled={!expertEditable}
                    value={row.expertPhone || ''} onChange={(e) => onChange('expertPhone', e.target.value)} />
                  <Input size="small" placeholder="邮箱" disabled={!expertEditable}
                    value={row.expertEmail || ''} onChange={(e) => onChange('expertEmail', e.target.value)} />
                  {!isBase && expertEditable ? (
                    <Popconfirm title="删除该追加专家？" onConfirm={() => {
                      const next = [...expertsWithBase]; next.splice(idx, 1); setExperts(next)
                    }}>
                      <Button danger size="small" icon={<DeleteOutlined />} />
                    </Popconfirm>
                  ) : <span />}
                </div>
              )
            })}

            {expertEditable && (
              <Button
                type="link"
                icon={<PlusOutlined />}
                style={{ paddingLeft: 0 }}
                onClick={() => setExperts([...expertsWithBase, { expertName: '' }])}
              >
                添加追加专家
              </Button>
            )}
          </div>

          {/* 腾讯会议安排 */}
          <div style={{ marginBottom: 16 }}>
            <Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>腾讯会议安排</Text>
            <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 16 }}>
              请根据腾讯会议生成的会议信息填写会议主题、会议时间、会议链接和会议号。确认后，用户将在前台看到会议安排。
            </Paragraph>
            <Form form={meetingForm} layout="vertical" disabled={!meetingEditable}>
              <Form.Item label={<>会议主题 <Text type="danger">*</Text></>} name="meetingTitle" style={{ marginBottom: 12 }}>
                <Input placeholder="如 标准小智专项工作组产品知晓会" maxLength={200} />
              </Form.Item>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label={<>会议开始时间 <Text type="danger">*</Text></>} name="meetingStartAt" style={{ marginBottom: 12 }}>
                    <DatePicker showTime style={{ width: '100%' }} format="YYYY-MM-DD HH:mm" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={<>会议结束时间 <Text type="danger">*</Text></>} name="meetingEndAt" style={{ marginBottom: 12 }}>
                    <DatePicker showTime style={{ width: '100%' }} format="YYYY-MM-DD HH:mm" />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label={<>腾讯会议链接 <Text type="danger">*</Text></>} name="tencentMeetingUrl" style={{ marginBottom: 12 }}>
                <Input placeholder="https://meeting.tencent.com/dm/xxxx" maxLength={500} />
              </Form.Item>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label={<>腾讯会议号 <Text type="danger">*</Text></>} name="tencentMeetingId" style={{ marginBottom: 12 }}>
                    <Input placeholder="942-680-019" maxLength={50} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="会议密码" name="tencentMeetingPwd" extra="选填" style={{ marginBottom: 12 }}>
                    <Input maxLength={50} />
                  </Form.Item>
                </Col>
              </Row>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item label="主持人" name="meetingHost" extra="选填" style={{ marginBottom: 12 }}>
                    <Input maxLength={100} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="主持人联系方式" name="meetingHostContact" extra="选填" style={{ marginBottom: 12 }}>
                    <Input maxLength={200} />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label="会议注意事项" name="meetingNotes" extra="选填" style={{ marginBottom: 0 }}>
                <Input.TextArea autoSize={{ minRows: 4, maxRows: 8 }} maxLength={2000} />
              </Form.Item>
            </Form>
            {data.meetingArrangedAt && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                最近一次确认：{new Date(data.meetingArrangedAt).toLocaleString('zh-CN')}
              </Text>
            )}
          </div>

          {/* 底部操作栏（卡片内）*/}
          {(expertEditable || meetingEditable) && (
            <Row
              justify="space-between"
              align="middle"
              style={{ paddingTop: 16, borderTop: '1px solid #E5E7EB' }}
            >
              <Col>
                <Space>
                  {(expertEditable || meetingEditable) && (
                    <Button loading={savingArrangement} onClick={handleSaveArrangement}>
                      保存安排草稿
                    </Button>
                  )}
                </Space>
              </Col>
              <Col>
                {canConfirm && (
                  <Space>
                    {!baseFilledOk && (
                      <Text type="warning">还需录入 {baseExpertCount - filledExpertCount} 位专家</Text>
                    )}
                    <Tooltip title="校验：会议主题 / 开始时间 / 结束时间 / 链接 / 会议号">
                      <Button
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        loading={confirming}
                        disabled={!baseFilledOk}
                        onClick={handleConfirmMeeting}
                      >
                        确认会议安排
                      </Button>
                    </Tooltip>
                  </Space>
                )}
              </Col>
            </Row>
          )}
        </Card>
      )}

      {/* 会议通知 + 会后录入 + Word 确认文件 + 归档（按状态展示，由 PostMeeting 处理）*/}
      <ExpertVotePostMeetingSection no={no!} data={data} experts={experts} reload={load} />
    </div>
  )
}
