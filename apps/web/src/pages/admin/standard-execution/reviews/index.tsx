import { useEffect, useState, useContext } from 'react'
import type { CSSProperties } from 'react'
import { useLocation } from 'react-router-dom'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import { Table, Typography, Button, Space, Select, Input, Tag, message, Drawer, Form, Modal, Descriptions, Divider, List, Tabs, Alert, Spin, Switch } from 'antd'
import { ReloadOutlined, RobotOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  seListReviews,
  seListReviewsEnterprise,
  seGetReview,
  seGetReviewEnterprise,
  seAnalyzeReview,
  seAnalyzeReviewEnterprise,
  seApproveReview,
  seApproveReviewEnterprise,
  seRejectReview,
  seRejectReviewEnterprise,
  seListEnterpriseMembers,
  type ReviewListItem,
  type ReviewAiAnalysis,
  type EnterpriseMember,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_COLOR,
} from '../../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

const { Title, Paragraph, Text } = Typography
const { TextArea } = Input

const enterprisePageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}
const pillButtonStyle: CSSProperties = {
  height: 26,
  border: 0,
  borderRadius: 13,
  padding: '0 12px',
  fontSize: 12,
  fontWeight: 500,
}
const fieldLabelStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 6,
}
const compactControlStyle: CSSProperties = {
  height: 34,
  borderRadius: 6,
}
const tableShellStyle: CSSProperties = {
  width: 720,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}
const sidePanelStyle: CSSProperties = {
  width: 348,
  minHeight: 620,
  background: '#fff',
  border: '1px solid #cbd5e1',
  borderRadius: 8,
  boxShadow: '0 10px 15px rgba(15, 23, 42, 0.1)',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
}

// 合规审核台 Tab：待处理(SUBMITTED，默认) / 已处理(APPROVED+REJECTED)
const REVIEW_TABS = [
  { key: 'todo', label: '待处理' },
  { key: 'done', label: '已处理' },
] as const
type ReviewTabKey = (typeof REVIEW_TABS)[number]['key']
// Tab 默认后端 status；todo 传空 → 后端默认仅 SUBMITTED
const REVIEW_TAB_BACKEND_STATUS: Record<ReviewTabKey, string> = {
  todo: '',
  done: 'APPROVED,REJECTED',
}
// 细分状态下拉（跟随当前 Tab）
const REVIEW_TAB_STATUS_OPTIONS: Record<ReviewTabKey, { value: string; label: string }[]> = {
  todo: [{ value: '', label: '待审核' }],
  done: [{ value: '', label: '全部' }, { value: 'APPROVED', label: '已通过' }, { value: 'REJECTED', label: '已驳回' }],
}
const REVIEW_ACTION_LABEL: Record<string, string> = {
  SUBMIT: '提交审核',
  APPROVE: '审核通过',
  REJECT: '审核驳回',
}
const REVIEW_ACTION_COLOR: Record<string, string> = {
  SUBMIT: 'blue',
  APPROVE: 'green',
  REJECT: 'red',
}

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'mine', label: '指派给我' },
]

const AI_RECOMMENDATION_LABEL: Record<ReviewAiAnalysis['recommendation'], string> = {
  APPROVE: '建议通过',
  REJECT: '建议驳回',
  MANUAL: '需人工判断',
}

const AI_RECOMMENDATION_COLOR: Record<ReviewAiAnalysis['recommendation'], string> = {
  APPROVE: 'green',
  REJECT: 'red',
  MANUAL: 'gold',
}

interface DetailData {
  submission: {
    id: string
    version: number
    isLatest: boolean
    submitText: string
    status: string
    submittedAt: string
    reviewedAt: string | null
    reviewerId: string | null
    reviewComment: string | null
    assigneeId: string
    taskId: string
    submitDataJson?: unknown
  }
  attachments: Array<{ id: string; fileName: string; fileUrl: string; mimeType: string | null; fileSize: number | null }>
  task: {
    id: string
    title: string
    description: string | null
    deadlineAt: string
    reviewerId: string
    taskType?: string | null
    checklistSchema?: { items?: ReviewRequirementSubmitConfig[] } | null
    parametersSchema?: unknown
  }
  requirement: { id: string; title: string; requirementText: string; requiredMaterials?: string[] | null; source: { id: string; title: string } }
  assignee: { id: string; assigneeId: string; status: string } | null
  reviewLogs: Array<{ id: string; action: string; comment: string | null; reviewerId: string; createdAt: string }>
  canApprove: boolean
}

