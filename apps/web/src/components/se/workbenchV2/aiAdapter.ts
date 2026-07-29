/**
 * 工作台 v2 的 AI 调用隔离层。
 *
 * 目的：UI 只依赖本文件，不直接依赖后端形状。
 * - preview+polish：契约 v1（main 已有），真实端点；VITE_SE_WORKBENCH_MOCK 时走本地样例。
 * - P2 三能力（单卡 AI 重写 / 批量 AI 优化 / 整体重提取）：等 Codex 契约 v2（今晚），
 *   先留 stub，签名稳定，UI 可先接线，契约到位后只换本文件实现。
 */
import {
  sePreviewTaskGenerationV2,
  sePreviewTaskGenerationV2Enterprise,
  seStartTaskGenerationPreviewJob,
  seStartTaskGenerationPreviewJobEnterprise,
  seGetTaskGenerationPreviewJob,
  seGetTaskGenerationPreviewJobEnterprise,
  seListTaskGenerationPreviewJobs,
  seListTaskGenerationPreviewJobsEnterprise,
  seGetTaskGenerationConfig,
  seGetTaskGenerationConfigEnterprise,
  seRewriteTaskCard,
  seRewriteTaskCardEnterprise,
  seRepolishTaskCards,
  seRepolishTaskCardsEnterprise,
  seReextractTaskGeneration,
  seReextractTaskGenerationEnterprise,
  type TaskCardRewriteBody,
  type TaskCardRewriteResp,
  type TaskCardsRepolishBody,
  type TaskCardsRepolishResp,
  type TaskCardV2,
  type TaskGenerationPreviewV2Body,
  type TaskGenerationPreviewV2Resp,
  type TaskGenerationPreviewJobResp,
  type TaskGenerationRuntimeConfig,
  type TaskGenerationReExtractBody,
  type TaskGenerationReExtractResp,
} from '../../../api/standardExecution'

export type WorkbenchScope = 'admin' | 'enterprise'
export type PreviewJobProgress = TaskGenerationPreviewJobResp

const MOCK =
  import.meta.env.VITE_SE_WORKBENCH_MOCK === '1' || import.meta.env.VITE_SE_WORKBENCH_MOCK === 'true'

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
const PREVIEW_JOB_POLL_LIMIT = 180

function previewJobError(job: TaskGenerationPreviewJobResp) {
  return Object.assign(new Error(job.error?.message || '任务草稿异步解析失败'), {
    response: { status: job.error?.status || 500, data: { error: job.error?.message || '任务草稿异步解析失败' } },
  })
}

async function waitForPreviewJob(
  scope: WorkbenchScope,
  initialJob: TaskGenerationPreviewJobResp,
  onProgress?: (job: PreviewJobProgress) => void,
): Promise<TaskGenerationPreviewV2Resp> {
  const getFn = scope === 'enterprise' ? seGetTaskGenerationPreviewJobEnterprise : seGetTaskGenerationPreviewJob
  let job = initialJob
  onProgress?.(job)
  for (let i = 0; i < PREVIEW_JOB_POLL_LIMIT; i++) {
    if (job.status === 'SUCCEEDED') {
      if (!job.result) throw new Error('异步解析任务缺少结果')
      return job.result
    }
    if (job.status === 'FAILED') throw previewJobError(job)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    job = (await getFn(job.id)).data
    onProgress?.(job)
  }
  throw Object.assign(new Error('任务草稿异步解析仍在进行，请稍后重试'), {
    response: { status: 202, data: { error: '任务草稿异步解析仍在进行，请稍后重试' } },
  })
}

export async function getWorkbenchRuntimeConfig(scope: WorkbenchScope): Promise<TaskGenerationRuntimeConfig> {
  if (MOCK) return DEFAULT_RUNTIME_CONFIG
  const fn = scope === 'enterprise' ? seGetTaskGenerationConfigEnterprise : seGetTaskGenerationConfig
  return (await fn()).data
}

