/**
 * standard-execution 类型定义（仅 Source 切片；其他切片在后续 PR 追加）
 *
 * @see 必读/02_技术架构.md §四 SE 模块核心模型 + §七 状态机
 */
import { z } from 'zod'
import {
  SOURCE_TYPE,
  SOURCE_STATUS,
  REQUIREMENT_STATUS,
  GENERATE_MODE,
  PARSE_MODE,
  TASK_STATUS,
  ASSIGNEE_STATUS,
  TASK_DEADLINE_MODE,
  PLAN_FREQUENCY,
  PACKAGE_FORMAT,
} from './enums.js'

// ─── Source: 请求体 ────────────────────────────────────

export const SourceCreateSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  sourceType: z.enum(SOURCE_TYPE),
  sourceNo: z.string().trim().max(100).optional().nullable(),
  version: z.string().trim().max(50).optional().nullable(),
  rawText: z.string().max(500_000).optional().nullable(),
  fileUrl: z.string().trim().max(500).optional().nullable(),
})
export type SourceCreateInput = z.infer<typeof SourceCreateSchema>

export const SourceUpdateSchema = SourceCreateSchema.partial()
export type SourceUpdateInput = z.infer<typeof SourceUpdateSchema>

// 列表 status 过滤：支持单值或逗号分隔多值（向后兼容）。
// 'DRAFT' → 单值；'DRAFT,ACTIVE' → ['DRAFT','ACTIVE']（route 层转 { in: [...] }）。保留 enum 校验。
const statusFilterSchema = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.includes(',') ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.union([z.enum(values), z.array(z.enum(values))]),
  )

export const SourceListQuerySchema = z.object({
  sourceType: z.enum(SOURCE_TYPE).optional(),
  status: statusFilterSchema(SOURCE_STATUS).optional(),
  keyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type SourceListQuery = z.infer<typeof SourceListQuerySchema>

// ─── Requirement: 请求体 ──────────────────────────────

export const RequirementCreateSchema = z.object({
  sourceId: z.string().trim().min(1, 'sourceId 不能为空'),
  clauseNo: z.string().trim().max(50).optional().nullable(),
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  requirementText: z.string().trim().min(1, 'requirementText 不能为空').max(10_000),
  applicableDeptIds: z.array(z.string()).max(50).optional().nullable(),
  archiveTags: z.array(z.string()).max(50).optional().nullable(),
  recommendedTaskType: z.string().trim().max(80).optional().nullable(),
  executionDescription: z.string().trim().max(2000).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  requiredMaterials: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
  // generateMode 在 create 端点透传可选；默认 'MANUAL'（auto-generate 接口走 RULE/AI/AI_STUB）
  generateMode: z.enum(GENERATE_MODE).optional(),
  // E3 人工确认入库可显式创建 DRAFT；缺省保持既有 REVIEW_PENDING 行为。
  status: z.enum(['DRAFT', 'REVIEW_PENDING']).optional(),
})
export type RequirementCreateInput = z.infer<typeof RequirementCreateSchema>

// PATCH 编辑：仅业务字段可改；sourceId / generateMode 不可改
export const RequirementUpdateSchema = RequirementCreateSchema
  .omit({ sourceId: true, generateMode: true, status: true })
  .partial()
export type RequirementUpdateInput = z.infer<typeof RequirementUpdateSchema>

// ─── 自动解析（auto-generate）─────────────────────────

export const AutoGenerateSchema = z.object({
  sourceId: z.string().trim().min(1, 'sourceId 不能为空'),
  parseMode: z.enum(PARSE_MODE),
  dryRun: z.boolean().optional().default(false),
})
export type AutoGenerateInput = z.infer<typeof AutoGenerateSchema>

/** 解析输出的草稿要求项（写库前形态） */
export interface RequirementDraft {
  clauseNo: string | null
  title: string
  requirementText: string
  // P0-5: AI 解析生成的可执行字段（预览展示；RULE 模式不填）
  executionDescription?: string | null
  recommendedTaskType?: string | null
  suggestedDepartment?: string | null
  suggestedFrequency?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
}

export interface CandidateRequirement {
  clauseNo: string | null
  sourceText: string
  action: string
  responsibleRole: string | null
  evidenceType: string | null
  frequency: string | null
  riskLevel: string | null
  suggestedTaskType: string | null
  score: number
  mergeable: boolean
  mergeReason: string | null
}

export interface CandidateScoreDistribution {
  total: number
  belowTaskThreshold: number
  associatedOnly: number
  taskEligible: number
  buckets: {
    lt60: number
    s60to74: number
    gte75: number
  }
}

export const RequirementListQuerySchema = z.object({
  sourceId: z.string().trim().optional(),
  status: statusFilterSchema(REQUIREMENT_STATUS).optional(),
  generateMode: z.enum(GENERATE_MODE).optional(),
  keyword: z.string().trim().max(100).optional(),
  sourceKeyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type RequirementListQuery = z.infer<typeof RequirementListQuerySchema>

// ─── Task: 请求体 ─────────────────────────────────────

const AssigneeIdsSchema = z
  .array(z.string().trim().min(1))
  .min(1, 'assigneeIds 至少需要 1 个执行人')
  .max(200, 'assigneeIds 最多 200 个')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'assigneeIds 含重复用户',
  })
const OptionalAssigneeIdsSchema = z
  .array(z.string().trim().min(1))
  .max(200, 'assigneeIds 最多 200 个')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'assigneeIds 含重复用户',
  })
  .optional()
  .default([])
