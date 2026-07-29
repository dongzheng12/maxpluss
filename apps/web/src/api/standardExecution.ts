/**
 * standard-execution 模块 API client（PC 管理端）
 * 后端接口详见 services/api/src/standard-execution/*.ts
 */
import { nodeApi } from './client'

// ─── 通用类型 ────────────────────────────────────────

export interface ListResp<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

export interface TaskListV2Counts {
  all: number
  draft?: number
  todo: number
  executing: number
  ended: number
  overdue?: number
  plan?: number
  requirement?: number
  mine?: number
  closed?: number
}

export interface TaskListV2Resp<T> extends ListResp<T> {
  counts?: TaskListV2Counts
}

export interface MyTaskListV2Counts {
  todo: number
  review: number
  done: number
  closed: number
}

export interface MyTaskListV2Resp<T> extends ListResp<T> {
  counts?: MyTaskListV2Counts
}

export interface ItemResp<T> {
  data: T
}

const SE_AI_REQUEST_TIMEOUT_MS = 120_000

export interface PackageGenerateResp<T> extends ItemResp<T> {
  skippedAttachments?: Array<{ fileName: string; fileUrl: string; reason: string }>
}

// ─── Source ──────────────────────────────────────────

export interface Source {
  id: string
  enterpriseId: string
  title: string
  sourceType: string
  sourceNo: string | null
  version: string | null
  rawText: string | null
  fileUrl: string | null
  parentSourceId?: string | null
  isLatestVersion?: boolean
  versionChangeSummary?: {
    mode?: string
    added?: string[]
    modified?: string[]
    removed?: string[]
    affectedClauseNos?: string[]
    summary?: string
  } | null
  status: string
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export const seListSources = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<Source>>('/api/admin/standard-execution/sources', { params })
export const seListSourcesEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<Source>>('/api/enterprise/standard-execution/sources', { params })
export const seGetSource = (id: string) =>
  nodeApi.get<unknown, ItemResp<Source>>(`/api/admin/standard-execution/sources/${id}`)
export const seCreateSource = (data: Partial<Source>) =>
  nodeApi.post<unknown, ItemResp<Source>>('/api/admin/standard-execution/sources', data)
export const seCreateSourceEnterprise = (data: Partial<Source>) =>
  nodeApi.post<unknown, ItemResp<Source>>('/api/enterprise/standard-execution/sources', data)
export const seUpdateSource = (id: string, data: Partial<Source>) =>
  nodeApi.patch<unknown, ItemResp<Source>>(`/api/admin/standard-execution/sources/${id}`, data)
export const seUpdateSourceEnterprise = (id: string, data: Partial<Source>) =>
  nodeApi.patch<unknown, ItemResp<Source>>(`/api/enterprise/standard-execution/sources/${id}`, data)
export const seDisableSource = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Source>>(`/api/admin/standard-execution/sources/${id}/disable`, {})
export const seDisableSourceEnterprise = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Source>>(`/api/enterprise/standard-execution/sources/${id}/disable`, {})
export const seListSourceVersionsEnterprise = (id: string) =>
  nodeApi.get<unknown, ListResp<Source>>(`/api/enterprise/standard-execution/sources/${id}/versions`)
export const seCreateSourceVersionEnterprise = (id: string, data: { title?: string; version: string; rawText?: string | null; fileUrl?: string | null; analyze?: boolean }) =>
  nodeApi.post<unknown, ItemResp<Source> & { summary: NonNullable<Source['versionChangeSummary']>; affectedRequirementIds: string[] }>(
    `/api/enterprise/standard-execution/sources/${id}/versions`,
    data,
  )

// ─── Requirement ─────────────────────────────────────

export interface Requirement {
  id: string
  enterpriseId: string
  sourceId: string
  clauseNo: string | null
  title: string
  requirementText: string
  applicableDeptIds: string[] | null
  archiveTags: string[] | null
  generateMode: string
  recommendedTaskType?: string | null
  executionDescription?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
  parseMode?: string | null
  degradedReason?: string | null
  requiresReview?: boolean
  status: string
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  source?: Source
  health?: RequirementHealth
}

export interface ParseV2RequirementDraft {
  clauseNo: string | null
  title: string
  requirementText: string
  executionDescription?: string | null
  recommendedTaskType?: string | null
  suggestedDepartment?: string | null
  suggestedFrequency?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
  confidence: number
  reasoning: string
  sourceChunks: string[]
  needsReview: boolean
}

export interface ParseV2SimilarContext {
  id: string
  collection: 'standard_clauses' | 'requirement_points' | 'execution_records'
  score: number
  title: string
  text: string
  payload?: Record<string, unknown>
}

export interface ParseV2SearchSnippet {
  title: string
  url: string
  content: string
  provider: 'tavily' | 'serper'
}

export interface ParseV2ChunkCache {
  chunk: {
    clauseNo: string
    title: string
    text: string
    chunkIndex: number
  }
  similarClauses: ParseV2SimilarContext[]
  similarRequirements: ParseV2SimilarContext[]
  similarRecords: ParseV2SimilarContext[]
  searchSnippets: ParseV2SearchSnippet[]
}

export interface ParseV2Result {
  version: 'v2'
  sourceId: string
  requirements: ParseV2RequirementDraft[]
  chunks?: ParseV2ChunkCache[]
  metadata: {
    version: 'E2_PARSE_V2'
    sourceId: string
    sourceTitle: string
    sourceNo: string | null
    chunkCount: number
    requirementCount: number
    degradedSteps: string[]
    retrieval: {
      standardClauses: number
      requirementPoints: number
      executionRecords: number
      internetSnippets: number
    }
    generatedAt: string
    disclaimer: string
  }
}

export interface ParseV2Job {
  jobId: string
  sourceId: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'
  progress: number
  step: string | null
  result: ParseV2Result | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RequirementHealth {
  status: 'COVERED' | 'EXPIRING' | 'UNCOVERED' | 'NO_TASK' | 'NA'
  taskCount: number
  validRecordCount: number
  latestValidRecordDate: string | null
  validUntil: string | null
  daysUntilExpiry: number | null
  description: string
}

export const seListRequirements = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<Requirement>>('/api/admin/standard-execution/requirements', { params })
export const seListRequirementsEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<Requirement>>('/api/enterprise/standard-execution/requirements', { params })
export const seGetRequirement = (id: string) =>
  nodeApi.get<unknown, ItemResp<Requirement>>(`/api/admin/standard-execution/requirements/${id}`)
export const seCreateRequirement = (data: Partial<Requirement>) =>
  nodeApi.post<unknown, ItemResp<Requirement>>('/api/admin/standard-execution/requirements', data)
export const seCreateRequirementEnterprise = (data: Partial<Requirement>) =>
  nodeApi.post<unknown, ItemResp<Requirement>>('/api/enterprise/standard-execution/requirements', data)
export const seUpdateRequirement = (id: string, data: Partial<Requirement>) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/admin/standard-execution/requirements/${id}`, data)
export const seUpdateRequirementEnterprise = (id: string, data: Partial<Requirement>) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/enterprise/standard-execution/requirements/${id}`, data)
export const seActivateRequirement = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/admin/standard-execution/requirements/${id}/activate`, {})
export const seActivateRequirementEnterprise = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/enterprise/standard-execution/requirements/${id}/activate`, {})
export const seDisableRequirement = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/admin/standard-execution/requirements/${id}/disable`, {})
export const seDisableRequirementEnterprise = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/enterprise/standard-execution/requirements/${id}/disable`, {})
export const seArchiveRequirement = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/admin/standard-execution/requirements/${id}/archive`, {})
export const seArchiveRequirementEnterprise = (id: string) =>
  nodeApi.patch<unknown, ItemResp<Requirement>>(`/api/enterprise/standard-execution/requirements/${id}/archive`, {})

export const seStartParseV2 = (sourceId: string) =>
  nodeApi.post<unknown, { jobId: string; status: ParseV2Job['status']; progress: number; reused: boolean }>(
    `/api/admin/standard-execution/sources/${sourceId}/parse-v2`,
    {},
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const seGetParseV2Job = (jobId: string) =>
  nodeApi.get<unknown, ParseV2Job>(`/api/admin/standard-execution/parse-jobs/${jobId}`)
export const seRegenerateParseV2Requirement = (jobId: string, index: number) =>
  nodeApi.post<unknown, { data: ParseV2RequirementDraft; result: ParseV2Result }>(
    `/api/admin/standard-execution/parse-jobs/${jobId}/requirements/${index}/regenerate`,
    {},
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )

// ─── Compliance Matrix ──────────────────────────────

export type ComplianceCoverageStatus = 'DIRECT' | 'REUSED'

export interface ComplianceMatrixSource {
  id: string
  title: string
  sourceNo: string | null
  version: string | null
}

export interface ComplianceMatrixCoverage {
  status: ComplianceCoverageStatus
  recordIds: string[]
}

export interface ComplianceMatrixRow {
  id: string
  sourceId: string
  clauseNo: string | null
  title: string
  requirementText: string
  source: ComplianceMatrixSource
  coverageBySource: Record<string, ComplianceMatrixCoverage>
}

export interface ComplianceMatrixResp {
  data: {
    sources: ComplianceMatrixSource[]
    rows: ComplianceMatrixRow[]
  }
  total: number
  page: number
  pageSize: number
}

export interface RecordCoverage {
  id: string
  enterpriseId: string
  recordId: string
  requirementId: string
  coverageType: 'DIRECT' | 'REUSE' | string
  createdBy: string
  createdAt: string
}

export type RequirementMappingType = 'EQUIVALENT' | 'PARTIAL' | 'REFERENCE'

export interface RequirementMapping {
  id: string
  enterpriseId: string
  sourceRequirementId: string
  targetRequirementId: string
  mappingType: RequirementMappingType
  createdBy: string
  createdAt: string
}

export const seGetComplianceMatrixEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ComplianceMatrixResp>('/api/enterprise/standard-execution/compliance-matrix', { params })
export const seListRecordCoveragesEnterprise = (recordId: string) =>
  nodeApi.get<unknown, { data: RecordCoverage[]; requirements: Requirement[] }>(
    `/api/enterprise/standard-execution/records/${recordId}/coverages`,
  )
export const seAddRecordCoveragesEnterprise = (recordId: string, data: { requirementIds: string[] }) =>
  nodeApi.post<unknown, { created: number }>(`/api/enterprise/standard-execution/records/${recordId}/coverages`, data)
export const seListRequirementMappingsEnterprise = () =>
  nodeApi.get<unknown, { data: RequirementMapping[] }>('/api/enterprise/standard-execution/requirement-mappings')
export const seCreateRequirementMappingEnterprise = (data: {
  sourceRequirementId: string
  targetRequirementId: string
  mappingType?: RequirementMappingType
}) =>
  nodeApi.post<unknown, ItemResp<RequirementMapping>>('/api/enterprise/standard-execution/requirement-mappings', data)

// ─── Industry Template ──────────────────────────────

export type IndustryTemplateCategory = 'MANUFACTURING' | 'FOOD_SAFETY' | 'MEDICAL_DEVICE' | 'SECURITY' | 'GENERAL' | 'OTHER'
export type IndustryTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'OFFLINE'

export const INDUSTRY_TEMPLATE_CATEGORY_LABEL: Record<IndustryTemplateCategory, string> = {
  MANUFACTURING: '制造业',
  FOOD_SAFETY: '食品安全',
  MEDICAL_DEVICE: '医疗器械',
  SECURITY: '安保',
  GENERAL: '通用',
  OTHER: '其他',
}

export const INDUSTRY_TEMPLATE_STATUS_LABEL: Record<IndustryTemplateStatus, string> = {
  DRAFT: '草稿',
  PUBLISHED: '已发布',
  OFFLINE: '已下线',
}

export const INDUSTRY_TEMPLATE_STATUS_COLOR: Record<IndustryTemplateStatus, string> = {
  DRAFT: 'default',
  PUBLISHED: 'green',
  OFFLINE: 'orange',
}

export interface IndustryTemplateItem {
  id: string
  templateId: string
  clauseNo: string | null
  title: string
  requirementText: string
  applicableDeptIds?: string[] | null
  archiveTags?: string[] | null
  recommendedTaskType?: string | null
  executionDescription?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
  sortOrder: number
  createdAt: string
}

export interface IndustryTemplate {
  id: string
  industryCategory: IndustryTemplateCategory
  title: string
  sourceNo: string | null
  version: string | null
  description: string | null
  status: IndustryTemplateStatus
  controlPointCount: number
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  items?: IndustryTemplateItem[]
}

export type IndustryTemplateItemInput = Omit<Partial<IndustryTemplateItem>, 'id' | 'templateId' | 'sortOrder' | 'createdAt'> & {
  title: string
  requirementText: string
}

export type IndustryTemplateInput = {
  industryCategory: IndustryTemplateCategory
  title: string
  sourceNo?: string | null
  version?: string | null
  description?: string | null
  items: IndustryTemplateItemInput[]
}

export const seListIndustryTemplates = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<IndustryTemplate>>('/api/admin/standard-execution/industry-templates', { params })
export const seGetIndustryTemplate = (id: string) =>
  nodeApi.get<unknown, ItemResp<IndustryTemplate>>(`/api/admin/standard-execution/industry-templates/${id}`)
export const seCreateIndustryTemplate = (data: IndustryTemplateInput) =>
  nodeApi.post<unknown, ItemResp<IndustryTemplate>>('/api/admin/standard-execution/industry-templates', data)
export const seUpdateIndustryTemplate = (id: string, data: Partial<IndustryTemplateInput>) =>
  nodeApi.patch<unknown, ItemResp<IndustryTemplate>>(`/api/admin/standard-execution/industry-templates/${id}`, data)
export const sePublishIndustryTemplate = (id: string) =>
  nodeApi.patch<unknown, ItemResp<IndustryTemplate>>(`/api/admin/standard-execution/industry-templates/${id}/publish`, {})
export const seOfflineIndustryTemplate = (id: string) =>
  nodeApi.patch<unknown, ItemResp<IndustryTemplate>>(`/api/admin/standard-execution/industry-templates/${id}/offline`, {})
export const seCreateIndustryTemplateFromRequirements = (data: Omit<IndustryTemplateInput, 'items'> & { enterpriseId?: string; requirementIds: string[] }) =>
  nodeApi.post<unknown, ItemResp<IndustryTemplate>>('/api/admin/standard-execution/industry-templates/from-requirements', data)

export const seListIndustryTemplatesEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<IndustryTemplate>>('/api/enterprise/standard-execution/industry-templates', { params })
export const seGetIndustryTemplateEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<IndustryTemplate>>(`/api/enterprise/standard-execution/industry-templates/${id}`)
export const seImportIndustryTemplateEnterprise = (id: string, data: { itemIds?: string[] }) =>
  nodeApi.post<unknown, { sourceId: string; imported: number }>(`/api/enterprise/standard-execution/industry-templates/${id}/import`, data)

export interface AutoGenerateResp {
  sourceId: string
  requestedMode: 'OCR_AI' | 'RULE' | 'AI_STUB'
  parseMode: 'OCR_AI' | 'RULE' | 'AI_STUB'
  degraded: boolean
  degradedReason?: string
  drafts: unknown[]
  createdCount: number
  skippedCount: number
  aiCount?: number
  ruleCount?: number
  degradedCount?: number
  dryRun: boolean
}
export const seAutoGenerate = (body: { sourceId: string; parseMode: string; dryRun?: boolean }) =>
  nodeApi.post<unknown, ItemResp<AutoGenerateResp>>(
    '/api/admin/standard-execution/requirements/auto-generate',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const seAutoGenerateEnterprise = (body: { sourceId: string; parseMode: string; dryRun?: boolean }) =>
  nodeApi.post<unknown, ItemResp<AutoGenerateResp>>(
    '/api/enterprise/standard-execution/requirements/auto-generate',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )

// ─── Task Generation Workbench ───────────────────────

export interface TaskGenerationDraft {
  draftId?: string
  splitFromId?: string | null
  groupId?: string | null
  clauseNo?: string | null
  title: string
  requirementText: string
  recommendedTaskType?: string | null
  executionDescription?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
  taskDrafts?: Array<{
    taskDraftId?: string
    groupId?: string | null
    title?: string | null
    description?: string | null
    taskType?: string | null
    submitRequirement?: string | null
  }>
}

export interface TaskGenerationPreviewResp {
  source: Pick<Source, 'id' | 'title' | 'sourceNo' | 'sourceType' | 'version'> | null
  requestedMode: 'OCR_AI' | 'RULE' | 'AI_STUB'
  parseMode: 'OCR_AI' | 'RULE' | 'AI_STUB'
  degraded: boolean
  degradedReason?: string | null
  warnings: string[]
  rejectedCount: number
  drafts: TaskGenerationDraft[]
}

export interface TaskGenerationCommitResp {
  batchId: string
  created: { requirementIds: string[]; taskIds: string[] }
  summary: { requirements: number; tasks: number; taskStatus: 'DRAFT' | 'PENDING_APPROVAL' }
}

export const sePreviewTaskGeneration = (body: { sourceId?: string; rawText?: string; parseMode?: string }) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewResp>>(
    '/api/admin/standard-execution/task-generation/preview',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const sePreviewTaskGenerationEnterprise = (body: { sourceId?: string; rawText?: string; parseMode?: string }) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewResp>>(
    '/api/enterprise/standard-execution/task-generation/preview',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const seCommitTaskGeneration = (body: Record<string, unknown>) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationCommitResp>>(
    '/api/admin/standard-execution/task-generation/commit',
    body,
  )
export const seCommitTaskGenerationEnterprise = (body: Record<string, unknown>) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationCommitResp>>(
    '/api/enterprise/standard-execution/task-generation/commit',
    body,
  )

// ─── Task Generation v2（AI 润色任务卡 / 工作台 v2）─────
// 契约：必读/archive/tasks/v2-ai-task-polish-api-contract-2026-06-05.md
// 复用现有 preview/commit 端点；preview 增加可选 polish 参数返回顶层 taskCards。

export type SeDeadlineMode = 'FIXED' | 'AFTER_APPROVAL_DAYS'

export interface TaskCardV2 {
  id: string
  draftId: string
  taskDraftId: string
  groupId: string
  title: string
  description: string
  submitRequirement: string
  taskType: string
  requiredMaterials: string[]
  deadlineSuggestion: {
    mode: SeDeadlineMode
    daysAfterApproval: number | null
    fixedAt: string | null
    label: string
    reason: string | null
  }
  basis: {
    sourceId: string | null
    sourceTitle: string | null
    clauseNo: string | null
    excerpt: string
  }
  polishStatus: 'AI_POLISHED' | 'FALLBACK_ORIGINAL'
  warnings: string[]
}

export interface PolishSummary {
  enabled: boolean
  status: 'SUCCEEDED' | 'DEGRADED' | 'SKIPPED'
  degraded: boolean
  degradedReason: string | null
  warnings: string[]
  stats: {
    inputDrafts: number
    outputCards: number
    aiCards: number
    fallbackCards: number
    batches: number
    failedBatches: number
    durationMs: number
  }
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

export interface TaskGenerationCandidateThresholds {
  candidateMinScore: number
  taskMinScore: number
}

export interface TaskGenerationTaskPackage {
  packageId: string
  groupId: string
  key: {
    taskType: string
    responsibleRole: string | null
    evidenceType: string | null
  }
  title: string
  description: string
  submitRequirement: string
  taskType: string
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

export type TaskGenerationCoverageDestination =
  | 'TASK_PACKAGE'
  | 'ASSOCIATED_CANDIDATE'
  | 'LOW_SCORE_CANDIDATE'
  | 'OVERFLOW_CANDIDATE'

export interface TaskGenerationCoverageEntry {
  candidateIndex: number
  clauseNo: string | null
  sourceText: string
  score: number
  destination: TaskGenerationCoverageDestination
  packageId: string | null
  reason: string
}

export interface TaskGenerationCoverageReport {
  totalCandidates: number
  taskPackageCount: number
  candidateOnlyCount: number
  entries: TaskGenerationCoverageEntry[]
}

export interface TaskGenerationPreviewV2Resp extends TaskGenerationPreviewResp {
  candidateV2Enabled?: boolean
  candidateRequirements?: CandidateRequirement[]
  candidateScoreDistribution?: CandidateScoreDistribution
  candidateThresholds?: TaskGenerationCandidateThresholds
  taskPackages?: TaskGenerationTaskPackage[]
  coverageReport?: TaskGenerationCoverageReport
  polish?: PolishSummary
  taskCards?: TaskCardV2[]
}

export interface TaskGenerationRuntimeConfig {
  aiChunkChars: number
  aiConcurrency: number
  realtimeAiMaxChunks: number
  realtimeAiMaxChars: number
  candidateMinScore?: number
  candidateTaskMinScore?: number
  candidateTaskPackageMax?: number
  candidateV2Enabled?: boolean
}

export interface TaskGenerationPreviewV2Body {
  sourceId?: string
  rawText?: string
  parseMode?: string
  polish?: boolean | { enabled?: boolean; target?: 'TASK_CARD_V2' }
}

export interface TaskGenerationPreviewJobResp {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  result: TaskGenerationPreviewV2Resp | null
  error: { status: number; message: string } | null
  volatile: boolean
}

export const sePreviewTaskGenerationV2 = (body: TaskGenerationPreviewV2Body) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewV2Resp>>(
    '/api/admin/standard-execution/task-generation/preview',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const sePreviewTaskGenerationV2Enterprise = (body: TaskGenerationPreviewV2Body) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewV2Resp>>(
    '/api/enterprise/standard-execution/task-generation/preview',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const seStartTaskGenerationPreviewJob = (body: TaskGenerationPreviewV2Body) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewJobResp>>(
    '/api/admin/standard-execution/task-generation/preview/jobs',
    body,
  )
export const seStartTaskGenerationPreviewJobEnterprise = (body: TaskGenerationPreviewV2Body) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationPreviewJobResp>>(
    '/api/enterprise/standard-execution/task-generation/preview/jobs',
    body,
  )
export const seGetTaskGenerationPreviewJob = (jobId: string) =>
  nodeApi.get<unknown, ItemResp<TaskGenerationPreviewJobResp>>(
    `/api/admin/standard-execution/task-generation/preview/jobs/${jobId}`,
  )
export const seGetTaskGenerationPreviewJobEnterprise = (jobId: string) =>
  nodeApi.get<unknown, ItemResp<TaskGenerationPreviewJobResp>>(
    `/api/enterprise/standard-execution/task-generation/preview/jobs/${jobId}`,
  )
export const seListTaskGenerationPreviewJobs = (params: { sourceId?: string; limit?: number }) =>
  nodeApi.get<unknown, { data: TaskGenerationPreviewJobResp[] }>(
    '/api/admin/standard-execution/task-generation/preview/jobs',
    { params },
  )
export const seListTaskGenerationPreviewJobsEnterprise = (params: { sourceId?: string; limit?: number }) =>
  nodeApi.get<unknown, { data: TaskGenerationPreviewJobResp[] }>(
    '/api/enterprise/standard-execution/task-generation/preview/jobs',
    { params },
  )
export const seGetTaskGenerationConfig = () =>
  nodeApi.get<unknown, ItemResp<TaskGenerationRuntimeConfig>>('/api/admin/standard-execution/task-generation/config')
export const seGetTaskGenerationConfigEnterprise = () =>
  nodeApi.get<unknown, ItemResp<TaskGenerationRuntimeConfig>>('/api/enterprise/standard-execution/task-generation/config')

// ─── Task Generation v2 三能力（单卡重写 / 批量重润色 / 整体重提取）契约 §6 ───

export interface TaskCardDraftForCommit {
  taskDraftId: string
  groupId: string
  title: string
  description: string
  taskType: string
  submitRequirement: string
}

export interface PolishOperationSummary {
  enabled: true
  status: 'SUCCEEDED' | 'DEGRADED' | 'SKIPPED'
  degraded: boolean
  degradedReason: string | null
  warnings: string[]
  stats: {
    inputCards: number
    outputCards: number
    aiCards: number
    fallbackCards: number
    batches: number
    failedBatches: number
    durationMs: number
  }
}

export interface TaskCardRewriteBody {
  sourceId?: string
  rawText?: string
  card: TaskCardV2
  draft?: TaskGenerationDraft | null
  instruction?: string
  surroundingCards?: TaskCardV2[]
}
export interface TaskCardRewriteResp {
  operation: 'CARD_REWRITE'
  polish: PolishOperationSummary
  taskCard: TaskCardV2
  taskDraft: TaskCardDraftForCommit
}

export interface TaskCardsRepolishBody {
  sourceId?: string
  rawText?: string
  cards: TaskCardV2[]
  drafts?: TaskGenerationDraft[]
  instruction?: string
}
export interface TaskCardsRepolishResp {
  operation: 'BATCH_REPOLISH'
  polish: PolishOperationSummary
  taskCards: TaskCardV2[]
  taskDrafts: TaskCardDraftForCommit[]
}

export interface TaskGenerationReExtractBody extends TaskGenerationPreviewV2Body {
  instruction?: string
  previousCardCount?: number
}
export type TaskGenerationReExtractResp = TaskGenerationPreviewV2Resp & { operation: 'RE_EXTRACT' }

export const seRewriteTaskCard = (body: TaskCardRewriteBody) =>
  nodeApi.post<unknown, ItemResp<TaskCardRewriteResp>>('/api/admin/standard-execution/task-generation/card-rewrite', body)
export const seRewriteTaskCardEnterprise = (body: TaskCardRewriteBody) =>
  nodeApi.post<unknown, ItemResp<TaskCardRewriteResp>>('/api/enterprise/standard-execution/task-generation/card-rewrite', body)

export const seRepolishTaskCards = (body: TaskCardsRepolishBody) =>
  nodeApi.post<unknown, ItemResp<TaskCardsRepolishResp>>('/api/admin/standard-execution/task-generation/cards/repolish', body)
export const seRepolishTaskCardsEnterprise = (body: TaskCardsRepolishBody) =>
  nodeApi.post<unknown, ItemResp<TaskCardsRepolishResp>>('/api/enterprise/standard-execution/task-generation/cards/repolish', body)

export const seReextractTaskGeneration = (body: TaskGenerationReExtractBody) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationReExtractResp>>(
    '/api/admin/standard-execution/task-generation/re-extract',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )
export const seReextractTaskGenerationEnterprise = (body: TaskGenerationReExtractBody) =>
  nodeApi.post<unknown, ItemResp<TaskGenerationReExtractResp>>(
    '/api/enterprise/standard-execution/task-generation/re-extract',
    body,
    { timeout: SE_AI_REQUEST_TIMEOUT_MS },
  )

// ─── Task ────────────────────────────────────────────

export interface TaskAssignee {
  id: string
  enterpriseId: string
  taskId: string
  assigneeId: string
  departmentId: string | null
  reviewerId: string | null
  status: string
  submittedAt: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskAssigneeSummary {
  total: number
  byStatus: Record<string, number>
}

export interface TaskListV2User {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  avatarUrl: string | null
}

export interface TaskListV2BasisItem {
  requirementId: string | null
  sourceId: string | null
  sourceTitle: string | null
  sourceNo: string | null
  sourceType: string | null
  clauseNo: string | null
  title: string
  requirementText: string
}

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

export interface TaskListV2Item extends SeTask {
  origin: 'PLAN' | 'MANUAL'
  planId: string | null
  planTitle: string | null
  reviewer: TaskListV2User | null
  reviewerName: string | null
  basis: TaskListV2BasisItem[]
  requirementCount: number
  requirementSummary: Array<{ requirementId: string | null; clauseNo: string | null; title: string; sourceTitle: string | null }>
  source: { id: string | null; title: string | null; sourceNo: string | null; sourceType: string | null } | null
  taskItems: Array<{ id: string; status: string; requirement: Requirement }>
  hasTaskItems: boolean
  hasQuiz: boolean
  quizBankId?: string | null
  assigneeCount: number
  assigneeSummary: TaskAssigneeSummary
  pendingReviewCount: number
  completedCount: number
  overdueCount: number
  assignees?: Array<TaskAssignee & { user?: TaskListV2User | null }>
  availableActions: string[]
}

export interface MyTaskListV2Item {
  assigneeId: string
  assigneeUserId: string
  assigneeStatus: string
  submittedAt: string | null
  reviewedAt: string | null
  isRejected: boolean
  isOverdue: boolean
  availableActions: string[]
  task: {
    id: string
    title: string
    description: string | null
    taskType: string | null
    status: string
    deadlineAt: string | null
    submitRequirement: string | null
    basis: TaskListV2BasisItem[]
    source: { id: string | null; title: string | null; sourceNo: string | null; sourceType: string | null } | null
    requirement: Requirement | null
    taskItems: Array<{ id: string; status: string; requirement: Requirement }>
    hasTaskItems: boolean
    hasQuiz: boolean
    quizBankId?: string | null
    submitFormConfig?: SubmitFormConfig
    reviewer: TaskListV2User | null
    assigneeSummary: TaskAssigneeSummary
  }
}

export interface SeTask {
  id: string
  enterpriseId: string
  requirementId: string | null
  title: string
  description: string | null
  taskType: string | null
  submitRequirement: string | null
  deadlineAt: string | null
  deadlineMode: 'FIXED' | 'AFTER_APPROVAL_DAYS'
  deadlineDaysAfterApproval: number | null
  reviewerId: string | null
  status: string
  checklistSchema?: { items: Array<Record<string, unknown>> } | null
  parametersSchema?: { items: Array<Record<string, unknown>> } | null
  learningMaterials?: { items: Array<Record<string, unknown>> } | null
  submittedForApprovalAt: string | null
  approvedAt: string | null
  publishedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  isOverdue: boolean
  assignees?: TaskAssignee[]
  requirement?: Requirement
  basisSnapshots?: TaskListV2BasisItem[] | null
  taskItems?: Array<{ id: string; status: string; requirement: Requirement }>
  submitFormConfig?: SubmitFormConfig
  quizBankId?: string | null
}

// ─── Enterprise Members ──────────────────────────────

export interface EnterpriseMember {
  id: string
  phone: string
  nickName: string | null
  enterpriseRole?: string | null  // ADMIN | MANAGER | REVIEWER | EMPLOYEE
  passwordMustChange?: boolean
}

export interface EnterpriseMe {
  user: { id: string; phone?: string | null; name?: string | null; role: string; passwordMustChange?: boolean }
  enterpriseId: string | null
  enterpriseRole: string | null
  enterpriseName?: string | null
  enterpriseStatus?: string | null
  isAdminBypass?: boolean
}

export const enterpriseMe = () =>
  nodeApi.get<unknown, EnterpriseMe>('/api/enterprise/me')

export const seListEnterpriseMembers = () =>
  nodeApi.get<unknown, { data: EnterpriseMember[] }>('/api/enterprise/members')
export const seAddEnterpriseMember = (data: { phone: string; name?: string; enterpriseRole: string }) =>
  nodeApi.post<unknown, { data: EnterpriseMember; temporaryPassword?: string | null }>('/api/enterprise/members', data)
export const seUpdateEnterpriseMemberRole = (id: string, enterpriseRole: string) =>
  nodeApi.patch<unknown, { data: EnterpriseMember }>(`/api/enterprise/members/${id}`, { enterpriseRole })
export const seResetEnterpriseMemberPassword = (id: string) =>
  nodeApi.post<unknown, { ok: boolean; temporaryPassword: string; passwordMustChange: boolean }>(`/api/enterprise/members/${id}/reset-password`, {})
export const seRemoveEnterpriseMember = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/members/${id}`)

