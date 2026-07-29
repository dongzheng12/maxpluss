import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  DatabaseOutlined,
  EditOutlined,
  ReloadOutlined,
  RetweetOutlined,
} from '@ant-design/icons'
import {
  seCreateRequirement,
  seGetParseV2Job,
  seRegenerateParseV2Requirement,
  type ParseV2Job,
  type ParseV2RequirementDraft,
} from '../../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

const { Text, Title } = Typography
const { TextArea } = Input

type ConfidenceGroup = 'high' | 'medium' | 'low'

interface DraftRow {
  key: string
  originalIndex: number
  draft: ParseV2RequirementDraft
  edited: boolean
  selected: boolean
  importedRequirementId: string | null
}

interface SourceSegment {
  key: string
  chunkIndex: number
  clauseNo: string
  title: string
  text: string
}

const groupMeta: Record<ConfidenceGroup, { title: string; color: string; bg: string; border: string }> = {
  high: { title: '高置信度', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
  medium: { title: '中置信度', color: '#ca8a04', bg: '#fffbeb', border: '#fde68a' },
  low: { title: '低置信度', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
}

function confidenceGroup(draft: ParseV2RequirementDraft): ConfidenceGroup {
  if (draft.needsReview || draft.confidence < 0.5) return 'low'
  if (draft.confidence < 0.8) return 'medium'
  return 'high'
}

function percent(confidence: number) {
  return Math.round(Math.max(0, Math.min(1, confidence)) * 100)
}

function chunkRef(draft: ParseV2RequirementDraft): number | null {
  const raw = draft.sourceChunks.find((item) => /^chunk:\d+$/.test(item))
  if (!raw) return null
  const index = Number(raw.split(':')[1])
  return Number.isInteger(index) ? index : null
}

function locateSegmentKey(draft: ParseV2RequirementDraft, segments: SourceSegment[]): string | null {
  const index = chunkRef(draft)
  if (index !== null) {
    const found = segments.find((segment) => segment.chunkIndex === index)
    if (found) return found.key
  }
  const clauseNo = draft.clauseNo?.trim()
  if (clauseNo) {
    const found = segments.find((segment) => segment.clauseNo === clauseNo || segment.clauseNo.startsWith(clauseNo))
    if (found) return found.key
  }
  return segments[0]?.key ?? null
}

function materialText(draft: ParseV2RequirementDraft) {
  return draft.requiredMaterials?.length ? draft.requiredMaterials.join('、') : '未列出'
}

function editableInitialValues(draft: ParseV2RequirementDraft) {
  return {
    clauseNo: draft.clauseNo ?? '',
    title: draft.title,
    requirementText: draft.requirementText,
    executionDescription: draft.executionDescription ?? '',
    recommendedTaskType: draft.recommendedTaskType ?? '',
    submitRequirement: draft.submitRequirement ?? '',
    requiredMaterials: draft.requiredMaterials?.join('\n') ?? '',
  }
}

export default function SeParseReviewPage() {
  const { sourceId = '', jobId = '' } = useParams()
  const navigate = useNavigate()
  const [job, setJob] = useState<ParseV2Job | null>(null)
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)
  const [committing, setCommitting] = useState(false)
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null)
  const [activeDraftKey, setActiveDraftKey] = useState<string | null>(null)
  const [activeSegmentKey, setActiveSegmentKey] = useState<string | null>(null)
  const [editRow, setEditRow] = useState<DraftRow | null>(null)
  const [editForm] = Form.useForm()
  const segmentRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const loadJob = async () => {
    if (!jobId) return
    const next = await seGetParseV2Job(jobId)
    setJob(next)
    if (next.result?.requirements) {
      setDrafts((current) => next.result!.requirements.map((draft, index) => {
        const key = `draft:${index}`
        const existing = current.find((item) => item.key === key)
        return {
          key,
          originalIndex: index,
          draft: existing?.edited ? existing.draft : draft,
          edited: existing?.edited ?? false,
          selected: existing?.selected ?? false,
          importedRequirementId: existing?.importedRequirementId ?? null,
        }
      }))
    }
  }

  useEffect(() => {
    let cancelled = false
    async function boot() {
      setLoading(true)
      try {
        const jobResp = await seGetParseV2Job(jobId)
        if (cancelled) return
        setJob(jobResp)
        if (jobResp.result?.requirements) {
          setDrafts(jobResp.result.requirements.map((draft, index) => ({
            key: `draft:${index}`,
            originalIndex: index,
            draft,
            edited: false,
            selected: false,
            importedRequirementId: null,
          })))
        }
      } catch (e) {
        const err = e as { response?: { data?: { error?: string } } }
        message.error(err?.response?.data?.error || '加载解析任务失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    boot()
    return () => { cancelled = true }
  }, [jobId, sourceId])

  useEffect(() => {
    if (!job || job.status === 'DONE' || job.status === 'FAILED') return undefined
    const timer = window.setInterval(() => {
      loadJob().catch(() => undefined)
    }, 1200)
    return () => window.clearInterval(timer)
  }, [job?.status, jobId])

  const segments = useMemo<SourceSegment[]>(() => {
    return job?.result?.chunks?.map((item) => ({
      key: `chunk:${item.chunk.chunkIndex}`,
      chunkIndex: item.chunk.chunkIndex,
      clauseNo: item.chunk.clauseNo,
      title: item.chunk.title,
      text: item.chunk.text,
    })) ?? []
  }, [job?.result?.chunks])

  const grouped = useMemo(() => ({
    high: drafts.filter((row) => confidenceGroup(row.draft) === 'high'),
    medium: drafts.filter((row) => confidenceGroup(row.draft) === 'medium'),
    low: drafts.filter((row) => confidenceGroup(row.draft) === 'low'),
  }), [drafts])

  const selectedRows = drafts.filter((row) => row.selected && !row.importedRequirementId)

  const focusDraft = (row: DraftRow) => {
    setActiveDraftKey(row.key)
    const segmentKey = locateSegmentKey(row.draft, segments)
    setActiveSegmentKey(segmentKey)
    if (segmentKey) {
      window.setTimeout(() => {
        segmentRefs.current[segmentKey]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 0)
    }
  }

  const toggleRow = (row: DraftRow, checked: boolean) => {
    setDrafts((current) => current.map((item) => item.key === row.key ? { ...item, selected: checked } : item))
  }

  const canCommit = (row: DraftRow) => {
    if (row.importedRequirementId) return false
    if (!row.draft.title.trim() || !row.draft.requirementText.trim()) return false
    return confidenceGroup(row.draft) !== 'low' || row.edited
  }

  const selectGroup = (group: ConfidenceGroup) => {
    setDrafts((current) => current.map((row) => (
      confidenceGroup(row.draft) === group && canCommit(row)
        ? { ...row, selected: true }
        : row
    )))
  }

  const openEdit = (row: DraftRow) => {
    setEditRow(row)
    editForm.setFieldsValue(editableInitialValues(row.draft))
  }

  const saveEdit = async () => {
    if (!editRow) return
    const values = await editForm.validateFields()
    const nextDraft: ParseV2RequirementDraft = {
      ...editRow.draft,
      clauseNo: values.clauseNo?.trim() || null,
      title: values.title.trim(),
      requirementText: values.requirementText.trim(),
      executionDescription: values.executionDescription?.trim() || null,
      recommendedTaskType: values.recommendedTaskType?.trim() || null,
      submitRequirement: values.submitRequirement?.trim() || null,
      requiredMaterials: String(values.requiredMaterials || '').split(/\n+/).map((item) => item.trim()).filter(Boolean),
      needsReview: false,
    }
    setDrafts((current) => current.map((row) => row.key === editRow.key ? { ...row, draft: nextDraft, edited: true } : row))
    setEditRow(null)
  }

  const commitRows = async (rows: DraftRow[]) => {
    const targetSourceId = sourceId || job?.sourceId || job?.result?.sourceId
    if (!targetSourceId || rows.length === 0) return
    setCommitting(true)
    try {
      const imported: Array<{ key: string; id: string }> = []
      for (const row of rows) {
        const res = await seCreateRequirement({
          sourceId: targetSourceId,
          clauseNo: row.draft.clauseNo,
          title: row.draft.title,
          requirementText: row.draft.requirementText,
          recommendedTaskType: row.draft.recommendedTaskType,
          executionDescription: row.draft.executionDescription,
          submitRequirement: row.draft.submitRequirement,
          requiredMaterials: row.draft.requiredMaterials,
          generateMode: 'AI',
          status: 'DRAFT',
        })
        imported.push({ key: row.key, id: res.data.id })
      }
      setDrafts((current) => current.map((row) => {
        const hit = imported.find((item) => item.key === row.key)
        return hit ? { ...row, selected: false, importedRequirementId: hit.id } : row
      }))
      message.success(`已入库 ${imported.length} 条草稿`)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '入库失败')
    } finally {
      setCommitting(false)
    }
  }

  const regenerateRow = async (row: DraftRow) => {
    setRegeneratingKey(row.key)
    try {
      const res = await seRegenerateParseV2Requirement(jobId, row.originalIndex)
      setJob((current) => current ? { ...current, result: res.result } : current)
      setDrafts((current) => current.map((item) => item.key === row.key ? {
        ...item,
        draft: res.data,
        edited: false,
        selected: false,
      } : item))
      message.success('已重新生成')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '重新生成失败')
    } finally {
      setRegeneratingKey(null)
    }
  }

  const renderDraft = (row: DraftRow) => {
    const group = confidenceGroup(row.draft)
    const meta = groupMeta[group]
    const disabled = !canCommit(row)
    return (
      <div
        key={row.key}
        onClick={() => focusDraft(row)}
        style={{
          border: `1px solid ${activeDraftKey === row.key ? meta.color : meta.border}`,
          background: row.importedRequirementId ? '#f8fafc' : '#fff',
          opacity: row.importedRequirementId ? 0.56 : 1,
          borderRadius: 8,
          padding: 14,
          cursor: 'pointer',
          boxShadow: activeDraftKey === row.key ? '0 0 0 2px rgba(37,99,235,0.12)' : 'none',
        }}
      >
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between', gap: 12 }}>
          <Space align="start">
            <Tooltip title={disabled ? '低置信度结果需编辑确认后入库' : undefined}>
              <Checkbox checked={row.selected} disabled={disabled || !!row.importedRequirementId} onChange={(event) => toggleRow(row, event.target.checked)} onClick={(event) => event.stopPropagation()} />
            </Tooltip>
            <div>
              <Space size={6} wrap>
                {row.draft.clauseNo && <Tag>{row.draft.clauseNo}</Tag>}
                <Tag color={group === 'high' ? 'green' : group === 'medium' ? 'gold' : 'red'}>{percent(row.draft.confidence)}%</Tag>
                {row.importedRequirementId && <Tag color="blue">已入库</Tag>}
                {row.edited && <Tag color="purple">已编辑</Tag>}
              </Space>
              <div style={{ marginTop: 8, fontWeight: 700, color: '#0f172a' }}>{sanitizeSEVisibleText(row.draft.title)}</div>
            </div>
          </Space>
          <Space size={6} onClick={(event) => event.stopPropagation()}>
            <Tooltip title="编辑草稿">
              <Button aria-label="编辑草稿" size="small" icon={<EditOutlined />} onClick={() => openEdit(row)} />
            </Tooltip>
            <Tooltip title="重新生成">
              <Button aria-label="重新生成" size="small" icon={<RetweetOutlined />} loading={regeneratingKey === row.key} disabled={!!row.importedRequirementId} onClick={() => regenerateRow(row)} />
            </Tooltip>
            <Button size="small" type="primary" disabled={!canCommit(row)} loading={committing} onClick={() => commitRows([row])}>入库</Button>
          </Space>
        </Space>
        <div style={{ marginTop: 10 }}>
          <Progress percent={percent(row.draft.confidence)} size="small" showInfo={false} strokeColor={meta.color} />
        </div>
        <div style={{ color: '#334155', lineHeight: 1.7, marginTop: 10 }}>{sanitizeSEVisibleText(row.draft.requirementText)}</div>
        <div style={{ color: '#64748b', lineHeight: 1.65, marginTop: 8 }}>{sanitizeSEVisibleText(row.draft.executionDescription || '暂无执行描述')}</div>
        <div style={{ color: '#64748b', lineHeight: 1.65, marginTop: 8 }}>材料：{sanitizeSEVisibleText(materialText(row.draft))}</div>
        <details style={{ marginTop: 10, color: '#475569' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>AI 推理依据与来源</summary>
          <div style={{ marginTop: 8, lineHeight: 1.7 }}>{sanitizeSEVisibleText(row.draft.reasoning)}</div>
          <Space wrap size={6} style={{ marginTop: 8 }}>{row.draft.sourceChunks.map((item) => <Tag key={item}>{item}</Tag>)}</Space>
        </details>
      </div>
    )
  }

  if (loading) {
    return <div style={{ padding: 80, textAlign: 'center' }}><Spin description="加载解析任务..." /></div>
  }

  const running = job?.status === 'QUEUED' || job?.status === 'RUNNING'

  return (
    <div style={{ minWidth: 960 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }} align="center">
        <Space align="center">
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/standard-execution/sources')}>返回标准库</Button>
          <div>
            <Title level={3} style={{ margin: 0 }}>解析结果确认</Title>
            <Text type="secondary">{job?.result?.metadata.sourceTitle || '标准来源'} · {job?.jobId.slice(0, 8)}</Text>
          </div>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => loadJob()} loading={running}>刷新状态</Button>
          <Button icon={<DatabaseOutlined />} type="primary" disabled={selectedRows.length === 0} loading={committing} onClick={() => commitRows(selectedRows)}>
            批量入库 {selectedRows.length || ''}
          </Button>
        </Space>
      </Space>

      {running && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={job.status === 'QUEUED' ? '解析任务等待中' : '解析任务正在执行'}
          description={<Progress percent={job.progress} status="active" />}
        />
      )}
      {job?.status === 'FAILED' && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="解析失败" description={job.errorMessage || '请返回标准库重试'} />
      )}
      {job?.result?.metadata.degradedSteps.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="部分检索已降级"
          description={job.result.metadata.degradedSteps.join(' / ')}
        />
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 0.9fr) minmax(520px, 1.1fr)', gap: 18, alignItems: 'start' }}>
        <section style={{ border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', maxHeight: 'calc(100vh - 190px)', overflowY: 'auto' }}>
          <div style={{ position: 'sticky', top: 0, zIndex: 1, background: '#fff', borderBottom: '1px solid #e2e8f0', padding: '12px 14px', fontWeight: 700 }}>原文对照</div>
          <div style={{ padding: 14 }}>
            {segments.length ? segments.map((segment) => (
              <div
                key={segment.key}
                ref={(node) => { segmentRefs.current[segment.key] = node }}
                style={{
                  border: `1px solid ${activeSegmentKey === segment.key ? '#2563eb' : '#e2e8f0'}`,
                  background: activeSegmentKey === segment.key ? '#eff6ff' : '#fff',
                  borderRadius: 8,
                  padding: '12px 14px',
                  marginBottom: 10,
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.75,
                  color: '#334155',
                }}
              >
                <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{[segment.clauseNo, segment.title].filter(Boolean).join(' ') || `片段 ${segment.chunkIndex + 1}`}</div>
                {sanitizeSEVisibleText(segment.text)}
              </div>
            )) : <Empty description="暂无原文" />}
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button size="small" onClick={() => selectGroup('high')}>全选高置信度</Button>
            <Button size="small" onClick={() => selectGroup('medium')}>全选中置信度</Button>
            <Button size="small" onClick={() => setDrafts((current) => current.map((row) => ({ ...row, selected: false })))}>清空选择</Button>
            <Text type="secondary">低置信度需编辑确认后才可入库</Text>
          </div>
          {(['high', 'medium', 'low'] as ConfidenceGroup[]).map((group) => {
            const rows = grouped[group]
            const meta = groupMeta[group]
            return (
              <div key={group} style={{ border: `1px solid ${meta.border}`, background: meta.bg, borderRadius: 8, padding: 12 }}>
                <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 10 }}>
                  <span style={{ fontWeight: 800, color: meta.color }}>{meta.title}</span>
                  <Tag color={group === 'high' ? 'green' : group === 'medium' ? 'gold' : 'red'}>{rows.length} 条</Tag>
                </Space>
                <Space orientation="vertical" size={10} style={{ width: '100%' }}>
                  {rows.length ? rows.map(renderDraft) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无结果" />}
                </Space>
              </div>
            )
          })}
        </section>
      </div>

      <Modal
        title="编辑入库草稿"
        open={!!editRow}
        onCancel={() => setEditRow(null)}
        onOk={saveEdit}
        width={720}
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
            <Form.Item name="clauseNo" label="条款号"><Input maxLength={50} /></Form.Item>
            <Form.Item name="title" label="标题" rules={[{ required: true, message: '必填' }]}><Input maxLength={200} /></Form.Item>
          </div>
          <Form.Item name="requirementText" label="要求原文" rules={[{ required: true, message: '必填' }]}><TextArea rows={4} maxLength={10000} showCount /></Form.Item>
          <Form.Item name="executionDescription" label="执行描述"><TextArea rows={3} maxLength={2000} showCount /></Form.Item>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Form.Item name="recommendedTaskType" label="推荐任务类型"><Input maxLength={80} /></Form.Item>
            <Form.Item name="submitRequirement" label="提交要求"><Input maxLength={1000} /></Form.Item>
          </div>
          <Form.Item name="requiredMaterials" label="需提交材料（一行一个）"><TextArea rows={4} /></Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