const OptionalCardIdsSchema = z
  .array(z.string().trim().min(1))
  .min(1, 'cardIds 不能为空')
  .max(500, 'cardIds 最多 500 个')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'cardIds 含重复任务卡',
  })
  .optional()

export const TASK_TYPES = [
  'TRAINING',
  'QUALIFICATION_MATERIAL',
  'ONBOARDING_ACCESS',
  'INSPECTION_FILL',
  'RECTIFICATION',
  'ARCHIVE_MATERIAL',
  // Legacy / advanced task templates kept for existing data and admin imports.
  'DOCUMENT_UPLOAD',
  'PHOTO',
  'PARAMETER',
  'OTHER',
] as const

export interface TaskGenerationTaskPackage {
  packageId: string
  groupId: string
  key: {
    taskType: typeof TASK_TYPES[number]
    responsibleRole: string | null
    evidenceType: string | null
  }
  title: string
  description: string
  submitRequirement: string
  taskType: typeof TASK_TYPES[number]
  responsibleRole: string | null
  evidenceType: string | null
  frequency: string | null
  riskLevel: string | null
  score: number
  candidateCount: number
  candidateIndexes: number[]
  clauseNos: string[]
  draftIds: string[]
  requiredMaterials: string[]
  mergeMode: 'DETERMINISTIC' | 'LLM_MERGED' | 'LLM_FALLBACK'
  warnings: string[]
}

export interface TaskGenerationCoverageEntry {
  candidateIndex: number
  clauseNo: string | null
  sourceText: string
  score: number
  destination: 'TASK_PACKAGE' | 'ASSOCIATED_CANDIDATE' | 'LOW_SCORE_CANDIDATE' | 'OVERFLOW_CANDIDATE'
  packageId: string | null
  reason: string
}

export interface TaskGenerationCoverageReport {
  totalCandidates: number
  taskPackageCount: number
  candidateOnlyCount: number
  entries: TaskGenerationCoverageEntry[]
}

export const ChecklistItemSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  judgeType: z.enum(['TEXT', 'BOOL', 'NUMBER_RANGE']),
  min: z.number().optional().nullable(),
  max: z.number().optional().nullable(),
  unit: z.string().trim().max(20).optional().nullable(),
  // T12/F11 POC: no-schema per requirement submit config carried by checklist JSON.
  requirementId: z.string().trim().min(1).optional().nullable(),
  requirementTitle: z.string().trim().max(200).optional().nullable(),
  requirementDescription: z.string().trim().max(2000).optional().nullable(),
  clauseNo: z.string().trim().max(50).optional().nullable(),
  sourceTitle: z.string().trim().max(200).optional().nullable(),
  required: z.boolean().optional(),
  sort: z.number().int().min(1).max(500).optional(),
  submitOptions: z.array(z.enum(['TEXT', 'IMAGE', 'FILE', 'STRUCTURED', 'QUIZ', 'LEARNING'])).max(10).optional(),
  submitModes: z.array(z.enum(['TEXT', 'ATTACHMENT', 'TASK_ITEMS', 'CHECKLIST', 'PARAMETER', 'LEARNING', 'QUIZ'])).max(10).optional(),
  textPrompt: z.string().trim().max(1000).optional().nullable(),
  attachmentRequired: z.boolean().optional(),
  attachmentMinCount: z.number().int().min(0).max(50).optional(),
  attachmentMaxCount: z.number().int().min(0).max(50).optional(),
  attachmentAccept: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  attachmentHint: z.string().trim().max(500).optional().nullable(),
  structuredFields: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(200),
    fieldType: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT']).default('TEXT'),
    required: z.boolean().optional(),
    validation: z.string().trim().max(200).optional().nullable(),
  })).max(50).optional(),
  quizBankId: z.string().trim().min(1).optional().nullable(),
  quizQuestionCount: z.number().int().min(1).max(200).optional().nullable(),
  quizPassScore: z.number().int().min(0).max(100).optional().nullable(),
  learningMaterials: z.array(z.object({
    type: z.enum(['file', 'link']),
    url: z.string().trim().max(1000).optional().nullable(),
    name: z.string().trim().min(1).max(200),
  })).max(50).optional(),
})
export const ChecklistSchema = z.object({
  items: z.array(ChecklistItemSchema).max(100),
})