export const seListTasks = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SeTask>>('/api/admin/standard-execution/tasks', { params })
export const seListTasksEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SeTask>>('/api/enterprise/standard-execution/tasks', { params })
export const seListTasksV2 = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, TaskListV2Resp<TaskListV2Item>>('/api/admin/standard-execution/tasks/list-v2', { params })
export const seListTasksV2Enterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, TaskListV2Resp<TaskListV2Item>>('/api/enterprise/standard-execution/tasks/list-v2', { params })
export const seListMyTasksV2 = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, MyTaskListV2Resp<MyTaskListV2Item>>('/api/app/standard-execution/tasks/list-v2', { params })
export const seGetTask = (id: string) =>
  nodeApi.get<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}`)
export const seCreateTask = (data: Record<string, unknown>) =>
  nodeApi.post<unknown, ItemResp<SeTask>>('/api/admin/standard-execution/tasks', data)
export const seCreateTaskEnterprise = (data: Record<string, unknown>) =>
  nodeApi.post<unknown, ItemResp<SeTask>>('/api/enterprise/standard-execution/tasks', data)
export const seCreateTaskFromRequirement = (requirementId: string, data: Record<string, unknown>) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(
    `/api/admin/standard-execution/requirements/${requirementId}/create-task`,
    data,
  )
export const seBatchCreateTasksFromRequirements = (data: Record<string, unknown>) =>
  nodeApi.post<unknown, { data: SeTask[]; createdCount: number }>(
    '/api/admin/standard-execution/requirements/batch-create-tasks',
    data,
  )
export const seBatchCreateTasksFromRequirementsEnterprise = (data: Record<string, unknown>) =>
  nodeApi.post<unknown, { data: SeTask[]; createdCount: number }>(
    '/api/enterprise/standard-execution/requirements/batch-create-tasks',
    data,
  )
export const seUpdateTask = (id: string, data: Record<string, unknown>) =>
  nodeApi.patch<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}`, data)
