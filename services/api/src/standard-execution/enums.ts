/**
 * standard-execution 全模块枚举集中定义
 *
 * 单一来源：所有路由 / 服务 / 测试 / 前端类型同步都从这里取值。
 * 改动时同步前端 apps/web/src/types/standardExecution.ts（一旦创建）和小程序 enums。
 *
 * @see 必读/02_技术架构.md §七 状态机 + §四 SE 模型字段
 */

// ─── 状态机（§五）──────────────────────────────────────

export const REQUIREMENT_STATUS = ['DRAFT', 'REVIEW_PENDING', 'ACTIVE', 'DISABLED', 'ARCHIVED'] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUS)[number]

export const TASK_STATUS = ['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED'] as const
export type TaskStatus = (typeof TASK_STATUS)[number]

export const TASK_DEADLINE_MODE = ['FIXED', 'AFTER_APPROVAL_DAYS'] as const
export type TaskDeadlineMode = (typeof TASK_DEADLINE_MODE)[number]

export const PLAN_FREQUENCY = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const
export type PlanFrequency = (typeof PLAN_FREQUENCY)[number]

export const ASSIGNEE_STATUS = [
  'PENDING',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REJECTED',
  'COMPLETED',
  'OVERDUE',
] as const
export type AssigneeStatus = (typeof ASSIGNEE_STATUS)[number]

export const SUBMISSION_STATUS = ['SUBMITTED', 'APPROVED', 'REJECTED'] as const
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[number]

export const RECORD_STATUS = ['VALID', 'EXPIRED', 'VOID'] as const
export type RecordStatus = (typeof RECORD_STATUS)[number]

export const PACKAGE_STATUS = ['DRAFT', 'READY', 'VOID'] as const
export type PackageStatus = (typeof PACKAGE_STATUS)[number]

export const PACKAGE_FORMAT = ['FOLDER', 'ZIP', 'PDF', 'DOCX'] as const
export type PackageFormat = (typeof PACKAGE_FORMAT)[number]

// ─── 通用状态（§六，Source 等共用 ACTIVE / DISABLED）─────

export const SOURCE_STATUS = ['ACTIVE', 'DISABLED'] as const
export type SourceStatus = (typeof SOURCE_STATUS)[number]

// ─── 类型枚举（§六）────────────────────────────────────

export const SOURCE_TYPE = [
  'PRODUCT_STANDARD',
  'TECH_STANDARD',
  'INTERNAL_POLICY',
  'CHECKLIST',
  'CUSTOM',
] as const
export type SourceType = (typeof SOURCE_TYPE)[number]

export const REQUIREMENT_TYPE = [
  'INSPECTION',
  'PERFORMANCE_TEST',
  'FUNCTIONAL_TEST',
  'DOCUMENTATION',
] as const
export type RequirementType = (typeof REQUIREMENT_TYPE)[number]

export const GENERATE_MODE = ['MANUAL', 'RULE', 'AI_STUB', 'AI'] as const
export type GenerateMode = (typeof GENERATE_MODE)[number]

export const PARSE_MODE = ['OCR_AI', 'RULE', 'AI_STUB'] as const
export type ParseMode = (typeof PARSE_MODE)[number]

export const ATTACHMENT_BIZ_TYPE = ['SOURCE', 'SUBMISSION', 'PACKAGE'] as const
export type AttachmentBizType = (typeof ATTACHMENT_BIZ_TYPE)[number]

export const REVIEW_ACTION = ['APPROVE', 'REJECT'] as const
export type ReviewAction = (typeof REVIEW_ACTION)[number]

export const PACKAGE_SCENE = [
  'CUSTOMER_AUDIT',
  'INTERNAL_CHECK',
  'CERTIFICATION',
  'REGULATORY',
  'TRAINING_ARCHIVE',
  'OTHER',
] as const
export type PackageScene = (typeof PACKAGE_SCENE)[number]

export const RISK_TYPE = [
  'REQUIREMENT_NO_TASK',
  'TASK_OVERDUE',
  'ASSIGNEE_NOT_SUBMITTED',
  'REVIEW_PENDING',
] as const
export type RiskType = (typeof RISK_TYPE)[number]

export const RISK_LEVEL = ['HIGH', 'MEDIUM', 'LOW'] as const
export type RiskLevel = (typeof RISK_LEVEL)[number]

export const RISK_STATUS = ['UNHANDLED', 'HANDLED', 'IGNORED'] as const
export type RiskStatus = (typeof RISK_STATUS)[number]

export const RECORD_CREATED_FROM = ['REVIEW_APPROVE', 'MANUAL'] as const
export type RecordCreatedFrom = (typeof RECORD_CREATED_FROM)[number]

// ─── 合规周期（Plan）状态（Step 1 架构升级）────────────────
export const PLAN_STATUS = ['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const
export type PlanStatus = (typeof PLAN_STATUS)[number]

// ─── 任务明细（TaskItem）状态 ────────────────────────────
export const ITEM_STATUS = ['PENDING', 'DONE', 'SKIPPED'] as const
export type ItemStatus = (typeof ITEM_STATUS)[number]
