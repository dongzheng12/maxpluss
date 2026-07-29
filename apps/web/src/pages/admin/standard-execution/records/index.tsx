import { useEffect, useState } from 'react'
import { Table, Typography, Button, Space, Select, Input, Tag, message, Modal, Drawer, Descriptions, List, Divider, DatePicker, Alert } from 'antd'
import type { CSSProperties, Key } from 'react'
import { ApartmentOutlined, BranchesOutlined, FilePdfOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  enterpriseMe,
  seListSources, seListSourcesEnterprise,
  seListRecords, seListRecordsEnterprise,
  seGetRecord, seGetRecordEnterprise,
  seGetRecordEvidenceChain, seGetRecordEvidenceChainEnterprise,
  seDownloadRecordEvidencePdf, seDownloadRecordEvidencePdfEnterprise,
  seVoidRecord, seVoidRecordEnterprise,
  seBatchVoidRecords, seBatchVoidRecordsEnterprise,
  seListRequirementsEnterprise,
  seAddRecordCoveragesEnterprise,
  seListEnterpriseMembers,
  type SeRecord,
  type Source,
  type Requirement,
  type RecordEvidenceChain,
  type EnterpriseMember,
  RECORD_STATUS_LABEL,
  RECORD_STATUS_COLOR,
  SUBMISSION_STATUS_LABEL,
  SUBMISSION_STATUS_COLOR,
} from '../../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

const { Title, Paragraph, Text } = Typography
const { RangePicker } = DatePicker

const enterprisePageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
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
const metricCardStyle: CSSProperties = {
  position: 'relative',
  width: 190,
  height: 88,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 4px 7px rgba(15, 23, 42, 0.04)',
  padding: '15px 16px 12px',
}
const tableShellStyle: CSSProperties = {
  width: 760,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}