export const seUpdateTaskEnterprise = (id: string, data: Record<string, unknown>) =>
  nodeApi.patch<unknown, ItemResp<SeTask>>(`/api/enterprise/standard-execution/tasks/${id}`, data)
export const sePublishTask = (id: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}/publish`, {})
export const sePublishTaskEnterprise = (id: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/enterprise/standard-execution/tasks/${id}/publish`, {})
export interface TaskApprovalResp extends ItemResp<SeTask> {
  deadlineAdjusted?: boolean
  oldDeadlineAt?: string | null
  newDeadlineAt?: string | null
}
export const seSubmitTaskApproval = (id: string, comment?: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}/submit-approval`, { comment })
export const seSubmitTaskApprovalEnterprise = (id: string, comment?: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/enterprise/standard-execution/tasks/${id}/submit-approval`, { comment })
export const seApproveTaskApproval = (id: string, comment?: string) =>
  nodeApi.post<unknown, TaskApprovalResp>(`/api/admin/standard-execution/tasks/${id}/approval/approve`, { comment })
export const seApproveTaskApprovalEnterprise = (id: string, comment?: string) =>
  nodeApi.post<unknown, TaskApprovalResp>(`/api/enterprise/standard-execution/tasks/${id}/approval/approve`, { comment })
export const seRejectTaskApproval = (id: string, comment?: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}/approval/reject`, { comment })
export const seRejectTaskApprovalEnterprise = (id: string, comment?: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/enterprise/standard-execution/tasks/${id}/approval/reject`, { comment })
export const seCancelTask = (id: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/admin/standard-execution/tasks/${id}/cancel`, {})
export const seCancelTaskEnterprise = (id: string) =>
  nodeApi.post<unknown, ItemResp<SeTask>>(`/api/enterprise/standard-execution/tasks/${id}/cancel`, {})
export const seGetTaskProgress = (id: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/admin/standard-execution/tasks/${id}/progress`)
export const seGetTaskProgressEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/enterprise/standard-execution/tasks/${id}/progress`)

// ─── Review ──────────────────────────────────────────

export interface ReviewListItem {
  submission: {
    id: string
    version: number
    isLatest: boolean
    submitText: string
    status: string
    submittedAt: string
    reviewedAt: string | null
    reviewComment: string | null
  }
  task: { id: string; title: string; deadlineAt: string; reviewerId: string }
  requirement: { id: string; title: string }
  assigneeId: string
  assignee: { status: string; submittedAt: string | null; reviewedAt: string | null } | null
}

export type ReviewAiRecommendation = 'APPROVE' | 'REJECT' | 'MANUAL'

export interface ReviewAiAnalysis {
  recommendation: ReviewAiRecommendation
  confidence: number
  summary: string
  reasons: string[]
  checks: {
    completeness: { status: 'PASS' | 'WARN' | 'FAIL'; missingMaterials: string[]; note: string }
    fillQuality: { status: 'PASS' | 'WARN' | 'FAIL' | 'NA'; note: string }
    anomaly: { status: 'PASS' | 'WARN' | 'NA'; note: string }
  }
  suggestedComment: string
  disclaimer: string
}

export const seListReviews = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<ReviewListItem>>('/api/admin/standard-execution/reviews', { params })
export const seListReviewsEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<ReviewListItem>>('/api/enterprise/standard-execution/reviews', { params })
export const seGetReview = (submissionId: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/admin/standard-execution/reviews/${submissionId}`)
export const seGetReviewEnterprise = (submissionId: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/enterprise/standard-execution/reviews/${submissionId}`)
export const seAnalyzeReview = (submissionId: string) =>
  nodeApi.post<unknown, ItemResp<ReviewAiAnalysis>>(`/api/admin/standard-execution/reviews/${submissionId}/ai-analysis`, {})
export const seAnalyzeReviewEnterprise = (submissionId: string) =>
  nodeApi.post<unknown, ItemResp<ReviewAiAnalysis>>(`/api/enterprise/standard-execution/reviews/${submissionId}/ai-analysis`, {})
export const seApproveReview = (
  submissionId: string,
  data: { reviewComment?: string; recordTitle?: string; recordSummary?: string },
) =>
  nodeApi.post<unknown, ItemResp<unknown>>(
    `/api/admin/standard-execution/reviews/${submissionId}/approve`,
    data,
  )
export const seApproveReviewEnterprise = (
  submissionId: string,
  data: { reviewComment?: string; recordTitle?: string; recordSummary?: string },
) =>
  nodeApi.post<unknown, ItemResp<unknown>>(
    `/api/enterprise/standard-execution/reviews/${submissionId}/approve`,
    data,
  )
export const seRejectReview = (submissionId: string, data: { reviewComment: string }) =>
  nodeApi.post<unknown, ItemResp<unknown>>(
    `/api/admin/standard-execution/reviews/${submissionId}/reject`,
    data,
  )
export const seRejectReviewEnterprise = (submissionId: string, data: { reviewComment: string }) =>
  nodeApi.post<unknown, ItemResp<unknown>>(
    `/api/enterprise/standard-execution/reviews/${submissionId}/reject`,
    data,
  )

// ─── Record ──────────────────────────────────────────

export interface SeRecord {
  id: string
  enterpriseId: string
  sourceId: string
  requirementId: string
  taskId: string
  submissionId: string
  assigneeId: string
  departmentId: string | null
  title: string
  summary: string | null
  recordDate: string
  validUntil: string | null
  status: string
  createdFrom: string
  createdAt: string
  updatedAt: string
  task?: {
    id: string
    title: string
    requirement?: {
      id: string
      title: string
      clauseNo?: string | null
      requirementText?: string | null
      source?: { id: string; title: string; sourceNo?: string | null; version?: string | null }
    }
  }
  submission?: {
    id: string
    version: number
    submittedAt: string | null
    reviewedAt: string | null
    reviewerId: string | null
    submitText?: string
    status?: string
    reviewComment?: string | null
    assigneeId?: string
  } | null
}

export interface RecordEvidenceChain {
  enterprise: { id: string; name: string }
  source: { id: string; sourceNo: string | null; title: string; version: string | null; sourceType: string | null }
  requirement: { id: string; clauseNo: string | null; title: string; requirementText: string; requirementTextSummary: string }
  task: {
    id: string
    title: string
    status: string
    deadlineAt: string | null
    assigneeId: string
    reviewerId: string | null
    assigneeStatus: string | null
    departmentId: string | null
  }
  submission: {
    id: string
    assigneeId: string
    submitText: string
    submitTextSummary: string
    status: string
    version: number
    submittedAt: string
  }
  review: {
    reviewerId: string | null
    reviewedAt: string | null
    reviewComment: string | null
    logs: Array<{ id: string; action: string; comment: string | null; reviewerId: string; createdAt: string }>
  }
  record: {
    id: string
    title: string
    summary: string | null
    recordDate: string
    validUntil: string | null
    status: string
    createdFrom: string
    createdAt: string
  }
  attachments: Array<{ id: string; fileName: string; fileUrl: string; fileSize?: number | null; mimeType?: string | null }>
}

export const seListRecords = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SeRecord>>('/api/admin/standard-execution/records', { params })
export const seListRecordsEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SeRecord>>('/api/enterprise/standard-execution/records', { params })
export const seGetRecord = (id: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/admin/standard-execution/records/${id}`)
export const seGetRecordEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<unknown>>(`/api/enterprise/standard-execution/records/${id}`)
export const seGetRecordEvidenceChain = (id: string) =>
  nodeApi.get<unknown, ItemResp<RecordEvidenceChain>>(`/api/admin/standard-execution/records/${id}/evidence-chain`)
export const seGetRecordEvidenceChainEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<RecordEvidenceChain>>(`/api/enterprise/standard-execution/records/${id}/evidence-chain`)
export const seDownloadRecordEvidencePdf = (id: string) =>
  nodeApi.get<unknown, Blob>(`/api/admin/standard-execution/records/${id}/export-pdf`, { responseType: 'blob' })
export const seDownloadRecordEvidencePdfEnterprise = (id: string) =>
  nodeApi.get<unknown, Blob>(`/api/enterprise/standard-execution/records/${id}/export-pdf`, { responseType: 'blob' })
export const seVoidRecord = (id: string, voidReason?: string) =>
  nodeApi.post<unknown, ItemResp<SeRecord>>(`/api/admin/standard-execution/records/${id}/void`, {
    voidReason,
  })
export const seVoidRecordEnterprise = (id: string, voidReason?: string) =>
  nodeApi.post<unknown, ItemResp<SeRecord>>(`/api/enterprise/standard-execution/records/${id}/void`, {
    voidReason,
  })

// ─── Package ─────────────────────────────────────────

export interface SePackage {
  id: string
  enterpriseId: string
  title: string
  packageScene: string
  description: string | null
  dateFrom: string | null
  dateTo: string | null
  status: string
  format: string
  hasInvalidRecord: boolean
  generationStatus?: string
  generationBatchId?: string | null
  generationOptions?: unknown
  outputDir?: string | null
  outputManifest?: PackageOutputManifest | null
  generationError?: string | null
  generatedAt: string | null
  fileUrl: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface PackageGenerationOptions {
  includeManifest?: boolean
  includeAuditTrace?: boolean
  includeBasisClauses?: boolean
  includeStatisticsSummary?: boolean
}

export interface PackageOutputFile {
  path: string
  kind: 'docx' | 'xlsx' | 'txt' | 'json' | 'zip' | 'pdf' | 'file'
  label: string
  size: number
  required: boolean
}

export interface PackagePreview {
  package: { id: string; title: string; packageScene: string; description: string | null; dateFrom: string | null; dateTo: string | null }
  cover: { reportTitle: string; enterpriseName: string; packageSceneLabel: string; auditDateRange: string; generatedBy: string; generatedAt: string }
  stats: {
    recordCount: number
    taskCount: number
    requirementCount: number
    sourceCount: number
    attachmentCount: number
  }
  attachmentCounts: Record<'image' | 'pdf' | 'video' | 'contract' | 'other', number>
  missingAttachments: Array<{ recordId: string; recordTitle: string; taskId: string; taskTitle: string; reason: string }>
  bodySections: string[]
  outputFileTree: PackageOutputFile[]
  attachmentIndexPreview: Array<{
    fileName: string
    type: string
    size: number | null
    uploadedBy: string
    uploadedAt: string
    taskTitle: string
    recordTitle: string
    relativePath: string
  }>
  v2Options: Required<PackageGenerationOptions>
  estimatedOutputSize: number
}

export interface PackageOutputManifest {
  files?: PackageOutputFile[]
  stats?: PackagePreview['stats']
  missingAttachments?: PackagePreview['missingAttachments']
  skippedAttachments?: Array<{ fileName: string; fileUrl: string; reason: string }>
}

export const seListPackages = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SePackage>>('/api/admin/standard-execution/packages', { params })
export const seListPackagesEnterprise = (params: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<SePackage>>('/api/enterprise/standard-execution/packages', { params })
export const seCreatePackage = (data: {
  title: string
  packageScene: string
  description?: string
  dateFrom?: string
  dateTo?: string
  format?: string
  recordIds?: string[]
  requirementIds?: string[]
  taskIds?: string[]
  planId?: string
}) =>
  nodeApi.post<unknown, ItemResp<SePackage>>('/api/admin/standard-execution/packages', data)
export const seCreatePackageEnterprise = (data: {
  title: string
  packageScene: string
  description?: string
  dateFrom?: string
  dateTo?: string
  format?: string
  recordIds?: string[]
  requirementIds?: string[]
  taskIds?: string[]
  planId?: string
}) =>
  nodeApi.post<unknown, ItemResp<SePackage>>('/api/enterprise/standard-execution/packages', data)
export const seGetPackage = (id: string) =>
  nodeApi.get<unknown, ItemResp<SePackage & { tree: unknown[] }>>(
    `/api/admin/standard-execution/packages/${id}`,
  )
export const seGetPackageEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<SePackage & { tree: unknown[] }>>(
    `/api/enterprise/standard-execution/packages/${id}`,
  )
export const sePreviewPackage = (id: string, data?: PackageGenerationOptions) =>
  nodeApi.post<unknown, ItemResp<PackagePreview>>(
    `/api/admin/standard-execution/packages/${id}/preview`,
    data ?? {},
  )
export const sePreviewPackageEnterprise = (id: string, data?: PackageGenerationOptions) =>
  nodeApi.post<unknown, ItemResp<PackagePreview>>(
    `/api/enterprise/standard-execution/packages/${id}/preview`,
    data ?? {},
  )
export const seGeneratePackage = (id: string, data?: PackageGenerationOptions) =>
  nodeApi.post<unknown, PackageGenerateResp<SePackage> & { batchId?: string; status?: string; outputFiles?: PackageOutputFile[] }>(
    `/api/admin/standard-execution/packages/${id}/generate`,
    data ?? {},
  )
export const seGeneratePackageEnterprise = (id: string, data?: PackageGenerationOptions) =>
  nodeApi.post<unknown, PackageGenerateResp<SePackage> & { batchId?: string; status?: string; outputFiles?: PackageOutputFile[] }>(
    `/api/enterprise/standard-execution/packages/${id}/generate`,
    data ?? {},
  )
export const seStartPackageGeneration = (id: string, data: PackageGenerationOptions & { previewConfirmed: true }) =>
  nodeApi.post<unknown, ItemResp<{ packageId: string; batchId: string; status: string; progress: number; step: string }>>(
    `/api/admin/standard-execution/packages/${id}/generate-async`,
    data,
  )
export const seStartPackageGenerationEnterprise = (id: string, data: PackageGenerationOptions & { previewConfirmed: true }) =>
  nodeApi.post<unknown, ItemResp<{ packageId: string; batchId: string; status: string; progress: number; step: string }>>(
    `/api/enterprise/standard-execution/packages/${id}/generate-async`,
    data,
  )
export const seGetPackageGenerationStatus = (id: string) =>
  nodeApi.get<unknown, ItemResp<SePackage>>(`/api/admin/standard-execution/packages/${id}/generation-status`)
export const seGetPackageGenerationStatusEnterprise = (id: string) =>
  nodeApi.get<unknown, ItemResp<SePackage>>(`/api/enterprise/standard-execution/packages/${id}/generation-status`)
export const seDownloadPackage = (id: string) =>
  nodeApi.get<unknown, Blob>(`/api/admin/standard-execution/packages/${id}/download`, { responseType: 'blob' })
export const seDownloadPackageEnterprise = (id: string) =>
  nodeApi.get<unknown, Blob>(`/api/enterprise/standard-execution/packages/${id}/download`, { responseType: 'blob' })
export const seDownloadPackageFile = (id: string, filePath: string) =>
  nodeApi.get<unknown, Blob>(`/api/admin/standard-execution/packages/${id}/files`, {
    params: { path: filePath },
    responseType: 'blob',
  })
export const seDownloadPackageFileEnterprise = (id: string, filePath: string) =>
  nodeApi.get<unknown, Blob>(`/api/enterprise/standard-execution/packages/${id}/files`, {
    params: { path: filePath },
    responseType: 'blob',
  })
export const seVoidPackage = (id: string) =>
  nodeApi.post<unknown, ItemResp<SePackage>>(`/api/admin/standard-execution/packages/${id}/void`, {})
export const seVoidPackageEnterprise = (id: string) =>
  nodeApi.post<unknown, ItemResp<SePackage>>(`/api/enterprise/standard-execution/packages/${id}/void`, {})

// ─── Risk ────────────────────────────────────────────

export interface RiskItem {
  id: string
  riskType: string
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW'
  title: string
  description: string
  relatedType: string
  relatedId: string
  createdAt: string
}

export interface ComplianceRadarData {
  generatedAt: string
  metrics: {
    controlPointCoverage: { covered: number; total: number; rate: number }
    monthlyTaskCompletion: { completed: number; total: number; rate: number }
    reviewPassRate: { approved: number; total: number; rate: number }
    overdueTasks: { count: number }
  }
  heatmap: Array<{
    sourceId: string
    sourceTitle: string
    sourceNo: string | null
    version: string | null
    controlPointCount: number
    coveredCount: number
    coverageRate: number
    overdueTaskCount: number
  }>
  expiringRecords: Array<{
    recordId: string
    recordTitle: string
    requirementId: string
    sourceId: string
    taskId: string
    validUntil: string
    daysUntilExpiry: number
    severity: 'ORANGE' | 'RED' | 'ERROR'
  }>
  riskEvents: RiskItem[]
}

export const seListRisks = () =>
  nodeApi.get<unknown, ListResp<RiskItem>>('/api/admin/standard-execution/risks')
export const seListRisksEnterprise = () =>
  nodeApi.get<unknown, ListResp<RiskItem>>('/api/enterprise/standard-execution/risks')
export const seHandleRisk = (id: string) =>
  nodeApi.post<unknown, ItemResp<unknown>>(
    `/api/admin/standard-execution/risks/${encodeURIComponent(id)}/handle`,
    {},
  )

// ─── Dashboard ───────────────────────────────────────

export interface DashboardData {
  counts: {
    sources: number
    requirements: number
    requirementsActive: number
    tasks: number
    tasksDraft: number
    tasksPublished: number
    tasksCompleted: number
    tasksOverdue: number
    assigneesPending: number
    assigneesPendingReview: number
    assigneesCompleted: number
    submissionsPending: number
    packages: number
    packagesReady: number
    records: number
    recordsValid: number
    risks: number
  }
  recentTasks: Array<{ id: string; title: string; status: string; deadlineAt: string; publishedAt: string | null }>
  recentReviews: Array<{ id: string; taskId: string; assigneeId: string; version: number; submittedAt: string }>
  recentRecords: Array<{ id: string; title: string; taskId: string; assigneeId: string; recordDate: string }>
  complianceRadar: ComplianceRadarData
}

export const seGetDashboard = () =>
  nodeApi.get<unknown, ItemResp<DashboardData>>('/api/admin/standard-execution/dashboard')

export const seGetDashboardEnterprise = () =>
  nodeApi.get<unknown, ItemResp<DashboardData>>('/api/enterprise/standard-execution/dashboard')

export type IntelligenceRangeDays = 30 | 90 | 365

export interface IntelligenceTrendPoint {
  label: string
  startDate: string
  endDate: string
  total: number
  completed?: number
  approved?: number
  overdue?: number
  rate?: number
}

export interface IntelligenceDashboardData {
  generatedAt: string
  rangeDays: IntelligenceRangeDays
  range: { startDate: string; endDate: string }
  overview: {
    totalRequirements: number
    coveredRequirements: number
    uncoveredRequirements: number
    coverageRate: number
    tasksTotal: number
    tasksCompleted: number
    taskCompletionRate: number
    reviewsTotal: number
    reviewsApproved: number
    reviewPassRate: number
    overdueTasks: number
  }
  trends: {
    taskCompletion: IntelligenceTrendPoint[]
    reviewPass: IntelligenceTrendPoint[]
    overdue: IntelligenceTrendPoint[]
  }
  department: {
    visible: boolean
    rows: Array<{
      departmentId: string
      controlPointCount: number
      coveredCount: number
      coverageRate: number
      overdueTaskCount: number
    }>
  }
  people: {
    visible: boolean
    topExecutors: Array<{ userId: string; name: string; totalTasks: number; completedTasks: number; completionRate: number }>
    bottomExecutors: Array<{ userId: string; name: string; totalTasks: number; completedTasks: number; completionRate: number }>
    reviewEfficiency: Array<{ userId: string; name: string; reviewedCount: number; approvedCount: number; passRate: number; avgReviewHours: number }>
  }
}

export const seGetIntelligenceDashboard = (range: IntelligenceRangeDays) =>
  nodeApi.get<unknown, ItemResp<IntelligenceDashboardData>>('/api/admin/standard-execution/intelligence-dashboard', { params: { range } })
export const seGetIntelligenceDashboardEnterprise = (range: IntelligenceRangeDays) =>
  nodeApi.get<unknown, ItemResp<IntelligenceDashboardData>>('/api/enterprise/standard-execution/intelligence-dashboard', { params: { range } })
export const seExportIntelligenceDashboard = (range: IntelligenceRangeDays) =>
  nodeApi.get<unknown, Blob>('/api/admin/standard-execution/intelligence-dashboard/export', { params: { range }, responseType: 'blob' })
export const seExportIntelligenceDashboardEnterprise = (range: IntelligenceRangeDays) =>
  nodeApi.get<unknown, Blob>('/api/enterprise/standard-execution/intelligence-dashboard/export', { params: { range }, responseType: 'blob' })

// ─── Open API / Webhook ─────────────────────────────

export type EnterpriseApiScope = 'records:write' | 'tasks:read' | 'webhooks:manage'
export type EnterpriseWebhookEvent = 'task.completed' | 'record.created' | 'review.approved' | 'record.expiring'

export const ENTERPRISE_API_SCOPE_LABEL: Record<EnterpriseApiScope, string> = {
  'records:write': '写入证据',
  'tasks:read': '读取任务',
  'webhooks:manage': '管理 Webhook',
}

export const ENTERPRISE_WEBHOOK_EVENT_LABEL: Record<EnterpriseWebhookEvent, string> = {
  'task.completed': '任务完成',
  'record.created': '证据创建',
  'review.approved': '审核通过',
  'record.expiring': '证据到期',
}

export interface EnterpriseApiKey {
  id: string
  name: string
  scopes: EnterpriseApiScope[]
  lastUsedAt: string | null
  expiresAt: string | null
  isActive: boolean
  createdAt: string
  revokedAt: string | null
}

export interface EnterpriseWebhook {
  id: string
  url: string
  events: EnterpriseWebhookEvent[]
  isActive: boolean
  lastTriggeredAt: string | null
  createdAt: string
  updatedAt: string
}

export const seListEnterpriseApiKeys = () =>
  nodeApi.get<unknown, { data: EnterpriseApiKey[] }>('/api/enterprise/open-api/keys')
export const seCreateEnterpriseApiKey = (body: { name: string; scopes: EnterpriseApiScope[]; expiresAt?: string | null }) =>
  nodeApi.post<unknown, { data: EnterpriseApiKey; plainKey: string }>('/api/enterprise/open-api/keys', body)
export const seRevokeEnterpriseApiKey = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/open-api/keys/${id}`)

export const seListEnterpriseWebhooks = () =>
  nodeApi.get<unknown, { data: EnterpriseWebhook[] }>('/api/enterprise/open-api/webhooks')
export const seCreateEnterpriseWebhook = (body: { url: string; events: EnterpriseWebhookEvent[] }) =>
  nodeApi.post<unknown, { data: EnterpriseWebhook; secret: string }>('/api/enterprise/open-api/webhooks', body)
export const seUpdateEnterpriseWebhook = (id: string, body: { url?: string; events?: EnterpriseWebhookEvent[]; isActive?: boolean }) =>
  nodeApi.patch<unknown, { data: EnterpriseWebhook }>(`/api/enterprise/open-api/webhooks/${id}`, body)
export const seDisableEnterpriseWebhook = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/open-api/webhooks/${id}`)

// ─── 枚举常量（与后端 enums.ts 对齐）─────────────

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  PRODUCT_STANDARD: '产品标准',
  TECH_STANDARD: '技术标准',
  INTERNAL_POLICY: '内部制度',
  ENTERPRISE_POLICY: '企业制度',
  CHECKLIST: '检查清单',
  CUSTOM: '自定义',
}


