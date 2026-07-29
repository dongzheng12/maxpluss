import type { SeTask, SubmitFormConfig, SubmitFormMode } from '../../../../api/standardExecution'

export const TASK_FIELD_MODEL = [
  { key: 'title', label: '标题' },
  { key: 'taskType', label: '任务类型' },
  { key: 'source', label: '文档来源' },
  { key: 'generatedContent', label: '生成内容 / 任务说明' },
  { key: 'assignees', label: '执行人' },
  { key: 'reviewer', label: '审核人' },
  { key: 'deadline', label: '截止时间' },
  { key: 'submitForm', label: '提交形式' },
  { key: 'submitRequirement', label: '提交要求' },
  { key: 'materials', label: '材料清单' },
  { key: 'status', label: '状态' },
  { key: 'lifecycle', label: '生命周期留痕' },
] as const

export type TaskFieldKey = (typeof TASK_FIELD_MODEL)[number]['key']

export const TASK_DETAIL_FIELD_KEYS = TASK_FIELD_MODEL.map((field) => field.key)
export const TASK_EDIT_FIELD_KEYS = TASK_FIELD_MODEL.map((field) => field.key)

const FILE_REQUIRED_TASK_TYPES = new Set([
  'PHOTO',
  'DOCUMENT_UPLOAD',
  'QUALIFICATION_MATERIAL',
  'ARCHIVE_MATERIAL',
])

const DOCUMENT_TASK_TYPES = new Set([
  'DOCUMENT_UPLOAD',
  'QUALIFICATION_MATERIAL',
  'ARCHIVE_MATERIAL',
])

function itemsCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const items = (value as { items?: unknown }).items
  return Array.isArray(items) ? items.length : 0
}

function uniqueModes(modes: SubmitFormMode[]): SubmitFormMode[] {
  return Array.from(new Set(modes))
}

