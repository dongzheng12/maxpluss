import { useEffect, useState, useMemo, useContext } from 'react'
import type { CSSProperties, Key, ReactNode } from 'react'
import { Alert, Button, Checkbox, Collapse, DatePicker, Descriptions, Divider, Drawer, Dropdown, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Timeline, Tooltip, Typography, message } from 'antd'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import { ReloadOutlined, PlusOutlined, MinusCircleOutlined, MoreOutlined, ThunderboltOutlined, EditOutlined } from '@ant-design/icons'
import { useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import { filterSEOption, sanitizeSEVisibleText, sortSEOptions } from '../../../../utils/sePresentation'
import {
  seListSources,
  seListSourcesEnterprise,
  seListRequirements,
  seListRequirementsEnterprise,
  seListTasksV2,
  seListTasksV2Enterprise,
  seCreateTask,
  seCreateTaskEnterprise,
  seUpdateTask,
  seUpdateTaskEnterprise,
  seSubmitTaskApproval,
  seSubmitTaskApprovalEnterprise,
  seCancelTask,
  seCancelTaskEnterprise,
  seGetTask,
  seGetTaskProgress,
  seGetTaskProgressEnterprise,
  seListEnterpriseMembers,
  seBatchCancelTasks, seBatchCancelTasksEnterprise,
  seBatchAssignTasks, seBatchAssignTasksEnterprise,
  seDeleteTask, seBatchDeleteTasks,
  seListQuestionBanks,
  seListQuestionBanksEnterprise,
  seListPlans,
  type SeTask,
  type Source,
  type Requirement,
  type TaskListV2Counts,
  type TaskListV2Item,
  type EnterpriseMember,
  type QuestionBank,
  type Plan,
  TASK_STATUS_LABEL,
  TASK_STATUS_COLOR,
  ASSIGNEE_STATUS_LABEL,
  TASK_TYPE_LABEL,
  STANDARD_TASK_TYPE_VALUES,
  SOURCE_TYPE_LABEL,
  type SubmitFormConfig,
  type SubmitFormMode,
} from '../../../../api/standardExecution'
import {
  TASK_FIELD_MODEL,
  buildSubmitFormConfigPreview,
  getTaskFieldEditPolicy,
  isTaskEditable,
  submitConfigForTask,
  type TaskFieldKey,
} from './taskFieldModel'

const { TextArea } = Input
const { Text } = Typography

const TASK_TABS = [
  { key: 'all', label: '全部', v2Key: 'all', countKey: 'all', description: '全部任务', accent: '#2563eb' },
  { key: 'draft', label: '草稿', v2Key: 'draft', countKey: 'draft', description: '待补齐 / 待派发', accent: '#64748b' },
  { key: 'todo', label: '待处理', v2Key: 'todo', countKey: 'todo', description: '审批 / 审核待处理', accent: '#d97706' },
  { key: 'executing', label: '执行中', v2Key: 'executing', countKey: 'executing', description: '已发布 / 员工执行', accent: '#2563eb' },
  { key: 'ended', label: '已结束', v2Key: 'ended', countKey: 'ended', description: '已完成 / 已关闭', accent: '#16a34a' },
] as const
type TaskTabKey = (typeof TASK_TABS)[number]['key']
type TaskListV2TabKey = (typeof TASK_TABS)[number]['v2Key']
const TASK_STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'DRAFT', label: '草稿' },
  { value: 'PENDING_REVIEW', label: '待审核' },
  { value: 'PUBLISHED', label: '已发布' },
  { value: 'EXECUTING', label: '执行中' },
  { value: 'OVERDUE', label: '已逾期' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CLOSED', label: '已关闭' },
]
// 列表状态展示：CANCELLED 前端显示「已关闭」（不改数据库值，仅展示）
const TASK_DISPLAY_STATUS_LABEL: Record<string, string> = { ...TASK_STATUS_LABEL, CANCELLED: '已关闭' }
const TASK_TYPE_OPTIONS = STANDARD_TASK_TYPE_VALUES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] }))
const STANDARD_TASK_TYPE_SET = new Set<string>(STANDARD_TASK_TYPE_VALUES)
const EMPTY_TASK_COUNTS: TaskListV2Counts = { all: 0, draft: 0, todo: 0, executing: 0, ended: 0, overdue: 0 }
const BATCH_CANCEL_STATUSES = new Set(['DRAFT', 'PENDING_APPROVAL'])

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
  height: 38,
  borderRadius: 6,
}
const panelFieldStyle: CSSProperties = {
  padding: '12px 14px',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  background: '#fff',
}
const panelFieldReadonlyStyle: CSSProperties = {
  color: '#0f172a',
  fontSize: 13,
  lineHeight: 1.7,
}
const helperTextStyle: CSSProperties = {
  color: '#64748b',
  fontSize: 12,
  lineHeight: 1.6,
}

const memberLabel = (member?: EnterpriseMember) => {
  if (!member) return ''
  return `${member.nickName || ''}${member.nickName && member.phone ? ' ' : ''}${member.phone || ''}`.trim()
}

const basisOptionLabel = (item: Requirement) =>
  sanitizeSEVisibleText([item.clauseNo, item.title].filter(Boolean).join(' ') || item.requirementText.slice(0, 24))

const dateTimeText = (value?: string | null) => value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-'