export const REQUIREMENT_STATUS_LABEL: Record<string, string> = {
  DRAFT: '历史草稿',
  REVIEW_PENDING: '待审核',
  ACTIVE: '可派发',
  DISABLED: '已停用',
  ARCHIVED: '已删除',
}

export const REQUIREMENT_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  REVIEW_PENDING: 'orange',
  ACTIVE: 'green',
  DISABLED: 'default',
  ARCHIVED: 'red',
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审核',
  PUBLISHED: '已下发',
  IN_PROGRESS: '处理中',
  COMPLETED: '已完成',
  OVERDUE: '已逾期',
  CANCELLED: '已取消',
}

export const TASK_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  PENDING_APPROVAL: 'orange',
  PUBLISHED: 'blue',
  IN_PROGRESS: 'processing',
  COMPLETED: 'green',
  OVERDUE: 'red',
  CANCELLED: 'default',
}

export const ASSIGNEE_STATUS_LABEL: Record<string, string> = {
  PENDING: '待开始',
  IN_PROGRESS: '进行中',
  PENDING_REVIEW: '待审核',
  REJECTED: '已驳回',
  COMPLETED: '已完成',
  OVERDUE: '已逾期',
}

export const SUBMISSION_STATUS_LABEL: Record<string, string> = {
  SUBMITTED: '待审核',
  APPROVED: '已通过',
  REJECTED: '已驳回',
}