/** preview + AI 润色，返回 v2 形态（含 taskCards） */
export async function previewWorkbench(
  scope: WorkbenchScope,
  body: TaskGenerationPreviewV2Body,
  onProgress?: (job: PreviewJobProgress) => void,
): Promise<TaskGenerationPreviewV2Resp> {
  const payload: TaskGenerationPreviewV2Body = {
    ...body,
    polish: body.polish ?? { enabled: true, target: 'TASK_CARD_V2' },
  }
  if (MOCK) return mockPreview(payload)
  if (!onProgress) {
    const fn = scope === 'enterprise' ? sePreviewTaskGenerationV2Enterprise : sePreviewTaskGenerationV2
    const res = await fn(payload)
    return res.data
  }
  const startFn = scope === 'enterprise' ? seStartTaskGenerationPreviewJobEnterprise : seStartTaskGenerationPreviewJob
  const job = (await startFn(payload)).data
  return waitForPreviewJob(scope, job, onProgress)
}

export async function restoreLatestPreviewJob(
  scope: WorkbenchScope,
  sourceId: string,
  onProgress?: (job: PreviewJobProgress) => void,
): Promise<{ job: PreviewJobProgress; result: TaskGenerationPreviewV2Resp } | null> {
  if (MOCK || !sourceId) return null
  const listFn = scope === 'enterprise' ? seListTaskGenerationPreviewJobsEnterprise : seListTaskGenerationPreviewJobs
  const latest = (await listFn({ sourceId, limit: 1 })).data[0]
  if (!latest) return null
  const result = await waitForPreviewJob(scope, latest, onProgress)
  return { job: latest, result }
}

// ─── P2 三能力：契约 §6（单卡重写 / 批量重润色 / 整体重提取）───

/** 单卡 AI 重写 */
export async function aiRewriteCard(scope: WorkbenchScope, body: TaskCardRewriteBody): Promise<TaskCardRewriteResp> {
  if (MOCK) return mockRewrite(body)
  const fn = scope === 'enterprise' ? seRewriteTaskCardEnterprise : seRewriteTaskCard
  return (await fn(body)).data
}

/** 批量重润色（≤24 张/批，调用方负责拆批） */
export async function aiBatchRepolish(scope: WorkbenchScope, body: TaskCardsRepolishBody): Promise<TaskCardsRepolishResp> {
  if (MOCK) return mockRepolish(body)
  const fn = scope === 'enterprise' ? seRepolishTaskCardsEnterprise : seRepolishTaskCards
  return (await fn(body)).data
}

/** 整体重新提取 + 润色（替换当前草稿集） */
export async function aiReextract(scope: WorkbenchScope, body: TaskGenerationReExtractBody): Promise<TaskGenerationReExtractResp> {
  const payload: TaskGenerationReExtractBody = { ...body, polish: body.polish ?? { enabled: true, target: 'TASK_CARD_V2' } }
  if (MOCK) return { ...(await mockPreview(payload)), operation: 'RE_EXTRACT' }
  const fn = scope === 'enterprise' ? seReextractTaskGenerationEnterprise : seReextractTaskGeneration
  return (await fn(payload)).data
}

const opSummary = (inputCards: number): TaskCardsRepolishResp['polish'] => ({
  enabled: true,
  status: 'SUCCEEDED',
  degraded: false,
  degradedReason: null,
  warnings: [],
  stats: { inputCards, outputCards: inputCards, aiCards: inputCards, fallbackCards: 0, batches: 1, failedBatches: 0, durationMs: 700 },
})

function rewriteCardMock(card: TaskCardV2): TaskCardV2 {
  return {
    ...card,
    title: card.title.replace(/（AI 重写）$/, '') + '（AI 重写）',
    description: `（已按要求重写）${card.description}`,
    polishStatus: 'AI_POLISHED',
    warnings: [],
  }
}

function cardToDraftForCommit(card: TaskCardV2) {
  return {
    taskDraftId: card.taskDraftId,
    groupId: card.groupId,
    title: card.title,
    description: card.description,
    taskType: card.taskType,
    submitRequirement: card.submitRequirement,
  }
}

function mockRewrite(body: TaskCardRewriteBody): Promise<TaskCardRewriteResp> {
  const taskCard = rewriteCardMock(body.card)
  return new Promise((resolve) =>
    setTimeout(() => resolve({ operation: 'CARD_REWRITE', polish: opSummary(1), taskCard, taskDraft: cardToDraftForCommit(taskCard) }), 500),
  )
}

function mockRepolish(body: TaskCardsRepolishBody): Promise<TaskCardsRepolishResp> {
  const taskCards = body.cards.map(rewriteCardMock)
  return new Promise((resolve) =>
    setTimeout(() => resolve({ operation: 'BATCH_REPOLISH', polish: opSummary(taskCards.length), taskCards, taskDrafts: taskCards.map(cardToDraftForCommit) }), 700),
  )
}

