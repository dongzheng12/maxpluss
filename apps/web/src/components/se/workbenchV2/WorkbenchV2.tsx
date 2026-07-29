import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { HighlightOutlined, InfoCircleOutlined, ReloadOutlined, RobotOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import {
  PARSE_MODE_LABEL,
  seCommitTaskGeneration,
  seCommitTaskGenerationEnterprise,
  seListEnterpriseMembers,
  seListSources,
  seListSourcesEnterprise,
  SOURCE_TYPE_LABEL,
  type EnterpriseMember,
  type Source,
  type TaskCardV2,
  type TaskGenerationRuntimeConfig,
} from '../../../api/standardExecution'
import {
  buildTaskGenerationPreviewErrorAlert,
  type TaskGenerationPreviewErrorAlert,
} from '../taskGenerationPreviewError'
import { aiBatchRepolish, aiReextract, aiRewriteCard, getWorkbenchRuntimeConfig, previewWorkbench, restoreLatestPreviewJob, type PreviewJobProgress, type WorkbenchScope } from './aiAdapter'
import {
  applyCardEdit,
  applyRepolishedCards,
  applyRewrittenCard,
  buildModelFromPreview,
  cardStats,
  deleteCard,
  emptyModel,
  findCard,
  mergeCards,
  promoteCandidateToCard,
  splitCard,
  type CardEditablePatch,
  type WorkbenchModel,
} from './model'
import { batchToCommitBody, buildDraftPayload, type DispatchConfig } from './commit'
import TaskCardItem from './TaskCardItem'
import EditCardModal from './EditCardModal'
import StandardTextPanel from './StandardTextPanel'
import DispatchModal from './DispatchModal'

const { Text, Title } = Typography

// shipped-feature-marker: se-workbench-v2 —— 勿删，构建守卫据此确认 v2 工作台进入主 bundle
export const WORKBENCH_V2_MARKER = 'AI 任务草稿工作台'

type ParseMode = 'OCR_AI' | 'RULE' | 'AI_STUB'

interface WorkbenchV2Props {
  scope: WorkbenchScope
  initialSourceId?: string
}

type CommitNotice = {
  kind: 'draft' | 'dispatch'
  tasks: number
  requirements?: number
  batches?: number
}

const ENABLED_PARSE_MODES: ParseMode[] = ['OCR_AI', 'RULE']

const CONTAINER_HEIGHT = 'calc(100vh - 104px)'
const DEFAULT_RUNTIME_CONFIG: TaskGenerationRuntimeConfig = {
  aiChunkChars: 8000,
  aiConcurrency: 3,
  realtimeAiMaxChunks: 6,
  realtimeAiMaxChars: 48000,
  candidateMinScore: 60,
  candidateTaskMinScore: 75,
  candidateTaskPackageMax: 12,
  candidateV2Enabled: false,
}
const PREVIEW_JOB_RETENTION_COPY = '解析结果短期保留，丢失可重新解析。'

function formatChars(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)} 万` : `${n}`
}

function previewJobPercent(job: PreviewJobProgress) {
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return 100
  if (job.status === 'QUEUED') return 12
  const startedAt = Date.parse(job.startedAt || job.createdAt)
  if (!Number.isFinite(startedAt)) return 36
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000)
  return Math.min(92, Math.round(24 + elapsedSeconds * 0.85))
}

function previewJobStatusText(status: PreviewJobProgress['status']) {
  if (status === 'QUEUED') return '排队中'
  if (status === 'RUNNING') return '解析中'
  if (status === 'SUCCEEDED') return '已完成'
  return '解析失败'
}

function seedDispatch(card: TaskCardV2): DispatchConfig {
  return {
    reviewerId: null,
    deadlineMode: card.deadlineSuggestion.mode,
    deadlineDaysAfterApproval: card.deadlineSuggestion.daysAfterApproval,
    deadlineAt: card.deadlineSuggestion.fixedAt,
  }
}

function destinationLabel(destination: string) {
  switch (destination) {
    case 'TASK_PACKAGE':
      return '进入任务包'
    case 'ASSOCIATED_CANDIDATE':
      return '关联要求'
    case 'LOW_SCORE_CANDIDATE':
      return '低分候选'
    case 'OVERFLOW_CANDIDATE':
      return '超量候选'
    default:
      return destination
  }
}

function destinationColor(destination: string) {
  switch (destination) {
    case 'TASK_PACKAGE':
      return 'green'
    case 'ASSOCIATED_CANDIDATE':
      return 'blue'
    case 'LOW_SCORE_CANDIDATE':
      return 'default'
    case 'OVERFLOW_CANDIDATE':
      return 'orange'
    default:
      return 'default'
  }
}

function mergeModeLabel(mode: string) {
  switch (mode) {
    case 'DETERMINISTIC':
      return '确定性分组'
    case 'LLM_MERGED':
      return '组内 AI 合并'
    case 'LLM_FALLBACK':
      return 'AI 失败保底'
    default:
      return mode
  }
}

function CandidateInsightsPanel({
  model,
  onPromote,
  onActivateClause,
}: {
  model: WorkbenchModel
  onPromote: (candidateIndex: number) => void
  onActivateClause: (clauseNo: string | null) => void
}) {
  const hasCandidateData =
    model.candidateV2Enabled ||
    model.candidateRequirements.length > 0 ||
    model.taskPackages.length > 0 ||
    !!model.coverageReport
  if (!hasCandidateData) return null

  const coverageEntries = model.coverageReport?.entries || []
  const candidateOnlyEntries = coverageEntries.filter((entry) => entry.destination !== 'TASK_PACKAGE')
  const totalCandidates = model.candidateScoreDistribution?.total ?? model.candidateRequirements.length
  const promotedIndexes = new Set(
    model.cards.flatMap((card) => {
      const match = /^candidate-(\d+)$/.exec(card.draftId)
      return match ? [Number(match[1]) - 1] : []
    }),
  )

  return (
    <div style={{ border: '1px solid #dbeafe', borderRadius: 12, padding: 12, marginBottom: 12, background: '#f8fbff' }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Space size={8} wrap>
            <Text strong>AI 候选解析 v2</Text>
            <Tag color={model.candidateV2Enabled ? 'processing' : 'default'}>{model.candidateV2Enabled ? '开关已开' : '开关未开'}</Tag>
            <Tag>候选 {totalCandidates}</Tag>
            <Tag color="green">任务包 {model.taskPackages.length}</Tag>
            <Tag color="orange">未成任务 {candidateOnlyEntries.length}</Tag>
          </Space>
          {model.candidateThresholds && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              入围 ≥{model.candidateThresholds.candidateMinScore}；独立成任务 ≥{model.candidateThresholds.taskMinScore}
            </Text>
          )}
        </div>

        {model.candidateScoreDistribution && (
          <Space size={6} wrap>
            <Tag color="default">&lt;60：{model.candidateScoreDistribution.buckets.lt60}</Tag>
            <Tag color="blue">60-74：{model.candidateScoreDistribution.buckets.s60to74}</Tag>
            <Tag color="green">≥75：{model.candidateScoreDistribution.buckets.gte75}</Tag>
            <Tag color="purple">可独立成任务：{model.candidateScoreDistribution.taskEligible}</Tag>
          </Space>
        )}

        {model.taskPackages.length > 0 && (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Text strong>聚合任务包</Text>
            {model.taskPackages.map((pkg) => (
              <div key={pkg.packageId} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, background: '#fff' }}>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Text strong>{pkg.title}</Text>
                    <Tag color="green">score {pkg.score}</Tag>
                  </div>
                  <Text type="secondary">{pkg.description}</Text>
                  <Space size={6} wrap>
                    <Tag>{pkg.taskType}</Tag>
                    <Tag>{pkg.responsibleRole || '未指定责任对象'}</Tag>
                    <Tag>{pkg.evidenceType || '未指定证据'}</Tag>
                    <Tag>{mergeModeLabel(pkg.mergeMode)}</Tag>
                    <Tag>候选 {pkg.candidateCount}</Tag>
                  </Space>
                  {pkg.clauseNos.length > 0 && (
                    <Space size={4} wrap>
                      {pkg.clauseNos.map((clauseNo) => (
                        <Button key={clauseNo} type="link" size="small" style={{ padding: 0 }} onClick={() => onActivateClause(clauseNo)}>
                          {clauseNo}
                        </Button>
                      ))}
                    </Space>
                  )}
                  {pkg.warnings.length > 0 && <Text type="warning">提示：{pkg.warnings.join('；')}</Text>}
                </Space>
              </div>
            ))}
          </Space>
        )}

        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text strong>未成任务候选区</Text>
          {candidateOnlyEntries.length === 0 ? (
            <Text type="secondary">暂无未成任务候选；所有候选均已进入任务包。</Text>
          ) : (
            candidateOnlyEntries.map((entry) => {
              const candidate = model.candidateRequirements[entry.candidateIndex]
              const promoted = promotedIndexes.has(entry.candidateIndex)
              return (
                <div key={`${entry.destination}-${entry.candidateIndex}`} style={{ border: '1px dashed #cbd5e1', borderRadius: 10, padding: 10, background: '#fff' }}>
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <Space size={6} wrap>
                        <Tag color={destinationColor(entry.destination)}>{destinationLabel(entry.destination)}</Tag>
                        <Tag>score {entry.score}</Tag>
                        {entry.clauseNo && (
                          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => onActivateClause(entry.clauseNo)}>
                            {entry.clauseNo}
                          </Button>
                        )}
                      </Space>
                      <Button size="small" disabled={promoted || !candidate} onClick={() => onPromote(entry.candidateIndex)}>
                        {promoted ? '已提升' : '提升为任务卡'}
                      </Button>
                    </div>
                    {candidate?.action && <Text>{candidate.action}</Text>}
                    <Text type="secondary">{entry.sourceText}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>原因：{entry.reason}</Text>
                  </Space>
                </div>
              )
            })
          )}
        </Space>

        {coverageEntries.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', color: '#1677ff' }}>查看条款覆盖报告（{coverageEntries.length} 条）</summary>
            <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
              {coverageEntries.map((entry) => (
                <div key={`coverage-${entry.candidateIndex}`} style={{ display: 'grid', gridTemplateColumns: '72px 112px 1fr', gap: 8, alignItems: 'start' }}>
                  <Text type="secondary">#{entry.candidateIndex + 1}</Text>
                  <Tag color={destinationColor(entry.destination)} style={{ width: 'fit-content' }}>{destinationLabel(entry.destination)}</Tag>
                  <Text type="secondary">
                    {entry.clauseNo ? `${entry.clauseNo} · ` : ''}{entry.reason}
                    {entry.packageId ? ` · ${entry.packageId}` : ''}
                  </Text>
                </div>
              ))}
            </Space>
          </details>
        )}
      </Space>
    </div>
  )
}

export default function WorkbenchV2({ scope, initialSourceId = '' }: WorkbenchV2Props) {
  const isEnterprise = scope === 'enterprise'
  const navigate = useNavigate()
  const [sources, setSources] = useState<Source[]>([])
  const [members, setMembers] = useState<EnterpriseMember[]>([])
  const [sourceId, setSourceId] = useState(initialSourceId)
  const [sourceTypeFilter, setSourceTypeFilter] = useState('')
  const [parseMode, setParseMode] = useState<ParseMode>('OCR_AI')
  const [model, setModel] = useState<WorkbenchModel>(emptyModel())
  const [runtimeConfig, setRuntimeConfig] = useState<TaskGenerationRuntimeConfig>(DEFAULT_RUNTIME_CONFIG)
  const [loading, setLoading] = useState(false)
  const [parseJob, setParseJob] = useState<PreviewJobProgress | null>(null)
  const [restoringPreview, setRestoringPreview] = useState(false)
  const [restoreNotice, setRestoreNotice] = useState<{ type: 'success' | 'warning'; message: string; description: string } | null>(null)
  const [errorAlert, setErrorAlert] = useState<TaskGenerationPreviewErrorAlert | null>(null)
  const [commitNotice, setCommitNotice] = useState<CommitNotice | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [generated, setGenerated] = useState(false)

  // 批次2：多选 / 派发
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [dispatchByCardId, setDispatchByCardId] = useState<Record<string, DispatchConfig>>({})
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [candidatePanelOpen, setCandidatePanelOpen] = useState(false)
  const [sourceCollapsed, setSourceCollapsed] = useState(false)
  const [deadlineStampOpen, setDeadlineStampOpen] = useState(false)
  const [stampMode, setStampMode] = useState<'AFTER_APPROVAL_DAYS' | 'FIXED'>('AFTER_APPROVAL_DAYS')
  const [stampDays, setStampDays] = useState(30)
  const [stampFixedAt, setStampFixedAt] = useState<dayjs.Dayjs | null>(dayjs().add(30, 'day').hour(18).minute(0).second(0))
  const [savingDraft, setSavingDraft] = useState(false)

  // 批次3：左右联动
  const [activeClauseNo, setActiveClauseNo] = useState<string | null>(null)
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const restoreRunRef = useRef(0)

  // P2：AI 三能力
  const [rewritingId, setRewritingId] = useState<string | null>(null)
  const [undoSnapshot, setUndoSnapshot] = useState<{ cardId: string; prevCard: TaskCardV2 } | null>(null)
  const [repolishing, setRepolishing] = useState(false)
  const [reextracting, setReextracting] = useState(false)

  const selectedSource = useMemo(() => sources.find((s) => s.id === sourceId) || null, [sources, sourceId])
  const sourceTypeOptions = useMemo(() => {
    const values = Array.from(new Set(sources.map((s) => s.sourceType).filter(Boolean))) as string[]
    return [
      { value: '', label: '全部类型' },
      ...values.map((value) => ({ value, label: SOURCE_TYPE_LABEL[value] || value })),
    ]
  }, [sources])
  const filteredSources = useMemo(
    () => sources.filter((s) => !sourceTypeFilter || s.sourceType === sourceTypeFilter),
    [sourceTypeFilter, sources],
  )
  const selectedRawTextLength = selectedSource?.rawText?.length ?? 0
  const overRealtimeAiLimit = parseMode === 'OCR_AI' && selectedRawTextLength > runtimeConfig.realtimeAiMaxChars
  const realtimeAiPolicyHit = model.degradedReason === 'REALTIME_RULE_LIMIT'
  const parseModeOptions = useMemo(() => ENABLED_PARSE_MODES.map((value) => ({
    value,
    label: value === 'OCR_AI'
      ? `AI 实时解析（≤ ${formatChars(runtimeConfig.realtimeAiMaxChars)} 字）`
      : '规则解析（正式）',
  })), [runtimeConfig.realtimeAiMaxChars])
  const generateButtonLabel = parseMode === 'RULE' || overRealtimeAiLimit
    ? (generated ? '重新规则解析' : '规则解析生成草稿')
    : (generated ? '重新 AI 生成' : 'AI 生成任务草稿')
  const stats = useMemo(() => cardStats(model.cards), [model.cards])
  const editingCard: TaskCardV2 | null = editingId ? findCard(model, editingId) || null : null
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const memberOptions = members.map((m) => ({ value: m.id, label: `${m.phone}${m.nickName ? ` ${m.nickName}` : ''}` }))
  const allSelected = model.cards.length > 0 && selectedIds.length === model.cards.length
  const workbenchStep = !sourceId ? 0 : loading ? 1 : generated && !commitNotice ? 2 : commitNotice ? 3 : 1
  const hasCandidateData =
    model.candidateV2Enabled ||
    model.candidateRequirements.length > 0 ||
    model.taskPackages.length > 0 ||
    !!model.coverageReport
  const tasksPath = isEnterprise ? '/enterprise/tasks' : '/admin/standard-execution/tasks'
  const committedTasksPath = commitNotice?.kind === 'draft' ? `${tasksPath}?tab=draft` : `${tasksPath}?tab=executing`

  const resetSelection = () => {
    setSelectedIds([])
    setDispatchByCardId({})
    setUndoSnapshot(null)
  }

  useEffect(() => {
    const fetchSources = isEnterprise ? seListSourcesEnterprise : seListSources
    fetchSources({ status: 'ACTIVE', pageSize: 500 })
      .then((res) => setSources(res.data))
      .catch(() => message.error('标准文档加载失败'))
    seListEnterpriseMembers()
      .then((res) => setMembers(res.data))
      .catch(() => message.error('成员列表加载失败'))
    getWorkbenchRuntimeConfig(scope)
      .then(setRuntimeConfig)
      .catch(() => setRuntimeConfig(DEFAULT_RUNTIME_CONFIG))
  }, [isEnterprise, scope])

  useEffect(() => {
    const runId = ++restoreRunRef.current
    let cancelled = false
    setModel(emptyModel())
    setGenerated(false)
    setParseJob(null)
    setRestoreNotice(null)
    setErrorAlert(null)
    setCommitNotice(null)
    setActiveClauseNo(null)
    setFocusedCardId(null)
    setSelectedIds([])
    setDispatchByCardId({})
    setUndoSnapshot(null)
    if (!sourceId) return () => { cancelled = true }

    setRestoringPreview(true)
    void restoreLatestPreviewJob(scope, sourceId, (job) => {
      if (cancelled || runId !== restoreRunRef.current) return
      setParseJob(job)
      if (job.status === 'QUEUED' || job.status === 'RUNNING') setLoading(true)
    })
      .then((restored) => {
        if (cancelled || runId !== restoreRunRef.current || !restored) return
        setModel(buildModelFromPreview(restored.result))
        setGenerated(true)
        setRestoreNotice({
          type: 'success',
          message: '已恢复最近一次解析结果',
          description: `你可以继续编辑、保存或派发。${PREVIEW_JOB_RETENTION_COPY}`,
        })
      })
      .catch(() => {
        if (cancelled || runId !== restoreRunRef.current) return
        setRestoreNotice({
          type: 'warning',
          message: '最近一次解析未能恢复',
          description: `API 重启或 8083 部署后，内存级解析结果可能丢失。${PREVIEW_JOB_RETENTION_COPY}`,
        })
      })
      .finally(() => {
        if (cancelled || runId !== restoreRunRef.current) return
        setRestoringPreview(false)
        setLoading(false)
        setParseJob(null)
      })

    return () => { cancelled = true }
  }, [scope, sourceId])

  const runGenerate = async (sid: string, pmode: ParseMode) => {
    if (!sid) {
      message.warning('请先选择标准文档')
      return
    }
    restoreRunRef.current += 1
    setLoading(true)
    setParseJob(null)
    setRestoreNotice(null)
    setErrorAlert(null)
    setCommitNotice(null)
    try {
      const resp = await previewWorkbench(scope, { sourceId: sid, parseMode: pmode }, setParseJob)
      setModel(buildModelFromPreview(resp))
      setGenerated(true)
      setParseJob(null)
      resetSelection()
      setActiveClauseNo(null)
      setFocusedCardId(null)
      const n = resp.taskCards?.length ?? resp.drafts.length
      if (n === 0) message.warning('未识别到可生成的任务')
      else if (resp.degradedReason === 'REALTIME_RULE_LIMIT') message.info(`文档超出 AI 实时解析上限，已使用规则解析生成 ${n} 个任务草稿，当前在预览区`)
      else if (resp.degraded) message.warning(`已生成 ${n} 个任务草稿，但解析已切换为 ${PARSE_MODE_LABEL[resp.parseMode]}，可重试 AI`)
      else message.success(`AI 已生成 ${n} 个任务草稿，当前在预览区`)
    } catch (error) {
      setErrorAlert(buildTaskGenerationPreviewErrorAlert(error))
    } finally {
      setLoading(false)
    }
  }

  const handleEditSave = (cardId: string, patch: CardEditablePatch) => {
    setModel((m) => applyCardEdit(m, cardId, patch))
    setEditingId(null)
    setCommitNotice(null)
    message.success('已保存修改')
  }

  const handleDelete = (cardId: string) => {
    setModel((m) => deleteCard(m, cardId))
    setCommitNotice(null)
    setSelectedIds((ids) => ids.filter((id) => id !== cardId))
    setDispatchByCardId((prev) => {
      if (!(cardId in prev)) return prev
      const next = { ...prev }
      delete next[cardId]
      return next
    })
  }

  const toggleSelect = (cardId: string, checked: boolean) => {
    setSelectedIds((ids) => (checked ? [...new Set([...ids, cardId])] : ids.filter((id) => id !== cardId)))
  }
  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? model.cards.map((c) => c.id) : [])
  }
  const invertSelection = () => {
    setSelectedIds((ids) => {
      const current = new Set(ids)
      return model.cards.filter((card) => !current.has(card.id)).map((card) => card.id)
    })
  }

  /** 把补丁 stamp 到所有选中卡（批量调审核人 / 调截止） */
  const stampSelected = (patch: Partial<DispatchConfig>) => {
    setDispatchByCardId((prev) => {
      const next = { ...prev }
      for (const id of selectedIds) {
        const card = model.cards.find((c) => c.id === id)
        if (!card) continue
        next[id] = { ...(prev[id] ?? seedDispatch(card)), ...patch }
      }
      return next
    })
  }

  const applyDeadlineStamp = () => {
    stampSelected({
      deadlineMode: stampMode,
      deadlineDaysAfterApproval: stampMode === 'AFTER_APPROVAL_DAYS' ? stampDays : null,
      deadlineAt: stampMode === 'FIXED' ? (stampFixedAt ? stampFixedAt.toISOString() : null) : null,
    })
    setDeadlineStampOpen(false)
    message.success(`已为 ${selectedIds.length} 张卡设置截止`)
  }

  const handleSaveDraft = async () => {
    if (selectedIds.length === 0) {
      message.warning('请先选择要保存的任务卡')
      return
    }
    const payload = buildDraftPayload(model, selectedIds)
    if (!payload) {
      message.warning('没有可保存的已选任务卡')
      return
    }
    setSavingDraft(true)
    try {
      const fn = isEnterprise ? seCommitTaskGenerationEnterprise : seCommitTaskGeneration
      const res = await fn(batchToCommitBody(payload))
      setCommitNotice({
        kind: 'draft',
        tasks: res.data.summary.tasks,
        requirements: res.data.summary.requirements,
      })
      message.success(`已保存 ${res.data.summary.tasks} 个任务草稿，可去任务管理查看`)
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存草稿失败')
    } finally {
      setSavingDraft(false)
    }
  }

  const handleDispatched = (summary: { requirements: number; tasks: number; batches: number }) => {
    setDispatchOpen(false)
    resetSelection()
    setCommitNotice({ kind: 'dispatch', ...summary })
    message.success(`已派发 ${summary.tasks} 个任务，可去任务管理查看`)
  }

  // 合并 / 拆分
  const handleMerge = () => {
    if (selectedIds.length < 2) return
    const selected = new Set(selectedIds)
    const target = model.cards.find((card) => selected.has(card.id))
    setModel((m) => mergeCards(m, selectedIds))
    if (target) {
      setSelectedIds([target.id])
      setFocusedCardId(target.id)
      setActiveClauseNo(target.basis.clauseNo ?? null)
    } else {
      setSelectedIds([])
    }
    setCommitNotice(null)
    message.success('已合并为 1 张任务卡；已定位到右侧任务草稿，可继续编辑、保存或派发')
  }
  const handleSplit = (cardId: string) => {
    setModel((m) => splitCard(m, cardId))
    setCommitNotice(null)
    message.success('已拆分为 2 张任务卡')
  }

  const handlePromoteCandidate = (candidateIndex: number) => {
    setModel((m) => {
      const next = promoteCandidateToCard(m, candidateIndex)
      const added = next.cards.find((card) => !m.cards.some((prev) => prev.id === card.id))
      if (added) {
        queueMicrotask(() => {
          setSelectedIds([added.id])
          setFocusedCardId(added.id)
          setActiveClauseNo(added.basis.clauseNo ?? null)
        })
      }
      return next
    })
    setCommitNotice(null)
    message.success('已提升为任务卡；已加入右侧任务草稿并选中')
  }

  // P2：单卡 AI 重写（失败不影响其它卡；持久 Alert；可撤销）
  const REPOLISH_LIMIT = 24
  const handleRewrite = async (cardId: string) => {
    const card = model.cards.find((c) => c.id === cardId)
    if (!card) return
    setRewritingId(cardId)
    setErrorAlert(null)
    try {
      const res = await aiRewriteCard(scope, {
        sourceId: sourceId || undefined,
        card,
        surroundingCards: model.cards.filter((c) => c.id !== cardId).slice(0, 6),
      })
      setUndoSnapshot({ cardId, prevCard: card })
      setModel((m) => applyRewrittenCard(m, res.taskCard))
      setCommitNotice(null)
      if (res.polish.status === 'DEGRADED') message.warning('AI 重写失败，已保留原卡内容，可重试')
      else message.success('已重写，可撤销')
    } catch (error) {
      setErrorAlert(buildTaskGenerationPreviewErrorAlert(error))
    } finally {
      setRewritingId(null)
    }
  }
  const handleUndoRewrite = (cardId: string) => {
    if (!undoSnapshot || undoSnapshot.cardId !== cardId) return
    setModel((m) => applyRewrittenCard(m, undoSnapshot.prevCard))
    setUndoSnapshot(null)
    message.success('已撤销重写')
  }

  // P2：批量 AI 优化（选中卡重润色，≤24/批；失败卡 fallback 不影响其它）
  const handleBatchRepolish = async () => {
    const cards = model.cards.filter((c) => selectedSet.has(c.id))
    if (cards.length === 0) return
    if (cards.length > REPOLISH_LIMIT) {
      message.warning(`批量 AI 优化单批最多 ${REPOLISH_LIMIT} 张，请减少选择`)
      return
    }
    setRepolishing(true)
    setErrorAlert(null)
    try {
      const res = await aiBatchRepolish(scope, { sourceId: sourceId || undefined, cards })
      setModel((m) => applyRepolishedCards(m, res.taskCards))
      setUndoSnapshot(null)
      setCommitNotice(null)
      const fb = res.polish.stats.fallbackCards
      if (res.polish.status === 'DEGRADED' || fb > 0) message.warning(`AI 优化完成，${fb} 张未优化（保留原卡），可重试`)
      else message.success(`已优化 ${res.taskCards.length} 张卡`)
    } catch (error) {
      setErrorAlert(buildTaskGenerationPreviewErrorAlert(error))
    } finally {
      setRepolishing(false)
    }
  }

  // P2：整体重新提取（替换当前草稿集，二次确认防误丢改动）
  const handleReextract = () => {
    if (!sourceId) {
      message.warning('请先选择标准文档')
      return
    }
    Modal.confirm({
      title: '整体重新提取',
      content: '将用 AI 重新提取并润色，丢弃当前所有任务卡的改动（含手工编辑、合并/拆分）。确认？',
      okText: '重新提取',
      cancelText: '取消',
      onOk: async () => {
        setReextracting(true)
        setErrorAlert(null)
        try {
          const res = await aiReextract(scope, { sourceId, parseMode, previousCardCount: model.cards.length })
          setModel(buildModelFromPreview(res))
          resetSelection()
          setActiveClauseNo(null)
          setCommitNotice(null)
          message.success(`已重新提取 ${res.taskCards?.length ?? res.drafts.length} 个任务草稿`)
        } catch (error) {
          setErrorAlert(buildTaskGenerationPreviewErrorAlert(error))
        } finally {
          setReextracting(false)
        }
      },
    })
  }

  // 左右联动：点卡 → 激活其条款；点原文条款 → 激活
  const activateByCard = (cardId: string) => {
    const c = model.cards.find((x) => x.id === cardId)
    setActiveClauseNo(c?.basis.clauseNo ?? null)
  }

  // 联动滚动：激活条款变化 → 左滚到原文段、右滚到首张对应卡
  useEffect(() => {
    if (!activeClauseNo || !rootRef.current) return
    const root = rootRef.current
    const sel = activeClauseNo.replace(/["\\]/g, '\\$&')
    root.querySelector(`[data-clause-no="${sel}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const firstCard = model.cards.find((c) => c.basis.clauseNo === activeClauseNo)
    if (firstCard) {
      const cid = firstCard.id.replace(/["\\]/g, '\\$&')
      root.querySelector(`[data-card-id="${cid}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [activeClauseNo, model.cards])

  useEffect(() => {
    if (!focusedCardId || !rootRef.current) return
    const root = rootRef.current
    const cid = focusedCardId.replace(/["\\]/g, '\\$&')
    root.querySelector(`[data-card-id="${cid}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = window.setTimeout(() => setFocusedCardId(null), 1800)
    return () => window.clearTimeout(timer)
  }, [focusedCardId, model.cards])

  const showArtifactNotice = generated && (model.cards.length > 0 || hasCandidateData)
  const artifactNoticeMessage = commitNotice
    ? commitNotice.kind === 'dispatch'
      ? `已派发 ${commitNotice.tasks} 个任务`
      : `已保存 ${commitNotice.tasks} 个任务草稿`
    : hasCandidateData
      ? `候选已聚合为右侧 ${stats.total} 张任务草稿`
      : `已生成 ${stats.total} 个任务草稿，当前在工作台预览区`
  const artifactNoticeDescription = commitNotice
    ? commitNotice.kind === 'dispatch'
      ? '已写入任务管理，执行人会在「我的任务」收到任务；这里仍可继续处理未选中的预览卡。'
      : '已写入任务管理 - 草稿；这里仍可继续处理未选中的预览卡。'
    : hasCandidateData
      ? '「聚合任务包」是 AI 候选到任务草稿的依据报告；真正可保存/派发的是右侧任务草稿。选中后保存草稿或批量派发，才会进入任务管理。'
      : '这些卡片还没有落库；选中后保存草稿或批量派发，才会进入任务管理。'
  const showArtifactInfo = () => {
    message.info({
      content: `${artifactNoticeMessage}。${artifactNoticeDescription}`,
      duration: 6,
    })
  }
  const primaryNextText = commitNotice
    ? '已进入任务管理，可继续处理未保存卡片'
    : generated
      ? selectedIds.length > 0
        ? `已选 ${selectedIds.length} 张，可保存草稿或批量派发`
        : '下一步：选择任务卡，然后保存草稿或批量派发'
      : '先选择文档并生成任务草稿'
  const selectionRequiredTip = selectedIds.length === 0 ? '请先勾选要处理的任务卡' : undefined

  return (
    <div style={{ height: CONTAINER_HEIGHT, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* 顶部入口栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 12, flexWrap: 'wrap' }}>
        <Title level={5} style={{ margin: 0 }}>
          <RobotOutlined style={{ color: '#4096ff', marginRight: 6 }} />
          {WORKBENCH_V2_MARKER}
        </Title>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ width: 160 }}
          value={sourceTypeFilter}
          options={sourceTypeOptions}
          onChange={(v) => setSourceTypeFilter(v || '')}
        />
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          filterOption={(input, option) => String(option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
          style={{ minWidth: 360 }}
          placeholder="选择已启用且含正文的标准文档"
          value={sourceId || undefined}
          options={filteredSources.map((s) => ({
            value: s.id,
            label: `${s.title}${s.sourceNo ? ` · ${s.sourceNo}` : ''}${s.sourceType ? ` · ${SOURCE_TYPE_LABEL[s.sourceType] || s.sourceType}` : ''}`,
            disabled: !s.rawText,
          }))}
          onChange={(v) => setSourceId(v || '')}
        />
        <Select style={{ width: 220 }} options={parseModeOptions} value={parseMode} onChange={(v) => setParseMode(v as ParseMode)} />
        <Button type="primary" icon={<ThunderboltOutlined />} loading={loading} onClick={() => runGenerate(sourceId, parseMode)}>
          {generateButtonLabel}
        </Button>
        <Tooltip title={PREVIEW_JOB_RETENTION_COPY}>
          <Button
            size="small"
            shape="circle"
            type="text"
            icon={<InfoCircleOutlined />}
            onClick={() => message.info(PREVIEW_JOB_RETENTION_COPY)}
            aria-label="查看解析结果保留说明"
          />
        </Tooltip>
        {restoreNotice && (
          <Tooltip title={restoreNotice.message}>
            <Button
              size="small"
              shape="circle"
              type="text"
              icon={<InfoCircleOutlined style={{ color: restoreNotice.type === 'success' ? '#52c41a' : '#faad14' }} />}
              onClick={() => message.info({ content: `${restoreNotice.message}。${restoreNotice.description}`, duration: 6 })}
              aria-label="查看最近解析恢复状态"
            />
          </Tooltip>
        )}
        {showArtifactNotice && (
          <Space size={4}>
            <Tooltip title="查看当前解析结果说明">
              <Button
                size="small"
                shape="circle"
                type="text"
                icon={<InfoCircleOutlined />}
                onClick={showArtifactInfo}
                aria-label="查看解析说明"
              />
            </Tooltip>
            {hasCandidateData && (
              <Button size="small" type="link" onClick={() => setCandidatePanelOpen(true)}>
                依据/覆盖报告
              </Button>
            )}
            {commitNotice && (
              <Button size="small" type="link" onClick={() => navigate(committedTasksPath)}>
                去任务管理
              </Button>
            )}
          </Space>
        )}
      </div>

      {errorAlert && (
        <Alert
          type={errorAlert.kind === 'overload' ? 'warning' : 'error'}
          showIcon
          closable
          onClose={() => setErrorAlert(null)}
          style={{ marginBottom: 12 }}
          message={errorAlert.message}
          description={errorAlert.description}
          action={<Button size="small" onClick={() => runGenerate(sourceId, parseMode)} loading={loading}>重试</Button>}
        />
      )}

      {overRealtimeAiLimit && !generated && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 8 }}
          message={`文档约 ${formatChars(selectedRawTextLength)} 字，超出 AI 实时解析上限（${formatChars(runtimeConfig.realtimeAiMaxChars)} 字），将使用规则解析`}
          action={<Button size="small" type="link" onClick={() => message.info('这是当前大文档的正式解析策略；AI 大文档异步解析将随 T10 C1 另行上线。')}>说明</Button>}
        />
      )}

      {parseJob && (loading || restoringPreview) && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={parseJob.status === 'QUEUED' ? '解析任务已进入队列' : '解析任务正在后台执行'}
          description={(
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Progress
                percent={previewJobPercent(parseJob)}
                status={parseJob.status === 'FAILED' ? 'exception' : 'active'}
                size="small"
              />
              <Text type="secondary">
                任务 ID：{parseJob.id.slice(0, 8)}；当前状态：{previewJobStatusText(parseJob.status)}。可离开页面，回来会自动恢复最近一次解析。{PREVIEW_JOB_RETENTION_COPY}
              </Text>
            </Space>
          )}
        />
      )}

      {model.polish?.status === 'DEGRADED' && !realtimeAiPolicyHit && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="AI 润色未完成，已降级展示原文提取结果"
          description={model.polish.degradedReason || undefined}
        />
      )}

      {model.degraded && (
        <Alert
          type={realtimeAiPolicyHit ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          message={
            realtimeAiPolicyHit
              ? `文档超出 AI 实时解析上限，已使用${PARSE_MODE_LABEL[model.parseMode as ParseMode] || model.parseMode}`
              : `解析已从 ${PARSE_MODE_LABEL[model.requestedMode as ParseMode] || model.requestedMode} 切换为 ${PARSE_MODE_LABEL[model.parseMode as ParseMode] || model.parseMode}`
          }
          description={
            realtimeAiPolicyHit
              ? `当前任务卡为规则解析/原文提取结果。AI 大文档异步解析将随 T10 C1 上线；当前无需重复点击 AI 重试。${model.warnings.length ? `系统提示：${model.warnings.join('；')}` : ''}`
              : model.warnings.length
              ? `${model.warnings.join('；')}。当前任务卡为规则解析/原文提取结果，可点击「重新生成」重试 AI。`
              : `${model.degradedReason || 'AI 解析未完成'}。当前任务卡为规则解析/原文提取结果，可点击「重新生成」重试 AI。`
          }
          action={realtimeAiPolicyHit ? undefined : <Button size="small" onClick={() => runGenerate(sourceId, parseMode)} loading={loading}>重试 AI</Button>}
        />
      )}

      <Steps
        size="small"
        current={workbenchStep}
        style={{ marginBottom: 12 }}
        items={[
          { title: '选择文档', description: selectedSource?.title ? `已选：${selectedSource.title}` : '选择标准文档' },
          { title: 'AI 解析', description: loading ? '解析中，可离开恢复' : generated ? '已生成结果' : '生成任务草稿' },
          { title: '确认任务卡', description: model.cards.length > 0 ? `右侧 ${model.cards.length} 张，可编辑/勾选` : '查看候选并生成卡片' },
          { title: '保存或派发', description: commitNotice ? '已进入任务管理' : '只处理已选任务卡' },
        ]}
      />

      {/* 1 屏主体：左原文 | 右任务卡 */}
      <div
        ref={rootRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: sourceCollapsed ? '44px minmax(520px, 1fr)' : 'minmax(240px, 0.58fr) minmax(520px, 1.42fr)',
          gap: 12,
          border: '1px solid #eef2f7',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#fff',
        }}
      >
        <div style={{ borderRight: '1px solid #eef2f7', minHeight: 0 }}>
          {sourceCollapsed ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc' }}>
              <Button
                size="small"
                type="text"
                onClick={() => setSourceCollapsed(false)}
                title="展开标准原文"
                style={{ writingMode: 'vertical-rl', height: 120 }}
              >
                展开原文
              </Button>
            </div>
          ) : (
            <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid #eef2f7', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text type="secondary" style={{ fontSize: 12 }}>标准原文</Text>
                <Button size="small" type="text" onClick={() => setSourceCollapsed(true)}>收起</Button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <StandardTextPanel
                  rawText={selectedSource?.rawText}
                  sourceTitle={selectedSource?.title || model.source?.title}
                  cards={model.cards}
                  activeClauseNo={activeClauseNo}
                  onClauseClick={setActiveClauseNo}
                />
              </div>
            </div>
          )}
        </div>

        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #eef2f7', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <Space direction="vertical" size={2}>
              <Space size={8}>
                <Text strong>第 3 步：确认任务卡</Text>
                {generated && <Tag color="blue">已生成 {stats.total} 张</Tag>}
                <Tag color={selectedIds.length > 0 ? 'green' : 'default'}>已选 {selectedIds.length} 张</Tag>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>{primaryNextText}</Text>
            </Space>
            <Space size={8} wrap style={{ justifyContent: 'flex-end' }}>
              {model.cards.length > 0 && (
                <Checkbox
                  checked={allSelected}
                  indeterminate={selectedIds.length > 0 && !allSelected}
                  onChange={(e) => toggleSelectAll(e.target.checked)}
                >
                  全选
                </Checkbox>
              )}
              {hasCandidateData && (
                <Button size="small" type="link" onClick={() => setCandidatePanelOpen(true)}>
                  查看依据/覆盖报告
                </Button>
              )}
            </Space>
          </div>

          {/* 任务卡操作条：有数据态常驻，禁用动作必须说明原因 */}
          {generated && (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid #eef2f7', background: '#f8fbff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <Space wrap>
              <Text type="secondary">已选 {selectedIds.length} / {model.cards.length}</Text>
              <Button size="small" onClick={() => toggleSelectAll(true)}>全选</Button>
              <Button size="small" onClick={invertSelection}>反选</Button>
              <Button size="small" type="text" onClick={() => setSelectedIds([])}>清除选择</Button>
            </Space>
            <Space wrap>
              <Select
                size="small"
                showSearch
                allowClear
                optionFilterProp="label"
                style={{ width: 180 }}
                placeholder="批量调审核人"
                options={memberOptions}
                value={undefined}
                onChange={(v) => v && stampSelected({ reviewerId: v })}
              />
              <Button size="small" onClick={() => setDeadlineStampOpen(true)}>批量调截止</Button>
              <Tooltip title={selectedIds.length < 2 ? '至少选择 2 张任务卡才能合并' : undefined}>
                <span><Button size="small" disabled={selectedIds.length < 2} onClick={handleMerge}>合并为一卡</Button></span>
              </Tooltip>
              <Tooltip title={selectionRequiredTip}>
                <span><Button size="small" disabled={selectedIds.length === 0} icon={<HighlightOutlined />} loading={repolishing} onClick={handleBatchRepolish}>AI 优化</Button></span>
              </Tooltip>
              <Button size="small" icon={<ReloadOutlined />} loading={reextracting} disabled={!generated} onClick={handleReextract}>整体重提取</Button>
              <Tooltip title={selectionRequiredTip}>
                <span>
                  <Button size="small" loading={savingDraft} disabled={selectedIds.length === 0} onClick={handleSaveDraft}>
                    保存草稿{selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={selectionRequiredTip}>
                <span>
                  <Button size="small" type="primary" disabled={selectedIds.length === 0} onClick={() => setDispatchOpen(true)}>
                    批量派发{selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}
                  </Button>
                </span>
              </Tooltip>
              {commitNotice && <Button size="small" type="primary" onClick={() => navigate(committedTasksPath)}>进入任务管理</Button>}
            </Space>
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {loading ? (
              <div style={{ textAlign: 'center', paddingTop: 60 }}><Spin tip={parseJob ? '解析任务后台执行中，可离开页面' : 'AI 生成中…'} /></div>
            ) : model.cards.length === 0 && !hasCandidateData ? (
              <Empty description={generated ? '没有可用任务草稿' : '选择标准文档后点「AI 生成任务草稿」'} style={{ paddingTop: 60 }} />
            ) : (
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {model.cards.length === 0 ? (
                  <Empty description="候选已保留在未成任务区，可手动提升后再保存或派发" />
                ) : (
                  model.cards.map((card) => (
                    <TaskCardItem
                      key={card.id}
                      card={card}
                      selected={selectedSet.has(card.id)}
                      focused={focusedCardId === card.id}
                      onToggleSelect={toggleSelect}
                      onEdit={setEditingId}
                      onDelete={handleDelete}
                      onSplit={handleSplit}
                      onRewrite={handleRewrite}
                      rewriting={rewritingId === card.id}
                      undoable={undoSnapshot?.cardId === card.id}
                      onUndoRewrite={handleUndoRewrite}
                      active={!!activeClauseNo && card.basis.clauseNo === activeClauseNo}
                      onActivate={activateByCard}
                    />
                  ))
                )}
              </Space>
            )}
          </div>
        </div>
      </div>

      <EditCardModal card={editingCard} open={!!editingId} onCancel={() => setEditingId(null)} onSave={handleEditSave} />

      <Modal
        title="AI 候选解析 v2：聚合任务包与覆盖报告"
        open={candidatePanelOpen}
        onCancel={() => setCandidatePanelOpen(false)}
        footer={null}
        width={960}
        destroyOnClose
      >
        <CandidateInsightsPanel
          model={model}
          onPromote={handlePromoteCandidate}
          onActivateClause={(clauseNo) => {
            setActiveClauseNo(clauseNo)
            setCandidatePanelOpen(false)
          }}
        />
      </Modal>

      <DispatchModal
        open={dispatchOpen}
        scope={scope}
        model={model}
        selectedIds={selectedIds}
        dispatchByCardId={dispatchByCardId}
        members={members}
        onCancel={() => setDispatchOpen(false)}
        onDispatched={handleDispatched}
      />

      {/* 批量调截止小弹窗 */}
      <Modal
        title={`批量调截止（${selectedIds.length} 张卡）`}
        open={deadlineStampOpen}
        onOk={applyDeadlineStamp}
        onCancel={() => setDeadlineStampOpen(false)}
        okText="应用"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Radio.Group value={stampMode} onChange={(e) => setStampMode(e.target.value)}>
            <Radio value="AFTER_APPROVAL_DAYS">审核通过后 N 天</Radio>
            <Radio value="FIXED">固定日期</Radio>
          </Radio.Group>
          {stampMode === 'AFTER_APPROVAL_DAYS' ? (
            <InputNumber min={1} max={3650} value={stampDays} onChange={(v) => setStampDays(v || 30)} addonAfter="天" style={{ width: 160 }} />
          ) : (
            <DatePicker showTime value={stampFixedAt} onChange={setStampFixedAt} style={{ width: 240 }} />
          )}
        </Space>
      </Modal>
    </div>
  )
}
