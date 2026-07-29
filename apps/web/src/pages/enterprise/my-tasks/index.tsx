/**
 * 企业员工端：我的任务
 * GET /api/app/standard-execution/tasks  — 任务列表（按 tab 过滤：todo/review/done/closed）
 * GET /api/app/standard-execution/tasks/:id — 任务详情
 * POST /api/app/standard-execution/tasks/:id/view — 标记进入（PENDING→IN_PROGRESS）
 * POST /api/app/standard-execution/tasks/:id/submit — 提交（multipart）
 */
import { useEffect, useState, useContext, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { SEPageContext } from '../../../contexts/SEPageContext'
import {
  Table, Typography, Button, Space, Tag, message,
  Modal, Form, Input, Upload, Alert, Radio, InputNumber,
} from 'antd'
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CloseCircleOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { nodeApi } from '../../../api/client'
import {
  ASSIGNEE_STATUS_LABEL,
  TASK_TYPE_LABEL,
  seGetTaskItems,
  seListMyTasksV2,
  sePatchTaskItem,
  type MyTaskListV2Counts,
  type MyTaskListV2Item,
  type SubmitFormConfig,
  type SubmitFormMode,
  type TaskItemVO,
} from '../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../utils/sePresentation'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// 每种任务类型的简短操作提示
const TASK_TYPE_HINT: Record<string, string> = {
  TRAINING: '阅读完成后填写确认说明',
  QUALIFICATION_MATERIAL: '请上传资质/证书材料',
  ONBOARDING_ACCESS: '请填写上岗准入确认',
  INSPECTION_FILL: '请逐项填写检查实测值',
  RECTIFICATION: '请详述整改措施及根因',
  ARCHIVE_MATERIAL: '请上传归档材料文件',
  PARAMETER: '请填写参数名称/标准值/实测值',
  DOCUMENT_UPLOAD: '必须上传相关资料文件',
  PHOTO: '必须上传至少 1 张现场照片',
  OTHER: '请按任务说明完成提交',
}

const FILE_REQUIRED_TASK_TYPES = new Set([
  'PHOTO',
  'DOCUMENT_UPLOAD',
  'QUALIFICATION_MATERIAL',
  'ARCHIVE_MATERIAL',
])

const DOCUMENT_LIKE_TASK_TYPES = new Set([
  'DOCUMENT_UPLOAD',
  'QUALIFICATION_MATERIAL',
  'ARCHIVE_MATERIAL',
])

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  boxShadow: '0 10px 22px rgba(15, 23, 42, 0.05)',
}

const mutedTextStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
}

type MpTaskTab = 'todo' | 'review' | 'done' | 'closed'

// ── 列表项（来自 GET /api/app/standard-execution/tasks） ─────────────────────
type MpTaskItem = MyTaskListV2Item

// ── 详情（来自 GET /api/app/standard-execution/tasks/:id） ──────────────────
type RequirementSubmitOption = 'TEXT' | 'IMAGE' | 'FILE' | 'STRUCTURED' | 'QUIZ' | 'LEARNING'
interface RequirementStructuredField { id?: string; name?: string; fieldType?: string; required?: boolean; validation?: string | null }
interface RequirementLearningMaterial { type?: 'file' | 'link'; url?: string | null; name?: string }
interface ChecklistItem {
  id: string
  name: string
  judgeType: 'TEXT' | 'BOOL' | 'NUMBER_RANGE'
  min?: number | null
  max?: number | null
  unit?: string | null
  requirementId?: string | null
  requirementTitle?: string | null
  requirementDescription?: string | null
  clauseNo?: string | null
  sourceTitle?: string | null
  required?: boolean
  sort?: number
  submitOptions?: RequirementSubmitOption[]
  submitModes?: SubmitFormMode[]
  textPrompt?: string | null
  attachmentRequired?: boolean
  attachmentMinCount?: number | null
  attachmentMaxCount?: number | null
  attachmentHint?: string | null
  structuredFields?: RequirementStructuredField[]
  quizBankId?: string | null
  quizQuestionCount?: number | null
  quizPassScore?: number | null
  learningMaterials?: RequirementLearningMaterial[]
}
interface ParameterItem  { id: string; name: string; standard: string; unit?: string | null; method?: string | null }
interface LearningMaterialItem { type: 'file' | 'link'; url: string; name: string }
interface MpTaskDetail {
  task: {
    id: string
    title: string
    description: string | null
    submitRequirement: string
    deadlineAt: string
    status: string
    reviewerId: string
    taskType?: string | null
    checklistSchema?: { items: ChecklistItem[] } | null
    parametersSchema?: { items: ParameterItem[] } | null
    learningMaterials?: { items: LearningMaterialItem[] } | null
    quizBankId?: string | null
    submitFormConfig?: SubmitFormConfig
  }
  requirement: {
    id: string
    title: string
    clauseNo: string | null
    source: { id: string; title: string }
  }
  myAssignee: {
    id: string
    status: string
    submittedAt: string | null
    reviewedAt: string | null
  }
  mySubmissions: Array<{
    id: string
    version: number
    submitText: string
    status: string
    reviewComment: string | null
    submittedAt: string
    attachments?: Array<{
      id: string
      fileName: string
      fileUrl: string
      fileSize?: number | null
      mimeType?: string | null
    }>
  }>
  isOverdue: boolean
}

const REQUIREMENT_SUBMIT_LABEL: Record<RequirementSubmitOption, string> = {
  TEXT: '文本填写',
  IMAGE: '图片上传',
  FILE: '文件上传',
  STRUCTURED: '结构化填写',
  QUIZ: '题库答题',
  LEARNING: '学习确认',
}

const DEFAULT_REQUIREMENT_SUBMIT_OPTIONS: RequirementSubmitOption[] = ['TEXT', 'IMAGE']

function normalizeRequirementSubmitOptions(raw: unknown): RequirementSubmitOption[] {
  const values = Array.isArray(raw) ? raw : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
  const allowed = new Set<RequirementSubmitOption>(Object.keys(REQUIREMENT_SUBMIT_LABEL) as RequirementSubmitOption[])
  const normalized = values.filter((value): value is RequirementSubmitOption => allowed.has(value as RequirementSubmitOption))
  return normalized.length ? Array.from(new Set(normalized)) : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
}

function requirementConfigItems(detail: MpTaskDetail | null): ChecklistItem[] {
  if (!detail?.task.checklistSchema?.items?.length) return []
  return detail.task.checklistSchema.items
    .filter((item) => item.requirementTitle || item.requirementDescription || item.submitOptions?.length)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
}

function findRequirementSubmitConfig(detail: MpTaskDetail | null, requirementId?: string | null, index = 0): ChecklistItem | null {
  const configs = requirementConfigItems(detail)
  if (!configs.length) return null
  return configs.find((item) => item.requirementId && item.requirementId === requirementId)
    || configs[index]
    || null
}

function renderRequirementSubmitTags(config: ChecklistItem | null) {
  const options = normalizeRequirementSubmitOptions(config?.submitOptions)
  return (
    <Space wrap size={4}>
      {options.map((option) => (
        <Tag key={option} color={option === 'QUIZ' ? 'purple' : option === 'IMAGE' || option === 'FILE' ? 'blue' : undefined}>
          {REQUIREMENT_SUBMIT_LABEL[option]}
        </Tag>
      ))}
    </Space>
  )
}