export const SUBMISSION_STATUS_COLOR: Record<string, string> = {
  SUBMITTED: 'orange',
  APPROVED: 'green',
  REJECTED: 'red',
}

export const RECORD_STATUS_LABEL: Record<string, string> = {
  VALID: '有效',
  EXPIRED: '已过期',
  VOID: '已作废',
}

export const RECORD_STATUS_COLOR: Record<string, string> = {
  VALID: 'green',
  EXPIRED: 'orange',
  VOID: 'red',
}

export const PACKAGE_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  READY: '已生成',
  VOID: '已作废',
}

export const PACKAGE_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  READY: 'green',
  VOID: 'red',
}

export const PACKAGE_SCENE_LABEL: Record<string, string> = {
  REGULATORY: '监管检查',
  CUSTOMER_AUDIT: '客户审厂',
  CERTIFICATION: '认证申请',
  INTERNAL_CHECK: '内部专项审计',
  TRAINING_ARCHIVE: '培训存档',
  OTHER: '其他',
}

export const RISK_TYPE_LABEL: Record<string, string> = {
  REQUIREMENT_NO_TASK: '执行要求未生成任务',
  TASK_OVERDUE: '任务逾期',
  ASSIGNEE_NOT_SUBMITTED: '执行人未提交',
  REVIEW_PENDING: '审核滞留',
}