export const ParameterItemSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(200),
  standard: z.string().trim().max(200),
  unit: z.string().trim().max(20).optional().nullable(),
  method: z.string().trim().max(200).optional().nullable(),
})
export const ParametersSchemaZ = z.object({
  items: z.array(ParameterItemSchema).max(100),
})

export const LearningMaterialItemSchema = z.object({
  type: z.enum(['file', 'link']),
  url: z.string().trim().min(1).max(1000),
  name: z.string().trim().min(1).max(200),
})
export const LearningMaterialsSchema = z.object({
  items: z.array(LearningMaterialItemSchema).max(50),
})

export const TaskCreateSchema = z.object({
  requirementId: z.string().trim().min(1, 'requirementId 不能为空').optional().nullable(),
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  taskType: z.enum(TASK_TYPES).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  deadlineAt: z.coerce.date().optional().nullable(),
  deadlineMode: z.enum(TASK_DEADLINE_MODE).default('FIXED'),
  deadlineDaysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
  reviewerId: z.string().trim().min(1, 'reviewerId 不能为空').optional().nullable(),
  assigneeIds: OptionalAssigneeIdsSchema,
  checklistSchema: ChecklistSchema.optional().nullable(),
  parametersSchema: ParametersSchemaZ.optional().nullable(),
  learningMaterials: LearningMaterialsSchema.optional().nullable(),
  quizBankId: z.string().trim().min(1).optional().nullable(),
})
export type TaskCreateInput = z.infer<typeof TaskCreateSchema>

export const BatchCreateTasksFromRequirementsSchema = TaskCreateSchema
  .omit({ requirementId: true, title: true, description: true, checklistSchema: true, parametersSchema: true, learningMaterials: true })
  .extend({
    requirementIds: z
    .array(z.string().trim().min(1))
    .min(1, '至少选择 1 个执行要求')
      .max(100, '一次最多生成 100 个任务')
      .refine((arr) => new Set(arr).size === arr.length, {
        message: 'requirementIds 含重复执行要求',
      }),
    titlePrefix: z.string().trim().max(80).optional().nullable(),
  })
export type BatchCreateTasksFromRequirementsInput = z.infer<typeof BatchCreateTasksFromRequirementsSchema>

// ─── Task Generation Workbench（3C-lite）────────────────

export const TaskGenerationPreviewSchema = z
  .object({
    sourceId: z.string().trim().min(1).optional(),
    rawText: z.string().max(500_000).optional(),
    parseMode: z.enum(PARSE_MODE).default('OCR_AI'),
    polish: z.union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        target: z.literal('TASK_CARD_V2').optional(),
      }),
    ]).optional(),
  })
  .refine((data) => !!data.sourceId || !!data.rawText?.trim(), {
    message: 'sourceId 或 rawText 必填',
  })
export type TaskGenerationPreviewInput = z.infer<typeof TaskGenerationPreviewSchema>

export const TaskGenerationTaskDraftSchema = z.object({
  taskDraftId: z.string().trim().min(1).optional(),
  groupId: z.string().trim().min(1).optional().nullable(),
  title: z.string().trim().min(1).max(200).optional().nullable(),
  description: z.string().trim().max(2000).optional().nullable(),
  taskType: z.enum(TASK_TYPES).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
})

