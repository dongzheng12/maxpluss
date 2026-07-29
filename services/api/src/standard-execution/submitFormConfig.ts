export type SubmitFormMode =
  | 'TEXT'
  | 'ATTACHMENT'
  | 'TASK_ITEMS'
  | 'CHECKLIST'
  | 'PARAMETER'
  | 'LEARNING'
  | 'QUIZ'

export interface SubmitFormConfig {
  version: 'T12_SUBMIT_FORM_V1'
  modes: SubmitFormMode[]
  text: {
    required: boolean
    label: string
    minLength: number
    maxLength: number
  }
  attachment: {
    required: boolean
    minCount: number
    maxCount: number
    accept: string[]
    reason: string | null
  }
  structured: {
    type: 'TASK_ITEMS' | 'CHECKLIST' | 'PARAMETER' | null
    itemCount: number
  }
  learning: {
    materialCount: number
    requiresConfirmation: boolean
  }
  quiz: {
    required: boolean
    quizBankId: string | null
  }
  employeeHint: string
}

interface SubmitFormTaskInput {
  taskType?: string | null
  checklistSchema?: unknown
  parametersSchema?: unknown
  learningMaterials?: unknown
  quizBankId?: string | null
}

interface SubmitFormBuildInput extends SubmitFormTaskInput {
  taskItemCount?: number
}

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

export function buildSubmitFormConfig(input: SubmitFormBuildInput): SubmitFormConfig {
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

export function withSubmitFormConfig<T extends SubmitFormTaskInput & { items?: unknown[] }>(
  task: T,
): T & { submitFormConfig: SubmitFormConfig } {
  return {
    ...task,
    submitFormConfig: buildSubmitFormConfig({
      taskType: task.taskType,
      checklistSchema: task.checklistSchema,
      parametersSchema: task.parametersSchema,
      learningMaterials: task.learningMaterials,
      quizBankId: task.quizBankId,
      taskItemCount: Array.isArray(task.items) ? task.items.length : 0,
    }),
  }
}