function requirementSubmitHint(config: ChecklistItem | null) {
  if (!config) return '按任务要求填写说明，可上传补充附件。'
  const parts: string[] = []
  if (config.textPrompt) parts.push(`文本：${config.textPrompt}`)
  const options = normalizeRequirementSubmitOptions(config.submitOptions)
  if (options.includes('IMAGE') || options.includes('FILE')) {
    const min = config.attachmentRequired === false ? 0 : Math.max(1, config.attachmentMinCount ?? 1)
    parts.push(`附件：${min > 0 ? `至少 ${min} 个` : '可选'}，最多 ${config.attachmentMaxCount ?? 20} 个${config.attachmentHint ? `，${config.attachmentHint}` : ''}`)
  }
  if (options.includes('STRUCTURED')) parts.push(`结构化：${config.structuredFields?.length || 0} 项`)
  if (options.includes('QUIZ')) parts.push(`题库：${config.quizQuestionCount ? `${config.quizQuestionCount} 题` : '需作答'}${config.quizPassScore ? `，通过分 ${config.quizPassScore}` : ''}`)
  if (options.includes('LEARNING')) parts.push(`学习材料：${config.learningMaterials?.length || 0} 份`)
  return parts.join('；') || '按本要求项配置提交。'
}

function submitFormFallback(detail: MpTaskDetail, taskItemCount: number): SubmitFormConfig {
  const taskType = detail.task.taskType || 'OTHER'
  const hasChecklist = !!detail.task.checklistSchema?.items?.length
  const hasParameter = !!detail.task.parametersSchema?.items?.length
  const hasLearning = !!detail.task.learningMaterials?.items?.length
  const hasQuiz = !!detail.task.quizBankId
  const attachmentRequired = FILE_REQUIRED_TASK_TYPES.has(taskType)
  const modes: SubmitFormConfig['modes'] = ['TEXT']
  if (attachmentRequired) modes.push('ATTACHMENT')
  if (taskItemCount > 0) modes.push('TASK_ITEMS')
  else if (hasChecklist) modes.push('CHECKLIST')
  else if (hasParameter) modes.push('PARAMETER')
  if (hasLearning) modes.push('LEARNING')
  if (hasQuiz) modes.push('QUIZ')
  return {
    version: 'T12_SUBMIT_FORM_V1',
    modes,
    text: { required: true, label: '提交内容', minLength: 10, maxLength: 5000 },
    attachment: {
      required: attachmentRequired,
      minCount: attachmentRequired ? 1 : 0,
      maxCount: 20,
      accept: [],
      reason: attachmentRequired ? '该任务要求上传附件作为完成凭证' : null,
    },
    structured: {
      type: taskItemCount > 0 ? 'TASK_ITEMS' : hasChecklist ? 'CHECKLIST' : hasParameter ? 'PARAMETER' : null,
      itemCount: taskItemCount || detail.task.checklistSchema?.items?.length || detail.task.parametersSchema?.items?.length || 0,
    },
    learning: {
      materialCount: detail.task.learningMaterials?.items?.length || 0,
      requiresConfirmation: taskType === 'TRAINING',
    },
    quiz: {
      required: taskType === 'TRAINING' && hasQuiz,
      quizBankId: detail.task.quizBankId ?? null,
    },
    employeeHint: TASK_TYPE_HINT[taskType] || TASK_TYPE_HINT.OTHER,
  }
}

function submitFormConfigFor(detail: MpTaskDetail, taskItemCount: number): SubmitFormConfig {
  const fallback = submitFormFallback(detail, taskItemCount)
  const raw = detail.task.submitFormConfig
  if (!raw) return fallback
  return {
    ...fallback,
    ...raw,
    modes: Array.isArray(raw.modes) && raw.modes.length ? raw.modes : fallback.modes,
    text: { ...fallback.text, ...raw.text },
    attachment: { ...fallback.attachment, ...raw.attachment },
    structured: { ...fallback.structured, ...raw.structured },
    learning: { ...fallback.learning, ...raw.learning },
    quiz: { ...fallback.quiz, ...raw.quiz },
    employeeHint: raw.employeeHint || fallback.employeeHint,
  }
}

function shouldCompleteQuizInMiniapp(detail: MpTaskDetail | null, submitConfig: SubmitFormConfig | null) {
  if (!detail || detail.task.taskType !== 'TRAINING') return false
  return Boolean(detail.task.quizBankId || submitConfig?.quiz.quizBankId || submitConfig?.modes.includes('QUIZ'))
}

const getTaskBasisItems = (detail: MpTaskDetail | null) => {
  if (!detail) return []
  return [{
    id: detail.requirement.id,
    sourceTitle: detail.requirement.source.title,
    clauseNo: detail.requirement.clauseNo,
    title: detail.requirement.title,
  }]
}

const TAB_ITEMS: Array<{ key: MpTaskTab; label: string; icon: React.ReactNode }> = [
  { key: 'todo', label: '待处理', icon: <ClockCircleOutlined style={{ color: '#3B7BF6' }} /> },
  { key: 'review', label: '审核中', icon: <ExclamationCircleOutlined style={{ color: '#D97706' }} /> },
  { key: 'done', label: '已完成', icon: <CheckCircleOutlined style={{ color: '#22C55E' }} /> },
  { key: 'closed', label: '已关闭', icon: <CloseCircleOutlined style={{ color: '#64748B' }} /> },
]

const ASSIGNEE_STATUS_COLOR: Record<string, string> = {
  PENDING: 'default', IN_PROGRESS: 'blue', PENDING_REVIEW: 'orange',
  REJECTED: 'red', COMPLETED: 'green', OVERDUE: 'red',
}

const METRIC_META: Record<MpTaskTab, { label: string; hint: string; color: string; icon: React.ReactNode }> = {
  todo: { label: '待处理', hint: '待查看或待提交', color: '#2563EB', icon: <ClockCircleOutlined /> },
  review: { label: '审核中', hint: '已提交待审核', color: '#D97706', icon: <ExclamationCircleOutlined /> },
  done: { label: '已完成', hint: '审核通过的任务', color: '#16A34A', icon: <CheckCircleOutlined /> },
  closed: { label: '已关闭', hint: '已取消或只读', color: '#64748B', icon: <CloseCircleOutlined /> },
}

// 可以提交的状态
const CAN_SUBMIT_STATUS = new Set(['PENDING', 'IN_PROGRESS', 'REJECTED'])

function ViewPill({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 26,
        minWidth: 78,
        border: 0,
        borderRadius: 13,
        padding: '0 12px',
        background: active ? '#eff6ff' : '#e2e8f0',
        color: active ? '#2563eb' : '#475569',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {label}{typeof count === 'number' ? ` ${count}` : ''}
    </button>
  )
}

function MetricPanel({
  label,
  value,
  color,
  onClick,
}: {
  label: string
  value: number
  color: string
  onClick?: () => void
}) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (!onClick) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      style={{ ...cardStyle, height: 88, position: 'relative', padding: '15px 17px', cursor: onClick ? 'pointer' : 'default' }}
    >
      <div style={{ position: 'absolute', left: -1, top: -1, width: 4, height: 88, borderRadius: '8px 0 0 8px', background: color }} />
      <div style={{ ...mutedTextStyle, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 8, color: '#0f172a', fontSize: 28, lineHeight: '34px', fontWeight: 800 }}>{value}</div>
    </div>
  )
}

function TextAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: 0,
        background: 'transparent',
        color: '#2563eb',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 700,
        padding: 0,
      }}
    >
      {label}
    </button>
  )
}