type ReviewSubmitOption = 'TEXT' | 'IMAGE' | 'FILE' | 'STRUCTURED' | 'QUIZ' | 'LEARNING'
interface ReviewRequirementSubmitConfig {
  id: string
  name?: string
  requirementId?: string | null
  requirementTitle?: string | null
  requirementDescription?: string | null
  clauseNo?: string | null
  sourceTitle?: string | null
  required?: boolean
  sort?: number
  submitOptions?: ReviewSubmitOption[]
  textPrompt?: string | null
  attachmentRequired?: boolean
  attachmentMinCount?: number | null
  attachmentMaxCount?: number | null
  attachmentHint?: string | null
  structuredFields?: Array<{ name?: string }>
  quizQuestionCount?: number | null
  quizPassScore?: number | null
  learningMaterials?: Array<{ name?: string }>
}

const REVIEW_REQUIREMENT_SUBMIT_LABEL: Record<ReviewSubmitOption, string> = {
  TEXT: '文本',
  IMAGE: '图片',
  FILE: '文件',
  STRUCTURED: '结构化',
  QUIZ: '答题',
  LEARNING: '学习确认',
}

const normalizeReviewSubmitOptions = (raw: unknown): ReviewSubmitOption[] => {
  const allowed = new Set<ReviewSubmitOption>(Object.keys(REVIEW_REQUIREMENT_SUBMIT_LABEL) as ReviewSubmitOption[])
  const values = Array.isArray(raw) ? raw : ['TEXT', 'IMAGE']
  const normalized = values.filter((value): value is ReviewSubmitOption => allowed.has(value as ReviewSubmitOption))
  return normalized.length ? normalized : ['TEXT', 'IMAGE']
}