export const TaskGenerationDeadlineSuggestionSchema = z.object({
  mode: z.enum(TASK_DEADLINE_MODE),
  daysAfterApproval: z.number().int().positive().max(365).nullable().default(null),
  fixedAt: z.string().datetime().nullable().default(null),
  label: z.string().trim().min(1).max(100),
  reason: z.string().trim().max(300).nullable().default(null),
})

export const TaskGenerationTaskCardSchema = z.object({
  id: z.string().trim().min(1),
  draftId: z.string().trim().min(1),
  taskDraftId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  submitRequirement: z.string().trim().min(1).max(1000),
  taskType: z.enum(TASK_TYPES),
  requiredMaterials: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  deadlineSuggestion: TaskGenerationDeadlineSuggestionSchema,
  basis: z.object({
    sourceId: z.string().trim().min(1).nullable().default(null),
    sourceTitle: z.string().trim().min(1).nullable().default(null),
    clauseNo: z.string().trim().max(50).nullable().default(null),
    excerpt: z.string().trim().min(1).max(600),
  }),
  polishStatus: z.enum(['AI_POLISHED', 'FALLBACK_ORIGINAL']),
  warnings: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
}, { required_error: 'card 必填' })
export type TaskGenerationTaskCardInput = z.infer<typeof TaskGenerationTaskCardSchema>

export const TaskGenerationDraftSchema = z.object({
  draftId: z.string().trim().min(1).optional(),
  splitFromId: z.string().trim().min(1).optional().nullable(),
  groupId: z.string().trim().min(1).optional().nullable(),
  clauseNo: z.string().trim().max(50).optional().nullable(),
  title: z.string().trim().min(1).max(200),
  requirementText: z.string().trim().min(1).max(10_000),
  recommendedTaskType: z.enum(TASK_TYPES).optional().nullable(),
  executionDescription: z.string().trim().max(2000).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  requiredMaterials: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
  taskDrafts: z.array(TaskGenerationTaskDraftSchema).min(1).max(20).optional(),
})

export const TaskGenerationCardRewriteSchema = z.object({
  sourceId: z.string().trim().min(1).optional(),
  rawText: z.string().max(500_000).optional(),
  card: TaskGenerationTaskCardSchema,
  draft: TaskGenerationDraftSchema.optional().nullable(),
  instruction: z.string().trim().max(1000).optional().nullable(),
  surroundingCards: z.array(TaskGenerationTaskCardSchema).max(6).optional(),
})
export type TaskGenerationCardRewriteInput = z.infer<typeof TaskGenerationCardRewriteSchema>

export const TaskGenerationCardsRepolishSchema = z.object({
  sourceId: z.string().trim().min(1).optional(),
  rawText: z.string().max(500_000).optional(),
  cards: z.array(TaskGenerationTaskCardSchema).min(1, 'cards 数量必须在 1..24').max(24, 'cards 数量必须在 1..24'),
  drafts: z.array(TaskGenerationDraftSchema).max(100).optional(),
  instruction: z.string().trim().max(1000).optional().nullable(),
})
export type TaskGenerationCardsRepolishInput = z.infer<typeof TaskGenerationCardsRepolishSchema>

export const TaskGenerationReExtractSchema = z
  .object({
    sourceId: z.string().trim().min(1).optional(),
    rawText: z.string().max(500_000).optional(),
    parseMode: z.enum(PARSE_MODE).default('OCR_AI'),
    polish: z.union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        target: z.literal('TASK_CARD_V2').optional(),
      }),
    ]).optional(),
    instruction: z.string().trim().max(1000).optional().nullable(),
    previousCardCount: z.number().int().nonnegative().max(500).optional().nullable(),
  })
  .refine((data) => !!data.sourceId || !!data.rawText?.trim(), {
    message: 'sourceId 或 rawText 必填',
  })
export type TaskGenerationReExtractInput = z.infer<typeof TaskGenerationReExtractSchema>