export default function MyTasksPage() {
  const [tab, setTab] = useState<MpTaskTab>('todo')
  const [items, setItems] = useState<MpTaskItem[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<MyTaskListV2Counts | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20

  const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MpTaskDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [submitForm] = Form.useForm()
  const [fileList, setFileList] = useState<Array<{ uid: string; name: string; originFileObj?: File }>>([])
  const [submitting, setSubmitting] = useState(false)
  // 结构化提交输入：INSPECTION_FILL / PARAMETER 按 schema item id 存值
  const [inspectionResults, setInspectionResults] = useState<Record<string, string>>({})
  const [parameterResults, setParameterResults] = useState<Record<string, string>>({})
  // 新模型 TaskItem 清单（空=旧模型，走 checklistSchema）
  const [taskItems, setTaskItems] = useState<TaskItemVO[]>([])
  const [itemNoteDraft, setItemNoteDraft] = useState<Record<string, string>>({})
  const activeSubmitConfig = useMemo(
    () => detail ? submitFormConfigFor(detail, taskItems.length) : null,
    [detail, taskItems.length],
  )

  const load = async () => {
    setLoading(true)
    try {
      const res = await seListMyTasksV2({ tab, page, pageSize, includeCounts: true })
      setItems(res.data ?? [])
      setTotal(res.total ?? 0)
      setCounts(res.counts ?? null)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [tab, page])

  useEffect(() => {
    if (items.length === 0) {
      setSelectedAssigneeId(null)
      setDetail(null)
      setDetailOpen(false)
      return
    }
    if (!selectedAssigneeId || !items.some((item) => item.assigneeId === selectedAssigneeId)) {
      setSelectedAssigneeId(items[0].assigneeId)
      setDetail(null)
      setDetailOpen(false)
    }
  }, [items, selectedAssigneeId])

  const selectRow = (row: MpTaskItem) => {
    setSelectedAssigneeId(row.assigneeId)
    if (detail?.task.id !== row.task.id) {
      setDetail(null)
      setDetailOpen(false)
    }
  }

  const openDetail = async (taskId: string) => {
    try {
      const row = items.find((item) => item.task.id === taskId)
      if (row) setSelectedAssigneeId(row.assigneeId)
      // 标记进入（PENDING → IN_PROGRESS）
      await nodeApi.post(`/api/app/standard-execution/tasks/${taskId}/view`, {}).catch(() => {})
      const res = await nodeApi.get<unknown, { data: MpTaskDetail }>(`/api/app/standard-execution/tasks/${taskId}`)
      setDetail(res.data)
      setTaskItems([])
      setItemNoteDraft({})
      setDetailOpen(true)
      // 新模型：拉 TaskItem 清单（空数组=旧模型）
      try {
        const itemsRes = await seGetTaskItems(taskId)
        const its = itemsRes.data || []
        setTaskItems(its)
        setItemNoteDraft(Object.fromEntries(its.map((it) => [it.id, it.note ?? ''])))
      } catch { setTaskItems([]) }
    } catch {
      message.error('加载详情失败')
    }
  }

  // 逐项暂存 TaskItem（status / note / fileUrls）
  const saveTaskItem = async (taskId: string, itemId: string, patch: { status?: 'DONE' | 'SKIPPED'; note?: string; fileUrls?: string[] }) => {
    try {
      const res = await sePatchTaskItem(taskId, itemId, patch)
      setTaskItems((prev) => prev.map((it) => (it.id === itemId ? res.data : it)))
      message.success('已暂存')
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '暂存失败')
    }
  }

  const openSubmit = () => {
    submitForm.resetFields()
    setFileList([])
    setInspectionResults({})
    setParameterResults({})
    setSubmitOpen(true)
  }

  // 数值是否落在标准范围内（INSPECTION_FILL NUMBER_RANGE 用）
  const isInRange = (v: string, min?: number | null, max?: number | null) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return false
    if (min != null && n < min) return false
    if (max != null && n > max) return false
    return true
  }

  const handleSubmit = async () => {
    if (!detail) return
    try {
      const values = await submitForm.validateFields()
      const submitConfig = activeSubmitConfig ?? submitFormConfigFor(detail, taskItems.length)
      if (shouldCompleteQuizInMiniapp(detail, submitConfig)) {
        message.warning('请在小程序完成答题')
        return
      }
      // 附件必填校验
      const requiredAttachmentCount = submitConfig.attachment.required ? Math.max(1, submitConfig.attachment.minCount || 1) : 0
      if (requiredAttachmentCount > 0 && fileList.length < requiredAttachmentCount) {
        message.error(requiredAttachmentCount === 1 ? '请上传至少 1 个附件' : `请上传至少 ${requiredAttachmentCount} 个附件`)
        return
      }

      // 结构化提交：INSPECTION_FILL 任务填写项 / PARAMETER 参数
      let structuredText = ''
      let submitDataJson: Record<string, unknown> | undefined
      const t = detail.task.taskType
      const isTaskItemMode = taskItems.length > 0

      // 新模型：至少完成一条任务填写项才能提交
      if (isTaskItemMode && !taskItems.some((it) => it.status === 'DONE')) {
        message.error('请至少完成一条任务填写项')
        return
      }
      if (isTaskItemMode) {
        const itemLines = taskItems.map((item, index) => {
          const itemConfig = findRequirementSubmitConfig(detail, item.requirementId, index)
          const options = normalizeRequirementSubmitOptions(itemConfig?.submitOptions)
            .map((option) => REQUIREMENT_SUBMIT_LABEL[option])
            .join(' + ')
          return `${index + 1}. ${sanitizeSEVisibleText(item.requirement?.title || item.requirementId)}：${item.status}；提交格式：${options}；说明：${sanitizeSEVisibleText(item.note || '（无）')}`
        })
        submitDataJson = {
          requirementSubmitConfigs: requirementConfigItems(detail),
        }
        structuredText = `【要求项提交快照】\n${itemLines.join('\n')}`
      }

      if (!isTaskItemMode && t === 'INSPECTION_FILL' && detail.task.checklistSchema?.items?.length) {
        const items = detail.task.checklistSchema.items
        const missing = items.find((it) => !inspectionResults[it.id]?.toString().trim())
        if (missing) {
      message.error(`任务填写项「${sanitizeSEVisibleText(missing.name)}」未填写`)
          return
        }
        submitDataJson = {
          taskType: 'INSPECTION_FILL',
          items: items.map((it) => ({
            id: it.id,
            name: it.name,
            judgeType: it.judgeType,
            result: inspectionResults[it.id],
            ...(it.judgeType === 'NUMBER_RANGE' && {
              inRange: isInRange(inspectionResults[it.id], it.min, it.max),
            }),
          })),
        }
        structuredText = items
          .map((it, i) => {
            const v = inspectionResults[it.id]
            if (it.judgeType === 'NUMBER_RANGE') {
              const ok = isInRange(v, it.min, it.max)
              return `${i + 1}. ${sanitizeSEVisibleText(it.name)}：实测 ${v}${it.unit || ''}（${ok ? '合格' : '不合格'}）`
            }
            return `${i + 1}. ${sanitizeSEVisibleText(it.name)}：${v}`
          })
          .join('\n')
      }

      if (!isTaskItemMode && t === 'PARAMETER' && detail.task.parametersSchema?.items?.length) {
        const items = detail.task.parametersSchema.items
        const missing = items.find((it) => !parameterResults[it.id]?.toString().trim())
        if (missing) {
          message.error(`参数「${missing.name}」未填写实测值`)
          return
        }
        submitDataJson = {
          taskType: 'PARAMETER',
          items: items.map((it) => ({
            id: it.id,
            name: it.name,
            standard: it.standard,
            unit: it.unit,
            measured: parameterResults[it.id],
          })),
        }
        structuredText = items
          .map((it, i) => `${i + 1}. ${sanitizeSEVisibleText(it.name)}：标准 ${sanitizeSEVisibleText(it.standard)}${it.unit || ''} / 实测 ${parameterResults[it.id]}${it.unit || ''}`)
          .join('\n')
      }

      const submitText = structuredText
        ? `${structuredText}\n\n【补充说明】\n${values.submitText || '（无）'}`
        : values.submitText

      setSubmitting(true)

      // 第一步：逐个上传文件，拿 fileUrl + 元数据
      const attachments: Array<{ fileName: string; fileUrl: string; fileSize?: number; mimeType?: string }> = []
      for (const f of fileList) {
        if (!f.originFileObj) continue
        const fd = new FormData()
        fd.append('file', f.originFileObj)
        const uploadRes = (await nodeApi.post(
          `/api/enterprise/my-tasks/${detail.task.id}/upload`,
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } },
        )) as { data?: { fileName: string; fileUrl: string; fileSize?: number; mimeType?: string } }
        const u = uploadRes.data ?? (uploadRes as unknown as { fileName: string; fileUrl: string })
        attachments.push({
          fileName: u.fileName || f.name,
          fileUrl: u.fileUrl,
          fileSize: (u as { fileSize?: number }).fileSize,
          mimeType: (u as { mimeType?: string }).mimeType,
        })
      }

      // attachments 必填校验由后端做（min 1）；若员工是 INSPECTION_FILL/TRAINING/RECTIFICATION/OTHER 文字类，
      // 后端 schema 仍要求 ≥1 附件 — 此处用占位说明文件兜底（与原 multipart 流程同语义）
      if (attachments.length === 0) {
        // 兜底：将 submitText 写成一个 .txt 文件上传（避免后端 attachments min(1) 拦截）
        const blob = new Blob([submitText || '（员工未上传文件）'], { type: 'text/plain' })
        const fd = new FormData()
        const ts = Date.now()
        fd.append('file', new File([blob], `submit-${ts}.txt`, { type: 'text/plain' }))
        const uploadRes = (await nodeApi.post(
          `/api/enterprise/my-tasks/${detail.task.id}/upload`,
          fd,
          { headers: { 'Content-Type': 'multipart/form-data' } },
        )) as { data?: { fileName: string; fileUrl: string; fileSize?: number; mimeType?: string } }
        const u = uploadRes.data ?? (uploadRes as unknown as { fileName: string; fileUrl: string })
        attachments.push({ fileName: u.fileName, fileUrl: u.fileUrl })
      }

      // 第二步：JSON 提交
      await nodeApi.post(`/api/enterprise/my-tasks/${detail.task.id}/submit`, {
        submitText,
        attachments,
        submitDataJson,
      })

      message.success('提交成功，等待审核')
      setSubmitOpen(false)
      setDetailOpen(false)
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const activeDetail = detailOpen ? detail : null
  const canSubmit = activeDetail ? CAN_SUBMIT_STATUS.has(activeDetail.myAssignee.status) : false
  const submitRequiresMiniappQuiz = shouldCompleteQuizInMiniapp(detail, activeSubmitConfig)
  const latestSubmission = activeDetail?.mySubmissions[0] ?? null
  const detailBasisItems = getTaskBasisItems(activeDetail)

  const getTaskContentSummary = (row: MpTaskItem) => {
    const basis = row.task.basis?.[0]
    const requirement = row.task.requirement
    const clauseNo = requirement?.clauseNo ?? basis?.clauseNo
    const title = sanitizeSEVisibleText(requirement?.title ?? basis?.title ?? '未关联生成内容')
    const sourceTitle = sanitizeSEVisibleText(basis?.sourceTitle ?? row.task.source?.title ?? '')
    const extraCount = Math.max((row.task.basis?.length || 0) - 1, 0)
    return { clauseNo, title, sourceTitle, extraCount }
  }

  const renderTaskContentSummary = (row: MpTaskItem) => {
    const summary = getTaskContentSummary(row)
    return (
      <div>
        <div style={{ fontWeight: 500 }}>{summary.clauseNo ? `[${summary.clauseNo}] ` : ''}{summary.title}</div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {summary.sourceTitle || '未标记标准文档'}{summary.extraCount > 0 ? ` · 等 ${summary.extraCount + 1} 项` : ''}
        </Text>
      </div>
    )
  }

  const columns = [
    {
      title: '任务',
      dataIndex: ['task', 'title'],
      ellipsis: true,
      render: (v: string) => <Text strong>{sanitizeSEVisibleText(v)}</Text>,
    },
    {
      title: '类型',
      dataIndex: ['task', 'taskType'],
      width: 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (v: any) => v ? <Tag>{TASK_TYPE_LABEL[v] || v}</Tag> : '-',
    },
    {
      title: '生成内容',
      key: 'basis',
      width: 180,
      render: (_: unknown, row: MpTaskItem) => renderTaskContentSummary(row),
    },
    {
      title: '截止时间',
      dataIndex: ['task', 'deadlineAt'],
      width: 140,
      render: (v: string | null, row: MpTaskItem) => v ? (
        <Space>
          <span style={{ color: row.isOverdue ? '#DC2626' : undefined }}>
            {dayjs(v).format('MM-DD HH:mm')}
          </span>
          {row.isOverdue && <Tag color="red" style={{ margin: 0 }}>逾期</Tag>}
        </Space>
      ) : '-',
    },
    {
      title: '状态',
      dataIndex: 'assigneeStatus',
      width: 100,
      render: (v: string) => (
        <Tag color={ASSIGNEE_STATUS_COLOR[v] || 'default'}>{ASSIGNEE_STATUS_LABEL[v] || v}</Tag>
      ),
    },
    {
      title: '操作',
      width: 100,
      render: (_: unknown, row: MpTaskItem) => (
        <TextAction label={tab === 'todo' ? '查看/提交' : '查看详情'} onClick={() => openDetail(row.task.id)} />
      ),
    },
  ]

  const { setData: setSEPageData } = useContext(SEPageContext)
  const overdueCount = useMemo(() => items.filter((item) => item.isOverdue).length, [items])
  const metricItems = useMemo(() => [
    { key: 'todo', label: '我的待处理', count: counts?.todo ?? (tab === 'todo' ? total : 0), color: METRIC_META.todo.color },
    { key: 'review', label: '审核中', count: counts?.review ?? (tab === 'review' ? total : 0), color: METRIC_META.review.color },
    { key: 'overdue', label: '已逾期', count: overdueCount, color: '#dc2626' },
  ], [counts, overdueCount, tab, total])
  const selectedItem = useMemo(
    () => items.find((item) => item.assigneeId === selectedAssigneeId) ?? items[0] ?? null,
    [items, selectedAssigneeId],
  )
  const selectedContent = selectedItem ? getTaskContentSummary(selectedItem) : null

  const switchTab = (next: MpTaskTab) => {
    setTab(next)
    setPage(1)
    setDetail(null)
    setDetailOpen(false)
  }

  useEffect(() => {
    setSEPageData({
      pageKey: 'my-tasks',
      summary: `我的待办任务（共 ${total} 条）：\n` + items.slice(0, 8).map((t) => `- ${sanitizeSEVisibleText(t.task.title)}｜${ASSIGNEE_STATUS_LABEL[t.assigneeStatus] || t.assigneeStatus}｜截止:${t.task.deadlineAt ? dayjs(t.task.deadlineAt).format('MM-DD') : '无'}`).join('\n'),
    })
    return () => setSEPageData(null)
  }, [items, total, setSEPageData])

  return (
    <div data-testid="enterprise-my-tasks-page" style={{ minWidth: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 356px', gap: 24, alignItems: 'start' }}>
        <main style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 22 }}>
            {TAB_ITEMS.map((item) => (
              <ViewPill
                key={item.key}
                active={tab === item.key}
                label={item.label}
                count={counts?.[item.key]}
                onClick={() => switchTab(item.key)}
              />
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(150px, 190px))', gap: 16, marginBottom: 32 }}>
            {metricItems.map((item) => (
              <MetricPanel
                key={item.key}
                label={item.label}
                value={item.count}
                color={item.color}
                onClick={item.key === 'overdue' ? undefined : () => switchTab(item.key as MpTaskTab)}
              />
            ))}
          </div>

          <div style={{ ...cardStyle, overflow: 'hidden' }}>
            <Table
              size="small"
              rowKey="assigneeId"
              loading={loading}
              dataSource={items}
              pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false, size: 'small' }}
              columns={columns}
              scroll={{ x: 720 }}
              locale={{ emptyText: '暂无任务' }}
              onRow={(row) => ({
                onClick: () => selectRow(row),
                style: {
                  cursor: 'pointer',
                  background: selectedItem?.assigneeId === row.assigneeId ? '#f8fbff' : undefined,
                },
              })}
            />
          </div>
        </main>

        <aside
          data-testid="my-task-detail-panel"
          style={{
            ...cardStyle,
            minHeight: 740,
            maxHeight: 740,
            overflowY: 'auto',
            padding: 20,
            borderColor: '#cbd5e1',
            boxShadow: '0 16px 34px rgba(15, 23, 42, 0.10)',
          }}
        >
          {selectedItem ? (
            <>
              <h2 style={{ margin: 0, color: '#0f172a', fontSize: 18, fontWeight: 800, lineHeight: '24px' }}>
                {sanitizeSEVisibleText(activeDetail?.task.title ?? selectedItem.task.title)}
              </h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, marginBottom: 24 }}>
                <Tag color={ASSIGNEE_STATUS_COLOR[activeDetail?.myAssignee.status ?? selectedItem.assigneeStatus] || 'default'} style={{ borderRadius: 999, paddingInline: 10 }}>
                  {ASSIGNEE_STATUS_LABEL[activeDetail?.myAssignee.status ?? selectedItem.assigneeStatus] || selectedItem.assigneeStatus}
                </Tag>
                {(activeDetail?.task.taskType ?? selectedItem.task.taskType) && (
                  <Tag style={{ borderRadius: 999, paddingInline: 10 }}>
                    {TASK_TYPE_LABEL[activeDetail?.task.taskType ?? selectedItem.task.taskType ?? ''] || activeDetail?.task.taskType || selectedItem.task.taskType}
                  </Tag>
                )}
                {selectedItem.isOverdue && <Tag color="red" style={{ borderRadius: 999, paddingInline: 10 }}>已逾期</Tag>}
              </div>

              {activeDetail?.isOverdue && (
              <Alert type="error" message="该任务已逾期" showIcon style={{ marginBottom: 12 }} />
              )}
              {activeDetail?.myAssignee.status === 'REJECTED' && latestSubmission?.reviewComment && (
              <Alert
                type="warning"
                showIcon
                message="上次提交被驳回，请修改后重新提交"
                description={sanitizeSEVisibleText(latestSubmission.reviewComment)}
                style={{ marginBottom: 12 }}
              />
              )}

              <div style={{ marginBottom: 26 }}>
                <Text strong style={{ color: '#64748b', fontSize: 13 }}>关联标准文档</Text>
                <div style={{ marginTop: 10, padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                  {activeDetail && detailBasisItems.length > 0 ? detailBasisItems.map((basis) => (
                    <div key={basis.id} style={{ marginBottom: detailBasisItems.length > 1 ? 10 : 0 }}>
                      <div style={{ color: '#475569', fontSize: 12, fontWeight: 600 }}>{basis.clauseNo ? `[${basis.clauseNo}] ` : ''}{sanitizeSEVisibleText(basis.title)}</div>
                      <div style={{ color: '#64748b', fontSize: 12, marginTop: 3 }}>标准文档：{sanitizeSEVisibleText(basis.sourceTitle)}</div>
                    </div>
                  )) : (
                    <>
                      <div style={{ color: '#475569', fontSize: 12, fontWeight: 600 }}>
                        {selectedContent?.clauseNo ? `[${selectedContent.clauseNo}] ` : ''}{sanitizeSEVisibleText(selectedContent?.title)}
                      </div>
                      <div style={{ color: '#64748b', fontSize: 12, marginTop: 3 }}>标准文档：{sanitizeSEVisibleText(selectedContent?.sourceTitle || '未标记标准文档')}</div>
                    </>
                  )}
                </div>
              </div>

              {activeDetail ? (
                <>
                  {/* 新模型：TaskItem 任务填写项清单（逐项标记 + 整体提交） */}
                  {taskItems.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <Text strong>任务填写项清单（共 {taskItems.length} 项，逐项标记后点「提交任务」整体提交）</Text>
                <div style={{ marginTop: 6 }}>
                  {taskItems.map((it, idx) => {
                    const submitConfig = findRequirementSubmitConfig(activeDetail, it.requirementId, idx)
                    return (
                    <div key={it.id} style={{ padding: 12, background: '#fafafa', borderRadius: 6, marginBottom: 8 }}>
                      <div style={{ fontWeight: 500, marginBottom: 6 }}>
                        <span style={{ color: '#3B7BF6', marginRight: 6 }}>#{idx + 1}</span>
                        {it.requirement?.clauseNo ? `[${it.requirement.clauseNo}] ` : ''}{sanitizeSEVisibleText(it.requirement?.title || it.requirementId)}
                        <Tag style={{ marginLeft: 8 }} color={it.status === 'DONE' ? 'green' : it.status === 'SKIPPED' ? 'default' : 'orange'}>
                          {it.status === 'DONE' ? '已完成' : it.status === 'SKIPPED' ? '已跳过' : '待处理'}
                        </Tag>
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        {renderRequirementSubmitTags(submitConfig)}
                        <div style={{ ...mutedTextStyle, marginTop: 4 }}>{sanitizeSEVisibleText(requirementSubmitHint(submitConfig))}</div>
                      </div>
                      {canSubmit ? (
                        <>
                          <Radio.Group
                            value={it.status === 'PENDING' ? undefined : it.status}
                            onChange={(e) => saveTaskItem(it.taskId, it.id, { status: e.target.value })}
                            style={{ marginBottom: 8 }}
                          >
                            <Radio value="DONE">完成</Radio>
                            <Radio value="SKIPPED">跳过</Radio>
                          </Radio.Group>
                          <TextArea
                            rows={2}
                            placeholder="说明（可选，失焦自动暂存）"
                            value={itemNoteDraft[it.id] ?? ''}
                            onChange={(e) => setItemNoteDraft((p) => ({ ...p, [it.id]: e.target.value }))}
                            onBlur={() => { if ((itemNoteDraft[it.id] ?? '') !== (it.note ?? '')) saveTaskItem(it.taskId, it.id, { note: itemNoteDraft[it.id] ?? '' }) }}
                          />
                        </>
                      ) : (
                        it.note ? <div style={{ color: '#475569', fontSize: 13 }}>说明：{sanitizeSEVisibleText(it.note)}</div> : null
                      )}
                    </div>
                    )
                  })}
                </div>
              </div>
                  )}
                  {taskItems.length === 0 && !activeDetail.task.checklistSchema?.items?.length && !activeDetail.task.parametersSchema?.items?.length && (
              <Alert
                type="info"
                showIcon
                message="暂无逐项任务填写项"
                description="该任务未配置 TaskItem 明细，按提交内容填写说明或上传附件即可。"
                style={{ marginBottom: 14 }}
              />
                  )}

                  {taskItems.length === 0 && requirementConfigItems(activeDetail).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <Text strong>要求项与提交格式（共 {requirementConfigItems(activeDetail).length} 项）</Text>
                <div style={{ marginTop: 6 }}>
                  {requirementConfigItems(activeDetail).map((config, idx) => (
                    <div key={config.id} style={{ padding: 12, background: '#fafafa', borderRadius: 6, marginBottom: 8 }}>
                      <div style={{ fontWeight: 500, marginBottom: 6 }}>
                        <span style={{ color: '#3B7BF6', marginRight: 6 }}>#{idx + 1}</span>
                        {config.clauseNo ? `[${config.clauseNo}] ` : ''}{sanitizeSEVisibleText(config.requirementTitle || config.name)}
                        {config.required === false ? <Tag style={{ marginLeft: 8 }}>可选</Tag> : <Tag color="blue" style={{ marginLeft: 8 }}>必做</Tag>}
                      </div>
                      {config.requirementDescription && <div style={{ color: '#475569', fontSize: 13, marginBottom: 8 }}>{sanitizeSEVisibleText(config.requirementDescription)}</div>}
                      {renderRequirementSubmitTags(config)}
                      <div style={{ ...mutedTextStyle, marginTop: 4 }}>{sanitizeSEVisibleText(requirementSubmitHint(config))}</div>
                    </div>
                  ))}
                </div>
              </div>
                  )}

                  {/* 结构化任务配置展示（让员工看到具体要做什么） */}
                  {activeDetail.task.taskType === 'INSPECTION_FILL' && activeDetail.task.checklistSchema?.items?.length ? (
              <div style={{ marginBottom: 14 }}>
                <Text strong>任务填写项清单（共 {activeDetail.task.checklistSchema.items.length} 项）</Text>
                <div style={{ marginTop: 6, background: '#f8fafc', padding: 12, borderRadius: 6 }}>
                  {activeDetail.task.checklistSchema.items.map((it, idx) => (
                    <div key={it.id} style={{ padding: '4px 0', borderBottom: idx === activeDetail.task.checklistSchema!.items.length - 1 ? 'none' : '1px solid #eaeef5' }}>
                      <span style={{ color: '#3B7BF6', marginRight: 6 }}>#{idx + 1}</span>
                      <strong>{sanitizeSEVisibleText(it.requirementTitle || it.name)}</strong>
                      <div style={{ marginTop: 4 }}>
                        {renderRequirementSubmitTags(it)}
                        <div style={{ ...mutedTextStyle, marginTop: 4 }}>{sanitizeSEVisibleText(requirementSubmitHint(it))}</div>
                      </div>
                      <span style={{ color: '#8a93a3', marginLeft: 8, fontSize: 12 }}>
                        {it.judgeType === 'BOOL' && '判定：合格/不合格'}
                        {it.judgeType === 'TEXT' && '判定：文字描述'}
                        {it.judgeType === 'NUMBER_RANGE' && `判定：数值范围${it.min != null ? ` ≥ ${it.min}` : ''}${it.max != null ? ` 且 ≤ ${it.max}` : ''}${it.unit ? ` ${it.unit}` : ''}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
                  ) : null}
                  {activeDetail.task.taskType === 'PARAMETER' && activeDetail.task.parametersSchema?.items?.length ? (
              <div style={{ marginBottom: 14 }}>
                <Text strong>参数清单（共 {activeDetail.task.parametersSchema.items.length} 项）</Text>
                <Table
                  size="small"
                  style={{ marginTop: 6 }}
                  rowKey="id"
                  pagination={false}
                  dataSource={activeDetail.task.parametersSchema.items}
                  columns={[
                    { title: '参数名', dataIndex: 'name', render: (v) => sanitizeSEVisibleText(v) },
                    { title: '标准值', dataIndex: 'standard', render: (v) => sanitizeSEVisibleText(v) },
                    { title: '单位', dataIndex: 'unit', width: 80, render: (v) => v || '-' },
                    { title: '检测方法', dataIndex: 'method', render: (v) => v || '-' },
                  ]}
                />
              </div>
                  ) : null}
                  {activeDetail.task.taskType === 'TRAINING' && activeDetail.task.learningMaterials?.items?.length ? (
              <div style={{ marginBottom: 14 }}>
                <Text strong>学习材料（共 {activeDetail.task.learningMaterials.items.length} 项）</Text>
                <div style={{ marginTop: 6, background: '#f8fafc', padding: 12, borderRadius: 6 }}>
                  {activeDetail.task.learningMaterials.items.map((it, idx) => (
                    <div key={idx} style={{ padding: '4px 0' }}>
                      <Tag>{it.type === 'file' ? '文件' : '链接'}</Tag>
                      <a href={it.url} target="_blank" rel="noreferrer">{sanitizeSEVisibleText(it.name)}</a>
                    </div>
                  ))}
                </div>
              </div>
                  ) : null}

                  {activeDetail.task.description && (
              <>
                <Text strong>任务说明</Text>
                <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 12, borderRadius: 6, marginTop: 6, marginBottom: 12 }}>
                  {sanitizeSEVisibleText(activeDetail.task.description)}
                </Paragraph>
              </>
                  )}

                  <Text strong>提交内容</Text>
            <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#eff6ff', padding: 12, borderRadius: 6, marginTop: 6, marginBottom: 16, borderLeft: '3px solid #3B7BF6' }}>
              {sanitizeSEVisibleText(activeDetail.task.submitRequirement)}
            </Paragraph>

                  {latestSubmission && (
              <>
                <Text strong>上次提交（v{latestSubmission.version}）</Text>
                <div style={{ marginTop: 4, marginBottom: 4 }}>
                  <Tag color={latestSubmission.status === 'APPROVED' ? 'green' : latestSubmission.status === 'REJECTED' ? 'red' : 'orange'}>
                    {latestSubmission.status === 'APPROVED' ? '已通过' : latestSubmission.status === 'REJECTED' ? '已驳回' : '审核中'}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    {dayjs(latestSubmission.submittedAt).format('MM-DD HH:mm')}
                  </Text>
                </div>
                <Paragraph style={{ whiteSpace: 'pre-wrap', background: '#fafafa', padding: 12, borderRadius: 6, marginTop: 6 }}>
                  {sanitizeSEVisibleText(latestSubmission.submitText)}
                </Paragraph>
                <Text strong>附件信息</Text>
                {latestSubmission.attachments?.length ? (
                  <div style={{ marginTop: 6, marginBottom: 12 }}>
                    {latestSubmission.attachments.map((a) => (
                      <div key={a.id} style={{ padding: '4px 0' }}>
                        <a href={a.fileUrl} target="_blank" rel="noreferrer">{sanitizeSEVisibleText(a.fileName)}</a>
                        {a.fileSize ? <Text type="secondary" style={{ marginLeft: 8 }}>{Math.round(a.fileSize / 1024)} KB</Text> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <Paragraph type="secondary" style={{ marginTop: 6 }}>本次提交未记录附件。</Paragraph>
                )}
              </>
                  )}

                  <div style={{ position: 'sticky', bottom: -20, margin: '18px -20px -20px', padding: 16, background: '#fff', borderTop: '1px solid #e2e8f0', textAlign: 'right' }}>
                    {canSubmit ? (
                      <Button type="primary" onClick={openSubmit}>提交任务</Button>
                    ) : (
                      <Button onClick={() => activeDetail && openDetail(activeDetail.task.id)}>刷新详情</Button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <Text strong style={{ color: '#64748b', fontSize: 13 }}>任务填写项清单</Text>
                  <div style={{ marginTop: 10, padding: 14, background: '#ecfdf5', border: '1px solid #bbf7d0', borderRadius: 6, color: '#166534', fontSize: 12, lineHeight: '20px' }}>
                    点击「查看/提交」后查看任务填写项、提交内容和历史提交记录。
                  </div>
                  <Text strong style={{ display: 'block', color: '#64748b', fontSize: 13, marginTop: 24 }}>提交内容</Text>
                  <div style={{ marginTop: 10, padding: 14, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, color: '#1e40af', fontSize: 12, lineHeight: '20px' }}>
                    {sanitizeSEVisibleText(selectedItem.task.submitRequirement || '查看详情后按任务要求填写说明或上传附件。')}
                  </div>
                  <Button type="primary" style={{ width: '100%', marginTop: 28 }} onClick={() => openDetail(selectedItem.task.id)}>
                    {tab === 'todo' ? '查看/提交' : '查看详情'}
                  </Button>
                </>
              )}
            </>
          ) : (
            <div style={{ padding: '160px 12px', textAlign: 'center', color: '#94a3b8' }}>
              暂无任务，切换上方分类查看其他状态。
            </div>
          )}
        </aside>
      </div>

      {/* ── 提交 Modal ── */}
      <Modal
        title="提交任务"
        open={submitOpen}
        onCancel={() => setSubmitOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText={submitRequiresMiniappQuiz ? '小程序完成答题' : '确认提交'}
        okButtonProps={{ disabled: submitRequiresMiniappQuiz }}
        width={580}
        destroyOnClose
      >
        {detail && (
          <>
            {/* 提交内容提示 */}
            <div style={{ marginBottom: 16, padding: '10px 12px', background: '#eff6ff', borderRadius: 6, borderLeft: '3px solid #3B7BF6', fontSize: 13, color: '#1e40af' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>提交内容</div>
              {sanitizeSEVisibleText(detail.task.submitRequirement)}
            </div>

            {/* 任务类型标签 */}
            {detail.task.taskType && (
              <div style={{ marginBottom: 14 }}>
                <Tag color="blue">{TASK_TYPE_LABEL[detail.task.taskType] || detail.task.taskType}</Tag>
                <span style={{ fontSize: 12, color: '#94A3B8', marginLeft: 6 }}>
                  {activeSubmitConfig?.employeeHint || TASK_TYPE_HINT[detail.task.taskType] || ''}
                </span>
              </div>
            )}
            {activeSubmitConfig && (
              <div style={{ marginBottom: 14, padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>提交形式</div>
                <Space wrap>
                  {activeSubmitConfig.modes.map((mode) => (
                    <Tag key={mode} color={mode === 'QUIZ' ? 'purple' : mode === 'ATTACHMENT' ? 'blue' : undefined}>
                      {mode === 'TEXT' ? activeSubmitConfig.text.label || '文字说明' :
                        mode === 'ATTACHMENT' ? (activeSubmitConfig.attachment.required ? `上传附件（至少 ${Math.max(1, activeSubmitConfig.attachment.minCount || 1)} 个）` : '上传附件') :
                          mode === 'QUIZ' ? '题库答题' :
                            mode === 'TASK_ITEMS' ? '任务填写项' :
                              mode === 'CHECKLIST' ? '检查填报' :
                                mode === 'PARAMETER' ? '参数填报' :
                                  mode === 'LEARNING' ? '学习材料' : mode}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            {requirementConfigItems(detail).length > 0 && (
              <div style={{ marginBottom: 14, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>按要求项提交</div>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {requirementConfigItems(detail).map((config, index) => (
                    <div key={config.id} style={{ padding: 10, background: '#fff', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                      <div style={{ fontWeight: 500 }}>{index + 1}. {sanitizeSEVisibleText(config.requirementTitle || config.name)}</div>
                      <div style={{ marginTop: 5 }}>{renderRequirementSubmitTags(config)}</div>
                      <div style={{ ...mutedTextStyle, marginTop: 5 }}>{sanitizeSEVisibleText(requirementSubmitHint(config))}</div>
                    </div>
                  ))}
                </Space>
              </div>
            )}
            {submitRequiresMiniappQuiz && (
              <Alert
                type="warning"
                showIcon
                message="请在小程序完成答题"
                description="该培训任务包含题库，PC 端暂不支持答题提交。完成答题后会进入审核流程。"
                style={{ marginBottom: 14 }}
              />
            )}
          </>
        )}

        {!submitRequiresMiniappQuiz && <Form form={submitForm} layout="vertical">
          {/* 学习确认类：展示学习材料链接 + 确认说明 */}
          {detail?.task.taskType === 'TRAINING' ? (
            <>
              {detail.task.learningMaterials?.items?.length ? (
                <div style={{ marginBottom: 14, padding: 12, background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6 }}>
                  <div style={{ fontWeight: 500, marginBottom: 8 }}>学习材料</div>
                  {detail.task.learningMaterials.items.map((m, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>
                      <Tag>{m.type === 'file' ? '文件' : '链接'}</Tag>
                      <a href={m.url} target="_blank" rel="noreferrer">{sanitizeSEVisibleText(m.name || m.url)}</a>
                    </div>
                  ))}
                </div>
              ) : null}
              <Form.Item
                name="submitText"
                label="确认说明"
                rules={[{ required: true, message: '请填写确认说明' }]}
              >
                <TextArea
                  rows={3}
                  maxLength={2000}
                  showCount
                  placeholder="我已认真阅读并理解相关标准文档，确认如实掌握要点…"
                />
              </Form.Item>
              {activeSubmitConfig?.modes.includes('ATTACHMENT') && (
                <Form.Item
                  label={<span>上传附件{activeSubmitConfig.attachment.required ? <span style={{ color: '#DC2626' }}>（必须上传）</span> : '（可选）'}</span>}
                  required={activeSubmitConfig.attachment.required}
                >
                  <Upload
                    fileList={fileList as never}
                    beforeUpload={(file) => {
                      setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                      return false
                    }}
                    onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                    accept={activeSubmitConfig.attachment.accept.join(',') || undefined}
                    multiple
                  >
                    <Button icon={<UploadOutlined />}>选择文件</Button>
                  </Upload>
                </Form.Item>
              )}
            </>
          ) : detail?.task.taskType === 'PHOTO' ? (
            /* 外观拍照类：附件必填，文字可选 */
            <>
              <Form.Item
                name="submitText"
                label="拍照说明"
                rules={[{ required: true, message: '请填写说明' }, { min: 5, message: '至少 5 个字' }]}
              >
                <TextArea rows={2} maxLength={1000} showCount placeholder="简要说明拍照部位、时间、现场状态…" />
              </Form.Item>
              <Form.Item
                label={<span>现场照片 <span style={{ color: '#DC2626' }}>（必须上传至少 1 张）</span></span>}
                required
              >
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => {
                    setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                    return false
                  }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  accept="image/*"
                  multiple
                  listType="picture-card"
                >
                  {fileList.length < 10 && <div><UploadOutlined /><div style={{ marginTop: 8, fontSize: 12 }}>上传图片</div></div>}
                </Upload>
              </Form.Item>
            </>
          ) : detail?.task.taskType === 'ONBOARDING_ACCESS' ? (
            /* 上岗准入类：确认说明 + 可选附件 */
            <>
              <Form.Item
                name="submitText"
                label="准入确认"
                rules={[{ required: true, message: '请填写准入确认' }, { min: 10, message: '至少 10 个字' }]}
              >
                <TextArea
                  rows={4}
                  maxLength={2000}
                  showCount
                  placeholder="请填写上岗日期、已掌握的岗位要求、本人确认或负责人确认信息…"
                />
              </Form.Item>
              <Form.Item label="附件（可选，如签字确认、培训证明）">
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => {
                    setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                    return false
                  }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>
              </Form.Item>
            </>
          ) : detail?.task.taskType === 'RECTIFICATION' ? (
            /* 整改反馈类：整改措施 + 附件 */
            <>
              <Form.Item
                name="submitText"
                label="整改措施说明"
                rules={[{ required: true, message: '请填写整改措施' }, { min: 20, message: '整改措施至少 20 个字，请详细描述' }]}
              >
                <TextArea
                  rows={5}
                  maxLength={5000}
                  showCount
                  placeholder="请说明问题根因、已采取的整改措施、预防复发的控制方法…"
                />
              </Form.Item>
              <Form.Item label="整改凭证（图片/文件，可选）">
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => {
                    setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                    return false
                  }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                >
                  <Button icon={<UploadOutlined />}>上传凭证</Button>
                </Upload>
              </Form.Item>
            </>
          ) : DOCUMENT_LIKE_TASK_TYPES.has(detail?.task.taskType || '') ? (
            /* 资质材料 / 资料归档 / 旧资料上传：附件为主 */
            <>
              <Form.Item
                name="submitText"
                label={
                  detail?.task.taskType === 'QUALIFICATION_MATERIAL'
                    ? '资质说明'
                    : detail?.task.taskType === 'ARCHIVE_MATERIAL'
                      ? '归档说明'
                      : '资料说明'
                }
                rules={[{ required: true, message: '请填写说明' }, { min: 5, message: '至少 5 个字' }]}
              >
                <TextArea
                  rows={3}
                  maxLength={1000}
                  showCount
                  placeholder={
                    detail?.task.taskType === 'QUALIFICATION_MATERIAL'
                      ? '请填写证书编号、有效期、材料用途或其他资质说明…'
                      : detail?.task.taskType === 'ARCHIVE_MATERIAL'
                        ? '请填写材料名称、归档用途和关联说明…'
                        : '简要说明上传文件的内容和版本…'
                  }
                />
              </Form.Item>
              <Form.Item
                label={<span>{detail?.task.taskType === 'QUALIFICATION_MATERIAL' ? '上传资质材料' : detail?.task.taskType === 'ARCHIVE_MATERIAL' ? '上传归档材料' : '上传资料'} <span style={{ color: '#DC2626' }}>（必须上传至少 1 个文件）</span></span>}
                required
              >
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => {
                    setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                    return false
                  }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>
              </Form.Item>
            </>
          ) : detail?.task.taskType === 'INSPECTION_FILL' && detail.task.checklistSchema?.items?.length ? (
            /* 检查填报：按 checklistSchema 逐项渲染 */
            <>
              <div style={{ marginBottom: 12 }}>
                {detail.task.checklistSchema.items.map((it, idx) => (
                  <div key={it.id} style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 6 }}>
                    <div style={{ fontWeight: 500, marginBottom: 6 }}>{idx + 1}. {sanitizeSEVisibleText(it.name)}</div>
                    {it.judgeType === 'BOOL' && (
                      <Radio.Group
                        value={inspectionResults[it.id]}
                        onChange={(e) => setInspectionResults((p) => ({ ...p, [it.id]: e.target.value }))}
                      >
                        <Radio value="合格">✓ 合格</Radio>
                        <Radio value="不合格">✗ 不合格</Radio>
                      </Radio.Group>
                    )}
                    {it.judgeType === 'TEXT' && (
                      <Input
                        placeholder="请填写实测情况"
                        value={inspectionResults[it.id] || ''}
                        onChange={(e) => setInspectionResults((p) => ({ ...p, [it.id]: e.target.value }))}
                      />
                    )}
                    {it.judgeType === 'NUMBER_RANGE' && (
                      <Space>
                        <InputNumber
                          placeholder={`标准：${it.min ?? '-'}~${it.max ?? '-'}`}
                          value={inspectionResults[it.id] ? Number(inspectionResults[it.id]) : undefined}
                          onChange={(v) => setInspectionResults((p) => ({ ...p, [it.id]: v == null ? '' : String(v) }))}
                          style={{ width: 160 }}
                        />
                        {it.unit && <span style={{ color: '#94A3B8' }}>{it.unit}</span>}
                        {inspectionResults[it.id] && (
                          <Tag color={isInRange(inspectionResults[it.id], it.min, it.max) ? 'green' : 'red'}>
                            {isInRange(inspectionResults[it.id], it.min, it.max) ? '合格' : '不合格'}
                          </Tag>
                        )}
                      </Space>
                    )}
                  </div>
                ))}
              </div>
              <Form.Item name="submitText" label="补充说明（可选）">
                <TextArea rows={3} maxLength={2000} showCount placeholder="如有需要，填写补充情况或异常处理说明…" />
              </Form.Item>
              <Form.Item label="附件（可选）">
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => { setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }]); return false }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                ><Button icon={<UploadOutlined />}>选择文件</Button></Upload>
              </Form.Item>
            </>
          ) : detail?.task.taskType === 'PARAMETER' && detail.task.parametersSchema?.items?.length ? (
            /* 参数核查：按 parametersSchema 渲染参数表格 */
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f0f5ff' }}>
                    <th style={{ padding: 8, border: '1px solid #d6e4ff', textAlign: 'left' }}>参数</th>
                    <th style={{ padding: 8, border: '1px solid #d6e4ff', textAlign: 'left' }}>标准值</th>
                    <th style={{ padding: 8, border: '1px solid #d6e4ff', textAlign: 'left', width: 70 }}>单位</th>
                    <th style={{ padding: 8, border: '1px solid #d6e4ff', textAlign: 'left', width: 160 }}>实测值</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.task.parametersSchema.items.map((p) => (
                    <tr key={p.id}>
                      <td style={{ padding: 8, border: '1px solid #d6e4ff' }}>{sanitizeSEVisibleText(p.name)}</td>
                      <td style={{ padding: 8, border: '1px solid #d6e4ff' }}>{sanitizeSEVisibleText(p.standard)}</td>
                      <td style={{ padding: 8, border: '1px solid #d6e4ff', color: '#94A3B8' }}>{p.unit || '-'}</td>
                      <td style={{ padding: 8, border: '1px solid #d6e4ff' }}>
                        <Input
                          placeholder="实测值"
                          value={parameterResults[p.id] || ''}
                          onChange={(e) => setParameterResults((prev) => ({ ...prev, [p.id]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Form.Item name="submitText" label="补充说明（可选）">
                <TextArea rows={3} maxLength={2000} showCount placeholder="如有需要，填写检测仪器、环境条件等说明…" />
              </Form.Item>
              <Form.Item label="附件（可选，如检测记录截图）">
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => { setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }]); return false }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                ><Button icon={<UploadOutlined />}>选择文件</Button></Upload>
              </Form.Item>
            </>
          ) : (
            /* 其他：通用文本 + 可选附件（INSPECTION_FILL/PARAMETER 未配置 schema 时也走此分支）*/
            <>
              <Form.Item
                name="submitText"
                label="提交内容"
                rules={[{ required: true, message: '请填写提交内容' }, { min: 10, message: '至少 10 个字' }]}
              >
                <TextArea
                  rows={5}
                  maxLength={5000}
                  showCount
                  placeholder={
                    detail?.task.taskType === 'INSPECTION_FILL'
                      ? '请逐项填写任务填写项实测值及符合情况（如：条款3.1 实测值=85℃，符合要求）…'
                      : detail?.task.taskType === 'PARAMETER'
                        ? '请填写各参数核查结果（参数名称/标准值/实测值/是否合格）…'
                        : '请详细描述执行情况...'
                  }
                />
              </Form.Item>
              <Form.Item label="附件（可选）">
                <Upload
                  fileList={fileList as never}
                  beforeUpload={(file) => {
                    setFileList((prev) => [...prev, { uid: file.uid, name: file.name, originFileObj: file }])
                    return false
                  }}
                  onRemove={(file) => setFileList((prev) => prev.filter((f) => f.uid !== file.uid))}
                  multiple
                >
                  <Button icon={<UploadOutlined />}>选择文件</Button>
                </Upload>
              </Form.Item>
            </>
          )}
        </Form>}
      </Modal>
    </div>
  )
}