// ─── 本地 mock（后端未就绪时联调用，按契约 §6 形状）───

function mockPreview(body: TaskGenerationPreviewV2Body): Promise<TaskGenerationPreviewV2Resp> {
  const resp: TaskGenerationPreviewV2Resp = {
    source: body.sourceId
      ? { id: body.sourceId, title: '保安服务管理标准（样例）', sourceNo: 'SMK-2026', sourceType: 'PRODUCT_STANDARD', version: '2026' }
      : { id: 'mock', title: '临时原文（样例）', sourceNo: null, sourceType: 'PRODUCT_STANDARD', version: null },
    requestedMode: (body.parseMode as TaskGenerationPreviewV2Resp['requestedMode']) || 'OCR_AI',
    parseMode: (body.parseMode as TaskGenerationPreviewV2Resp['parseMode']) || 'OCR_AI',
    degraded: false,
    degradedReason: null,
    warnings: [],
    rejectedCount: 0,
    polish: {
      enabled: true,
      status: 'SUCCEEDED',
      degraded: false,
      degradedReason: null,
      warnings: [],
      stats: { inputDrafts: 3, outputCards: 3, aiCards: 3, fallbackCards: 0, batches: 1, failedBatches: 0, durationMs: 1200 },
    },
    drafts: MOCK_SEEDS.map((s) => ({
      draftId: s.draftId,
      groupId: s.draftId,
      clauseNo: s.clauseNo,
      title: s.shortTitle,
      requirementText: s.excerpt,
      recommendedTaskType: s.taskType,
      executionDescription: s.description,
      submitRequirement: s.submitRequirement,
      requiredMaterials: s.materials,
      taskDrafts: [
        {
          taskDraftId: s.taskDraftId,
          groupId: s.draftId,
          title: s.title,
          description: s.description,
          taskType: s.taskType,
          submitRequirement: s.submitRequirement,
        },
      ],
    })),
    taskCards: MOCK_SEEDS.map((s) => ({
      id: s.taskDraftId,
      draftId: s.draftId,
      taskDraftId: s.taskDraftId,
      groupId: s.draftId,
      title: s.title,
      description: s.description,
      submitRequirement: s.submitRequirement,
      taskType: s.taskType,
      requiredMaterials: s.materials,
      deadlineSuggestion: {
        mode: 'AFTER_APPROVAL_DAYS',
        daysAfterApproval: s.days,
        fixedAt: null,
        label: `审核通过后 ${s.days} 天内完成`,
        reason: s.reason,
      },
      basis: { sourceId: 'mock', sourceTitle: '保安服务管理标准（样例）', clauseNo: s.clauseNo, excerpt: s.excerpt },
      polishStatus: 'AI_POLISHED',
      warnings: [],
    })),
    candidateV2Enabled: true,
    candidateRequirements: [
      ...MOCK_SEEDS.map((s, index) => ({
        clauseNo: s.clauseNo,
        sourceText: s.excerpt,
        action: s.description,
        responsibleRole: index === 1 ? '培训负责人' : '项目主管',
        evidenceType: s.materials.join('、'),
        frequency: index === 1 ? 'ONCE' : 'MONTHLY',
        riskLevel: index === 0 ? 'HIGH' : 'MEDIUM',
        suggestedTaskType: s.taskType,
        score: index === 1 ? 82 : 88,
        mergeable: true,
        mergeReason: '同责任对象与证据类型可聚合',
      })),
      {
        clauseNo: '8.4',
        sourceText: '8.4 客户投诉应形成原因分析，可作为服务改进依据。',
        action: '汇总客户投诉并形成服务改进分析',
        responsibleRole: '客服主管',
        evidenceType: '投诉分析记录',
        frequency: 'MONTHLY',
        riskLevel: 'LOW',
        suggestedTaskType: 'ARCHIVE_MATERIAL',
        score: 66,
        mergeable: true,
        mergeReason: '作为关联要求保留，暂不独立成任务',
      },
    ],
    candidateScoreDistribution: {
      total: 4,
      belowTaskThreshold: 0,
      associatedOnly: 1,
      taskEligible: 3,
      buckets: { lt60: 0, s60to74: 1, gte75: 3 },
    },
    candidateThresholds: { candidateMinScore: 60, taskMinScore: 75 },
    taskPackages: MOCK_SEEDS.map((s, index) => ({
      packageId: `pkg-mock-${index + 1}`,
      groupId: s.draftId,
      key: {
        taskType: s.taskType,
        responsibleRole: index === 1 ? '培训负责人' : '项目主管',
        evidenceType: s.materials.join('、'),
      },
      title: s.title,
      description: s.description,
      submitRequirement: s.submitRequirement,
      taskType: s.taskType,
      responsibleRole: index === 1 ? '培训负责人' : '项目主管',
      evidenceType: s.materials.join('、'),
      frequency: index === 1 ? 'ONCE' : 'MONTHLY',
      riskLevel: index === 0 ? 'HIGH' : 'MEDIUM',
      score: index === 1 ? 82 : 88,
      candidateCount: 1,
      candidateIndexes: [index],
      clauseNos: [s.clauseNo],
      draftIds: [s.draftId],
      requiredMaterials: s.materials,
      mergeMode: 'DETERMINISTIC',
      warnings: [],
    })),
    coverageReport: {
      totalCandidates: 4,
      taskPackageCount: 3,
      candidateOnlyCount: 1,
      entries: [
        ...MOCK_SEEDS.map((s, index) => ({
          candidateIndex: index,
          clauseNo: s.clauseNo,
          sourceText: s.excerpt,
          score: index === 1 ? 82 : 88,
          destination: 'TASK_PACKAGE' as const,
          packageId: `pkg-mock-${index + 1}`,
          reason: '进入同硬键任务包',
        })),
        {
          candidateIndex: 3,
          clauseNo: '8.4',
          sourceText: '8.4 客户投诉应形成原因分析，可作为服务改进依据。',
          score: 66,
          destination: 'ASSOCIATED_CANDIDATE',
          packageId: null,
          reason: 'score 66 位于关联要求区间',
        },
      ],
    },
  }
  return new Promise((resolve) => setTimeout(() => resolve(resp), 600))
}