export const TaskGenerationCommitSchema = z.object({
  sourceId: z.string().trim().min(1, 'sourceId 不能为空'),
  parseMode: z.enum(PARSE_MODE).default('OCR_AI'),
  taskStatus: z.enum(['DRAFT', 'PENDING_APPROVAL']).default('DRAFT'),
  titlePrefix: z.string().trim().max(80).optional().nullable(),
  taskType: z.enum(TASK_TYPES).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  deadlineAt: z.coerce.date().optional().nullable(),
  deadlineMode: z.enum(TASK_DEADLINE_MODE).default('FIXED'),
  deadlineDaysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
  reviewerId: z.string().trim().min(1, 'reviewerId 不能为空').optional().nullable(),
  assigneeIds: OptionalAssigneeIdsSchema,
  cardIds: OptionalCardIdsSchema,
  drafts: z.array(TaskGenerationDraftSchema).min(1, '草稿不能为空').max(100, '一次最多提交 100 条草稿'),
})
export type TaskGenerationCommitInput = z.infer<typeof TaskGenerationCommitSchema>

/** create-task 便捷端点：requirementId 来自路径，不接受 body 里覆盖 */
export const TaskCreateViaRequirementSchema = TaskCreateSchema.omit({ requirementId: true })
export type TaskCreateViaRequirementInput = z.infer<typeof TaskCreateViaRequirementSchema>

// PATCH 编辑：仅 DRAFT 任务；requirementId 不可改
export const TaskUpdateSchema = TaskCreateSchema
  .omit({ requirementId: true })
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: '没有可更新字段' })
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>

// ─── 员工小程序：我的任务 ──────────────────────────────

export const MP_TASK_TAB = ['todo', 'review', 'done', 'closed'] as const
export type MpTaskTab = (typeof MP_TASK_TAB)[number]