function attachmentAccept(taskType?: string | null): string[] {
  if (taskType === 'PHOTO') return ['image/*']
  if (DOCUMENT_TASK_TYPES.has(taskType || '')) {
    return ['application/pdf', 'image/*', '.doc', '.docx', '.xls', '.xlsx', '.zip']
  }
  return ['application/pdf', 'image/*', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip']
}

export function buildSubmitFormConfigPreview(input: {
  taskType?: string | null
  checklistSchema?: unknown
  parametersSchema?: unknown
  learningMaterials?: unknown
  quizBankId?: string | null
  taskItemCount?: number
}): SubmitFormConfig {
  const taskType = input.taskType || 'OTHER'
  const checklistCount = itemsCount(input.checklistSchema)
  const parameterCount = itemsCount(input.parametersSchema)
  const materialCount = itemsCount(input.learningMaterials)
  const taskItemCount = input.taskItemCount ?? 0
  const modes: SubmitFormMode[] = ['TEXT', 'ATTACHMENT']

  let structured: SubmitFormConfig['structured'] = { type: null, itemCount: 0 }
  if (taskItemCount > 0) {
    modes.push('TASK_ITEMS')
    structured = { type: 'TASK_ITEMS', itemCount: taskItemCount }
  } else if (checklistCount > 0) {
    modes.push('CHECKLIST')
    structured = { type: 'CHECKLIST', itemCount: checklistCount }
  } else if (parameterCount > 0) {
    modes.push('PARAMETER')
    structured = { type: 'PARAMETER', itemCount: parameterCount }
  }

  if (taskType === 'TRAINING' || materialCount > 0) {
    modes.push('LEARNING')
  }
  if (input.quizBankId) modes.push('QUIZ')

  const attachmentRequired = FILE_REQUIRED_TASK_TYPES.has(taskType)
  const quizRequired = !!input.quizBankId
  const hintParts: string[] = []
  if (structured.type === 'TASK_ITEMS') hintParts.push(`逐项完成 ${structured.itemCount} 个任务填写项`)
  if (structured.type === 'CHECKLIST') hintParts.push(`填写 ${structured.itemCount} 个检查项`)
  if (structured.type === 'PARAMETER') hintParts.push(`填写 ${structured.itemCount} 个参数实测值`)
  if (taskType === 'TRAINING' || materialCount > 0) hintParts.push(materialCount > 0 ? `阅读 ${materialCount} 份学习材料并确认` : '填写学习确认')
  if (quizRequired) hintParts.push('通过题库考核')
  hintParts.push(attachmentRequired ? '上传必需附件' : '可上传补充附件')
  hintParts.push('填写提交说明')

  return {
    version: 'T12_SUBMIT_FORM_V1',
    modes: uniqueModes(modes),
    text: {
      required: true,
      label: taskType === 'TRAINING' ? '确认说明' : '提交说明',
      minLength: taskType === 'RECTIFICATION' ? 20 : 1,
      maxLength: 5000,
    },
    attachment: {
      required: attachmentRequired,
      minCount: attachmentRequired ? 1 : 0,
      maxCount: 20,
      accept: attachmentAccept(taskType),
      reason: attachmentRequired ? '该任务类型要求员工提交材料附件作为完成凭证' : null,
    },
    structured,
    learning: {
      materialCount,
      requiresConfirmation: taskType === 'TRAINING' || materialCount > 0,
    },
    quiz: {
      required: quizRequired,
      quizBankId: input.quizBankId ?? null,
    },
    employeeHint: hintParts.join('，'),
  }
}

function mergeSubmitFormConfig(
  rawConfig: Partial<SubmitFormConfig> | undefined,
  fallback: SubmitFormConfig,
): SubmitFormConfig {
  if (!rawConfig) return fallback
  const legacyMode = (rawConfig as { mode?: SubmitFormMode }).mode
  const modes = Array.isArray(rawConfig.modes) && rawConfig.modes.length
    ? rawConfig.modes
    : legacyMode
      ? uniqueModes([...fallback.modes, legacyMode])
      : fallback.modes
  const attachmentAccept = Array.isArray(rawConfig.attachment?.accept)
    ? rawConfig.attachment.accept
    : fallback.attachment.accept

  return {
    ...fallback,
    ...rawConfig,
    version: 'T12_SUBMIT_FORM_V1',
    modes: uniqueModes(modes),
    text: {
      ...fallback.text,
      ...rawConfig.text,
    },
    attachment: {
      ...fallback.attachment,
      ...rawConfig.attachment,
      accept: attachmentAccept,
    },
    structured: {
      ...fallback.structured,
      ...rawConfig.structured,
    },
    learning: {
      ...fallback.learning,
      ...rawConfig.learning,
    },
    quiz: {
      ...fallback.quiz,
      ...rawConfig.quiz,
    },
    employeeHint: rawConfig.employeeHint || fallback.employeeHint,
  }
}

const DRAFT_EDITABLE_FIELDS = new Set<TaskFieldKey>([
  'title',
  'taskType',
  'source',
  'generatedContent',
  'assignees',
  'reviewer',
  'deadline',
  'submitForm',
  'submitRequirement',
])

export function isTaskEditable(status?: string | null) {
  return !status || status === 'DRAFT'
}

export function getTaskFieldEditPolicy(status?: string | null): Record<TaskFieldKey, { editable: boolean; reason: string }> {
  const editableSet = DRAFT_EDITABLE_FIELDS
  return TASK_FIELD_MODEL.reduce<Record<TaskFieldKey, { editable: boolean; reason: string }>>((acc, field) => {
    const editable = isTaskEditable(status) && editableSet.has(field.key)
    let reason = editable ? '可编辑' : '只读'
    if (status && !isTaskEditable(status)) reason = `当前状态 ${status} 不可编辑`
    if (status === 'PUBLISHED') reason = '已下发任务不可编辑，避免破坏员工执行记录'
    if (field.key === 'submitForm') reason = editable ? '可配置员工提交内容' : '已发布后锁定提交格式，避免破坏员工执行记录'
    if (field.key === 'materials') reason = '来自标准依据与提交形式，不单独写任务字段'
    if (field.key === 'status' || field.key === 'lifecycle') reason = '系统留痕，只读'
    acc[field.key] = { editable, reason }
    return acc
  }, {} as Record<TaskFieldKey, { editable: boolean; reason: string }>)
}

export function submitConfigForTask(task: SeTask | null | undefined): SubmitFormConfig {
  const fallback = buildSubmitFormConfigPreview({
    taskType: task?.taskType,
    checklistSchema: task?.checklistSchema,
    parametersSchema: task?.parametersSchema,
    learningMaterials: task?.learningMaterials,
    quizBankId: task?.quizBankId,
    taskItemCount: Array.isArray((task as SeTask & { taskItems?: unknown[] } | null | undefined)?.taskItems)
      ? ((task as SeTask & { taskItems?: unknown[] }).taskItems?.length ?? 0)
      : 0,
  })
  return mergeSubmitFormConfig(task?.submitFormConfig, fallback)
}