const MOCK_SEEDS = [
  {
    draftId: 'draft-1',
    taskDraftId: 'task-draft-1',
    clauseNo: '5.2.1',
    shortTitle: '保安员持证上岗',
    title: '检查保安员保安服务资格证有效期',
    description: '逐一核对在岗保安员的保安服务资格证，确认证件在有效期内，记录姓名、证号、到期日；临期（30 天内到期）的列入续证清单。',
    submitRequirement: '上传保安员持证花名册截图或台账，含证号与到期日字段。',
    taskType: 'QUALIFICATION_MATERIAL',
    materials: ['保安员持证花名册', '临期续证清单'],
    days: 30,
    reason: '条款要求持证上岗，证件需在有效期内',
    excerpt: '5.2.1 保安服务公司应确保从业的保安员均持有有效的保安员证，并在有效期内上岗。',
  },
  {
    draftId: 'draft-2',
    taskDraftId: 'task-draft-2',
    clauseNo: '6.3',
    shortTitle: '岗前培训',
    title: '完成新入职保安员岗前培训并留存记录',
    description: '对新入职保安员开展岗前培训，覆盖服务规范、应急处置、法律法规；培训结束组织考核，留存签到表、课件与考核成绩。',
    submitRequirement: '上传岗前培训签到表、培训照片与考核成绩单。',
    taskType: 'TRAINING',
    materials: ['培训签到表', '考核成绩单'],
    days: 15,
    reason: '条款要求岗前培训',
    excerpt: '6.3 保安服务公司应对新入职保安员进行岗前培训，经考核合格后方可上岗。',
  },
  {
    draftId: 'draft-3',
    taskDraftId: 'task-draft-3',
    clauseNo: '7.1',
    shortTitle: '装备月检',
    title: '每月检查保安装备完好并登记',
    description: '每月对对讲机、防护器械、监控设备等保安装备进行完好性检查，登记设备编号、检查结果与异常处置情况。',
    submitRequirement: '上传装备月检表或台账截图。',
    taskType: 'INSPECTION_FILL',
    materials: ['装备月检表'],
    days: 30,
    reason: '条款要求按月确认装备状态',
    excerpt: '7.1 保安服务公司应定期检查、维护保安装备，确保其处于完好可用状态。',
  },
]