const submitModeLabel: Record<string, string> = {
  TEXT: '填写说明',
  ATTACHMENT: '上传附件',
  TASK_ITEMS: '逐项填写',
  CHECKLIST: '检查清单',
  PARAMETER: '参数填写',
  LEARNING: '学习确认',
  QUIZ: '题库答题',
}
const DEFAULT_SUBMIT_MODES: SubmitFormMode[] = ['TEXT', 'ATTACHMENT']
const REQUIREMENT_SUBMIT_OPTIONS = [
  { value: 'TEXT', label: '文本填写', help: '填写本要求项的完成说明' },
  { value: 'IMAGE', label: '图片上传', help: '上传现场照片、截图等图片证据' },
  { value: 'FILE', label: '文件上传', help: '上传 PDF、Word、表格或压缩包' },
  { value: 'STRUCTURED', label: '结构化填写项', help: '为本要求项配置字段' },
  { value: 'QUIZ', label: '答题 / 题库', help: '关联题库并要求作答' },
  { value: 'LEARNING', label: '学习材料确认', help: '阅读材料后确认完成' },
] as const
type RequirementSubmitOption = (typeof REQUIREMENT_SUBMIT_OPTIONS)[number]['value']
const DEFAULT_REQUIREMENT_SUBMIT_OPTIONS: RequirementSubmitOption[] = ['TEXT', 'IMAGE']
const DEFAULT_ATTACHMENT_ACCEPT = ['application/pdf', 'image/*', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip']

type RequirementStructuredField = {
  id?: string
  name?: string
  fieldType?: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT'
  required?: boolean
  validation?: string | null
}

type RequirementLearningMaterial = {
  type?: 'file' | 'link'
  url?: string | null
  name?: string
}

interface RequirementSubmitConfigItem {
  id: string
  requirementId?: string | null
  title: string
  description?: string | null
  clauseNo?: string | null
  sourceTitle?: string | null
  required?: boolean
  sort?: number
  submitOptions: RequirementSubmitOption[]
  submitModes: SubmitFormMode[]
  textPrompt?: string | null
  attachmentRequired?: boolean
  attachmentMinCount?: number
  attachmentMaxCount?: number
  attachmentAccept?: string[]
  attachmentHint?: string | null
  structuredFields?: RequirementStructuredField[]
  quizBankId?: string | null
  quizQuestionCount?: number | null
  quizPassScore?: number | null
  learningMaterials?: RequirementLearningMaterial[]
}

const submitOptionsToModes = (options: RequirementSubmitOption[] = DEFAULT_REQUIREMENT_SUBMIT_OPTIONS): SubmitFormMode[] => {
  const modes = new Set<SubmitFormMode>()
  if (options.includes('TEXT')) modes.add('TEXT')
  if (options.includes('IMAGE') || options.includes('FILE')) modes.add('ATTACHMENT')
  if (options.includes('STRUCTURED')) modes.add('CHECKLIST')
  if (options.includes('QUIZ')) modes.add('QUIZ')
  if (options.includes('LEARNING')) modes.add('LEARNING')
  return Array.from(modes.size ? modes : new Set<SubmitFormMode>(DEFAULT_SUBMIT_MODES))
}

const submitOptionsToAccept = (options: RequirementSubmitOption[] = DEFAULT_REQUIREMENT_SUBMIT_OPTIONS) => {
  const hasImage = options.includes('IMAGE')
  const hasFile = options.includes('FILE')
  if (hasImage && !hasFile) return ['image/*']
  if (hasFile && !hasImage) return ['application/pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip']
  return DEFAULT_ATTACHMENT_ACCEPT
}

const normalizeSubmitOptions = (raw: unknown): RequirementSubmitOption[] => {
  const values = Array.isArray(raw) ? raw : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
  const allowed = new Set<RequirementSubmitOption>(REQUIREMENT_SUBMIT_OPTIONS.map((item) => item.value))
  const normalized = values.filter((value): value is RequirementSubmitOption => allowed.has(value as RequirementSubmitOption))
  return normalized.length ? Array.from(new Set(normalized)) : DEFAULT_REQUIREMENT_SUBMIT_OPTIONS
}

const makeDraftId = (prefix = 'req') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const structuredTypeLabel: Record<string, string> = {
  TASK_ITEMS: '任务填写项',
  CHECKLIST: '检查清单',
  PARAMETER: '参数填写',
}

const taskStatusTag = (task: SeTask) => (
  <Space size={4} wrap>
    <Tag color={TASK_STATUS_COLOR[task.status]}>{TASK_DISPLAY_STATUS_LABEL[task.status] || task.status}</Tag>
    {task.isOverdue && <Tag color="red">逾期</Tag>}
  </Space>
)

// 每种任务类型的默认提交内容文案（选类型后自动填入，可手动覆盖）
const TASK_TYPE_DEFAULT_SUBMIT: Record<string, string> = {
  TRAINING: '请阅读学习材料，填写学习确认说明；如有签到表、考核记录等，可一并上传。',
  QUALIFICATION_MATERIAL: '请上传资质/证书材料，填写证书编号、有效期或补充说明。',
  ONBOARDING_ACCESS: '请确认已掌握岗位要求，填写上岗日期、岗位准入说明或负责人确认信息。',
  INSPECTION_FILL: '请逐项填写各任务填写项实测值，注明检查时间、检查人及是否符合要求。',
  RECTIFICATION: '请详述问题根因、整改措施、整改结果，并上传整改前后凭证。',
  ARCHIVE_MATERIAL: '请上传需归档的过程记录或证明材料，并填写材料名称与归档说明。',
  DOCUMENT_UPLOAD: '请上传最新版相关制度/规程/记录文件，并在提交说明中注明文件版本及更新要点。',
  PHOTO: '请上传现场照片（至少 1 张），照片需清晰展示检查部位，并在说明中注明地点和时间。',
  PARAMETER: '请填写各参数名称、标准值范围、实测值及合格判定，附检测记录截图。',
  OTHER: '请按任务要求完成提交，并提供必要的说明和证明材料。',
}

interface ProgressData {
  taskId: string
  taskStatus: string
  deadlineAt: string
  isOverdue: boolean
  total: number
  byStatus: Record<string, number>
  assignees: Array<{ id: string; assigneeId: string; status: string; submittedAt: string | null; reviewedAt: string | null; isOverdue: boolean }>
}

interface TaskBasisItem {
  id?: string
  sourceId?: string | null
  sourceTitle?: string | null
  sourceNo?: string | null
  sourceType?: string | null
  clauseNo?: string | null
  title?: string | null
  requirementText?: string | null
}

const getTaskBasisItems = (task: SeTask | null): TaskBasisItem[] => {
  if (!task) return []
  const basis = (task as SeTask & { basis?: TaskBasisItem[] | null }).basis
  if (Array.isArray(basis) && basis.length > 0) return basis
  const snapshots = (task as SeTask & { basisSnapshots?: TaskBasisItem[] | null }).basisSnapshots
  if (Array.isArray(snapshots) && snapshots.length > 0) return snapshots
  if (!task.requirement) return []
  return [{
    id: task.requirement.id,
    sourceId: task.requirement.sourceId,
    sourceTitle: task.requirement.source?.title,
    sourceNo: task.requirement.source?.sourceNo,
    sourceType: task.requirement.source?.sourceType,
    clauseNo: task.requirement.clauseNo,
    title: task.requirement.title,
    requirementText: task.requirement.requirementText,
  }]
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const stringOrNull = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null

const numberOrNull = (value: unknown) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const requirementConfigFromBasis = (
  basis: Partial<TaskBasisItem> | null | undefined,
  index: number,
  fallback?: Partial<RequirementSubmitConfigItem>,
): RequirementSubmitConfigItem => {
  const title = stringOrNull(fallback?.title)
    || stringOrNull(basis?.title)
    || stringOrNull(basis?.requirementText)?.slice(0, 60)
    || `要求项 ${index + 1}`
  const description = stringOrNull(fallback?.description)
    || stringOrNull(basis?.requirementText)
    || stringOrNull(title)
    || ''
  const submitOptions = normalizeSubmitOptions(fallback?.submitOptions)
  return {
    id: fallback?.id || basis?.id || makeDraftId('req'),
    requirementId: fallback?.requirementId ?? basis?.id ?? null,
    title,
    description,
    clauseNo: fallback?.clauseNo ?? basis?.clauseNo ?? null,
    sourceTitle: fallback?.sourceTitle ?? basis?.sourceTitle ?? null,
    required: fallback?.required ?? true,
    sort: fallback?.sort ?? index + 1,
    submitOptions,
    submitModes: submitOptionsToModes(submitOptions),
    textPrompt: fallback?.textPrompt ?? '请填写本要求项完成情况。',
    attachmentRequired: fallback?.attachmentRequired ?? submitOptions.some((option) => option === 'IMAGE' || option === 'FILE'),
    attachmentMinCount: fallback?.attachmentMinCount ?? (submitOptions.some((option) => option === 'IMAGE' || option === 'FILE') ? 1 : 0),
    attachmentMaxCount: fallback?.attachmentMaxCount ?? 20,
    attachmentAccept: fallback?.attachmentAccept?.length ? fallback.attachmentAccept : submitOptionsToAccept(submitOptions),
    attachmentHint: fallback?.attachmentHint ?? null,
    structuredFields: fallback?.structuredFields ?? [],
    quizBankId: fallback?.quizBankId ?? null,
    quizQuestionCount: fallback?.quizQuestionCount ?? null,
    quizPassScore: fallback?.quizPassScore ?? null,
    learningMaterials: fallback?.learningMaterials ?? [],
  }
}

const requirementConfigFromChecklistItem = (rawItem: unknown, index: number): RequirementSubmitConfigItem => {
  const item = asRecord(rawItem)
  const submitOptions = normalizeSubmitOptions(item.submitOptions)
  const structuredFields = Array.isArray(item.structuredFields)
    ? item.structuredFields.map((field) => {
      const record = asRecord(field)
      return {
        id: stringOrNull(record.id) || makeDraftId('field'),
        name: stringOrNull(record.name) || '',
        fieldType: (['TEXT', 'NUMBER', 'DATE', 'SELECT'].includes(String(record.fieldType)) ? record.fieldType : 'TEXT') as RequirementStructuredField['fieldType'],
        required: record.required !== false,
        validation: stringOrNull(record.validation),
      }
    })
    : []
  const learningMaterials = Array.isArray(item.learningMaterials)
    ? item.learningMaterials.map((material) => {
      const record = asRecord(material)
      return {
        type: record.type === 'file' ? 'file' as const : 'link' as const,
        name: stringOrNull(record.name) || '',
        url: stringOrNull(record.url),
      }
    })
    : []
  return requirementConfigFromBasis({
    id: stringOrNull(item.requirementId) || stringOrNull(item.id) || undefined,
    title: stringOrNull(item.requirementTitle) || stringOrNull(item.name) || undefined,
    requirementText: stringOrNull(item.requirementDescription) || stringOrNull(item.name) || undefined,
    clauseNo: stringOrNull(item.clauseNo),
    sourceTitle: stringOrNull(item.sourceTitle),
  }, index, {
    id: stringOrNull(item.id) || makeDraftId('req'),
    requirementId: stringOrNull(item.requirementId),
    title: stringOrNull(item.requirementTitle) || stringOrNull(item.name) || '',
    description: stringOrNull(item.requirementDescription) || stringOrNull(item.name) || '',
    clauseNo: stringOrNull(item.clauseNo),
    sourceTitle: stringOrNull(item.sourceTitle),
    required: item.required !== false,
    sort: numberOrNull(item.sort) ?? index + 1,
    submitOptions,
    submitModes: submitOptionsToModes(submitOptions),
    textPrompt: stringOrNull(item.textPrompt),
    attachmentRequired: item.attachmentRequired === undefined ? undefined : item.attachmentRequired === true,
    attachmentMinCount: numberOrNull(item.attachmentMinCount) ?? undefined,
    attachmentMaxCount: numberOrNull(item.attachmentMaxCount) ?? undefined,
    attachmentAccept: Array.isArray(item.attachmentAccept) ? item.attachmentAccept.filter((value): value is string => typeof value === 'string') : undefined,
    attachmentHint: stringOrNull(item.attachmentHint),
    structuredFields,
    quizBankId: stringOrNull(item.quizBankId),
    quizQuestionCount: numberOrNull(item.quizQuestionCount),
    quizPassScore: numberOrNull(item.quizPassScore),
    learningMaterials,
  })
}

const requirementConfigsForTask = (task: SeTask | null | undefined): RequirementSubmitConfigItem[] => {
  const checklistItems = Array.isArray(task?.checklistSchema?.items) ? task.checklistSchema.items : []
  const explicitConfigs = checklistItems
    .map((item, index) => requirementConfigFromChecklistItem(item, index))
    .filter((item) => item.title)
  const configByRequirement = new Map(explicitConfigs.map((item) => [item.requirementId || item.id, item]))
  const taskItems = Array.isArray((task as SeTask & { taskItems?: TaskListV2Item['taskItems'] } | null | undefined)?.taskItems)
    ? ((task as SeTask & { taskItems?: TaskListV2Item['taskItems'] }).taskItems || [])
    : []
  if (taskItems.length > 0) {
    return taskItems.map((item, index) => {
      const matched = configByRequirement.get(item.requirement?.id || item.id)
      return requirementConfigFromBasis({
        id: item.requirement?.id,
        title: item.requirement?.title,
        requirementText: item.requirement?.requirementText,
        clauseNo: item.requirement?.clauseNo,
        sourceTitle: item.requirement?.source?.title,
      }, index, matched)
    })
  }
  if (explicitConfigs.length > 0) return explicitConfigs
  const basisItems = getTaskBasisItems(task || null)
  if (basisItems.length > 0) return basisItems.map((basis, index) => requirementConfigFromBasis(basis, index))
  if (task) {
    return [requirementConfigFromBasis(null, 0, {
      title: task.title,
      description: task.description || task.submitRequirement || task.title,
      textPrompt: task.submitRequirement || null,
    })]
  }
  return [requirementConfigFromBasis(null, 0)]
}

const checklistItemFromRequirementConfig = (rawConfig: RequirementSubmitConfigItem, index: number) => {
  const submitOptions = normalizeSubmitOptions(rawConfig.submitOptions)
  const submitModes = submitOptionsToModes(submitOptions)
  const attachmentAccept = rawConfig.attachmentAccept?.length ? rawConfig.attachmentAccept : submitOptionsToAccept(submitOptions)
  return {
    id: rawConfig.id || makeDraftId('req'),
    name: rawConfig.title?.trim() || `要求项 ${index + 1}`,
    judgeType: 'TEXT',
    requirementId: rawConfig.requirementId || null,
    requirementTitle: rawConfig.title?.trim() || `要求项 ${index + 1}`,
    requirementDescription: rawConfig.description?.trim() || rawConfig.textPrompt?.trim() || '',
    clauseNo: rawConfig.clauseNo || null,
    sourceTitle: rawConfig.sourceTitle || null,
    required: rawConfig.required !== false,
    sort: index + 1,
    submitOptions,
    submitModes,
    textPrompt: rawConfig.textPrompt?.trim() || '请填写本要求项完成情况。',
    attachmentRequired: rawConfig.attachmentRequired ?? submitOptions.some((option) => option === 'IMAGE' || option === 'FILE'),
    attachmentMinCount: rawConfig.attachmentMinCount ?? (submitOptions.some((option) => option === 'IMAGE' || option === 'FILE') ? 1 : 0),
    attachmentMaxCount: rawConfig.attachmentMaxCount ?? 20,
    attachmentAccept,
    attachmentHint: rawConfig.attachmentHint || null,
    structuredFields: (rawConfig.structuredFields || []).filter((field) => field.name?.trim()).map((field) => ({
      id: field.id || makeDraftId('field'),
      name: field.name?.trim() || '',
      fieldType: field.fieldType || 'TEXT',
      required: field.required !== false,
      validation: field.validation?.trim() || null,
    })),
    quizBankId: rawConfig.quizBankId || null,
    quizQuestionCount: rawConfig.quizQuestionCount ?? null,
    quizPassScore: rawConfig.quizPassScore ?? null,
    learningMaterials: (rawConfig.learningMaterials || []).filter((material) => material.name?.trim()).map((material) => ({
      type: material.type || 'link',
      name: material.name?.trim() || '',
      url: material.url?.trim() || null,
    })),
  }
}

const summarizeRequirementSubmitText = (configs: RequirementSubmitConfigItem[]) =>
  configs
    .map((config, index) => {
      const options = normalizeSubmitOptions(config.submitOptions)
        .map((option) => REQUIREMENT_SUBMIT_OPTIONS.find((item) => item.value === option)?.label || option)
        .join(' + ')
      return `${index + 1}. ${config.title || `要求项 ${index + 1}`}：${config.textPrompt || config.description || '按要求完成'}；提交格式：${options}`
    })
    .join('\n')

export default function SeTasksPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const [items, setItems] = useState<TaskListV2Item[]>([])
  const [members, setMembers] = useState<EnterpriseMember[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<TaskListV2Counts>(EMPTY_TASK_COUNTS)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterStatus, setFilterStatus] = useState('')
  const [filterAssigneeId, setFilterAssigneeId] = useState('')
  const [filterSourceId, setFilterSourceId] = useState('')
  const [filterPlanId, setFilterPlanId] = useState('')
  const [onlyMine, setOnlyMine] = useState(false)
  const [activeTab, setActiveTab] = useState<TaskTabKey>('all')
  const [keyword, setKeyword] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const createdBatch = searchParams.get('createdBatch') || ''
  const createdTaskStatus = searchParams.get('createdTaskStatus') || 'DRAFT'
  const createdTaskIds = useMemo(
    () => (searchParams.get('createdTaskIds') || '').split(',').map((id) => id.trim()).filter(Boolean),
    [searchParams],
  )
  const createdTaskIdSet = useMemo(() => new Set(createdTaskIds), [createdTaskIds])

  const [editOpen, setEditOpen] = useState(false)
  const [editRow, setEditRow] = useState<SeTask | null>(null)
  const [form] = Form.useForm()
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignForm] = Form.useForm()

  const [progressOpen, setProgressOpen] = useState(false)
  const [progressData, setProgressData] = useState<ProgressData | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailRow, setDetailRow] = useState<SeTask | null>(null)
  const [editReturnToDetail, setEditReturnToDetail] = useState(false)
  const [quizBanks, setQuizBanks] = useState<QuestionBank[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [sourceBasisItems, setSourceBasisItems] = useState<Requirement[]>([])
  const [sourceBasisLoading, setSourceBasisLoading] = useState(false)
  const [sourceBasisError, setSourceBasisError] = useState('')

  const prefillReqId = useMemo(() => searchParams.get('requirementId') || '', [searchParams])
  const prefillSourceId = useMemo(() => searchParams.get('sourceId') || '', [searchParams])
  const newTaskIntent = useMemo(() => searchParams.get('newTask') === '1', [searchParams])
  const watchedTaskType = Form.useWatch('taskType', form)
  const watchedRequirementConfigs = Form.useWatch('requirementSubmitConfigs', form) as RequirementSubmitConfigItem[] | undefined

  const loadMembers = async () => {
    if (!isEnterprise) return   // admin 路径不调企业成员接口
    try {
      const res = await seListEnterpriseMembers()
      setMembers(res.data)
    } catch { /* ignore */ }
  }

  const loadQuizBanks = async () => {
    try {
      const fn = isEnterprise ? seListQuestionBanksEnterprise : seListQuestionBanks
      const res = await fn({ pageSize: 200 })
      setQuizBanks(res.data)
    } catch { /* ignore */ }
  }

  const loadSources = async () => {
    try {
      const fn = isEnterprise ? seListSourcesEnterprise : seListSources
      const res = await fn({ pageSize: 200 })
      setSources(res.data)
    } catch { /* ignore */ }
  }

  const loadPlans = async () => {
    if (!isEnterprise) return
    try {
      const res = await seListPlans({ pageSize: 200 })
      setPlans(res.data)
    } catch { /* ignore */ }
  }

  const loadSourceBasisItems = async (sourceId: string, preferredRequirementId?: string) => {
    setSelectedSourceId(sourceId)
    form.setFieldValue('sourceId', sourceId || undefined)
    if (!sourceId) {
      setSourceBasisItems([])
      setSourceBasisError('')
      form.setFieldValue('requirementId', undefined)
      return
    }
    setSourceBasisLoading(true)
    setSourceBasisError('')
    try {
      const fn = isEnterprise ? seListRequirementsEnterprise : seListRequirements
      const res = await fn({ sourceId, status: 'ACTIVE', pageSize: 200 })
      setSourceBasisItems(res.data)
      const nextRequirementId = preferredRequirementId || form.getFieldValue('requirementId')
      if (nextRequirementId && res.data.some((item) => item.id === nextRequirementId)) {
        form.setFieldValue('requirementId', nextRequirementId)
        if (!editRow) {
          const basis = res.data.find((item) => item.id === nextRequirementId)
          if (basis) {
            form.setFieldValue('requirementSubmitConfigs', [requirementConfigFromBasis({
              id: basis.id,
              sourceId: basis.sourceId,
              sourceTitle: basis.source?.title,
              sourceNo: basis.source?.sourceNo,
              sourceType: basis.source?.sourceType,
              clauseNo: basis.clauseNo,
              title: basis.title,
              requirementText: basis.executionDescription || basis.requirementText,
            }, 0, {
              textPrompt: basis.submitRequirement || TASK_TYPE_DEFAULT_SUBMIT[basis.recommendedTaskType || 'OTHER'],
              attachmentHint: basis.requiredMaterials?.length ? `建议提交：${basis.requiredMaterials.join('、')}` : null,
            })])
          }
        }
        return
      }
      form.setFieldValue('requirementId', undefined)
    } catch {
      setSourceBasisError('生成内容暂不可用，可先手动填写任务草稿。')
      setSourceBasisItems([])
    } finally {
      setSourceBasisLoading(false)
    }
  }

  const applyBasisToForm = (requirementId: string | undefined) => {
    if (!requirementId || editRow) return
    const item = sourceBasisItems.find((basis) => basis.id === requirementId)
    if (!item) return
    const recommendedTaskType = item.recommendedTaskType || ''
    const nextTaskType = STANDARD_TASK_TYPE_SET.has(recommendedTaskType)
      ? recommendedTaskType
      : undefined
    form.setFieldsValue({
      title: form.getFieldValue('title') || item.title,
      taskType: form.getFieldValue('taskType') || nextTaskType,
      description: form.getFieldValue('description') || item.executionDescription || item.requirementText,
      submitRequirement: form.getFieldValue('submitRequirement') || item.submitRequirement || TASK_TYPE_DEFAULT_SUBMIT[nextTaskType || 'OTHER'],
      requirementSubmitConfigs: [requirementConfigFromBasis({
        id: item.id,
        sourceId: item.sourceId,
        sourceTitle: item.source?.title,
        sourceNo: item.source?.sourceNo,
        sourceType: item.source?.sourceType,
        clauseNo: item.clauseNo,
        title: item.title,
        requirementText: item.executionDescription || item.requirementText,
      }, 0, {
        textPrompt: item.submitRequirement || TASK_TYPE_DEFAULT_SUBMIT[nextTaskType || 'OTHER'],
        attachmentHint: item.requiredMaterials?.length ? `建议提交：${item.requiredMaterials.join('、')}` : null,
      })],
    })
  }

  const load = async () => {
    setLoading(true)
    try {
      const fetchFn = isEnterprise ? seListTasksV2Enterprise : seListTasksV2
      const currentTab = TASK_TABS.find((tab) => tab.key === activeTab)
      const v2Tab = (currentTab?.v2Key ?? 'all') as TaskListV2TabKey
      const res = await fetchFn({
        tab: v2Tab,
        status: filterStatus && filterStatus !== 'OVERDUE' ? filterStatus : undefined,
        deadline: filterStatus === 'OVERDUE' ? 'overdue' : undefined,
        assigneeId: filterAssigneeId || undefined,
        sourceId: filterSourceId || undefined,
        planId: filterPlanId || undefined,
        mine: onlyMine || undefined,
        keyword: keyword || undefined,
        includeCounts: true,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
      setCounts(res.counts ?? EMPTY_TASK_COUNTS)
      setSelectedKeys([])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadMembers(); loadQuizBanks(); loadSources(); loadPlans() }, [])
  useEffect(() => { load() }, [page, filterStatus, filterAssigneeId, filterSourceId, filterPlanId, onlyMine, activeTab])

  const visibleItems = items
  const sourceOptions = useMemo(() => sortSEOptions([
    { value: '', label: '全部文档' },
    ...sources.map((source) => ({
      value: source.id,
      label: sanitizeSEVisibleText(`${source.title}${source.sourceType ? ` · ${SOURCE_TYPE_LABEL[source.sourceType] || source.sourceType}` : ''}`),
    })),
  ]), [sources])
  const planOptions = useMemo(() => sortSEOptions([
    { value: '', label: '全部计划' },
    ...plans.map((plan) => ({ value: plan.id, label: sanitizeSEVisibleText(plan.title) })),
  ]), [plans])
  const memberOptions = useMemo(() => sortSEOptions([
    { value: '', label: '全部成员' },
    ...members.map((m) => ({ value: m.id, label: sanitizeSEVisibleText(memberLabel(m) || m.id.slice(0, 8)) })),
  ]), [members])
  const existingAssigneeIds = useMemo(
    () => new Set((editRow?.assignees || []).map((assignee) => assignee.assigneeId)),
    [editRow],
  )
  const assigneeEditOptions = useMemo(() => memberOptions
    .filter((option) => option.value)
    .map((option) => ({
      ...option,
      disabled: editRow?.status === 'PUBLISHED' && existingAssigneeIds.has(String(option.value)),
    })),
  [memberOptions, editRow?.status, existingAssigneeIds])
  const editFieldPolicy = useMemo(() => getTaskFieldEditPolicy(editRow?.status ?? null), [editRow?.status])
  const editTaskItemCount = Array.isArray((editRow as TaskListV2Item | null)?.taskItems)
    ? ((editRow as TaskListV2Item).taskItems?.length ?? 0)
    : 0
  const editSubmitFormConfig = useMemo(() => {
    const requirementConfigs = (watchedRequirementConfigs?.length ? watchedRequirementConfigs : requirementConfigsForTask(editRow || detailRow))
      .map((config, index) => checklistItemFromRequirementConfig(config, index))
    const firstQuizBankId = requirementConfigs.find((item) => item.quizBankId)?.quizBankId ?? null
    const learningItems = requirementConfigs.flatMap((item) => item.learningMaterials || [])
    const config = buildSubmitFormConfigPreview({
      taskType: watchedTaskType ?? editRow?.taskType,
      checklistSchema: { items: requirementConfigs },
      parametersSchema: { items: [] },
      learningMaterials: { items: learningItems },
      quizBankId: firstQuizBankId,
      taskItemCount: editTaskItemCount,
    })
    return config
  }, [watchedTaskType, watchedRequirementConfigs, editRow, detailRow, editTaskItemCount])

  const memberName = (id?: string | null) => {
    if (!id) return '-'
    const member = members.find((item) => item.id === id)
    return memberLabel(member) || id.slice(0, 8)
  }

  const closeTaskPanel = () => {
    setEditOpen(false)
    setDetailOpen(false)
    setEditRow(null)
    setDetailRow(null)
    setEditReturnToDetail(false)
    if (prefillReqId || newTaskIntent) setSearchParams({})
  }

  const cancelEdit = () => {
    if (editReturnToDetail && detailRow) {
      setEditOpen(false)
      setEditRow(null)
      setEditReturnToDetail(false)
      setDetailOpen(true)
      return
    }
    closeTaskPanel()
  }

  const taskSource = (task: SeTask | null) => {
    const v2Source = (task as TaskListV2Item | null)?.source
    if (v2Source?.id || v2Source?.title) return v2Source
    const basis = getTaskBasisItems(task)
    const first = basis.find((item) => item.sourceId || item.sourceTitle || item.sourceNo)
    if (first) {
      return {
        id: first.sourceId ?? null,
        title: first.sourceTitle ?? null,
        sourceNo: first.sourceNo ?? null,
        sourceType: first.sourceType ?? null,
      }
    }
    const requirementSource = task?.requirement?.source
    if (requirementSource) {
      return {
        id: requirementSource.id,
        title: requirementSource.title,
        sourceNo: requirementSource.sourceNo,
        sourceType: requirementSource.sourceType,
      }
    }
    return null
  }

  const sourcePath = (sourceId?: string | null, requirementId?: string | null) => {
    const base = isEnterprise ? '/enterprise/sources' : '/admin/standard-execution/sources'
    const params = new URLSearchParams()
    if (sourceId) params.set('sourceId', sourceId)
    if (requirementId) params.set('requirementId', requirementId)
    if (requirementId) params.set('advanced', 'requirements')
    const query = params.toString()
    return query ? `${base}?${query}` : base
  }

  const selectedRequirementForEdit = () => {
    const requirementId = form.getFieldValue('requirementId') || editRow?.requirementId
    return sourceBasisItems.find((item) => item.id === requirementId) || editRow?.requirement || null
  }

  const collectTaskMaterials = (task: SeTask | null) => {
    const materials = new Set<string>()
    const requirementMaterials = task?.requirement?.requiredMaterials
    if (Array.isArray(requirementMaterials)) requirementMaterials.forEach((item) => item && materials.add(item))
    const itemRequirements = (task as TaskListV2Item | null)?.taskItems || []
    itemRequirements.forEach((item) => {
      const requiredMaterials = item.requirement?.requiredMaterials
      if (Array.isArray(requiredMaterials)) requiredMaterials.forEach((material) => material && materials.add(material))
    })
    return Array.from(materials)
  }

  const renderSubmitFormConfig = (config: SubmitFormConfig) => (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space wrap>
        {config.modes.map((mode) => <Tag key={mode}>{submitModeLabel[mode] || mode}</Tag>)}
      </Space>
      <div style={helperTextStyle}>{sanitizeSEVisibleText(config.employeeHint || '-')}</div>
      <div style={helperTextStyle}>
        说明字段：{config.text.label}，{config.text.required ? '必填' : '选填'}，{config.text.minLength}-{config.text.maxLength} 字
      </div>
      <div style={helperTextStyle}>
        附件：{config.attachment.required ? `必传 ${config.attachment.minCount}-${config.attachment.maxCount} 个` : `可选，最多 ${config.attachment.maxCount} 个`}
        {config.attachment.accept.length ? `；格式 ${config.attachment.accept.join(' / ')}` : ''}
      </div>
      {config.structured.type && (
        <div style={helperTextStyle}>{structuredTypeLabel[config.structured.type] || config.structured.type}：{config.structured.itemCount} 项</div>
      )}
      {config.learning.requiresConfirmation && <div style={helperTextStyle}>学习确认：{config.learning.materialCount} 份材料</div>}
      {config.quiz.required && <div style={helperTextStyle}>题库答题：必答</div>}
    </Space>
  )

  const renderLifecycle = (task: SeTask | null) => {
    const assignees = task?.assignees || []
    const submitted = assignees.filter((item) => item.submittedAt)
    const reviewed = assignees.filter((item) => item.reviewedAt)
    const latestSubmittedAt = submitted
      .map((item) => item.submittedAt)
      .filter(Boolean)
      .sort()
    const latestSubmitted = latestSubmittedAt[latestSubmittedAt.length - 1] || null
    const latestReviewedAt = reviewed
      .map((item) => item.reviewedAt)
      .filter(Boolean)
      .sort()
    const latestReviewed = latestReviewedAt[latestReviewedAt.length - 1] || null
    return (
      <Timeline
        style={{ margin: 0 }}
        items={[
          { color: task?.createdAt ? 'green' : 'gray', children: <span>创建：{dateTimeText(task?.createdAt)}{task?.createdBy ? `（${memberName(task.createdBy)}）` : ''}</span> },
          { color: task?.submittedForApprovalAt ? 'green' : 'gray', children: <span>提交审批：{dateTimeText(task?.submittedForApprovalAt)}</span> },
          { color: task?.approvedAt ? 'green' : 'gray', children: <span>审批通过：{dateTimeText(task?.approvedAt)}</span> },
          { color: task?.publishedAt ? 'green' : 'gray', children: <span>派发：{dateTimeText(task?.publishedAt)}</span> },
          { color: submitted.length ? 'green' : 'gray', children: <span>员工提交：{latestSubmitted ? `${dateTimeText(latestSubmitted)}（${submitted.length} 人）` : '-'}</span> },
          { color: reviewed.length || task?.completedAt ? 'green' : 'gray', children: <span>审核 / 完成：{task?.completedAt ? dateTimeText(task.completedAt) : latestReviewed ? `${dateTimeText(latestReviewed)}（${reviewed.length} 人）` : '-'}</span> },
          ...(task?.cancelledAt ? [{ color: 'red' as const, children: <span>关闭：{dateTimeText(task.cancelledAt)}</span> }] : []),
        ]}
      />
    )
  }

  const fieldShell = (fieldKey: TaskFieldKey, mode: 'detail' | 'edit', children: ReactNode, helper?: ReactNode) => {
    const label = TASK_FIELD_MODEL.find((field) => field.key === fieldKey)?.label || fieldKey
    return (
      <div key={`${mode}-${fieldKey}`} data-task-panel-mode={mode} data-task-field-key={fieldKey} style={panelFieldStyle}>
        <div style={{ ...fieldLabelStyle, marginBottom: 8 }}>{label}</div>
        {children}
        {helper ? <div style={{ ...helperTextStyle, marginTop: 8 }}>{helper}</div> : null}
      </div>
    )
  }

  // 从标准库文档或历史内容入口进入时，直接打开创建抽屉。
  useEffect(() => {
    if (newTaskIntent || prefillReqId) {
      setDetailOpen(false)
      setDetailRow(null)
      setEditReturnToDetail(false)
      setEditRow(null)
      form.resetFields()
      form.setFieldsValue({
        sourceId: prefillSourceId || undefined,
        requirementId: prefillReqId || undefined,
        deadlineMode: 'FIXED',
        deadlineDaysAfterApproval: 7,
        submitModes: DEFAULT_SUBMIT_MODES,
        requirementSubmitConfigs: [requirementConfigFromBasis(null, 0)],
      })
      if (prefillSourceId) loadSourceBasisItems(prefillSourceId, prefillReqId)
      setEditOpen(true)
    }
  }, [newTaskIntent, prefillReqId, prefillSourceId])

  useEffect(() => {
    const queryTab = searchParams.get('tab') as TaskTabKey | null
    if (queryTab && TASK_TABS.some((tab) => tab.key === queryTab)) {
      setActiveTab(queryTab)
      setFilterStatus(searchParams.get('status') || '')
      setPage(1)
    }
  }, [searchParams])

  useEffect(() => {
    if (!createdBatch) return
    setActiveTab(createdTaskStatus === 'PENDING_APPROVAL' ? 'todo' : createdTaskStatus === 'PUBLISHED' ? 'executing' : 'draft')
    setFilterAssigneeId('')
    setFilterSourceId('')
    setFilterPlanId('')
    setOnlyMine(false)
    setKeyword('')
    setFilterStatus('')
    setPage(1)
  }, [createdBatch, createdTaskStatus])

  const openCreate = () => {
    setDetailOpen(false)
    setDetailRow(null)
    setEditReturnToDetail(false)
    setEditRow(null)
    form.resetFields()
    setSelectedSourceId('')
    setSourceBasisItems([])
    setSourceBasisError('')
    form.setFieldsValue({
      deadlineMode: 'FIXED',
      deadlineDaysAfterApproval: 7,
      submitModes: DEFAULT_SUBMIT_MODES,
      requirementSubmitConfigs: [requirementConfigFromBasis(null, 0)],
    })
    setEditOpen(true)
  }
  const openEdit = (row: SeTask, options: { returnToDetail?: boolean } = {}) => {
    setDetailOpen(false)
    setEditReturnToDetail(!!options.returnToDetail)
    if (options.returnToDetail) setDetailRow(row)
    setEditRow(row)
    const rowSourceId = (row as TaskListV2Item).source?.id || row.requirement?.sourceId || ''
    setSelectedSourceId(rowSourceId)
    if (rowSourceId) loadSourceBasisItems(rowSourceId, row.requirementId || undefined)
    form.setFieldsValue({
      ...row,
      sourceId: rowSourceId || undefined,
      requirementId: row.requirementId || undefined,
      deadlineAt: dayjs(row.deadlineAt),
      deadlineMode: row.deadlineMode || 'FIXED',
      deadlineDaysAfterApproval: row.deadlineDaysAfterApproval ?? 7,
      assigneeIds: row.assignees?.map((a) => a.assigneeId) ?? [],
      quizBankId: (row as SeTask & { quizBankId?: string | null }).quizBankId ?? null,
      requirementSubmitConfigs: requirementConfigsForTask(row),
    })
    setEditOpen(true)
  }
  const handleSave = async () => {
    try {
      const values = await form.validateFields()
      const deadlineMode = values.deadlineMode || 'FIXED'
      const deadlineDaysAfterApproval = Number(values.deadlineDaysAfterApproval || 7)
      const resolvedDeadlineAt = deadlineMode === 'FIXED' && values.deadlineAt
        ? values.deadlineAt.toISOString()
        : null
      const assigneeIds = typeof values.assigneeIds === 'string'
        ? values.assigneeIds.split(',').map((s: string) => s.trim()).filter(Boolean)
        : (values.assigneeIds ?? [])
      const normalizedAssigneeIds = editRow?.status === 'PUBLISHED'
        ? Array.from(new Set([...(editRow.assignees?.map((a) => a.assigneeId) ?? []), ...assigneeIds]))
        : assigneeIds
      const rawRequirementConfigs = Array.isArray(values.requirementSubmitConfigs) && values.requirementSubmitConfigs.length
        ? values.requirementSubmitConfigs as RequirementSubmitConfigItem[]
        : requirementConfigsForTask(editRow || detailRow)
      const requirementConfigs = rawRequirementConfigs
        .map((config, index) => requirementConfigFromBasis(null, index, config))
        .filter((config) => config.title?.trim())
      const checklistItems = requirementConfigs.map((config, index) => checklistItemFromRequirementConfig(config, index))
      const submitModes = new Set<SubmitFormMode>(DEFAULT_SUBMIT_MODES)
      checklistItems.forEach((item) => item.submitModes.forEach((mode) => submitModes.add(mode)))
      const flattenedLearningMaterials = checklistItems
        .flatMap((item) => item.learningMaterials || [])
        .filter((item) => item.name && item.url)
        .map((item) => ({ type: item.type, name: item.name, url: item.url }))
      const firstQuizBankId = checklistItems.find((item) => item.quizBankId)?.quizBankId ?? null
      const submitRequirement = values.submitRequirement?.trim() || summarizeRequirementSubmitText(requirementConfigs).slice(0, 1000)
      const payload: Record<string, unknown> = {
        ...values,
        deadlineMode,
        deadlineDaysAfterApproval: deadlineMode === 'AFTER_APPROVAL_DAYS' ? deadlineDaysAfterApproval : null,
        deadlineAt: resolvedDeadlineAt,
        submitRequirement: submitRequirement || null,
        reviewerId: values.reviewerId || null,
        assigneeIds: normalizedAssigneeIds,
        checklistSchema: { items: checklistItems },
        parametersSchema: null,
        learningMaterials: flattenedLearningMaterials.length ? { items: flattenedLearningMaterials } : null,
        quizBankId: firstQuizBankId,
      }
      submitModes.add('TEXT')
      submitModes.add('ATTACHMENT')
      delete payload.sourceId
      delete payload.submitModes
      delete payload.requirementSubmitConfigs
      if (!submitModes.has('LEARNING')) payload.learningMaterials = null
      if (!submitModes.has('QUIZ')) payload.quizBankId = null
      if (editRow) {
        delete payload.requirementId
        const updateFn = isEnterprise ? seUpdateTaskEnterprise : seUpdateTask
        const res = await updateFn(editRow.id, payload)
        if (editReturnToDetail) {
          const current = detailRow || editRow
          const currentAssignees = current.assignees || []
          const nextAssignees = normalizedAssigneeIds.map((assigneeId: string) => (
            currentAssignees.find((assignee) => assignee.assigneeId === assigneeId) || {
              id: `${editRow.id}-${assigneeId}`,
              enterpriseId: editRow.enterpriseId,
              taskId: editRow.id,
              assigneeId,
              departmentId: null,
              reviewerId: null,
              status: 'PENDING',
              submittedAt: null,
              reviewedAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }
          ))
          setDetailRow({
            ...current,
            ...res.data,
            assignees: nextAssignees,
            requirement: current.requirement,
            basis: (current as TaskListV2Item).basis,
            source: (current as TaskListV2Item).source,
            taskItems: (current as TaskListV2Item).taskItems,
            requirementSummary: (current as TaskListV2Item).requirementSummary,
          } as TaskListV2Item)
        }
        message.success('已更新')
      } else {
        const createFn = isEnterprise ? seCreateTaskEnterprise : seCreateTask
        await createFn(payload)
        message.success('已保存任务草稿')
        setActiveTab('draft')
        setFilterStatus('')
        setFilterAssigneeId('')
        setFilterSourceId('')
        setFilterPlanId('')
        setOnlyMine(false)
        setKeyword('')
        setPage(1)
      }
      if (editRow && editReturnToDetail) {
        setEditOpen(false)
        setEditRow(null)
        setEditReturnToDetail(false)
        setDetailOpen(true)
      } else {
        setEditOpen(false)
        setEditRow(null)
        setEditReturnToDetail(false)
        setDetailRow(null)
      }
      if (prefillReqId || newTaskIntent) setSearchParams({})
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const handleSubmitApproval = (row: SeTask) => {
    Modal.confirm({
      title: '提交任务审核',
      content: `确认将「${row.title}」提交审核？审核通过后才会正式下发给员工。`,
      onOk: async () => {
        try {
          const fn = isEnterprise ? seSubmitTaskApprovalEnterprise : seSubmitTaskApproval
          await fn(row.id)
          message.success('已提交审核')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const handleCancel = (row: SeTask) => {
    const isPublishedTask = row.status === 'PUBLISHED'
    Modal.confirm({
      title: isPublishedTask ? '停用任务' : '取消任务',
      content: isPublishedTask
        ? `确认停用「${row.title}」？停用后员工端不再继续执行，任务进入已结束。`
        : `确认取消「${row.title}」？已分发的执行人将看不到该任务。`,
      onOk: async () => {
        try {
          const cancelFn = isEnterprise ? seCancelTaskEnterprise : seCancelTask
          await cancelFn(row.id)
          message.success(isPublishedTask ? '已停用，员工端不再继续执行' : '已取消')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const handleProgress = async (row: SeTask) => {
    try {
      const progressFn = isEnterprise ? seGetTaskProgressEnterprise : seGetTaskProgress
      const res = await progressFn(row.id)
      setProgressData((res.data as ProgressData))
      setProgressOpen(true)
    } catch {
      message.error('加载失败')
    }
  }

  // ─── 批量操作 ─────────────────────────────────────────
  const handleBatchCancel = () => {
    Modal.confirm({
      title: '批量取消',
      content: `确认取消选中的任务？${selectedKeys.length} 项中 ${selectedCancellableCount} 项适用；已完成、已关闭或执行中的任务会自动跳过。`,
      onOk: async () => {
        try {
          const fn = isEnterprise ? seBatchCancelTasksEnterprise : seBatchCancelTasks
          const r = await fn(selectedKeys as string[])
          message.success(`已取消 ${r.ok} 项${r.skipped ? `，${r.skipped} 项跳过` : ''}`)
          setSelectedKeys([]); load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const handleDelete = (row: SeTask) => {
    Modal.confirm({
      title: '删除任务',
      content: `确认删除任务草稿「${row.title}」？删除后不在列表显示，历史记录不受影响。仅草稿可删。`,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await seDeleteTask(row.id)
          message.success('已删除')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '删除失败')
        }
      },
    })
  }
  const handleBatchDelete = () => {
    Modal.confirm({
      title: '批量删除',
      content: `确认删除选中的 ${selectedKeys.length} 个任务？仅「草稿」会删除，其余跳过。`,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const r = await seBatchDeleteTasks(selectedKeys as string[])
          message.success(`已删除 ${r.ok} 项${r.skipped ? `，${r.skipped} 项跳过（仅草稿可删）` : ''}`)
          setSelectedKeys([]); load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '删除失败')
        }
      },
    })
  }
  const openDetail = async (row: SeTask) => {
    setEditOpen(false)
    setEditRow(null)
    setEditReturnToDetail(false)
    setDetailRow(row)        // 先用列表项快速显示基本信息
    setDetailOpen(true)
    if (!isEnterprise) {
      try {
        const res = await seGetTask(row.id) // admin 端补全 assignees / schema
        setDetailRow(res.data)
      } catch { /* detail 失败时用列表项兜底 */ }
    }
  }

  const openBatchAssign = () => { assignForm.resetFields(); setAssignOpen(true) }
  const handleBatchAssignConfirm = async () => {
    try {
      const values = await assignForm.validateFields()
      const fn = isEnterprise ? seBatchAssignTasksEnterprise : seBatchAssignTasks
      const r = await fn(selectedKeys as string[], values.reviewerId, values.assigneeIds)
      message.success(`已指派 ${r.ok} 项${r.skipped ? `，${r.skipped} 项跳过（仅 DRAFT 可指派）` : ''}`)
      setAssignOpen(false); setSelectedKeys([]); load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }
  const renderTaskActions = (row: SeTask) => {
    const isDraft = row.status === 'DRAFT'
    const isPendingApproval = row.status === 'PENDING_APPROVAL'
    const isPublished = row.status === 'PUBLISHED'
    const moreItems: { key: string; label: string; danger?: boolean }[] = []
    if (!isEnterprise && isDraft) moreItems.push({ key: 'delete', label: '删除', danger: true })

    const handleMoreClick = ({ key }: { key: string }) => {
      if (key === 'delete') handleDelete(row)
    }

    return (
      <Space size={0} split={<Divider type="vertical" />}>
        <Button size="small" type="link" onClick={() => handleProgress(row)}>进度</Button>
        {isDraft && <Button size="small" type="link" onClick={() => openEdit(row)}>编辑</Button>}
        {isDraft && <Button size="small" type="link" onClick={() => handleSubmitApproval(row)}>提交</Button>}
        {isPendingApproval && <Button size="small" type="link" disabled title="审核中任务请在合规审核台处理">编辑</Button>}
        {isPendingApproval && <Button size="small" type="link" disabled title="已提交审核，等待合规审核台处理">提交</Button>}
        {isPublished && <Button size="small" type="link" onClick={() => openDetail(row)}>查看</Button>}
        {isPublished && <Button size="small" type="link" danger onClick={() => handleCancel(row)}>停用</Button>}
        {!isDraft && !isPendingApproval && !isPublished && <Button size="small" type="link" onClick={() => openDetail(row)}>查看</Button>}
        {moreItems.length > 0 && (
          <Dropdown menu={{ items: moreItems, onClick: handleMoreClick }} trigger={['click']}>
            <Button size="small" type="link" icon={<MoreOutlined />}>更多</Button>
          </Dropdown>
        )}
      </Space>
    )
  }

  const selectedRows = useMemo(() => items.filter((it) => selectedKeys.includes(it.id)), [items, selectedKeys])
  const selectedDraftCount = selectedRows.filter((it) => it.status === 'DRAFT').length
  const selectedCancellableCount = selectedRows.filter((it) => BATCH_CANCEL_STATUSES.has(it.status)).length
  const allSelectedDraft = selectedRows.length > 0 && selectedDraftCount === selectedRows.length
  const batchAssignDisabled = selectedDraftCount === 0
  const batchCancelDisabled = selectedCancellableCount === 0
  const batchAssignTip = batchAssignDisabled
    ? '已完成或非草稿任务不可指派'
    : selectedDraftCount < selectedRows.length
      ? `已选 ${selectedRows.length} 项中 ${selectedDraftCount} 项可指派；非草稿会自动跳过`
      : '所选任务均可指派'
  const batchCancelTip = batchCancelDisabled
    ? '已完成、已关闭或执行中的任务不可批量取消；执行中任务请逐条点「停用」确认'
    : selectedCancellableCount < selectedRows.length
      ? `已选 ${selectedRows.length} 项中 ${selectedCancellableCount} 项可取消；其余会自动跳过`
      : '所选任务均可取消'
  const selectedStatusSummary = useMemo(() => {
    const byStatus = selectedRows.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + 1
      return acc
    }, {})
    return Object.entries(byStatus)
      .map(([status, count]) => `${TASK_DISPLAY_STATUS_LABEL[status] || status} ${count}`)
      .join('，')
  }, [selectedRows])
  const detailBasisItems = useMemo(() => getTaskBasisItems(detailRow), [detailRow])

  const { setData: setSEPageData, triggerAsk } = useContext(SEPageContext)
  useEffect(() => {
    setSEPageData({
      pageKey: 'tasks',
      summary: `当前任务列表（共 ${total} 条，当前页 ${items.length} 条）：\n` + items.slice(0, 8).map((t) => `- ${sanitizeSEVisibleText(t.title)}｜${TASK_STATUS_LABEL[t.status]}｜截止:${t.deadlineAt ? dayjs(t.deadlineAt).format('MM-DD') : '无'}`).join('\n'),
    })
    return () => setSEPageData(null)
  }, [items, total, setSEPageData])

  const renderMaterials = (materials: string[], config: SubmitFormConfig) => (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {materials.length > 0 ? (
        <Space wrap>{materials.map((item) => <Tag key={item}>{sanitizeSEVisibleText(item)}</Tag>)}</Space>
      ) : (
        <span style={panelFieldReadonlyStyle}>暂无单独材料清单</span>
      )}
      <div style={helperTextStyle}>
        T12 附件规则：{config.attachment.required ? `必须上传 ${config.attachment.minCount}-${config.attachment.maxCount} 个附件` : `可上传补充附件，最多 ${config.attachment.maxCount} 个`}
        {config.attachment.reason ? `；${config.attachment.reason}` : ''}
      </div>
    </Space>
  )

  const renderRequirementSubmitDetail = (task: SeTask) => {
    const configs = requirementConfigsForTask(task)
    return (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <div style={helperTextStyle}>每个要求项都有自己的提交格式；员工端会按以下结构逐项展示。</div>
        {renderRequirementConfigCards(configs)}
      </Space>
    )
  }

  const renderRequirementConfigCards = (configs: RequirementSubmitConfigItem[]) => (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {configs.map((config, index) => {
        const submitOptions = normalizeSubmitOptions(config.submitOptions)
        const optionLabels = submitOptions.map((option) => REQUIREMENT_SUBMIT_OPTIONS.find((item) => item.value === option)?.label || option)
        return (
          <div key={config.id || index} style={{ padding: 14, border: '1px solid #dbeafe', background: '#f8fbff', borderRadius: 12 }}>
            <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
              <div>
                <div style={{ fontWeight: 700, color: '#0f172a' }}>
                  {index + 1}. {sanitizeSEVisibleText(config.title || `要求项 ${index + 1}`)}
                  {config.required === false ? <Tag style={{ marginLeft: 8 }}>可选</Tag> : <Tag color="blue" style={{ marginLeft: 8 }}>必做</Tag>}
                </div>
                <div style={{ ...helperTextStyle, marginTop: 4 }}>{sanitizeSEVisibleText(config.description || '-')}</div>
                {(config.clauseNo || config.sourceTitle) && (
                  <div style={{ ...helperTextStyle, marginTop: 4 }}>来源：{config.clauseNo ? `${config.clauseNo} · ` : ''}{sanitizeSEVisibleText(config.sourceTitle || '标准依据')}</div>
                )}
              </div>
              <Space wrap>{optionLabels.map((label) => <Tag key={label}>{label}</Tag>)}</Space>
            </Space>
            <div style={{ marginTop: 10, padding: 10, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>本要求项提交格式</div>
              {config.textPrompt && <div style={helperTextStyle}>文本提示：{sanitizeSEVisibleText(config.textPrompt)}</div>}
              {(submitOptions.includes('IMAGE') || submitOptions.includes('FILE')) && (
                <div style={helperTextStyle}>
                  附件：{config.attachmentRequired === false ? '选传' : `至少 ${config.attachmentMinCount ?? 1} 个`}，最多 {config.attachmentMaxCount ?? 20} 个
                  {config.attachmentHint ? `；${sanitizeSEVisibleText(config.attachmentHint)}` : ''}
                </div>
              )}
              {submitOptions.includes('STRUCTURED') && <div style={helperTextStyle}>结构化字段：{config.structuredFields?.length || 0} 项</div>}
              {submitOptions.includes('QUIZ') && <div style={helperTextStyle}>题库：{config.quizBankId ? '已关联' : '未选择'}{config.quizQuestionCount ? `，${config.quizQuestionCount} 题` : ''}{config.quizPassScore ? `，通过分 ${config.quizPassScore}` : ''}</div>}
              {submitOptions.includes('LEARNING') && <div style={helperTextStyle}>学习材料：{config.learningMaterials?.length || 0} 份</div>}
            </div>
          </div>
        )
      })}
    </Space>
  )

  const renderRequirementSubmitConfigEditor = () => {
    const disabled = editRow?.status === 'PUBLISHED'
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, color: '#0f172a' }}>要求项配置</div>
            <div style={helperTextStyle}>一个任务可包含多个要求项；每个要求项单独配置员工要提交的内容。</div>
          </div>
          <Tag color="blue">保存后员工端逐项展示</Tag>
        </div>
        <Form.List name="requirementSubmitConfigs">
          {(fields, { add, remove }) => (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {fields.map(({ key, name, ...restField }, index) => (
                <div key={key} style={{ padding: 14, border: '1px solid #dbeafe', background: '#f8fbff', borderRadius: 12 }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} align="center">
                    <Text strong>要求项 {index + 1}</Text>
                    {!disabled && fields.length > 1 && <Button size="small" danger type="text" onClick={() => remove(name)}>删除要求项</Button>}
                  </Space>
                  <Form.Item {...restField} name={[name, 'id']} hidden><Input /></Form.Item>
                  <Form.Item {...restField} name={[name, 'requirementId']} hidden><Input /></Form.Item>
                  <Form.Item {...restField} name={[name, 'clauseNo']} hidden><Input /></Form.Item>
                  <Form.Item {...restField} name={[name, 'sourceTitle']} hidden><Input /></Form.Item>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) 120px 120px', gap: 12 }}>
                    <Form.Item {...restField} name={[name, 'title']} label="要求标题" rules={[{ required: true, message: '要求标题必填' }]}>
                      <Input disabled={disabled} maxLength={200} placeholder="例如：核查许可证续期" />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'required']} label="是否必做" valuePropName="checked" initialValue>
                      <Switch disabled={disabled} checkedChildren="必做" unCheckedChildren="可选" />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'sort']} label="排序" initialValue={index + 1}>
                      <InputNumber disabled={disabled} min={1} max={500} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </div>
                  <Form.Item {...restField} name={[name, 'description']} label="要求描述" rules={[{ required: true, message: '要求描述必填' }]}>
                    <TextArea disabled={disabled} rows={3} maxLength={2000} placeholder="说明员工要完成什么，不要写提交方式。" />
                  </Form.Item>
                  <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, background: '#fff' }}>
                    <Form.Item {...restField} name={[name, 'submitOptions']} label="本要求项提交格式" initialValue={DEFAULT_REQUIREMENT_SUBMIT_OPTIONS}>
                      <Checkbox.Group disabled={disabled} style={{ width: '100%' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                          {REQUIREMENT_SUBMIT_OPTIONS.map((option) => (
                            <label key={option.value} style={{ display: 'block', padding: 10, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                              <Checkbox value={option.value}>{option.label}</Checkbox>
                              <div style={{ ...helperTextStyle, marginTop: 4 }}>{option.help}</div>
                            </label>
                          ))}
                        </div>
                      </Checkbox.Group>
                    </Form.Item>
                    <Form.Item shouldUpdate noStyle>
                      {({ getFieldValue }) => {
                        const options = normalizeSubmitOptions(getFieldValue(['requirementSubmitConfigs', name, 'submitOptions']))
                        const needsAttachment = options.includes('IMAGE') || options.includes('FILE')
                        return (
                          <Space direction="vertical" size={10} style={{ width: '100%' }}>
                            {options.includes('TEXT') && (
                              <Form.Item {...restField} name={[name, 'textPrompt']} label="文本填写提示" style={{ marginBottom: 0 }}>
                                <TextArea disabled={disabled} rows={2} maxLength={1000} placeholder="例如：填写核查结果、异常说明和处理意见。" />
                              </Form.Item>
                            )}
                            {needsAttachment && (
                              <div style={{ display: 'grid', gridTemplateColumns: '120px 120px minmax(0, 1fr)', gap: 10 }}>
                                <Form.Item {...restField} name={[name, 'attachmentMinCount']} label="最少附件" initialValue={1}>
                                  <InputNumber disabled={disabled} min={0} max={50} precision={0} style={{ width: '100%' }} />
                                </Form.Item>
                                <Form.Item {...restField} name={[name, 'attachmentMaxCount']} label="最多附件" initialValue={20}>
                                  <InputNumber disabled={disabled} min={1} max={50} precision={0} style={{ width: '100%' }} />
                                </Form.Item>
                                <Form.Item {...restField} name={[name, 'attachmentHint']} label="附件示例 / 要求">
                                  <Input disabled={disabled} maxLength={500} placeholder="例如：上传许可证扫描件、现场照片或记录表 PDF" />
                                </Form.Item>
                              </div>
                            )}
                            {options.includes('STRUCTURED') && (
                              <div style={{ padding: 10, background: '#f8fafc', borderRadius: 8 }}>
                                <Text strong>结构化填写项</Text>
                                <Form.List name={[name, 'structuredFields']}>
                                  {(subFields, { add: addField, remove: removeField }) => (
                                    <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                                      {subFields.map((field, fieldIndex) => (
                                        <Space key={field.key} align="baseline" style={{ display: 'flex', flexWrap: 'wrap' }}>
                                          <Form.Item {...field} name={[field.name, 'id']} hidden initialValue={makeDraftId('field')}><Input /></Form.Item>
                                          <Form.Item {...field} name={[field.name, 'name']} rules={[{ required: true, message: '字段名必填' }]} style={{ marginBottom: 0 }}>
                                            <Input disabled={disabled} placeholder={`字段 ${fieldIndex + 1}`} style={{ width: 180 }} />
                                          </Form.Item>
                                          <Form.Item {...field} name={[field.name, 'fieldType']} initialValue="TEXT" style={{ marginBottom: 0 }}>
                                            <Select disabled={disabled} style={{ width: 120 }} options={[
                                              { value: 'TEXT', label: '文本' },
                                              { value: 'NUMBER', label: '数字' },
                                              { value: 'DATE', label: '日期' },
                                              { value: 'SELECT', label: '选择' },
                                            ]} />
                                          </Form.Item>
                                          <Form.Item {...field} name={[field.name, 'validation']} style={{ marginBottom: 0 }}>
                                            <Input disabled={disabled} placeholder="校验规则 / 选项" style={{ width: 220 }} />
                                          </Form.Item>
                                          {!disabled && <MinusCircleOutlined onClick={() => removeField(field.name)} style={{ color: '#999' }} />}
                                        </Space>
                                      ))}
                                      {!disabled && <Button type="dashed" size="small" onClick={() => addField({ id: makeDraftId('field'), fieldType: 'TEXT', required: true })} icon={<PlusOutlined />}>添加字段</Button>}
                                    </Space>
                                  )}
                                </Form.List>
                              </div>
                            )}
                            {options.includes('QUIZ') && (
                              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px 120px', gap: 10 }}>
                                <Form.Item {...restField} name={[name, 'quizBankId']} label="题库">
                                  <Select
                                    allowClear
                                    disabled={disabled}
                                    placeholder="选择题库"
                                    options={sortSEOptions(quizBanks.map((b) => ({ value: b.id, label: sanitizeSEVisibleText(`${b.title}（${b.questionCount} 题）`) })))}
                                    showSearch
                                    filterOption={filterSEOption}
                                  />
                                </Form.Item>
                                <Form.Item {...restField} name={[name, 'quizQuestionCount']} label="题数">
                                  <InputNumber disabled={disabled} min={1} max={200} precision={0} style={{ width: '100%' }} />
                                </Form.Item>
                                <Form.Item {...restField} name={[name, 'quizPassScore']} label="通过分">
                                  <InputNumber disabled={disabled} min={0} max={100} precision={0} style={{ width: '100%' }} />
                                </Form.Item>
                              </div>
                            )}
                            {options.includes('LEARNING') && (
                              <div style={{ padding: 10, background: '#f8fafc', borderRadius: 8 }}>
                                <Text strong>学习材料</Text>
                                <Form.List name={[name, 'learningMaterials']}>
                                  {(materialFields, { add: addMaterial, remove: removeMaterial }) => (
                                    <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
                                      {materialFields.map((field) => (
                                        <Space key={field.key} align="baseline" style={{ display: 'flex', flexWrap: 'wrap' }}>
                                          <Form.Item {...field} name={[field.name, 'type']} initialValue="link" style={{ marginBottom: 0 }}>
                                            <Select disabled={disabled} style={{ width: 96 }} options={[
                                              { value: 'link', label: '链接' },
                                              { value: 'file', label: '文件' },
                                            ]} />
                                          </Form.Item>
                                          <Form.Item {...field} name={[field.name, 'name']} rules={[{ required: true, message: '材料名称必填' }]} style={{ marginBottom: 0 }}>
                                            <Input disabled={disabled} placeholder="材料名称" style={{ width: 200 }} />
                                          </Form.Item>
                                          <Form.Item {...field} name={[field.name, 'url']} style={{ marginBottom: 0 }}>
                                            <Input disabled={disabled} placeholder="链接或文件地址" style={{ width: 260 }} />
                                          </Form.Item>
                                          {!disabled && <MinusCircleOutlined onClick={() => removeMaterial(field.name)} style={{ color: '#999' }} />}
                                        </Space>
                                      ))}
                                      {!disabled && <Button type="dashed" size="small" onClick={() => addMaterial({ type: 'link' })} icon={<PlusOutlined />}>添加材料</Button>}
                                    </Space>
                                  )}
                                </Form.List>
                              </div>
                            )}
                          </Space>
                        )
                      }}
                    </Form.Item>
                  </div>
                </div>
              ))}
              {!disabled && (
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => add(requirementConfigFromBasis(null, fields.length))}
                >
                  新增要求项
                </Button>
              )}
            </Space>
          )}
        </Form.List>
      </Space>
    )
  }

  const renderDetailField = (fieldKey: TaskFieldKey) => {
    if (!detailRow) return null
    const config = submitConfigForTask(detailRow)
    const source = taskSource(detailRow)
    const materials = collectTaskMaterials(detailRow)
    const basisItems = detailBasisItems
    switch (fieldKey) {
      case 'title':
        return fieldShell(fieldKey, 'detail', <div style={panelFieldReadonlyStyle}>{sanitizeSEVisibleText(detailRow.title)}</div>)
      case 'taskType':
        return fieldShell(fieldKey, 'detail', <div style={panelFieldReadonlyStyle}>{detailRow.taskType ? (TASK_TYPE_LABEL[detailRow.taskType] || detailRow.taskType) : '-'}</div>)
      case 'source':
        return fieldShell(fieldKey, 'detail', (
          <Space direction="vertical" size={6}>
            <div style={panelFieldReadonlyStyle}>{sanitizeSEVisibleText(source?.title || source?.sourceNo || '-')}</div>
            {source?.sourceType ? <Tag>{SOURCE_TYPE_LABEL[source.sourceType] || source.sourceType}</Tag> : null}
            {source?.id ? <Button size="small" onClick={() => nav(sourcePath(source.id))}>查看文档</Button> : null}
          </Space>
        ))
      case 'generatedContent':
        return fieldShell(fieldKey, 'detail', (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {detailRow.description ? <div style={panelFieldReadonlyStyle}>{sanitizeSEVisibleText(detailRow.description)}</div> : null}
            {basisItems.length > 0 ? basisItems.map((basis, index) => (
              <div key={basis.id || `${basis.title}-${index}`} style={{ padding: 10, background: '#f8fafc', borderRadius: 8 }}>
                <div style={{ fontWeight: 500 }}>{basis.clauseNo ? `[${basis.clauseNo}] ` : ''}{sanitizeSEVisibleText(basis.title || '未命名内容')}</div>
                <div style={helperTextStyle}>标准文档：{sanitizeSEVisibleText(basis.sourceTitle || basis.sourceNo || '-')}</div>
                {basis.requirementText ? <div style={{ ...helperTextStyle, whiteSpace: 'pre-wrap' }}>{sanitizeSEVisibleText(basis.requirementText)}</div> : null}
                {(basis.sourceId || basis.id) ? <Button size="small" type="link" style={{ paddingLeft: 0 }} onClick={() => nav(sourcePath(basis.sourceId, basis.id))}>查看溯源</Button> : null}
              </div>
            )) : <span style={panelFieldReadonlyStyle}>暂无标准依据</span>}
          </Space>
        ))
      case 'assignees':
        return fieldShell(fieldKey, 'detail', (
          detailRow.assignees?.length ? (
            <Space wrap>
              {detailRow.assignees.map((assignee) => (
                <Tag key={assignee.id || assignee.assigneeId}>{memberName(assignee.assigneeId)} · {ASSIGNEE_STATUS_LABEL[assignee.status] || assignee.status}</Tag>
              ))}
            </Space>
          ) : <span style={panelFieldReadonlyStyle}>无</span>
        ))
      case 'reviewer':
        return fieldShell(fieldKey, 'detail', <div style={panelFieldReadonlyStyle}>{memberName(detailRow.reviewerId)}</div>)
      case 'deadline':
        return fieldShell(fieldKey, 'detail', (
          <Space direction="vertical" size={4}>
            <div style={panelFieldReadonlyStyle}>{detailRow.deadlineMode === 'AFTER_APPROVAL_DAYS' ? `审核通过后 ${detailRow.deadlineDaysAfterApproval ?? 7} 天内完成` : dateTimeText(detailRow.deadlineAt)}</div>
            {detailRow.deadlineAt ? <div style={helperTextStyle}>固定截止：{dateTimeText(detailRow.deadlineAt)}</div> : null}
          </Space>
        ))
      case 'submitForm':
        return fieldShell(fieldKey, 'detail', renderRequirementSubmitDetail(detailRow))
      case 'submitRequirement':
        return fieldShell(fieldKey, 'detail', <div style={{ ...panelFieldReadonlyStyle, whiteSpace: 'pre-wrap' }}>{sanitizeSEVisibleText(detailRow.submitRequirement, '-')}</div>)
      case 'materials':
        return fieldShell(fieldKey, 'detail', renderMaterials(materials, config))
      case 'status':
        return fieldShell(fieldKey, 'detail', taskStatusTag(detailRow))
      case 'lifecycle':
        return fieldShell(fieldKey, 'detail', renderLifecycle(detailRow))
      default:
        return null
    }
  }

  const renderEditField = (fieldKey: TaskFieldKey) => {
    const policy = editFieldPolicy[fieldKey]
    const selectedRequirement = selectedRequirementForEdit()
    const selectedMaterials = selectedRequirement?.requiredMaterials || []
    const currentTask = editRow || detailRow
    switch (fieldKey) {
      case 'title':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="title" rules={[{ required: true, message: '必填' }]} style={{ marginBottom: 0 }}>
            <Input maxLength={200} placeholder="自动带入生成内容标题，可手动修改" disabled={!policy.editable} />
          </Form.Item>
        ), policy.reason)
      case 'taskType':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="taskType" style={{ marginBottom: 0 }}>
            <Select
              disabled={!policy.editable}
              options={TASK_TYPE_OPTIONS}
              allowClear
              placeholder="填写 / 资料上传 / 学习确认"
              onChange={(v: string) => {
                const current = form.getFieldValue('submitRequirement')
                if (!current || Object.values(TASK_TYPE_DEFAULT_SUBMIT).includes(current)) {
                  form.setFieldValue('submitRequirement', TASK_TYPE_DEFAULT_SUBMIT[v] || '')
                }
              }}
            />
          </Form.Item>
        ), policy.reason)
      case 'source':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="sourceId" style={{ marginBottom: 0 }}>
            <Select
              allowClear
              disabled={!!editRow || !policy.editable}
              loading={sources.length === 0}
              placeholder="选择标准库文档"
              showSearch
              optionFilterProp="label"
              options={sortSEOptions(sources.map((source) => ({
                value: source.id,
                label: sanitizeSEVisibleText(`${source.title}${source.sourceType ? ` · ${SOURCE_TYPE_LABEL[source.sourceType] || source.sourceType}` : ''}`),
              })))}
              onChange={(value) => loadSourceBasisItems(value || '')}
              filterOption={filterSEOption}
            />
          </Form.Item>
        ), editRow ? '已创建执行任务的文档来源锁定；可在详情中查看溯源' : policy.reason)
      case 'generatedContent':
        return fieldShell(fieldKey, 'edit', (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Form.Item name="requirementId" extra={sourceBasisError || undefined} style={{ marginBottom: 0 }}>
              <Select
                allowClear
                disabled={!!editRow || !selectedSourceId}
                loading={sourceBasisLoading}
                placeholder={sourceBasisError ? '生成内容暂不可用' : (selectedSourceId ? '选择文档下可生成任务的内容' : '先选择文档来源')}
                showSearch
                optionFilterProp="label"
                options={sourceBasisItems.map((item) => ({
                  value: item.id,
                  label: basisOptionLabel(item),
                }))}
                onChange={(value) => applyBasisToForm(value)}
                filterOption={filterSEOption}
              />
            </Form.Item>
            <Form.Item name="description" style={{ marginBottom: 0 }}>
              <TextArea rows={3} maxLength={2000} placeholder="任务说明 / 现场执行口径" disabled={!policy.editable} />
            </Form.Item>
            {selectedRequirement ? (
              <Button size="small" onClick={() => nav(sourcePath(selectedRequirement.sourceId, selectedRequirement.id))}>查看当前生成内容溯源</Button>
            ) : null}
          </Space>
        ), editRow ? '生成内容来源锁定；任务说明可编辑' : policy.reason)
      case 'assignees':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="assigneeIds" style={{ marginBottom: 0 }}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称，可多选"
              options={assigneeEditOptions}
              filterOption={filterSEOption}
              disabled={!policy.editable}
            />
          </Form.Item>
        ), policy.reason)
      case 'reviewer':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="reviewerId" style={{ marginBottom: 0 }}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称"
              options={memberOptions.filter((option) => option.value)}
              filterOption={filterSEOption}
              disabled={!policy.editable}
            />
          </Form.Item>
        ), policy.reason)
      case 'deadline':
        return fieldShell(fieldKey, 'edit', (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Form.Item name="deadlineMode" initialValue="FIXED" style={{ marginBottom: 0 }}>
              <Select
                disabled={!policy.editable}
                options={[
                  { value: 'FIXED', label: '固定截止时间' },
                  { value: 'AFTER_APPROVAL_DAYS', label: '审核通过后 N 天内完成' },
                ]}
              />
            </Form.Item>
            <Form.Item shouldUpdate={(prev, cur) => prev.deadlineMode !== cur.deadlineMode} noStyle>
              {() => {
                const mode = form.getFieldValue('deadlineMode') || 'FIXED'
                return mode === 'AFTER_APPROVAL_DAYS' ? (
                  <Form.Item name="deadlineDaysAfterApproval" initialValue={7} style={{ marginBottom: 0 }}>
                    <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} disabled={!policy.editable} />
                  </Form.Item>
                ) : (
                  <Form.Item name="deadlineAt" style={{ marginBottom: 0 }}>
                    <DatePicker showTime style={{ width: '100%' }} disabled={!policy.editable} />
                  </Form.Item>
                )
              }}
            </Form.Item>
          </Space>
        ), policy.reason)
      case 'submitForm':
        return fieldShell(fieldKey, 'edit', (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            {renderSubmitFormConfig(editSubmitFormConfig)}
            {renderRequirementSubmitConfigEditor()}
          </Space>
        ), policy.reason)
      case 'submitRequirement':
        return fieldShell(fieldKey, 'edit', (
          <Form.Item name="submitRequirement" style={{ marginBottom: 0 }}>
            <TextArea rows={4} maxLength={1000} placeholder="描述执行人需要提交什么内容才算完成此任务；保存草稿可留空，提交审核前需补齐。" disabled={!policy.editable} />
          </Form.Item>
        ), policy.reason)
      case 'materials':
        return fieldShell(fieldKey, 'edit', renderMaterials(selectedMaterials, editSubmitFormConfig), policy.reason)
      case 'status':
        return fieldShell(fieldKey, 'edit', currentTask ? taskStatusTag(currentTask) : <Tag>保存后为草稿</Tag>, policy.reason)
      case 'lifecycle':
        return fieldShell(fieldKey, 'edit', currentTask ? renderLifecycle(currentTask) : <div style={panelFieldReadonlyStyle}>保存草稿后开始记录生命周期</div>, policy.reason)
      default:
        return null
    }
  }

  return (
    <div style={enterprisePageStyle}>
      {createdBatch && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16, borderRadius: 8 }}
          message={`任务生成批次 ${createdBatch} 已创建，当前页会高亮可见的${createdTaskStatus === 'PENDING_APPROVAL' ? '待审核任务' : '任务草稿'}。`}
          action={<Button size="small" onClick={() => setSearchParams({})}>关闭提示</Button>}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(150px, 1fr))', gap: 14, marginBottom: 22 }}>
        {TASK_TABS.map((tab) => {
          const active = activeTab === tab.key
          return (
            <div
              key={tab.key}
              role="button"
              tabIndex={0}
              title={`${tab.label} ${counts[tab.countKey] ?? 0}`}
              onClick={() => { setActiveTab(tab.key); setFilterStatus(''); setPage(1) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveTab(tab.key)
                  setFilterStatus('')
                  setPage(1)
                }
              }}
              style={{
                position: 'relative',
                minHeight: 92,
                borderRadius: 12,
                border: active ? `1px solid ${tab.accent}` : '1px solid #e2e8f0',
                background: active ? '#f8fbff' : '#fff',
                boxShadow: active ? '0 8px 18px rgba(37,99,235,0.10)' : '0 4px 12px rgba(15,23,42,0.04)',
                padding: '15px 18px',
                cursor: 'pointer',
                overflow: 'hidden',
              }}
            >
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: tab.accent }} />
              <div style={{ color: active ? tab.accent : '#475569', fontSize: 13, fontWeight: 700 }}>{tab.label}</div>
              <div style={{ marginTop: 8, color: '#0f172a', fontSize: 30, fontWeight: 800, lineHeight: 1 }}>{counts[tab.countKey] ?? 0}</div>
              <div style={{ marginTop: 8, color: '#64748b', fontSize: 12 }}>{tab.description}</div>
              {tab.key === 'executing' && (counts.overdue ?? 0) > 0 && (
                <Tag color="red" style={{ position: 'absolute', right: 12, top: 12 }}>逾期 {counts.overdue}</Tag>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
        <div>
          <div style={fieldLabelStyle}>搜索任务</div>
          <Input.Search
            placeholder="任务标题 / 标准文档"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={load}
            style={{ width: 260 }}
            allowClear
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>状态</div>
          <Select
            options={TASK_STATUS_OPTIONS}
            value={filterStatus}
            onChange={(v) => { setPage(1); setFilterStatus(v) }}
            style={{ width: 140 }}
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>执行人</div>
          <Select
            value={filterAssigneeId}
            onChange={(v) => { setPage(1); setFilterAssigneeId(v) }}
            style={{ width: 160 }}
            showSearch
            filterOption={filterSEOption}
            options={memberOptions}
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>计划</div>
          <Select
            value={filterPlanId}
            onChange={(v) => { setPage(1); setFilterPlanId(v) }}
            style={{ width: 160 }}
            showSearch
            filterOption={filterSEOption}
            options={planOptions}
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>文档</div>
          <Select
            value={filterSourceId}
            onChange={(v) => { setPage(1); setFilterSourceId(v) }}
            style={{ width: 180 }}
            showSearch
            filterOption={filterSEOption}
            options={sourceOptions}
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>负责人</div>
          <Switch checked={onlyMine} onChange={(v) => { setPage(1); setOnlyMine(v) }} checkedChildren="只看我" unCheckedChildren="全部" />
        </div>
        <div style={{ flex: 1 }} />
        {isEnterprise && (
          <Button icon={<ThunderboltOutlined />} onClick={() => nav('/enterprise/workbench')} style={{ ...compactControlStyle, width: 176 }}>从标准文档拆解任务</Button>
        )}
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} style={{ ...compactControlStyle, width: 88 }}>刷新</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} style={{ ...compactControlStyle, width: 112 }}>新建任务</Button>
      </div>

      {selectedKeys.length > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedKeys.length} 项{selectedStatusSummary ? `（${selectedStatusSummary}）` : ''}</span>
          <Space wrap>
            <Tooltip title={batchAssignTip}>
              <span><Button size="small" disabled={batchAssignDisabled} onClick={openBatchAssign}>批量指派</Button></span>
            </Tooltip>
            <Tooltip title={batchCancelTip}>
              <span><Button size="small" danger disabled={batchCancelDisabled} onClick={handleBatchCancel}>批量取消</Button></span>
            </Tooltip>
            {!isEnterprise && (
              <Button size="small" danger disabled={!allSelectedDraft} onClick={handleBatchDelete} title={!allSelectedDraft ? '仅当选中项全部为草稿时可删除' : ''}>批量删除</Button>
            )}
            <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
          </Space>
        </div>
      )}

      <Table<TaskListV2Item>
        rowKey="id"
        size="small"
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        loading={loading}
        dataSource={visibleItems}
        onRow={(row) => ({
          style: (() => {
            const selected = detailRow?.id === row.id || editRow?.id === row.id
            if (selected) return { background: '#eff6ff', boxShadow: 'inset 3px 0 0 #2563eb' }
            if (createdTaskIdSet.has(row.id)) return { background: '#f6ffed', boxShadow: 'inset 3px 0 0 #52c41a' }
            return undefined
          })(),
        })}
        locale={{ emptyText: <div style={{ padding: '24px 0', color: '#8a93a3' }}>还没有任务，点击右上「新建」创建第一个执行任务</div> }}
        pagination={{ current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
        style={{ width: '100%', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}
        columns={[
          {
            title: '任务',
            dataIndex: 'title',
            ellipsis: true,
            render: (v: string, row: TaskListV2Item) => (
              <Space direction="vertical" size={2}>
                  <Typography.Link style={{ color: '#0f172a', fontSize: 12, fontWeight: 500 }} onClick={() => openDetail(row)}>{sanitizeSEVisibleText(v)}</Typography.Link>
                <span style={{ color: '#94a3b8', fontSize: 11 }}>
                  {sanitizeSEVisibleText(row.planTitle || '临时任务')} · {sanitizeSEVisibleText(row.requirementSummary?.[0]?.title || row.source?.title || '无来源文档')}
                </span>
              </Space>
            ),
          },
          {
            title: '类型', dataIndex: 'taskType', width: 96,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            render: (v: any) => <span style={{ color: '#475569', fontSize: 12 }}>{v ? (TASK_TYPE_LABEL[v] || v) : '-'}</span>,
          },
          {
            title: '执行人',
            width: 92,
            render: (_: unknown, row: TaskListV2Item) => {
              const assignee = row.assignees?.[0]
              const member = members.find((m) => m.id === assignee?.assigneeId)
              const user = assignee?.user
              const primary = memberLabel(member) || user?.name || user?.phone || user?.email || (row.assigneeCount ? `${row.assigneeCount} 人` : '-')
              return <span style={{ color: '#475569', fontSize: 12 }}>{primary}</span>
            },
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 96,
            render: (v: string, r: SeTask) => <Space size={4}><span style={{ color: r.isOverdue ? '#dc2626' : '#475569', fontSize: 12 }}>{r.isOverdue ? '已逾期' : (TASK_DISPLAY_STATUS_LABEL[v] || v)}</span></Space>,
          },
          { title: '截止', dataIndex: 'deadlineAt', width: 112, render: (v: string | null) => <span style={{ color: '#475569', fontSize: 12 }}>{v ? dayjs(v).format('MM-DD HH:mm') : '-'}</span> },
          { title: '操作', width: 220, render: (_: unknown, row: SeTask) => <div style={{ whiteSpace: 'nowrap' }}>{renderTaskActions(row)}</div> },
        ]}
      />

      {editOpen && (
        <Modal
          open={editOpen}
          width={1120}
          centered
          keyboard
          maskClosable={false}
          onCancel={cancelEdit}
          footer={null}
          destroyOnClose={false}
          title={(
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingRight: 28 }}>
              <Space direction="vertical" size={0}>
                <span>{editRow ? '编辑任务' : '新建任务'}</span>
                <Text type="secondary" style={{ fontSize: 12 }}>基础信息 + 要求项配置；每个要求项单独配置自己的提交格式。</Text>
              </Space>
              <Space>
                <Button onClick={cancelEdit}>取消</Button>
                <Button type="primary" onClick={handleSave}>{editRow ? '保存' : '保存草稿'}</Button>
              </Space>
            </div>
          )}
        >
          <Form form={form} layout="vertical" data-task-panel-field-count={TASK_FIELD_MODEL.length}>
            {editRow?.status === 'PUBLISHED' && (
              <div style={{ padding: '8px 12px', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 6, marginBottom: 16, fontSize: 13, color: '#874d00' }}>
                已下发任务不可编辑，避免破坏员工执行记录；如需终止执行，请在列表中使用「停用」。
              </div>
            )}
            <div style={{ maxHeight: '72vh', overflowY: 'auto', paddingRight: 4 }}>
              <Collapse
                defaultActiveKey={['basic']}
                style={{ marginBottom: 14, background: '#fff' }}
                items={[{
                  key: 'basic',
                  label: '基础信息',
                  children: (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))', gap: 12 }}>
                      {(['title', 'taskType', 'source', 'assignees', 'reviewer', 'deadline'] as TaskFieldKey[]).map((key) => renderEditField(key))}
                    </div>
                  ),
                }]}
              />
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {renderEditField('generatedContent')}
                {renderEditField('submitForm')}
                {fieldShell('submitRequirement', 'edit', (
                  <div style={helperTextStyle}>提交要求由每个要求项的「本要求项提交格式」生成；保存时会汇总为兼容字段，员工端仍按要求项逐项展示。</div>
                ), editFieldPolicy.submitRequirement.reason)}
                {renderEditField('materials')}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(260px, 1fr))', gap: 12 }}>
                  {renderEditField('status')}
                  {renderEditField('lifecycle')}
                </div>
              </Space>
            </div>
          </Form>
        </Modal>
      )}

      <Drawer title="任务进度" open={progressOpen} onClose={() => setProgressOpen(false)} width={560}>
        {progressData && (
          <>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="任务状态">{TASK_STATUS_LABEL[progressData.taskStatus]}</Descriptions.Item>
              <Descriptions.Item label="截止时间">{dayjs(progressData.deadlineAt).format('YYYY-MM-DD HH:mm')}</Descriptions.Item>
              <Descriptions.Item label="是否逾期">{progressData.isOverdue ? <Tag color="red">是</Tag> : <Tag>否</Tag>}</Descriptions.Item>
              <Descriptions.Item label="执行人总数">{progressData.total}</Descriptions.Item>
              <Descriptions.Item label="按状态统计">
                {Object.entries(progressData.byStatus).map(([k, v]) => v > 0 ? <Tag key={k}>{ASSIGNEE_STATUS_LABEL[k] || k}: {v}</Tag> : null)}
              </Descriptions.Item>
            </Descriptions>
            <Table
              size="small"
              style={{ marginTop: 16 }}
              rowKey="id"
              pagination={false}
              dataSource={progressData.assignees}
              columns={[
                {
                  title: '执行人', dataIndex: 'assigneeId', ellipsis: true,
                  render: (v: string) => {
                    const m = members.find((mb) => mb.id === v)
                    return m ? `${m.nickName || ''}${m.nickName && m.phone ? ' · ' : ''}${m.phone || ''}`.trim() || v.slice(0, 8) : v.slice(0, 8)
                  },
                },
                { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => ASSIGNEE_STATUS_LABEL[v] || v },
                { title: '逾期', dataIndex: 'isOverdue', width: 70, render: (v: boolean) => v ? <Tag color="red">是</Tag> : '-' },
                { title: '提交时间', dataIndex: 'submittedAt', width: 130, render: (v: string | null) => v ? dayjs(v).format('MM-DD HH:mm') : '-' },
              ]}
            />
          </>
        )}
      </Drawer>

      {detailOpen && !editOpen && (
        <Drawer
          title="任务详情"
          open={detailOpen}
          size={640}
          mask={false}
          keyboard
          onClose={closeTaskPanel}
          extra={detailRow && (
            <Space>
              {isTaskEditable(detailRow.status) && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(detailRow, { returnToDetail: true })}>编辑</Button>}
              <Button size="small" onClick={() => triggerAsk(`任务：${sanitizeSEVisibleText(detailRow.title)}｜类型：${detailRow.taskType || '未指定'}｜状态：${detailRow.status}｜截止：${detailRow.deadlineAt ? dayjs(detailRow.deadlineAt).format('YYYY-MM-DD HH:mm') : '未设置'}`, '这个任务怎么提交？')}>问小智：这个任务怎么提交？</Button>
            </Space>
          )}
        >
          {detailRow && (
            <Space direction="vertical" size={12} style={{ width: '100%' }} data-task-panel-field-count={TASK_FIELD_MODEL.length}>
              {TASK_FIELD_MODEL.map((field) => renderDetailField(field.key))}
            </Space>
          )}
        </Drawer>
      )}

      <Modal
        title={`批量指派（${selectedKeys.length} 项中 ${selectedDraftCount} 项适用）`}
        open={assignOpen}
        onCancel={() => setAssignOpen(false)}
        onOk={handleBatchAssignConfirm}
        okText="确认指派"
      >
        <Form form={assignForm} layout="vertical">
          <Form.Item name="reviewerId" label="审核人" rules={[{ required: true, message: '必填' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称"
              options={memberOptions.filter((option) => option.value)}
              filterOption={filterSEOption}
            />
          </Form.Item>
          <Form.Item name="assigneeIds" label="执行人" rules={[{ required: true, message: '必填' }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="搜索手机号或昵称，可多选"
              options={memberOptions.filter((option) => option.value)}
              filterOption={filterSEOption}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