export const MpTaskListQuerySchema = z.object({
  tab: z.enum(MP_TASK_TAB).default('todo'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type MpTaskListQuery = z.infer<typeof MpTaskListQuerySchema>

export const MpRecordListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type MpRecordListQuery = z.infer<typeof MpRecordListQuerySchema>

// ─── 员工小程序：提交 ─────────────────────────────────

export const MpSubmitAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileUrl: z.string().trim().min(1).max(500),
  fileSize: z.number().int().nonnegative().optional().nullable(),
  mimeType: z.string().trim().max(100).optional().nullable(),
})
export type MpSubmitAttachment = z.infer<typeof MpSubmitAttachmentSchema>

// ─── 审核（admin / reviewer）──────────────────────────

import { SUBMISSION_STATUS, RECORD_STATUS, PACKAGE_SCENE, PLAN_STATUS } from './enums.js'

export const REVIEW_STATUS_FILTER = [...SUBMISSION_STATUS, 'all'] as const
export type ReviewStatusFilter = (typeof REVIEW_STATUS_FILTER)[number]

export const ReviewListQuerySchema = z.object({
  status: statusFilterSchema(REVIEW_STATUS_FILTER).optional(), // 默认 SUBMITTED；'all'=不过滤；逗号分隔=多值
  scope: z.enum(['all', 'mine']).default('all'), // mine = task.reviewerId=me
  taskId: z.string().trim().optional(),
  keyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>

export const ReviewApproveSchema = z.object({
  reviewComment: z.string().trim().max(2000).optional().nullable(),
  recordTitle: z.string().trim().max(200).optional().nullable(),
  recordSummary: z.string().trim().max(2000).optional().nullable(),
})
export type ReviewApproveInput = z.infer<typeof ReviewApproveSchema>

export const ReviewRejectSchema = z.object({
  reviewComment: z.string().trim().min(1, 'reviewComment 不能为空').max(2000),
})
export type ReviewRejectInput = z.infer<typeof ReviewRejectSchema>

export const MpSubmitSchema = z.object({
  submitText: z.string().trim().min(1, 'submitText 不能为空').max(5000),
  attachments: z
    .array(MpSubmitAttachmentSchema)
    .min(1, '至少需要 1 个附件')
    .max(20, '附件最多 20 个'),
  submitDataJson: z.record(z.unknown()).optional(),
})
export type MpSubmitInput = z.infer<typeof MpSubmitSchema>

export const TaskListQuerySchema = z.object({
  requirementId: z.string().trim().optional(),
  status: statusFilterSchema(TASK_STATUS).optional(),
  origin: z.enum(['PLAN', 'MANUAL']).optional(),
  reviewerId: z.string().trim().optional(),
  assigneeId: z.string().trim().optional(), // 通过 assignees 关联筛
  keyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>

const boolQuerySchema = z.preprocess((v) => {
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}, z.boolean())

export const TASK_LIST_V2_MANAGEMENT_TAB = ['all', 'draft', 'todo', 'executing', 'ended', 'plan', 'requirement', 'mine', 'closed'] as const
export type TaskListV2ManagementTab = (typeof TASK_LIST_V2_MANAGEMENT_TAB)[number]

export const TASK_LIST_V2_DEADLINE_FILTER = ['overdue', 'dueSoon', 'none'] as const
export type TaskListV2DeadlineFilter = (typeof TASK_LIST_V2_DEADLINE_FILTER)[number]

export const TASK_LIST_V2_STATUS_FILTER = [...TASK_STATUS, 'PENDING_REVIEW', 'EXECUTING', 'CLOSED'] as const
export type TaskListV2StatusFilter = (typeof TASK_LIST_V2_STATUS_FILTER)[number]

export const TaskListV2QuerySchema = z.object({
  tab: z.enum(TASK_LIST_V2_MANAGEMENT_TAB).default('all'),
  status: statusFilterSchema(TASK_LIST_V2_STATUS_FILTER).optional(),
  assigneeStatus: statusFilterSchema(ASSIGNEE_STATUS).optional(),
  origin: z.enum(['PLAN', 'MANUAL']).optional(),
  keyword: z.string().trim().max(100).optional(),
  sourceId: z.string().trim().optional(),
  requirementId: z.string().trim().optional(),
  planId: z.string().trim().optional(),
  reviewerId: z.string().trim().optional(),
  assigneeId: z.string().trim().optional(),
  mine: boolQuerySchema.default(false),
  deadline: z.enum(TASK_LIST_V2_DEADLINE_FILTER).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
  includeCounts: boolQuerySchema.default(false),
})
export type TaskListV2Query = z.infer<typeof TaskListV2QuerySchema>

export const MyTaskListV2QuerySchema = z.object({
  tab: z.enum(MP_TASK_TAB).default('todo'),
  keyword: z.string().trim().max(100).optional(),
  deadline: z.enum(TASK_LIST_V2_DEADLINE_FILTER).optional(),
  taskType: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
  includeCounts: boolQuerySchema.default(false),
})
export type MyTaskListV2Query = z.infer<typeof MyTaskListV2QuerySchema>

// ─── 证据库（admin）───────────────────────────────

export const RecordListQuerySchema = z.object({
  status: z.enum(RECORD_STATUS).optional(),
  sourceId: z.string().trim().optional(),
  requirementId: z.string().trim().optional(),
  taskId: z.string().trim().optional(),
  assigneeId: z.string().trim().optional(),
  departmentId: z.string().trim().optional(),
  keyword: z.string().trim().max(100).optional(), // title + summary
  recordDateFrom: z.coerce.date().optional(),
  recordDateTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type RecordListQuery = z.infer<typeof RecordListQuerySchema>

export const RecordVoidSchema = z.object({
  voidReason: z.string().trim().max(500).optional().nullable(),
})
export type RecordVoidInput = z.infer<typeof RecordVoidSchema>

// ─── 审计包（admin）───────────────────────────────────

const RecordIdsSchema = z
  .array(z.string().trim().min(1))
  .max(500, 'recordIds 最多 500 条')
  .refine((arr) => new Set(arr).size === arr.length, {
    message: 'recordIds 含重复记录',
  })
const SelectionIdsSchema = (fieldName: string) =>
  z
    .array(z.string().trim().min(1))
    .max(500, `${fieldName} 最多 500 条`)
    .refine((arr) => new Set(arr).size === arr.length, {
      message: `${fieldName} 含重复记录`,
    })

export const PackageCreateSchema = z.object({
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  packageScene: z.enum(PACKAGE_SCENE),
  templateKey: z.enum(['CUSTOMER_AUDIT', 'CERTIFICATION_PREP', 'ANNUAL_ARCHIVE', 'CUSTOM']).optional(),
  description: z.string().trim().max(2000).optional().nullable(),
  format: z.enum(PACKAGE_FORMAT).optional().default('FOLDER'),
  recordIds: RecordIdsSchema.optional(),
  // Backward compatible only. New UI must select tasks / records, not execution requirements.
  requirementIds: SelectionIdsSchema('requirementIds').optional(),
  taskIds: SelectionIdsSchema('taskIds').optional(),
  sourceIds: SelectionIdsSchema('sourceIds').optional(),
  departmentIds: SelectionIdsSchema('departmentIds').optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  planId: z.string().trim().min(1).optional().nullable(),
}).superRefine((data, ctx) => {
  const hasRecordIds = (data.recordIds?.length ?? 0) > 0
  const hasRequirementIds = (data.requirementIds?.length ?? 0) > 0
  const hasTaskIds = (data.taskIds?.length ?? 0) > 0
  const hasSourceIds = (data.sourceIds?.length ?? 0) > 0
  const hasDepartmentIds = (data.departmentIds?.length ?? 0) > 0
  const hasDateRange = !!data.dateFrom || !!data.dateTo
  const hasPlanId = !!data.planId
  if (!hasRecordIds && !hasRequirementIds && !hasTaskIds && !hasSourceIds && !hasDepartmentIds && !hasDateRange && !hasPlanId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'recordIds / requirementIds / taskIds / sourceIds / departmentIds / date range / planId 至少提供一项',
      path: ['recordIds'],
    })
  }
  if (data.dateFrom && data.dateTo && data.dateFrom.getTime() > data.dateTo.getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'dateFrom 不得晚于 dateTo',
      path: ['dateFrom'],
    })
  }
})
export type PackageCreateInput = z.infer<typeof PackageCreateSchema>

export const PackageGenerationOptionsSchema = z.object({
  includeManifest: z.boolean().optional().default(false),
  includeAuditTrace: z.boolean().optional().default(false),
  includeBasisClauses: z.boolean().optional().default(false),
  includeStatisticsSummary: z.boolean().optional().default(false),
})
export type PackageGenerationOptionsInput = z.infer<typeof PackageGenerationOptionsSchema>

export const PackageGenerateSchema = z.object({
  // Legacy callers may still pass format, but V1+V2 now always generates a multi-file folder.
  format: z.enum(PACKAGE_FORMAT).optional(),
}).merge(PackageGenerationOptionsSchema)
export type PackageGenerateInput = z.infer<typeof PackageGenerateSchema>

export const PackageAsyncGenerateSchema = PackageGenerateSchema.extend({
  previewConfirmed: z.literal(true, {
    errorMap: () => ({ message: '生成前必须完成并确认预览' }),
  }),
})
export type PackageAsyncGenerateInput = z.infer<typeof PackageAsyncGenerateSchema>

export const PackagePreviewSchema = z.object({
  format: z.enum(PACKAGE_FORMAT).optional(),
}).merge(PackageGenerationOptionsSchema)
export type PackagePreviewInput = z.infer<typeof PackagePreviewSchema>

export const PackageListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'READY', 'VOID']).optional(),
  packageScene: z.enum(PACKAGE_SCENE).optional(),
  keyword: z.string().trim().max(100).optional(), // title
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type PackageListQuery = z.infer<typeof PackageListQuerySchema>

// ─── 合规周期（Plan）请求体（Step 1 架构升级）─────────

export const PlanCreateSchema = z.object({
  sourceId: z.string().trim().min(1, 'sourceId 不能为空'),
  title: z.string().trim().min(1, 'title 不能为空').max(200),
  roundNumber: z.number().int().positive().optional(),
  scheduledAt: z.string().datetime().optional(),
  frequency: z.enum(PLAN_FREQUENCY).optional().nullable(),
  startAt: z.string().datetime().optional().nullable(),
  endAt: z.string().datetime().optional().nullable(),
  nextRunAt: z.string().datetime().optional().nullable(),
  defaultReviewerId: z.string().trim().min(1).optional().nullable(),
  defaultAssigneeIds: OptionalAssigneeIdsSchema,
  defaultTaskType: z.enum(TASK_TYPES).optional().nullable(),
  defaultDeadlineMode: z.enum(TASK_DEADLINE_MODE).default('AFTER_APPROVAL_DAYS'),
  defaultDeadlineDaysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
})
export type PlanCreateInput = z.infer<typeof PlanCreateSchema>

export const PlanListQuerySchema = z.object({
  sourceId: z.string().trim().optional(),
  status: z.enum(PLAN_STATUS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
})
export type PlanListQuery = z.infer<typeof PlanListQuerySchema>

export const PlanUpdateSchema = z
  .object({
    title: z.string().trim().min(1, 'title 不能为空').max(200).optional(),
    status: z.enum(PLAN_STATUS).optional(),
    roundNumber: z.number().int().positive().optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    frequency: z.enum(PLAN_FREQUENCY).nullable().optional(),
    startAt: z.string().datetime().nullable().optional(),
    endAt: z.string().datetime().nullable().optional(),
    nextRunAt: z.string().datetime().nullable().optional(),
    defaultReviewerId: z.string().trim().min(1).nullable().optional(),
    defaultAssigneeIds: OptionalAssigneeIdsSchema,
    defaultTaskType: z.enum(TASK_TYPES).nullable().optional(),
    defaultDeadlineMode: z.enum(TASK_DEADLINE_MODE).optional(),
    defaultDeadlineDaysAfterApproval: z.number().int().positive().max(365).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: '至少需要一个可更新字段' })
export type PlanUpdateInput = z.infer<typeof PlanUpdateSchema>

export const PlanBindTasksSchema = z.object({
  taskIds: z
    .array(z.string().trim().min(1))
    .min(1, 'taskIds 至少需要 1 项'),
})
export type PlanBindTasksInput = z.infer<typeof PlanBindTasksSchema>

// ─── 批量软删 / 作废通用入参 ──────────────────────────
// 各实体「批量删除」= 置成已有的语义化终态（DISABLED/ARCHIVED/CANCELLED/VOID），
// 不新增 deletedAt。端点统一用 updateMany + where status in [可转换态]，
// 天然跳过不存在 / 越权（enterpriseId 不符）/ 已是终态的项，返回 { ok, requested, skipped }。
export const BatchIdsSchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, 'ids 至少需要 1 项')
    .max(500, '一次最多处理 500 项')
    .refine((arr) => new Set(arr).size === arr.length, { message: 'ids 含重复项' }),
})
export type BatchIdsInput = z.infer<typeof BatchIdsSchema>