export default function SeReviewsPage() {
  const loc = useLocation()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [items, setItems] = useState<ReviewListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState('')
  const [activeTab, setActiveTab] = useState<ReviewTabKey>('todo')
  const [filterScope, setFilterScope] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [members, setMembers] = useState<EnterpriseMember[]>([])

  const memberLabel = (id: string | null | undefined) => {
    if (!id) return '——'
    const m = members.find((mb) => mb.id === id)
    return m ? `${m.nickName || ''}${m.nickName && m.phone ? ' · ' : ''}${m.phone || ''}`.trim() || id.slice(0, 8) : id.slice(0, 8)
  }

  const [detail, setDetail] = useState<DetailData | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [reviewCommentDraft, setReviewCommentDraft] = useState('')
  const [aiAutoEnabled, setAiAutoEnabled] = useState(() => localStorage.getItem('se_review_ai_auto') !== '0')
  const [aiAnalysis, setAiAnalysis] = useState<ReviewAiAnalysis | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectForm] = Form.useForm()
  const [actingId, setActingId] = useState<string | null>(null)
  const [rejectMode, setRejectMode] = useState<'single' | 'batch'>('single')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [batchLoading, setBatchLoading] = useState(false)
  const isTodoTab = activeTab === 'todo'
  const reviewMetrics = {
    pending: items.filter((item) => item.submission.status === 'SUBMITTED').length,
    approved: items.filter((item) => item.submission.status === 'APPROVED').length,
    rejected: items.filter((item) => item.submission.status === 'REJECTED').length,
  }

  const load = async () => {
    setLoading(true)
    try {
      // todo Tab 不传 status（后端默认 SUBMITTED）；done Tab 默认 APPROVED+REJECTED，可按下拉细分
      const backendStatus = filterStatus || REVIEW_TAB_BACKEND_STATUS[activeTab]
      const listReviews = isEnterprise ? seListReviewsEnterprise : seListReviews
      const res = await listReviews({
        status: backendStatus || undefined,
        scope: filterScope,
        keyword: keyword || undefined,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    seListEnterpriseMembers().then((r) => setMembers(r.data)).catch(() => {})
  }, [])
  useEffect(() => { load() }, [page, filterStatus, filterScope, activeTab, isEnterprise])

  const openDetail = async (subId: string) => {
    try {
      const getReview = isEnterprise ? seGetReviewEnterprise : seGetReview
      const res = await getReview(subId)
      setDetail(res.data as DetailData)
      setReviewCommentDraft('')
      setAiAnalysis(null)
      setDetailOpen(true)
    } catch {
      message.error('加载详情失败')
    }
  }
  const closeDetail = () => {
    setDetailOpen(false)
    setDetail(null)
    setReviewCommentDraft('')
    setAiAnalysis(null)
  }
  useEffect(() => {
    if (!isEnterprise || !detail) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDetail()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEnterprise, detail])

  const loadAiAnalysis = async (subId: string) => {
    setAiLoading(true)
    try {
      const analyzeReview = isEnterprise ? seAnalyzeReviewEnterprise : seAnalyzeReview
      const res = await analyzeReview(subId)
      setAiAnalysis(res.data)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || 'AI 分析失败')
    } finally {
      setAiLoading(false)
    }
  }

  useEffect(() => {
    if (!detail || !aiAutoEnabled) return
    loadAiAnalysis(detail.submission.id)
  }, [detail?.submission.id, aiAutoEnabled])

  const handleAiAutoChange = (checked: boolean) => {
    setAiAutoEnabled(checked)
    localStorage.setItem('se_review_ai_auto', checked ? '1' : '0')
  }

  const applyAiSuggestion = () => {
    if (!detail || !aiAnalysis) return
    setReviewCommentDraft(aiAnalysis.suggestedComment)
    if (aiAnalysis.recommendation === 'REJECT') {
      openReject(detail.submission.id, aiAnalysis.suggestedComment)
    } else {
      message.success('已填入审核意见')
    }
  }

  const handleApprove = (subId: string, reviewComment?: string) => {
    Modal.confirm({
      title: '审核通过',
      content: '通过后会自动写入证据库；所有执行人完成后任务自动标为已完成。',
      onOk: async () => {
        try {
          const approveReview = isEnterprise ? seApproveReviewEnterprise : seApproveReview
          await approveReview(subId, { reviewComment })
          message.success('已通过')
          closeDetail()
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const handleBatchApprove = async () => {
    setBatchLoading(true)
    let ok = 0
    const ids = selectedKeys
    const approveReview = isEnterprise ? seApproveReviewEnterprise : seApproveReview
    for (const id of ids) {
      try { await approveReview(id, {}); ok++ } catch { /* skip */ }
    }
    setBatchLoading(false)
    message.success(`已通过 ${ok} / 共 ${ids.length} 个`)
    setSelectedKeys([])
    load()
  }

  const openReject = (subId: string, initialComment?: string) => {
    setRejectMode('single')
    setActingId(subId)
    rejectForm.resetFields()
    if (initialComment) rejectForm.setFieldsValue({ reviewComment: initialComment })
    setRejectOpen(true)
  }
  const openBatchReject = () => {
    setRejectMode('batch')
    setActingId(null)
    rejectForm.resetFields()
    setRejectOpen(true)
  }
  const handleRejectSubmit = async () => {
    try {
      const values = await rejectForm.validateFields()
      const rejectReview = isEnterprise ? seRejectReviewEnterprise : seRejectReview
      if (rejectMode === 'batch') {
        const ids = selectedKeys
        setBatchLoading(true)
        let ok = 0
        for (const id of ids) {
          try { await rejectReview(id, { reviewComment: values.reviewComment }); ok++ } catch { /* skip */ }
        }
        setBatchLoading(false)
        setSelectedKeys([])
        message.success(`已驳回 ${ok} / 共 ${ids.length} 个`)
      } else {
        if (!actingId) return
        await rejectReview(actingId, { reviewComment: values.reviewComment })
        message.success('已驳回')
      }
      setRejectOpen(false)
      closeDetail()
      load()
    } catch (e) {
      setBatchLoading(false)
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const { setData: setSEPageData, triggerAsk } = useContext(SEPageContext)
  useEffect(() => {
    setSEPageData({
      pageKey: 'reviews',
      summary: `当前审核列表（共 ${total} 条）：\n` + items.slice(0, 8).map((r) => `- ${sanitizeSEVisibleText(r.task?.title || r.requirement?.title || '任务')}｜${SUBMISSION_STATUS_LABEL[r.submission?.status] || ''}`).join('\n'),
    })
    return () => setSEPageData(null)
  }, [items, total, setSEPageData])

  const renderRequirementSubmitAudit = (row: DetailData) => {
    const requirementSubmitConfigs = (row.task.checklistSchema?.items || [])
      .filter((item) => item.requirementTitle || item.requirementDescription || item.submitOptions?.length)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    if (!requirementSubmitConfigs.length) return null
    return (
      <>
        <Text strong style={{ color: '#64748b', fontSize: 13, marginTop: 22 }}>要求项提交核对</Text>
        <List
          size="small"
          style={{ marginTop: 8 }}
          dataSource={requirementSubmitConfigs}
          renderItem={(item, index) => {
            const options = normalizeReviewSubmitOptions(item.submitOptions)
            return (
              <List.Item style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '10px 12px', marginBottom: 8 }}>
                <Space direction="vertical" size={5} style={{ width: '100%' }}>
                  <Space wrap>
                    <Text strong>{index + 1}. {sanitizeSEVisibleText(item.requirementTitle || item.name || '未命名要求项')}</Text>
                    {item.required === false ? <Tag>可选</Tag> : <Tag color="blue">必做</Tag>}
                  </Space>
                  {item.requirementDescription && <Text type="secondary" style={{ fontSize: 12 }}>{sanitizeSEVisibleText(item.requirementDescription)}</Text>}
                  <Space wrap>
                    {options.map((option) => <Tag key={option}>{REVIEW_REQUIREMENT_SUBMIT_LABEL[option]}</Tag>)}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {item.textPrompt ? `文本：${sanitizeSEVisibleText(item.textPrompt)}；` : ''}
                    {options.includes('IMAGE') || options.includes('FILE') ? `附件：${item.attachmentRequired === false ? '可选' : `至少 ${item.attachmentMinCount ?? 1} 个`}，最多 ${item.attachmentMaxCount ?? 20} 个${item.attachmentHint ? `，${sanitizeSEVisibleText(item.attachmentHint)}` : ''}` : '无附件要求'}
                  </Text>
                </Space>
              </List.Item>
            )
          }}
        />
      </>
    )
  }

  const renderAiAnalysis = () => {
    if (!detail) return null
    const alertType = aiAnalysis?.recommendation === 'REJECT'
      ? 'warning'
      : aiAnalysis?.recommendation === 'APPROVE'
        ? 'success'
        : 'info'
    return (
      <div style={{ marginBottom: 18, padding: 14, border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
          <Space size={8}>
            <RobotOutlined style={{ color: '#2563eb' }} />
            <Text strong>AI 合规顾问</Text>
            {aiAnalysis && <Tag color={AI_RECOMMENDATION_COLOR[aiAnalysis.recommendation]}>{AI_RECOMMENDATION_LABEL[aiAnalysis.recommendation]}</Tag>}
          </Space>
          <Space size={8}>
            <Switch size="small" checked={aiAutoEnabled} onChange={handleAiAutoChange} />
            <Button size="small" loading={aiLoading} onClick={() => loadAiAnalysis(detail.submission.id)}>重新分析</Button>
          </Space>
        </Space>
        {aiLoading && !aiAnalysis ? (
          <div style={{ padding: '18px 0', textAlign: 'center' }}><Spin size="small" /></div>
        ) : aiAnalysis ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert type={alertType} showIcon message={aiAnalysis.summary} description={aiAnalysis.disclaimer} />
            <List
              size="small"
              dataSource={aiAnalysis.reasons}
              renderItem={(reason) => (
                <List.Item style={{ padding: '6px 0' }}>
                  <Text style={{ fontSize: 12 }}>{sanitizeSEVisibleText(reason)}</Text>
                </List.Item>
              )}
            />
            <Space wrap>
              <Tag>完整性：{aiAnalysis.checks.completeness.status}</Tag>
              <Tag>填报质量：{aiAnalysis.checks.fillQuality.status}</Tag>
              <Tag>异常检测：{aiAnalysis.checks.anomaly.status}</Tag>
            </Space>
            <Button size="small" type="primary" onClick={applyAiSuggestion}>采用建议</Button>
          </Space>
        ) : (
          <Button size="small" type="primary" onClick={() => loadAiAnalysis(detail.submission.id)}>生成建议</Button>
        )}
      </div>
    )
  }

  const renderReviewDetail = () => {
    if (!detail) {
      return null
    }

    return (
      <>
        <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 18 }}>
          <Title level={4} style={{ margin: 0, fontSize: 18 }}>审核详情</Title>
          <Space size={8}>
            <Button size="small" onClick={() => triggerAsk(`任务：${sanitizeSEVisibleText(detail.task.title)}｜生成内容：${sanitizeSEVisibleText(detail.requirement.title)}｜提交内容：${sanitizeSEVisibleText(detail.submission.submitText)}｜附件 ${detail.attachments.length} 个`, '这条提交是否完整？')}>问小智</Button>
            {isEnterprise && <Button size="small" type="text" aria-label="关闭审核详情" onClick={closeDetail}>×</Button>}
          </Space>
        </Space>
        <Title level={5} style={{ margin: '0 0 12px', fontSize: 16 }}>{sanitizeSEVisibleText(detail.task.title)}</Title>
        <Tag color={SUBMISSION_STATUS_COLOR[detail.submission.status]} style={{ borderRadius: 13, padding: '3px 10px', marginBottom: 20 }}>
          {SUBMISSION_STATUS_LABEL[detail.submission.status] || detail.submission.status}
        </Tag>

        {renderAiAnalysis()}

        <Descriptions column={1} size="small" title="任务信息" style={{ marginBottom: 12 }}>
          <Descriptions.Item label="任务标题">{sanitizeSEVisibleText(detail.task.title)}</Descriptions.Item>
          <Descriptions.Item label="生成内容">{sanitizeSEVisibleText(detail.requirement.title)}</Descriptions.Item>
          <Descriptions.Item label="标准文档">{sanitizeSEVisibleText(detail.requirement.source.title)}</Descriptions.Item>
          <Descriptions.Item label="任务截止">{dayjs(detail.task.deadlineAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
          <Descriptions.Item label="审核人">{memberLabel(detail.task.reviewerId)}</Descriptions.Item>
        </Descriptions>

        <Descriptions column={1} size="small" title="提交元数据" style={{ marginBottom: 12 }}>
          <Descriptions.Item label="执行人">{memberLabel(detail.submission.assigneeId)}</Descriptions.Item>
          <Descriptions.Item label="指派状态">{detail.assignee?.status || '——'}</Descriptions.Item>
          <Descriptions.Item label="提交版本">{detail.submission.version}（{detail.submission.isLatest ? '最新' : '历史'}）</Descriptions.Item>
          <Descriptions.Item label="提交状态">
            <Tag color={SUBMISSION_STATUS_COLOR[detail.submission.status]}>{SUBMISSION_STATUS_LABEL[detail.submission.status] || detail.submission.status}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="提交时间">{dayjs(detail.submission.submittedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
          <Descriptions.Item label="审核时间">{detail.submission.reviewedAt ? dayjs(detail.submission.reviewedAt).format('YYYY-MM-DD HH:mm') : '——'}</Descriptions.Item>
          <Descriptions.Item label="审核人">{memberLabel(detail.submission.reviewerId || detail.task.reviewerId)}</Descriptions.Item>
          <Descriptions.Item label="审核意见">{sanitizeSEVisibleText(detail.submission.reviewComment || '暂无审核意见')}</Descriptions.Item>
        </Descriptions>

        <Text strong style={{ color: '#64748b', fontSize: 13 }}>提交内容</Text>
        <div style={{ marginTop: 10, padding: 14, minHeight: 102, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, color: '#475569', fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {sanitizeSEVisibleText(detail.submission.submitText || '暂无提交说明')}
        </div>

        {renderRequirementSubmitAudit(detail)}

        <Text strong style={{ color: '#64748b', fontSize: 13, marginTop: 22 }}>附件 {detail.attachments.length} 个</Text>
        <List
          size="small"
          style={{ marginTop: 8 }}
          dataSource={detail.attachments.length ? detail.attachments : [{ id: 'empty', fileName: '暂无附件', fileUrl: '', mimeType: null, fileSize: null }]}
          renderItem={(a) => (
            <List.Item style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '10px 12px', marginBottom: 8 }}>
              {a.fileUrl ? <a href={a.fileUrl} target="_blank" rel="noreferrer">{a.fileName}</a> : <Text type="secondary">{a.fileName}</Text>}
              {a.fileSize && <span style={{ marginLeft: 8, color: '#999' }}>{Math.round(a.fileSize / 1024)} KB</span>}
            </List.Item>
          )}
        />

        <div style={{ marginTop: 14 }}>
          <Text strong style={{ color: '#64748b', fontSize: 13 }}>审核意见</Text>
          <TextArea
            rows={3}
            maxLength={1000}
            showCount
            value={reviewCommentDraft}
            placeholder={detail.submission.reviewComment || (detail.canApprove ? '填写审核意见，可采用 AI 建议作为初稿' : '暂无审核意见')}
            onChange={(event) => setReviewCommentDraft(event.target.value)}
            style={{ marginTop: 8, borderRadius: 6 }}
          />
        </div>

        {detail.reviewLogs.length > 0 && (
          <>
            <Divider style={{ margin: '18px 0 12px' }} />
            <Text strong style={{ color: '#64748b', fontSize: 13 }}>审核链路</Text>
            <List
              size="small"
              style={{ marginTop: 8 }}
              dataSource={detail.reviewLogs}
              renderItem={(log) => (
                <List.Item style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '10px 12px', marginBottom: 8 }}>
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space size={6} wrap>
                      <Tag color={REVIEW_ACTION_COLOR[log.action] || 'default'}>{REVIEW_ACTION_LABEL[log.action] || log.action}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(log.createdAt).format('YYYY-MM-DD HH:mm')}</Text>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>经办人：{memberLabel(log.reviewerId)}</Text>
                    {log.comment && <Text style={{ fontSize: 12 }}>{sanitizeSEVisibleText(log.comment)}</Text>}
                  </Space>
                </List.Item>
              )}
            />
          </>
        )}

        {detail.canApprove && (
          <Space style={{ marginTop: 'auto', justifyContent: 'flex-end', paddingTop: 28 }}>
            <Button onClick={() => openReject(detail.submission.id, reviewCommentDraft)} style={{ ...compactControlStyle, width: 82 }}>驳回</Button>
            <Button type="primary" onClick={() => handleApprove(detail.submission.id, reviewCommentDraft || undefined)} style={{ ...compactControlStyle, width: 82 }}>通过</Button>
          </Space>
        )}
      </>
    )
  }

  return (
    <div style={isEnterprise ? enterprisePageStyle : undefined}>
      {!isEnterprise && (
        <div>
          <Title level={4} style={{ margin: 0 }}>合规审核台</Title>
          <Text type="secondary">审核员工提交，待处理页集中完成通过、驳回和问小智辅助判断。</Text>
        </div>
      )}
      <div style={isEnterprise ? { display: 'flex', gap: 32, alignItems: 'flex-start' } : undefined}>
        <div style={isEnterprise ? { width: detail ? 720 : '100%' } : { width: '100%' }}>
          {isEnterprise ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 28 }}>
              {REVIEW_TABS.map((tab) => {
                const active = activeTab === tab.key
                return (
                  <Button
                    key={tab.key}
                    type="text"
                    title={tab.label}
                    onClick={() => { setActiveTab(tab.key); setFilterStatus(''); setSelectedKeys([]); setPage(1) }}
                    style={{
                      ...pillButtonStyle,
                      color: active ? '#2563eb' : '#475569',
                      background: active ? '#eff6ff' : '#e2e8f0',
                    }}
                  >
                    {tab.label}
                  </Button>
                )
              })}
            </div>
          ) : (
            <Tabs
              activeKey={activeTab}
              onChange={(k) => { setActiveTab(k as ReviewTabKey); setFilterStatus(''); setSelectedKeys([]); setPage(1) }}
              items={REVIEW_TABS.map((t) => ({ key: t.key, label: t.label }))}
              style={{ marginBottom: 0 }}
            />
          )}

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: isEnterprise ? 32 : 14, flexWrap: 'wrap' }}>
            <div>
              <div style={isEnterprise ? fieldLabelStyle : undefined}>{isEnterprise ? '搜索任务' : ''}</div>
              <Input.Search placeholder="任务标题" value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={load} style={{ width: isEnterprise ? 240 : 200 }} allowClear />
            </div>
            {!isTodoTab && (
              <div>
                <div style={isEnterprise ? fieldLabelStyle : undefined}>{isEnterprise ? '状态' : ''}</div>
                <Select options={REVIEW_TAB_STATUS_OPTIONS[activeTab]} value={filterStatus} onChange={(v) => { setPage(1); setFilterStatus(v) }} style={{ width: 140 }} />
              </div>
            )}
            <div>
              <div style={isEnterprise ? fieldLabelStyle : undefined}>{isEnterprise ? '范围' : ''}</div>
              <Select options={SCOPE_OPTIONS} value={filterScope} onChange={(v) => { setPage(1); setFilterScope(v) }} style={{ width: 140 }} />
            </div>
            <div style={{ flex: 1 }} />
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ ...compactControlStyle, width: isEnterprise ? 90 : undefined }}>刷新</Button>
          </div>

          {isTodoTab && selectedKeys.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedKeys.length} 个待审提交</span>
              <Space>
                <Button size="small" type="primary" loading={batchLoading} onClick={handleBatchApprove}>批量通过</Button>
                <Button size="small" danger loading={batchLoading} onClick={openBatchReject}>批量驳回</Button>
                <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </Space>
            </div>
          )}

          {!isEnterprise && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 14 }}>
                {[
                  { label: '待审核', value: reviewMetrics.pending, color: '#d97706' },
                  { label: '已通过', value: reviewMetrics.approved, color: '#16a34a' },
                  { label: '已驳回', value: reviewMetrics.rejected, color: '#dc2626' },
                ].map((item) => (
                  <div key={item.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 16px', borderLeft: `4px solid ${item.color}` }}>
                    <div style={{ color: '#64748b', fontSize: 13 }}>{item.label}</div>
                    <div style={{ color: '#0f172a', fontSize: 24, fontWeight: 700, lineHeight: 1.2 }}>{item.value}</div>
                  </div>
                ))}
              </div>

            </>
          )}

          <div style={isEnterprise ? { ...tableShellStyle, width: detail ? 720 : '100%' } : { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey={(row: ReviewListItem) => row.submission.id}
          size="small"
          loading={loading}
          dataSource={items}
          rowSelection={isTodoTab ? {
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys as string[]),
            getCheckboxProps: (row: ReviewListItem) => ({ disabled: row.submission.status !== 'SUBMITTED' }),
          } : undefined}
          pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
          onRow={(row) => ({ onClick: () => openDetail(row.submission.id), style: { cursor: 'pointer', background: detail?.submission.id === row.submission.id ? '#eff6ff' : undefined } })}
          columns={[
            { title: '任务', dataIndex: ['task', 'title'], ellipsis: true, width: isEnterprise ? 150 : undefined, render: (v: string, row: ReviewListItem) => <Typography.Link style={{ color: '#0f172a', fontSize: 12, fontWeight: 500 }} onClick={(event) => { event.stopPropagation(); openDetail(row.submission.id) }}>{sanitizeSEVisibleText(v)}</Typography.Link> },
            { title: '生成内容', dataIndex: ['requirement', 'title'], ellipsis: true, width: isEnterprise ? 150 : 200, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{sanitizeSEVisibleText(v)}</span> },
            { title: '执行人', dataIndex: 'assigneeId', width: isEnterprise ? 90 : 170, ellipsis: true, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{memberLabel(v)}</span> },
            { title: '版本', dataIndex: ['submission', 'version'], width: isEnterprise ? 50 : 64, render: (v: number) => <span style={{ color: '#475569', fontSize: 12 }}>{`v${v}`}</span> },
            { title: '状态', dataIndex: ['submission', 'status'], width: isEnterprise ? 80 : 110, render: (v: string) => isEnterprise ? <span style={{ color: '#475569', fontSize: 12 }}>{SUBMISSION_STATUS_LABEL[v] || v}</span> : <Tag color={SUBMISSION_STATUS_COLOR[v]}>{SUBMISSION_STATUS_LABEL[v]}</Tag> },
            { title: '提交时间', dataIndex: ['submission', 'submittedAt'], width: isEnterprise ? 130 : 132, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{dayjs(v).format('MM-DD HH:mm')}</span> },
            ...(!isEnterprise ? [{ title: '操作', width: 88, render: (_: unknown, row: ReviewListItem) => <Button size="small" type={row.submission.status === 'SUBMITTED' ? 'primary' : 'default'} onClick={() => openDetail(row.submission.id)}>{row.submission.status === 'SUBMITTED' ? '审核' : '详情'}</Button> }] : []),
          ]}
        />
          </div>
        </div>

        {isEnterprise && detail && <div style={sidePanelStyle}>{renderReviewDetail()}</div>}
      </div>

      {!isEnterprise && <Drawer title="审核详情" open={detailOpen} onClose={closeDetail} width={680} extra={detail && <Button size="small" onClick={() => triggerAsk(`任务：${sanitizeSEVisibleText(detail.task.title)}｜生成内容：${sanitizeSEVisibleText(detail.requirement.title)}｜提交内容：${sanitizeSEVisibleText(detail.submission.submitText)}｜附件 ${detail.attachments.length} 个`, '这条提交是否完整？')}>问小智</Button>}>
        {detail && (
          <>
            {renderAiAnalysis()}
            <Descriptions column={1} size="small" title="任务信息">
              <Descriptions.Item label="任务标题">{sanitizeSEVisibleText(detail.task.title)}</Descriptions.Item>
              <Descriptions.Item label="生成内容">{sanitizeSEVisibleText(detail.requirement.title)}</Descriptions.Item>
              <Descriptions.Item label="标准文档">{sanitizeSEVisibleText(detail.requirement.source.title)}</Descriptions.Item>
              <Descriptions.Item label="任务截止">{dayjs(detail.task.deadlineAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="审核人">{memberLabel(detail.task.reviewerId)}</Descriptions.Item>
            </Descriptions>

            <Divider />
            <Descriptions column={1} size="small" title="本次提交">
              <Descriptions.Item label="执行人">{memberLabel(detail.submission.assigneeId)}</Descriptions.Item>
              <Descriptions.Item label="版本">{detail.submission.version}（{detail.submission.isLatest ? '最新' : '历史'}）</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={SUBMISSION_STATUS_COLOR[detail.submission.status]}>{SUBMISSION_STATUS_LABEL[detail.submission.status]}</Tag></Descriptions.Item>
              <Descriptions.Item label="提交时间">{dayjs(detail.submission.submittedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              {detail.submission.reviewComment && <Descriptions.Item label="审核意见">{sanitizeSEVisibleText(detail.submission.reviewComment)}</Descriptions.Item>}
            </Descriptions>

            <Paragraph style={{ marginTop: 12 }}><b>提交内容：</b></Paragraph>
            <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 12, borderRadius: 4 }}>
              {sanitizeSEVisibleText(detail.submission.submitText)}
            </Paragraph>

            {renderRequirementSubmitAudit(detail)}

            <Paragraph><b>附件（{detail.attachments.length} 个）：</b></Paragraph>
            <List
              size="small"
              dataSource={detail.attachments}
              renderItem={(a) => (
                <List.Item>
                  <a href={a.fileUrl} target="_blank" rel="noreferrer">{a.fileName}</a>
                  {a.fileSize && <span style={{ marginLeft: 8, color: '#999' }}>{Math.round(a.fileSize / 1024)} KB</span>}
                </List.Item>
              )}
            />

            {detail.reviewLogs.length > 0 && (
              <>
                <Divider />
                <Paragraph><b>历史审核日志：</b></Paragraph>
                <List
                  size="small"
                  dataSource={detail.reviewLogs}
                  renderItem={(log) => (
                    <List.Item>
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Space>
                          <Tag color={log.action === 'APPROVE' ? 'green' : 'red'}>{REVIEW_ACTION_LABEL[log.action] || log.action}</Tag>
                          <span>{dayjs(log.createdAt).format('YYYY-MM-DD HH:mm')}</span>
                          <span style={{ color: '#999' }}>by {memberLabel(log.reviewerId)}</span>
                        </Space>
                        {log.comment && <div>{sanitizeSEVisibleText(log.comment)}</div>}
                      </Space>
                    </List.Item>
                  )}
                />
              </>
            )}

            {detail.canApprove && (
              <Space style={{ marginTop: 20 }}>
                <Button type="primary" onClick={() => handleApprove(detail.submission.id, reviewCommentDraft || undefined)}>通过</Button>
                <Button danger onClick={() => openReject(detail.submission.id, reviewCommentDraft)}>驳回</Button>
              </Space>
            )}
          </>
        )}
      </Drawer>}

      <Modal
        title={rejectMode === 'batch' ? `批量驳回 ${selectedKeys.length} 个提交` : '驳回提交'}
        open={rejectOpen}
        onCancel={() => setRejectOpen(false)}
        onOk={handleRejectSubmit}
        okText="确认驳回"
        okButtonProps={{ danger: true, loading: batchLoading }}
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item name="reviewComment" label="驳回原因（必填）" rules={[{ required: true, message: '驳回必须填写原因' }, { max: 2000 }]}>
            <TextArea rows={5} maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