export const RISK_LEVEL_COLOR: Record<string, string> = {
  HIGH: 'red',
  MEDIUM: 'orange',
  LOW: 'blue',
}

export const PARSE_MODE_LABEL: Record<string, string> = {
  OCR_AI: 'AI 解析（主力）',
  RULE: '规则模式',
  AI_STUB: '占位测试',
}

export const TASK_TYPE_LABEL: Record<string, string> = {
  TRAINING: '学习确认类',
  QUALIFICATION_MATERIAL: '资质材料类',
  ONBOARDING_ACCESS: '上岗准入类',
  INSPECTION_FILL: '检查填报类',
  RECTIFICATION: '整改闭环类',
  ARCHIVE_MATERIAL: '资料归档类',
  DOCUMENT_UPLOAD: '资料上传',
  PHOTO: '外观拍照',
  PARAMETER: '参数核查',
  OTHER: '其他',
}

export const STANDARD_TASK_TYPE_VALUES = [
  'TRAINING',
  'QUALIFICATION_MATERIAL',
  'ONBOARDING_ACCESS',
  'INSPECTION_FILL',
  'RECTIFICATION',
  'ARCHIVE_MATERIAL',
] as const

// ─── Plan ────────────────────────────────────────────

export type Plan = {
  id: string; enterpriseId: string; sourceId: string; title: string
  complianceCycleId?: string | null
  roundNumber: number; scheduledAt: string | null
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null
  startAt: string | null
  endAt: string | null
  nextRunAt: string | null
  lastRunAt: string | null
  defaultReviewerId: string | null
  defaultAssigneeIds: string[] | null
  defaultTaskType: string | null
  defaultDeadlineMode: 'FIXED' | 'AFTER_APPROVAL_DAYS'
  defaultDeadlineDaysAfterApproval: number | null
  status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  createdBy: string; createdAt: string; updatedAt: string
  tasks?: SeTask[]
}
export type PlanListResp = { data: Plan[]; total: number; page: number; pageSize: number }
export const seListPlans = (params?: { status?: string; page?: number; pageSize?: number }) =>
  nodeApi.get<unknown, PlanListResp>('/api/enterprise/standard-execution/plans', { params })
export const seGetPlan = (id: string) =>
  nodeApi.get<unknown, { data: Plan }>(`/api/enterprise/standard-execution/plans/${id}`)
export const seCreatePlan = (body: Partial<Plan> & { sourceId: string; title: string }) =>
  nodeApi.post<unknown, { data: Plan }>('/api/enterprise/standard-execution/plans', body)
export const seUpdatePlan = (id: string, body: Partial<Plan>) =>
  nodeApi.patch<unknown, { data: Plan }>(`/api/enterprise/standard-execution/plans/${id}`, body)
export const seCancelPlan = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/standard-execution/plans/${id}`)
export const seBindPlanTasks = (planId: string, taskIds: string[]) =>
  nodeApi.post<unknown, { ok: boolean; bound: number }>(`/api/enterprise/standard-execution/plans/${planId}/tasks`, { taskIds })
export const seUnbindPlanTask = (planId: string, taskId: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/standard-execution/plans/${planId}/tasks/${taskId}`)

export type ComplianceCycleType = 'ANNUAL' | 'QUARTERLY' | 'MONTHLY' | 'CUSTOM'
export type ComplianceCycleStatus = 'PLANNING' | 'ACTIVE' | 'COMPLETED'
export type ComplianceCycleTemplateStatus = 'ACTIVE' | 'DISABLED'

export const COMPLIANCE_CYCLE_TYPE_LABEL: Record<ComplianceCycleType, string> = {
  ANNUAL: '年度',
  QUARTERLY: '季度',
  MONTHLY: '月度',
  CUSTOM: '自定义',
}

export const COMPLIANCE_CYCLE_STATUS_LABEL: Record<ComplianceCycleStatus, string> = {
  PLANNING: '规划中',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
}

export type ComplianceCycleTaskConfig = {
  reviewerId?: string | null
  assigneeIds?: string[]
  taskType?: string | null
  taskStatus?: 'DRAFT' | 'PENDING_APPROVAL'
  deadlineMode?: 'FIXED' | 'AFTER_APPROVAL_DAYS'
  deadlineDaysAfterApproval?: number | null
  submitRequirement?: string | null
  titlePrefix?: string | null
}