const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  ...Object.entries(RECORD_STATUS_LABEL).map(([value, label]) => ({ value, label })),
]
const RECORD_SOURCE_LABEL: Record<string, string> = {
  REVIEW_APPROVE: '审核通过后自动沉淀',
  MANUAL: '手动录入',
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
const RECORD_STATUS_TONE: Record<string, string> = {
  VALID: 'green',
  EXPIRED: 'gold',
  VOID: 'red',
}

function safeFilename(input: string) {
  return input.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_')
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

interface RecordReviewLog {
  id: string
  action: string
  comment: string | null
  reviewerId: string
  createdAt: string
}
interface RecordDetail extends SeRecord {
  submission: {
    id: string
    submitText: string
    version: number
    status?: string
    submittedAt: string | null
    reviewedAt: string | null
    reviewerId: string | null
    reviewComment?: string | null
    assigneeId?: string
  } | null
  task: {
    id: string
    title: string
    requirement: {
      id: string
      title: string
      clauseNo?: string | null
      requirementText?: string | null
      source?: { id: string; title: string; sourceNo?: string | null; version?: string | null }
    }
  }
  attachments: Array<{ id: string; fileName: string; fileUrl: string; fileSize: number | null }>
  reviewLogs?: RecordReviewLog[]
}

export default function SeRecordsPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [items, setItems] = useState<SeRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState(isEnterprise ? 'VALID' : '')
  const [filterSourceId, setFilterSourceId] = useState('')
  const [filterDepartmentId, setFilterDepartmentId] = useState('')
  const [filterDateRange, setFilterDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [chain, setChain] = useState<RecordEvidenceChain | null>(null)
  const [chainOpen, setChainOpen] = useState(false)
  const [chainLoading, setChainLoading] = useState(false)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [members, setMembers] = useState<EnterpriseMember[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [enterpriseName, setEnterpriseName] = useState('企业')
  const [reuseOpen, setReuseOpen] = useState(false)
  const [reuseRecord, setReuseRecord] = useState<SeRecord | RecordDetail | null>(null)
  const [reuseRequirements, setReuseRequirements] = useState<Requirement[]>([])
  const [reuseRequirementIds, setReuseRequirementIds] = useState<string[]>([])
  const [reuseLoading, setReuseLoading] = useState(false)
  const [reuseSubmitting, setReuseSubmitting] = useState(false)

  const memberLabel = (id: string | null | undefined) => {
    if (!id) return '——'
    const m = members.find((mb) => mb.id === id)
    if (!m) return id.slice(0, 8)
    return [m.nickName, m.phone].filter(Boolean).join(' · ')
  }
  const sourceTitleOf = (record: Pick<SeRecord, 'task'> | RecordDetail | null | undefined) =>
    sanitizeSEVisibleText(record?.task?.requirement?.source?.title || '未标记标准文档')
  const sourceShortOf = (record: Pick<SeRecord, 'task'> | RecordDetail | null | undefined) =>
    sanitizeSEVisibleText(record?.task?.requirement?.source?.sourceNo || record?.task?.requirement?.source?.title || '未标记标准来源')
  const clauseNoOf = (record: Pick<SeRecord, 'requirementId' | 'task'> | RecordDetail | null | undefined) =>
    sanitizeSEVisibleText(record?.task?.requirement?.clauseNo || record?.requirementId?.slice(0, 8) || '未编号')
  const requirementTitleOf = (record: Pick<SeRecord, 'summary' | 'task'> | RecordDetail | null | undefined) =>
    sanitizeSEVisibleText(record?.task?.requirement?.title || record?.summary || '未标记生成内容')
  const taskTitleOf = (record: Pick<SeRecord, 'title' | 'task'> | RecordDetail | null | undefined) =>
    sanitizeSEVisibleText(record?.task?.title || record?.title || '未标记任务')
  const submissionVersionOf = (record: RecordDetail) => record.submission?.version ?? 1
  const reviewerOf = (record: Pick<SeRecord, 'submission'> | RecordDetail | null | undefined) =>
    memberLabel(record?.submission?.reviewerId)
  const recordPdfName = (record: SeRecord | RecordDetail) =>
    safeFilename(`${enterpriseName}-${clauseNoOf(record)}-${dayjs(record.recordDate).format('YYYY-MM-DD')}-证据.pdf`)
  const recordLikeFromChain = (value: RecordEvidenceChain): SeRecord => ({
    ...value.record,
    enterpriseId: value.enterprise.id,
    sourceId: value.source.id,
    requirementId: value.requirement.id,
    taskId: value.task.id,
    submissionId: value.submission.id,
    assigneeId: value.submission.assigneeId,
    departmentId: value.task.departmentId,
    updatedAt: value.record.createdAt,
    task: {
      id: value.task.id,
      title: value.task.title,
      requirement: {
        id: value.requirement.id,
        title: value.requirement.title,
        clauseNo: value.requirement.clauseNo,
        requirementText: value.requirement.requirementText,
        source: {
          id: value.source.id,
          title: value.source.title,
          sourceNo: value.source.sourceNo,
          version: value.source.version,
        },
      },
    },
    submission: {
      id: value.submission.id,
      version: value.submission.version,
      submittedAt: value.submission.submittedAt,
      reviewedAt: value.review.reviewedAt,
      reviewerId: value.review.reviewerId,
    },
  })

  const load = async () => {
    setLoading(true)
    try {
      const listFn = isEnterprise ? seListRecordsEnterprise : seListRecords
      const res = await listFn({
        status: filterStatus || undefined,
        sourceId: filterSourceId || undefined,
        departmentId: filterDepartmentId || undefined,
        recordDateFrom: filterDateRange?.[0]?.startOf('day').toISOString(),
        recordDateTo: filterDateRange?.[1]?.endOf('day').toISOString(),
        keyword: keyword || undefined,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
      setSelectedKeys([])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    seListEnterpriseMembers().then((r) => setMembers(r.data)).catch(() => {})
    const listSources = isEnterprise ? seListSourcesEnterprise : seListSources
    listSources({ page: 1, pageSize: 200 }).then((r) => setSources(r.data)).catch(() => {})
    if (isEnterprise) {
      enterpriseMe().then((r) => setEnterpriseName(r.enterpriseName || r.enterpriseId || '企业')).catch(() => {})
    }
  }, [isEnterprise])
  useEffect(() => { load() }, [page, filterStatus, filterSourceId, filterDepartmentId, filterDateRange])

  const recordMetrics = {
    valid: items.filter((item) => item.status === 'VALID').length,
    expiring: items.filter((item) => item.status === 'EXPIRED').length,
    voided: items.filter((item) => item.status === 'VOID').length,
  }
  const packagePath = isEnterprise ? '/enterprise/packages' : '/admin/standard-execution/packages'

  const openDetail = async (id: string) => {
    try {
      const getFn = isEnterprise ? seGetRecordEnterprise : seGetRecord
      const res = await getFn(id)
      setDetail(res.data as RecordDetail)
      setDetailOpen(true)
    } catch {
      message.error('加载失败')
    }
  }

  const openEvidenceChain = async (id: string) => {
    setChainOpen(true)
    setChain(null)
    setChainLoading(true)
    try {
      const getFn = isEnterprise ? seGetRecordEvidenceChainEnterprise : seGetRecordEvidenceChain
      const res = await getFn(id)
      setChain(res.data)
    } catch {
      message.error('加载证据链失败')
      setChainOpen(false)
    } finally {
      setChainLoading(false)
    }
  }

  const exportRecordPdf = async (row: SeRecord | RecordDetail) => {
    setExportingId(row.id)
    try {
      const downloadFn = isEnterprise ? seDownloadRecordEvidencePdfEnterprise : seDownloadRecordEvidencePdf
      const blob = await downloadFn(row.id)
      downloadBlob(blob, recordPdfName(row))
      message.success('证据 PDF 已生成')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '导出失败')
    } finally {
      setExportingId(null)
    }
  }

  const openReuseCoverage = async (row: SeRecord | RecordDetail) => {
    if (!isEnterprise || row.status !== 'VALID') return
    setReuseRecord(row)
    setReuseRequirementIds([])
    setReuseOpen(true)
    setReuseLoading(true)
    try {
      const res = await seListRequirementsEnterprise({ page: 1, pageSize: 200, status: 'ACTIVE' })
      setReuseRequirements(res.data.filter((requirement) => requirement.id !== row.requirementId))
    } catch {
      message.error('加载控制点失败')
    } finally {
      setReuseLoading(false)
    }
  }

  const handleReuseCoverage = async () => {
    if (!reuseRecord || reuseRequirementIds.length === 0) {
      message.warning('请选择复用覆盖的控制点')
      return
    }
    setReuseSubmitting(true)
    try {
      const res = await seAddRecordCoveragesEnterprise(reuseRecord.id, { requirementIds: reuseRequirementIds })
      message.success(res.created > 0 ? `已新增 ${res.created} 个复用覆盖` : '复用覆盖关系已存在')
      setReuseOpen(false)
      setReuseRecord(null)
      setReuseRequirementIds([])
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '复用失败')
    } finally {
      setReuseSubmitting(false)
    }
  }

  const handleVoid = (row: SeRecord) => {
    Modal.confirm({
      title: '作废执行记录',
      content: (
        <>
          <Paragraph>{`确认作废「${row.title}」？`}</Paragraph>
          <Paragraph type="warning">作废后，所有含该记录的审计包会自动标记 hasInvalidRecord=true。</Paragraph>
        </>
      ),
      onOk: async () => {
        try {
          const voidFn = isEnterprise ? seVoidRecordEnterprise : seVoidRecord
          await voidFn(row.id)
          message.success('已作废')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  const handleBatchVoid = () => {
    Modal.confirm({
      title: '批量作废',
      content: `确认作废选中的 ${selectedKeys.length} 条执行记录？已作废的自动跳过；含这些记录的审计包会被标脏。`,
      onOk: async () => {
        try {
          const fn = isEnterprise ? seBatchVoidRecordsEnterprise : seBatchVoidRecords
          const r = await fn(selectedKeys as string[])
          message.success(`已作废 ${r.ok} 条${r.skipped ? `，${r.skipped} 条跳过` : ''}`)
          setSelectedKeys([]); load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const renderMetric = (label: string, value: number, accent: string) => (
    <div style={metricCardStyle}>
      <div style={{ position: 'absolute', left: -1, top: -1, bottom: -1, width: 4, borderRadius: '8px 0 0 8px', background: accent }} />
      <div style={{ color: '#64748b', fontSize: 12, fontWeight: 500 }}>{label}</div>
      <div style={{ marginTop: 8, color: '#0f172a', fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>{value}</div>
    </div>
  )

  const renderReviewTimeline = (compact = false) => {
    if (!detail) return null
    const logs = detail.reviewLogs || []
    const timeline = [
      detail.submission?.submittedAt ? {
        id: `${detail.submission.id}-submitted`,
        label: `员工提交 v${submissionVersionOf(detail)}`,
        color: 'blue',
        time: detail.submission.submittedAt,
        actor: memberLabel(detail.submission.assigneeId || detail.assigneeId),
        comment: detail.submission.submitText,
      } : null,
      ...logs.map((log) => ({
        id: log.id,
        label: REVIEW_ACTION_LABEL[log.action] || log.action,
        color: REVIEW_ACTION_COLOR[log.action] || 'default',
        time: log.createdAt,
        actor: memberLabel(log.reviewerId),
        comment: log.comment || '',
      })),
      {
        id: `${detail.id}-record`,
        label: '写入证据库',
        color: detail.status === 'VALID' ? 'green' : 'default',
        time: detail.recordDate,
        actor: memberLabel(detail.submission?.reviewerId),
        comment: RECORD_SOURCE_LABEL[detail.createdFrom || ''] || detail.createdFrom || '审核通过后自动沉淀',
      },
    ].filter(Boolean) as Array<{ id: string; label: string; color: string; time: string; actor: string; comment: string }>

    return (
      <div style={{ marginTop: compact ? 18 : 12 }}>
        <Text strong style={compact ? { color: '#64748b', fontSize: 13 } : undefined}>审核链路时间线</Text>
        <List
          size="small"
          style={{ marginTop: 8 }}
          dataSource={timeline}
          renderItem={(item) => (
            <List.Item style={compact ? { border: '1px solid #e2e8f0', borderRadius: 6, padding: '10px 12px', marginBottom: 8 } : undefined}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={6} wrap>
                  <Tag color={item.color}>{item.label}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(item.time).format('YYYY-MM-DD HH:mm')}</Text>
                </Space>
                <Text type="secondary" style={{ fontSize: 12 }}>经办人：{item.actor}</Text>
                {item.comment && <Text style={{ fontSize: 12 }}>{sanitizeSEVisibleText(item.comment)}</Text>}
              </Space>
            </List.Item>
          )}
        />
      </div>
    )
  }

  const renderEvidenceChain = () => {
    if (!chain) return null
    const nodes = [
      {
        key: 'source',
        label: '标准来源',
        title: [chain.source.sourceNo, chain.source.title].filter(Boolean).join(' · '),
        desc: [chain.source.version ? `版本 ${chain.source.version}` : null, chain.source.sourceType].filter(Boolean).join(' · ') || '未记录来源版本',
        color: '#2563eb',
      },
      {
        key: 'requirement',
        label: '控制点',
        title: [chain.requirement.clauseNo, chain.requirement.title].filter(Boolean).join(' · '),
        desc: chain.requirement.requirementTextSummary || '暂无控制点摘要',
        color: '#0891b2',
      },
      {
        key: 'task',
        label: '执行任务',
        title: chain.task.title,
        desc: `执行人 ${memberLabel(chain.task.assigneeId)} · 截止 ${chain.task.deadlineAt ? dayjs(chain.task.deadlineAt).format('YYYY-MM-DD HH:mm') : '未设置'}`,
        color: '#7c3aed',
      },
      {
        key: 'submission',
        label: '提交',
        title: `v${chain.submission.version} · ${SUBMISSION_STATUS_LABEL[chain.submission.status] || chain.submission.status}`,
        desc: `${dayjs(chain.submission.submittedAt).format('YYYY-MM-DD HH:mm')} · 提交人 ${memberLabel(chain.submission.assigneeId)} · ${sanitizeSEVisibleText(chain.submission.submitTextSummary || '暂无提交摘要')}`,
        color: '#d97706',
      },
      {
        key: 'review',
        label: '审核',
        title: `审核人 ${memberLabel(chain.review.reviewerId)}`,
        desc: `${chain.review.reviewedAt ? dayjs(chain.review.reviewedAt).format('YYYY-MM-DD HH:mm') : '未记录审核时间'} · ${sanitizeSEVisibleText(chain.review.reviewComment || '暂无审核意见')}`,
        color: '#16a34a',
      },
      {
        key: 'record',
        label: '本条记录',
        title: chain.record.title,
        desc: `入库 ${dayjs(chain.record.createdAt).format('YYYY-MM-DD HH:mm')} · 有效期 ${chain.record.validUntil ? dayjs(chain.record.validUntil).format('YYYY-MM-DD') : '未设置'}`,
        color: '#0f172a',
      },
    ]

    return (
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="本证据库记录依合规流程自动归档，记录一经审核通过不可物理删除。"
        />
        {nodes.map((node, index) => (
          <div key={node.key} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: 12 }}>
            <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
              <span style={{ width: 12, height: 12, marginTop: 6, borderRadius: 999, background: node.color, boxShadow: '0 0 0 4px #f1f5f9' }} />
              {index < nodes.length - 1 && <span style={{ position: 'absolute', top: 22, bottom: -20, width: 2, background: '#e2e8f0' }} />}
            </div>
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#fff' }}>
              <Tag color="blue" style={{ marginBottom: 8 }}>{node.label}</Tag>
              <div style={{ color: '#0f172a', fontWeight: 700, lineHeight: '20px' }}>{sanitizeSEVisibleText(node.title || '未记录')}</div>
              <div style={{ color: '#475569', fontSize: 12, lineHeight: '20px', marginTop: 4 }}>{sanitizeSEVisibleText(node.desc)}</div>
            </div>
          </div>
        ))}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 12, background: '#f8fafc' }}>
          <Text strong>附件</Text>
          <List
            size="small"
            dataSource={chain.attachments}
            locale={{ emptyText: '无附件' }}
            renderItem={(file) => <List.Item><a href={file.fileUrl} target="_blank" rel="noreferrer">{sanitizeSEVisibleText(file.fileName)}</a></List.Item>}
          />
        </div>
      </Space>
    )
  }

  const renderRecordDetail = () => {
    if (!detail) return null
    const submissionStatus = detail.submission?.status

    return (
      <>
        <Title level={4} style={{ margin: '0 0 22px', fontSize: 18 }}>记录详情</Title>
        <Title level={5} style={{ margin: '0 0 12px', fontSize: 16 }}>{detail.title}</Title>
        <Tag color={RECORD_STATUS_COLOR[detail.status]} style={{ borderRadius: 13, padding: '3px 10px', marginBottom: 22 }}>
          {RECORD_STATUS_LABEL[detail.status] || detail.status}
        </Tag>

        <div style={{ color: '#475569', fontSize: 13, lineHeight: 1.65 }}>
          <div>来源：{sourceTitleOf(detail)} · {requirementTitleOf(detail)}</div>
          <div>任务：{taskTitleOf(detail)}</div>
          <div>执行人：{memberLabel(detail.assigneeId)}</div>
          <div>审核人：{memberLabel(detail.submission?.reviewerId)}</div>
          <div>提交版本：v{submissionVersionOf(detail)}</div>
          {submissionStatus && <div>提交状态：{SUBMISSION_STATUS_LABEL[submissionStatus] || submissionStatus}</div>}
          <div>审核意见：{sanitizeSEVisibleText(detail.submission?.reviewComment || '暂无审核意见')}</div>
        </div>

        <div style={{ marginTop: 34, padding: 16, minHeight: 92, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, color: '#475569', fontSize: 12, lineHeight: 1.55 }}>
          <div>{dayjs(detail.recordDate).format('MM-DD HH:mm')} 写入证据库</div>
          <div>来源提交版本 v{submissionVersionOf(detail)}</div>
          <div>{RECORD_SOURCE_LABEL[detail.createdFrom || ''] || detail.createdFrom || '审核通过后自动沉淀'}</div>
        </div>

        {renderReviewTimeline(true)}

        <Button type="primary" onClick={() => nav(`${packagePath}?recordId=${detail.id}`)} style={{ ...compactControlStyle, width: 104, marginTop: 'auto', alignSelf: 'flex-end' }}>加入审计包</Button>
      </>
    )
  }

  return (
    <div style={isEnterprise ? enterprisePageStyle : undefined}>
      <Space style={{ marginBottom: isEnterprise ? 32 : 14, justifyContent: 'space-between', width: '100%' }} wrap>
        {!isEnterprise && (
        <div>
          <Title level={4} style={{ margin: 0 }}>证据库</Title>
          <Text type="secondary">沉淀审核通过的执行记录，支持导出、作废和进入审计包管理。</Text>
        </div>
        )}
        <Space wrap align="end">
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>关键词</div>}
            <Input.Search placeholder={isEnterprise ? '任务 / 标准文档 / 执行人' : '搜索标题/摘要'} value={keyword} onChange={(e) => setKeyword(e.target.value)} onSearch={load} style={{ width: isEnterprise ? 240 : 200 }} allowClear />
          </div>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>标准来源</div>}
            <Select
              showSearch
              allowClear
              placeholder="全部标准来源"
              optionFilterProp="label"
              value={filterSourceId || undefined}
              onChange={(v) => { setPage(1); setFilterSourceId(v || '') }}
              style={{ width: isEnterprise ? 180 : 200 }}
              options={sources.map((source) => ({
                value: source.id,
                label: [source.sourceNo, source.title].filter(Boolean).join(' · ') || source.id,
              }))}
            />
          </div>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>执行人部门</div>}
            <Input
              placeholder="部门 ID"
              value={filterDepartmentId}
              onChange={(event) => setFilterDepartmentId(event.target.value)}
              onPressEnter={() => { setPage(1); load() }}
              allowClear
              style={{ width: isEnterprise ? 120 : 140 }}
            />
          </div>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>记录日期</div>}
            <RangePicker
              value={filterDateRange}
              onChange={(dates) => { setPage(1); setFilterDateRange(dates) }}
              style={{ width: isEnterprise ? 220 : 240 }}
            />
          </div>
          <div>
            {isEnterprise && <div style={fieldLabelStyle}>状态</div>}
            <Select options={STATUS_OPTIONS} value={filterStatus} onChange={(v) => { setPage(1); setFilterStatus(v) }} style={{ width: 140 }} />
          </div>
          {!isEnterprise && <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>}
          {!isEnterprise && <Button onClick={() => nav(packagePath)}>新建审计包</Button>}
          {isEnterprise && <div style={{ width: 492 }} />}
          {isEnterprise && <Button icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ ...compactControlStyle, width: 80 }}>刷新</Button>}
        </Space>
      </Space>

      <Alert
        type="warning"
        showIcon
        message="本证据库记录依合规流程自动归档，记录一经审核通过不可物理删除。"
        style={{ marginBottom: 16, position: 'sticky', top: 0, zIndex: 2 }}
      />

      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        <div style={isEnterprise ? { width: 760 } : { width: '100%' }}>
          <div style={{ display: 'flex', gap: 16, marginBottom: isEnterprise ? 28 : 16, flexWrap: 'wrap' }}>
            {renderMetric('有效记录', recordMetrics.valid, '#16a34a')}
            {renderMetric('即将过期', recordMetrics.expiring, '#d97706')}
            {renderMetric('已作废', recordMetrics.voided, '#64748b')}
          </div>

          {selectedKeys.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedKeys.length} 条记录</span>
              <Space>
                <Button size="small" danger onClick={handleBatchVoid}>批量作废</Button>
                <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </Space>
            </div>
          )}

      <div style={isEnterprise ? tableShellStyle : { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        <Table
          rowKey="id"
          size="small"
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
          loading={loading}
          dataSource={items}
          locale={{ emptyText: <div style={{ padding: '24px 0', color: '#8a93a3' }}>暂无执行记录，员工提交且审核通过的任务会自动落入证据库</div> }}
          pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
          onRow={(row) => ({ onClick: () => openDetail(row.id), style: { cursor: 'pointer' } })}
          scroll={{ x: isEnterprise ? 1120 : 1280 }}
          columns={[
            {
              title: '记录标题', dataIndex: 'title', ellipsis: true, width: isEnterprise ? 150 : 190,
              render: (v: string, row: SeRecord) => (
                <div>
                  <Typography.Link style={{ color: '#0f172a', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={(event) => { event.stopPropagation(); openDetail(row.id) }}>{v}</Typography.Link>
                  {!isEnterprise && row.summary && <Text type="secondary" style={{ fontSize: 12 }}>{row.summary}</Text>}
                </div>
              ),
            },
            { title: '标准来源', width: 150, ellipsis: true, render: (_: unknown, row: SeRecord) => <span style={{ color: '#475569', fontSize: 12 }}>{sourceShortOf(row)}</span> },
            { title: '控制点编号', width: 110, ellipsis: true, render: (_: unknown, row: SeRecord) => <Tag style={{ margin: 0 }}>{clauseNoOf(row)}</Tag> },
            { title: '执行人', dataIndex: 'assigneeId', width: isEnterprise ? 110 : 150, ellipsis: true, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{memberLabel(v)}</span> },
            { title: '审核人', width: isEnterprise ? 110 : 150, ellipsis: true, render: (_: unknown, row: SeRecord) => <span style={{ color: '#475569', fontSize: 12 }}>{reviewerOf(row)}</span> },
            { title: '状态', dataIndex: 'status', width: isEnterprise ? 86 : 92, render: (v: string) => <Tag color={RECORD_STATUS_TONE[v] || RECORD_STATUS_COLOR[v]}>{RECORD_STATUS_LABEL[v] || v}</Tag> },
            { title: '记录日期', dataIndex: 'recordDate', width: isEnterprise ? 112 : 132, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{isEnterprise ? dayjs(v).format('YYYY-MM-DD') : dayjs(v).format('YYYY-MM-DD HH:mm')}</span> },
            {
              title: '操作', width: isEnterprise ? 300 : 290, fixed: 'right' as const, render: (_: unknown, row: SeRecord) => (
                <Space size={0} split={isEnterprise ? <span style={{ color: '#cbd5e1' }}>/</span> : undefined} wrap={!isEnterprise}>
                  <Button size="small" type={isEnterprise ? 'link' : 'default'} icon={<ApartmentOutlined />} onClick={(event) => { event.stopPropagation(); openEvidenceChain(row.id) }}>证据链</Button>
                  <Button size="small" type={isEnterprise ? 'link' : 'default'} icon={<FilePdfOutlined />} loading={exportingId === row.id} onClick={(event) => { event.stopPropagation(); exportRecordPdf(row) }}>PDF</Button>
                  {isEnterprise && row.status === 'VALID' && <Button size="small" type="link" icon={<BranchesOutlined />} onClick={(event) => { event.stopPropagation(); openReuseCoverage(row) }}>复用覆盖</Button>}
                  <Button size="small" type={isEnterprise ? 'link' : 'default'} onClick={(event) => { event.stopPropagation(); openDetail(row.id) }}>详情</Button>
                  {!isEnterprise && <Button size="small" onClick={(event) => { event.stopPropagation(); nav(`${packagePath}?recordId=${row.id}`) }}>加入审计包</Button>}
                  {(row.status === 'VALID' || row.status === 'EXPIRED') && <Button size="small" type={isEnterprise ? 'link' : 'default'} danger onClick={(event) => { event.stopPropagation(); handleVoid(row) }}>作废</Button>}
                </Space>
              ),
            },
          ]}
        />
      </div>
        </div>

      </div>

      <Drawer title="记录详情" open={detailOpen} onClose={() => { setDetailOpen(false); setDetail(null) }} width={620} extra={detail && (
        <Space>
          <Button size="small" icon={<ApartmentOutlined />} onClick={() => openEvidenceChain(detail.id)}>证据链</Button>
          <Button size="small" icon={<FilePdfOutlined />} loading={exportingId === detail.id} onClick={() => exportRecordPdf(detail)}>PDF</Button>
          {isEnterprise && detail.status === 'VALID' && <Button size="small" icon={<BranchesOutlined />} onClick={() => openReuseCoverage(detail)}>复用覆盖</Button>}
          <Button size="small" onClick={() => nav(`${packagePath}?recordId=${detail.id}`)}>加入审计包</Button>
        </Space>
      )}>
        {isEnterprise ? renderRecordDetail() : detail && (
          <>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="摘要">{detail.summary || '-'}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={RECORD_STATUS_COLOR[detail.status]}>{RECORD_STATUS_LABEL[detail.status]}</Tag></Descriptions.Item>
              <Descriptions.Item label="任务">{taskTitleOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="生成内容">{requirementTitleOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="标准文档">{sourceTitleOf(detail)}</Descriptions.Item>
              <Descriptions.Item label="执行人">{memberLabel(detail.assigneeId)}</Descriptions.Item>
              <Descriptions.Item label="提交版本">v{submissionVersionOf(detail)}</Descriptions.Item>
              {detail.submission?.status && (
                <Descriptions.Item label="提交状态">
                  <Tag color={SUBMISSION_STATUS_COLOR[detail.submission.status]}>{SUBMISSION_STATUS_LABEL[detail.submission.status] || detail.submission.status}</Tag>
                </Descriptions.Item>
              )}
              {detail.submission?.submittedAt && <Descriptions.Item label="提交时间">{dayjs(detail.submission.submittedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>}
              {detail.submission?.reviewedAt && <Descriptions.Item label="审核时间">{dayjs(detail.submission.reviewedAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>}
              <Descriptions.Item label="审核人">{memberLabel(detail.submission?.reviewerId)}</Descriptions.Item>
              <Descriptions.Item label="完成时间">{dayjs(detail.recordDate).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="生成来源">{RECORD_SOURCE_LABEL[detail.createdFrom || ''] || detail.createdFrom || '审核通过后自动沉淀'}</Descriptions.Item>
              <Descriptions.Item label="审核意见">{sanitizeSEVisibleText(detail.submission?.reviewComment || '暂无审核意见')}</Descriptions.Item>
            </Descriptions>
            <Paragraph style={{ marginTop: 12 }}><b>提交原文：</b></Paragraph>
            <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 12, borderRadius: 4 }}>{sanitizeSEVisibleText(detail.submission?.submitText || '暂无提交原文')}</Paragraph>
            <Paragraph><b>附件（{detail.attachments.length} 个）：</b></Paragraph>
            <List size="small" dataSource={detail.attachments} renderItem={(a) => (
              <List.Item><a href={a.fileUrl} target="_blank" rel="noreferrer">{a.fileName}</a></List.Item>
            )} />
            <Divider />
            {renderReviewTimeline()}
          </>
        )}
      </Drawer>
      <Drawer
        title="证据链"
        open={chainOpen}
        onClose={() => { setChainOpen(false); setChain(null) }}
        width={680}
        loading={chainLoading}
        extra={chain && (
          <Button size="small" icon={<FilePdfOutlined />} loading={exportingId === chain.record.id} onClick={() => exportRecordPdf(recordLikeFromChain(chain))}>导出 PDF</Button>
        )}
      >
        {renderEvidenceChain()}
      </Drawer>
      <Modal
        title="复用覆盖"
        open={reuseOpen}
        okText="保存"
        cancelText="取消"
        onOk={handleReuseCoverage}
        confirmLoading={reuseSubmitting}
        onCancel={() => {
          setReuseOpen(false)
          setReuseRecord(null)
          setReuseRequirementIds([])
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={reuseRecord ? `当前证据：${sanitizeSEVisibleText(reuseRecord.title)}` : '当前证据'}
          />
          <Select
            mode="multiple"
            allowClear
            showSearch
            loading={reuseLoading}
            placeholder="选择可复用覆盖的控制点"
            optionFilterProp="label"
            value={reuseRequirementIds}
            onChange={setReuseRequirementIds}
            style={{ width: '100%' }}
            options={reuseRequirements.map((requirement) => ({
              value: requirement.id,
              label: [
                requirement.source?.sourceNo || requirement.source?.title,
                requirement.clauseNo,
                sanitizeSEVisibleText(requirement.title),
              ].filter(Boolean).join(' · '),
            }))}
          />
        </Space>
      </Modal>
    </div>
  )
}