// 批量指派：给多个 DRAFT 任务统一设置审核人 + 执行人（复用 AssigneeIdsSchema 去重/上限规则）
export const BatchAssignSchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, 'ids 至少需要 1 项')
    .max(200, '一次最多指派 200 个任务')
    .refine((arr) => new Set(arr).size === arr.length, { message: 'ids 含重复项' }),
  reviewerId: z.string().trim().min(1, 'reviewerId 不能为空'),
  assigneeIds: AssigneeIdsSchema,
})
export type BatchAssignInput = z.infer<typeof BatchAssignSchema>

export const TaskApprovalCommentSchema = z.object({
  comment: z.string().trim().max(1000).optional().nullable(),
})
export type TaskApprovalCommentInput = z.infer<typeof TaskApprovalCommentSchema>

// ─── Plan generate-tasks（Step B 接口 1）────────────────────
// 按 recommendedTaskType 自动分组；显式 taskType 则统一覆盖成一个任务组。
export const PlanGenerateTasksSchema = z.object({
  requirementIds: z
    .array(z.string().trim().min(1))
    .min(1, '至少需要 1 个执行要求')
    .max(200, '一次最多 200 个执行要求')
    .refine((arr) => new Set(arr).size === arr.length, { message: 'requirementIds 含重复项' }),
  taskType: z.string().trim().min(1, 'taskType 不能为空').max(100).optional().nullable(),
  reviewerId: z.string().trim().min(1, 'reviewerId 不能为空'),
  assigneeIds: AssigneeIdsSchema,
  deadlineAt: z.coerce.date().optional(),
  deadlineMode: z.enum(TASK_DEADLINE_MODE).default('FIXED'),
  deadlineDaysAfterApproval: z.number().int().positive().max(365).optional().nullable(),
  submitRequirement: z.string().trim().max(1000).optional().nullable(),
  titlePrefix: z.string().trim().max(80).optional().nullable(),
  taskStatus: z.enum(['DRAFT', 'PENDING_APPROVAL']).default('DRAFT'),
})
export type PlanGenerateTasksInput = z.infer<typeof PlanGenerateTasksSchema>

// ─── App 端 TaskItem 暂存（Step B 接口 3）────────────────────
export const TaskItemPatchSchema = z.object({
  status: z.enum(['DONE', 'SKIPPED']).optional(),
  note: z.string().trim().max(2000).optional().nullable(),
  fileUrls: z.array(z.string().trim().min(1).max(500)).max(20).optional().nullable(),
})
export type TaskItemPatchInput = z.infer<typeof TaskItemPatchSchema>