export type ComplianceCycleTemplate = {
  id: string
  enterpriseId: string
  title: string
  cycleType: ComplianceCycleType
  requirementIds: string[]
  taskConfig?: ComplianceCycleTaskConfig | null
  status: ComplianceCycleTemplateStatus
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type ComplianceCycle = {
  id: string
  enterpriseId: string
  templateId: string
  planId: string | null
  title: string
  cycleType: ComplianceCycleType
  requirementIds: string[]
  taskConfig?: ComplianceCycleTaskConfig | null
  startDate: string
  endDate: string
  status: ComplianceCycleStatus
  reportStatus: 'IDLE' | 'READY' | 'FAILED'
  reportFileUrl: string | null
  reportGeneratedAt: string | null
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type ComplianceCycleDetailResp = {
  data: ComplianceCycle
  template: ComplianceCycleTemplate | null
  stats: {
    totalRequirements: number
    coveredRequirements: number
    progressPercent: number
    overdueTasks: number
    totalTasks: number
    completedTasks: number
  }
  requirements: Array<{
    id: string
    clauseNo: string | null
    title: string
    sourceTitle: string | null
    sourceNo: string | null
    status: 'COVERED' | 'DONE_NO_RECORD' | 'PENDING'
    taskCount: number
    latestRecordDate: string | null
    validUntil: string | null
  }>
  tasks: SeTask[]
}

export const seListComplianceCycleTemplates = (params?: { status?: string; cycleType?: string; page?: number; pageSize?: number }) =>
  nodeApi.get<unknown, { data: ComplianceCycleTemplate[]; total: number; page: number; pageSize: number }>('/api/enterprise/standard-execution/cycle-templates', { params })
export const seCreateComplianceCycleTemplate = (body: {
  title: string
  cycleType: ComplianceCycleType
  requirementIds: string[]
  taskConfig?: ComplianceCycleTaskConfig
}) => nodeApi.post<unknown, { data: ComplianceCycleTemplate }>('/api/enterprise/standard-execution/cycle-templates', body)
export const seStartComplianceCycle = (templateId: string, body: {
  title?: string
  startDate: string
  endDate: string
} & ComplianceCycleTaskConfig) =>
  nodeApi.post<unknown, { data: ComplianceCycle; plan: Plan; createdTasks: number; createdItems: number }>(`/api/enterprise/standard-execution/cycle-templates/${templateId}/start`, body)
export const seListComplianceCycles = (params?: { status?: string; templateId?: string; page?: number; pageSize?: number }) =>
  nodeApi.get<unknown, { data: ComplianceCycle[]; total: number; page: number; pageSize: number }>('/api/enterprise/standard-execution/cycles', { params })
export const seGetComplianceCycle = (id: string) =>
  nodeApi.get<unknown, ComplianceCycleDetailResp>(`/api/enterprise/standard-execution/cycles/${id}`)
export const seGenerateComplianceCycleReport = (id: string) =>
  nodeApi.post<unknown, { data: ComplianceCycle; fileUrl: string; fileName: string }>(`/api/enterprise/standard-execution/cycles/${id}/report`, {})

export const PLAN_STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  ACTIVE: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

export const PLAN_STATUS_COLOR: Record<string, string> = {
  DRAFT: 'default',
  ACTIVE: 'processing',
  COMPLETED: 'success',
  CANCELLED: 'error',
}

// ═══ 批量操作（软删 / 作废 / 发布 / 指派 / 移除）═══════
// 后端 URL：/api/{admin|enterprise}/standard-execution/{entity}/batch-{action}
// 统一返回 { ok, requested, skipped }；前端按 skipped>0 提示「N 条因状态/权限跳过」。
export interface BatchResp {
  ok: number
  requested: number
  skipped: number
}

export const seBatchDisableSources = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/sources/batch-disable', { ids })
export const seBatchDisableSourcesEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/sources/batch-disable', { ids })

export const seBatchArchiveRequirements = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/requirements/batch-archive', { ids })
export const seBatchArchiveRequirementsEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/requirements/batch-archive', { ids })

// ── 来源批量删除 ──
export const seBatchDeleteSources = (ids: string[]) =>
  nodeApi.post<unknown, { deleted: number }>('/api/admin/standard-execution/sources/batch-delete', { ids })
export const seBatchDeleteSourcesEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, { deleted: number }>('/api/enterprise/standard-execution/sources/batch-delete', { ids })

// ── 执行要求批量启用 / 停用 / 删除 ──
export const seBatchActivateRequirements = (ids: string[]) =>
  nodeApi.post<unknown, { updated: number }>('/api/admin/standard-execution/requirements/batch-activate', { ids })
export const seBatchActivateRequirementsEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, { updated: number }>('/api/enterprise/standard-execution/requirements/batch-activate', { ids })
export const seBatchDisableRequirements = (ids: string[]) =>
  nodeApi.post<unknown, { updated: number }>('/api/admin/standard-execution/requirements/batch-disable', { ids })
export const seBatchDisableRequirementsEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, { updated: number }>('/api/enterprise/standard-execution/requirements/batch-disable', { ids })

export type RequirementDeleteDetail =
  | { id: string; action: 'deleted'; reason: 'NO_ASSOCIATION' }
  | {
      id: string
      action: 'archived'
      reason: 'HAS_HISTORY'
      associations: {
        tasks: number
        taskItems: number
        records: number
        packageItems: number
      }
    }
  | { id: string; action: 'skipped'; reason: 'NOT_FOUND' }

export interface RequirementDeleteResp {
  requested: number
  deleted: number
  archived: number
  skipped: number
  details: RequirementDeleteDetail[]
}

export const seBatchDeleteRequirements = (ids: string[]) =>
  nodeApi.post<unknown, RequirementDeleteResp>('/api/admin/standard-execution/requirements/batch-delete', { ids })
export const seBatchDeleteRequirementsEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, RequirementDeleteResp>('/api/enterprise/standard-execution/requirements/batch-delete', { ids })

export const seBatchCancelTasks = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/tasks/batch-cancel', { ids })
export const seBatchCancelTasksEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/tasks/batch-cancel', { ids })
export const seBatchPublishTasks = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/tasks/batch-publish', { ids })
export const seBatchPublishTasksEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/tasks/batch-publish', { ids })
export const seBatchAssignTasks = (ids: string[], reviewerId: string, assigneeIds: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/tasks/batch-assign', { ids, reviewerId, assigneeIds })
export const seBatchAssignTasksEnterprise = (ids: string[], reviewerId: string, assigneeIds: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/tasks/batch-assign', { ids, reviewerId, assigneeIds })
// 软删除（仅 admin 端；仅 DRAFT 可删）
export const seDeleteTask = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/admin/standard-execution/tasks/${id}`)
export const seBatchDeleteTasks = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/tasks/batch-delete', { ids })

export const seBatchVoidRecords = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/records/batch-void', { ids })
export const seBatchVoidRecordsEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/records/batch-void', { ids })

export const seBatchVoidPackages = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/admin/standard-execution/packages/batch-void', { ids })
export const seBatchVoidPackagesEnterprise = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/standard-execution/packages/batch-void', { ids })

export const seBatchRemoveMembers = (ids: string[]) =>
  nodeApi.post<unknown, BatchResp>('/api/enterprise/members/batch-remove', { ids })

// ─── Plan TaskItem（Step D）──────────────────────────

export interface TaskItemVO {
  id: string
  taskId: string
  requirementId: string
  status: 'PENDING' | 'DONE' | 'SKIPPED'
  note: string | null
  fileUrls: string[]
  completedAt: string | null
  requirement?: {
    title: string
    clauseNo: string | null
    requirementText: string
  }
}

export interface GeneratePlanTasksBody {
  requirementIds: string[]
  taskType: string
  taskStatus?: 'DRAFT' | 'PENDING_APPROVAL'
  reviewerId: string
  assigneeIds: string[]
  deadlineAt?: string
  deadlineMode?: 'FIXED' | 'AFTER_APPROVAL_DAYS'
  deadlineDaysAfterApproval?: number | null
  submitRequirement?: string
  titlePrefix?: string
}

export interface GeneratePlanTasksResp {
  ok: boolean
  createdTasks: number
  createdItems: number
  skippedExisting?: number
  taskStatus?: 'DRAFT' | 'PENDING_APPROVAL'
}

export const seGeneratePlanTasks = (planId: string, body: GeneratePlanTasksBody) =>
  nodeApi.post<unknown, GeneratePlanTasksResp>(
    `/api/enterprise/standard-execution/plans/${planId}/generate-tasks`,
    body,
  )

export const seGetTaskItems = (taskId: string) =>
  nodeApi.get<unknown, { data: TaskItemVO[] }>(
    `/api/app/standard-execution/tasks/${taskId}/items`,
  )

export const sePatchTaskItem = (
  taskId: string,
  itemId: string,
  body: { status?: 'DONE' | 'SKIPPED'; note?: string; fileUrls?: string[] },
) =>
  nodeApi.patch<unknown, { data: TaskItemVO }>(
    `/api/app/standard-execution/tasks/${taskId}/items/${itemId}`,
    body,
  )

// ═══ 纯前端 CSV 导出 ═══════════════════════════════════
// @deprecated F6 产品裁决：标准执行企业侧不再暴露 CSV 导出入口；仅保留历史调用兼容。
export function exportRowsToCsv(
  filename: string,
  headers: { key: string; label: string }[],
  rows: Record<string, unknown>[],
) {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = headers.map((h) => escape(h.label)).join(',')
  const body = rows.map((r) => headers.map((h) => escape(r[h.key])).join(',')).join('\n')
  const csv = '﻿' + head + '\n' + body
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ═══ 题库 ═══════════════════════════════════════════════════════════════════
export interface QuizQuestion {
  id: string
  type: 'single' | 'multi'
  text: string
  opts: string[]
  answer: number[]
  score: number
  exp?: string
  relatedRequirementId?: string | null // P1-9: AI 出题来源执行要求（选填）
}

export interface QuestionBank {
  id: string
  title: string
  description?: string | null
  questions: QuizQuestion[]
  questionCount?: number
  taskCount?: number
  createdAt: string
  updatedAt: string
}

export const seListQuestionBanks = (params?: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<QuestionBank>>('/api/admin/standard-execution/question-banks', { params })

export const seGetQuestionBank = (id: string) =>
  nodeApi.get<unknown, QuestionBank>(`/api/admin/standard-execution/question-banks/${id}`)

export const seCreateQuestionBank = (data: { title: string; description?: string | null; questions: QuizQuestion[] }) =>
  nodeApi.post<unknown, QuestionBank>('/api/admin/standard-execution/question-banks', data)

export const seUpdateQuestionBank = (id: string, data: Partial<{ title: string; description: string | null; questions: QuizQuestion[] }>) =>
  nodeApi.patch<unknown, QuestionBank>(`/api/admin/standard-execution/question-banks/${id}`, data)

export const seDeleteQuestionBank = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/admin/standard-execution/question-banks/${id}`)

// 企业版（/enterprise 门户用，enterpriseId 隔离）
export const seListQuestionBanksEnterprise = (params?: Record<string, unknown>) =>
  nodeApi.get<unknown, ListResp<QuestionBank>>('/api/enterprise/standard-execution/question-banks', { params })
export const seGetQuestionBankEnterprise = (id: string) =>
  nodeApi.get<unknown, QuestionBank>(`/api/enterprise/standard-execution/question-banks/${id}`)
export const seCreateQuestionBankEnterprise = (data: { title: string; description?: string | null; questions: QuizQuestion[] }) =>
  nodeApi.post<unknown, QuestionBank>('/api/enterprise/standard-execution/question-banks', data)
export const seUpdateQuestionBankEnterprise = (id: string, data: Partial<{ title: string; description: string | null; questions: QuizQuestion[] }>) =>
  nodeApi.patch<unknown, QuestionBank>(`/api/enterprise/standard-execution/question-banks/${id}`, data)
export const seDeleteQuestionBankEnterprise = (id: string) =>
  nodeApi.delete<unknown, { ok: boolean }>(`/api/enterprise/standard-execution/question-banks/${id}`)

// P1-9 题库 AI 生成题目（仅 enterprise 端点；admin token 经 resolveEnterpriseId 通配 DEFAULT 也可用）
export const seAiGenerateQuestions = (data: {
  requirementId?: string
  requirementText?: string
  count: number
  questionType: 'SINGLE' | 'MULTI' | 'TRUEFALSE'
  difficulty: 'BASIC' | 'MEDIUM' | 'HARD'
}) => nodeApi.post<unknown, { data: { questions: QuizQuestion[] } }>('/api/enterprise/standard-execution/question-banks/ai-generate', data)
