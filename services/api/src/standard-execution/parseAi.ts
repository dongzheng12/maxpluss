/**
 * standard-execution / OCR_AI 模式解析（doc §七.1 主力）
 *
 * 纯函数：拿 rawText + aiCaller → 返回 RequirementDraft[]。
 * 任一环节失败（aiCaller 异常 / 非法 JSON / 校验失败）都通过抛错由路由层降级到 RULE。
 *
 * Prompt 模板严格对齐 doc §七.1。
 */
import { z } from 'zod'
import type { CandidateRequirement, CandidateScoreDistribution, RequirementDraft } from './types.js'
import { normalizeStandardTextForParsing } from './parseRule.js'
import { getCandidateRequirementMinScore, getCandidateTaskMinScore, isCandidateV2Enabled } from './parseRuntimeConfig.js'

const AI_SUGGESTED_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const

/** AI 模式返回 JSON 的单条结构（仅 parseAi 使用，避免扩大 M5 改动面） */
const AI_RECOMMENDED_TASK_TYPES = ['TRAINING', 'QUALIFICATION_MATERIAL', 'ONBOARDING_ACCESS', 'INSPECTION_FILL', 'RECTIFICATION', 'ARCHIVE_MATERIAL'] as const
const AiRequirementJsonSchema = z.object({
  clauseNo: z.string().optional().nullable(),
  title: z.string(),
  requirementText: z.string(),
  executionDescription: z.string().optional(),
  recommendedTaskType: z.enum(AI_RECOMMENDED_TASK_TYPES).optional(),
  suggestedDepartment: z.string().optional(),
  suggestedFrequency: z.enum(AI_SUGGESTED_FREQUENCIES).optional(),
  submitRequirement: z.string().optional(),
  requiredMaterials: z.array(z.string()).optional(),
})
const AiRequirementJsonArraySchema = z.array(AiRequirementJsonSchema)
const AiCandidateRequirementJsonSchema = z.object({
  clauseNo: z.string().optional().nullable(),
  sourceText: z.string(),
  action: z.string(),
  responsibleRole: z.string().optional().nullable(),
  evidenceType: z.string().optional().nullable(),
  frequency: z.string().optional().nullable(),
  riskLevel: z.string().optional().nullable(),
  suggestedTaskType: z.enum(AI_RECOMMENDED_TASK_TYPES).optional().nullable(),
  score: z.coerce.number().min(0).max(100),
  mergeable: z.boolean().optional().default(true),
  mergeReason: z.string().optional().nullable(),
})
const AiCandidateResponseSchema = z.object({
  candidateRequirements: z.array(AiCandidateRequirementJsonSchema),
})

const LEGACY_FEW_SHOT_EXAMPLES = `few-shot 示例（来自 scripts/seed-se-local.ts 的 SE 本地演示标准与要求项）：
输入条款：
4.1 企业应建立并保存标准执行记录，记录应包含责任人、时间、结果和整改情况。
期望 JSON：
{
  "clauseNo": "4.1",
  "title": "岗位培训确认",
  "requirementText": "4.1 岗位培训确认：企业应按标准要求完成执行、记录和归档。",
  "executionDescription": "组织岗位人员完成标准执行培训，上传签到表和考核结果。",
  "recommendedTaskType": "TRAINING",
  "suggestedDepartment": "生产部",
  "suggestedFrequency": "YEARLY",
  "submitRequirement": "提交「岗位培训确认」相关证明材料",
  "requiredMaterials": ["岗位培训确认记录", "现场照片或截图"]
}

输入条款：
4.2 相关岗位人员应接受标准执行培训并通过考核。
期望 JSON：
{
  "clauseNo": "4.2",
  "title": "资质材料维护",
  "requirementText": "4.2 资质材料维护：企业应按标准要求完成执行、记录和归档。",
  "executionDescription": "核查人员或供应商资质有效期，上传证书或资质清单。",
  "recommendedTaskType": "QUALIFICATION_MATERIAL",
  "suggestedDepartment": "质量部",
  "suggestedFrequency": "YEARLY",
  "submitRequirement": "提交「资质材料维护」相关证明材料",
  "requiredMaterials": ["资质材料维护记录", "现场照片或截图"]
}`

const LEGACY_PROMPT_TEMPLATE = `你是标准合规专家。下面是一份技术标准原文。
请从中提取所有可执行的要求项，返回 JSON 数组，不要有任何其他文字。

每条要求项包含以下字段：
- clauseNo: 条款编号（如 5.1a、5.7.2.1，没有则留空字符串）
- title: 简短标题，不超过15字
- requirementText: 完整要求原文，保留数值和单位
- executionDescription: 可落地执行描述。不要复述原文，转成现场人员能理解、能提交材料的执行说明（核查什么、怎么做、需要什么证据）
- recommendedTaskType: 推荐任务类型，只能取 TRAINING / QUALIFICATION_MATERIAL / ONBOARDING_ACCESS / INSPECTION_FILL / RECTIFICATION / ARCHIVE_MATERIAL
- suggestedDepartment: 适用部门，字符串，例如"质检部""生产部""安全部"
- suggestedFrequency: 建议执行频率，只能取 MONTHLY / QUARTERLY / YEARLY
- submitRequirement: 执行人需提交什么才算完成（如"上传台账/记录截图/检测报告"）
- requiredMaterials: 需提交的材料清单，字符串数组（如 ["安全台账","检查记录"]）

executionDescription 示例：
  输入条款："企业应建立安全生产记录档案并妥善保存。"
  输出："核查企业是否已建立安全生产记录档案，重点检查记录是否含责任人、检查时间、检查内容、整改情况及归档位置；执行时上传相关台账、记录截图或档案目录。"

提取规则：
1. 只提取有明确执行动作的要求（验收、测试、检查、记录、配置等）
2. 跳过：纯定义条款、引用说明（"符合XX标准"本身）、表格注释、前言
3. 数值约束（≤15s、≥IP65、不小于500N）必须完整保留在 requirementText 中
4. executionDescription 必须是可执行说明，不允许只复述原文

{fewShotExamples}

标准原文：
{rawText}`

export const FEW_SHOT_EXAMPLES = `few-shot 示例（安保行业候选要求，不直接生成任务卡）：
输入条款：
4.1 门岗值守人员应核验来访人员身份，登记姓名、单位、联系方式、来访事由和进出时间。
期望 JSON：
{
  "candidateRequirements": [
    {
      "clauseNo": "4.1",
      "sourceText": "门岗值守人员应核验来访人员身份，登记姓名、单位、联系方式、来访事由和进出时间。",
      "action": "门岗核验来访人员身份并完整登记进出信息",
      "responsibleRole": "门岗值守人员",
      "evidenceType": "来访登记台账或门岗系统截图",
      "frequency": "每次来访",
      "riskLevel": "MEDIUM",
      "suggestedTaskType": "INSPECTION_FILL",
      "score": 88,
      "mergeable": true,
      "mergeReason": "可与同一门岗登记章节内的身份核验、访客记录要求合并为门岗值守检查包"
    }
  ]
}

输入条款：
5.3 保安员应每季度参加岗位培训和应急处置考核，考核记录应保存不少于一年。
期望 JSON：
{
  "candidateRequirements": [
    {
      "clauseNo": "5.3",
      "sourceText": "保安员应每季度参加岗位培训和应急处置考核，考核记录应保存不少于一年。",
      "action": "组织保安员完成季度岗位培训和应急处置考核",
      "responsibleRole": "培训负责人",
      "evidenceType": "培训签到表、考核成绩单、培训课件",
      "frequency": "每季度",
      "riskLevel": "HIGH",
      "suggestedTaskType": "TRAINING",
      "score": 92,
      "mergeable": true,
      "mergeReason": "培训、考核、记录保存属于同一培训闭环，可合并成一张培训考核任务包"
    }
  ]
}`

const PROMPT_TEMPLATE = `你是安保行业标准执行顾问。下面是一份标准原文片段。
请只做第一轮 candidateRequirements 提取，不要生成任务卡，不要聚合，不要写 UI 文案。返回 JSON 对象，不要有任何其他文字。

返回格式：
{
  "candidateRequirements": [
    {
      "clauseNo": "条款编号，没有则为空字符串",
      "sourceText": "可追溯的原文要求，必须保留关键数值、频率、证据要求",
      "action": "现场可执行动作，用一句话说明谁要做什么",
      "responsibleRole": "责任对象/岗位，如门岗值守人员、巡逻队长、培训负责人",
      "evidenceType": "应提交或留存的证据类型，如巡逻记录、签到表、交接班记录",
      "frequency": "执行频率，如每日、每班次、每季度、发生时",
      "riskLevel": "LOW / MEDIUM / HIGH",
      "suggestedTaskType": "TRAINING / QUALIFICATION_MATERIAL / ONBOARDING_ACCESS / INSPECTION_FILL / RECTIFICATION / ARCHIVE_MATERIAL",
      "score": 0-100,
      "mergeable": true,
      "mergeReason": "可合并理由；不可合并时说明原因"
    }
  ]
}

评分锚点：
- 0-39：定义、背景、引用说明、宣传性表述；不得进入任务，只能作为低价值候选。例：score 35「固定岗是指在指定位置执行守护任务的岗位」。
- 40-59：有合规含义但缺少明确 5W（谁做、做什么、何时、交什么、怎么算合格）；不得进入任务。例：score 59「应加强门岗管理」。
- 60-74：有关联价值，但只适合作为任务依据的一部分；例如仅说明保存期限、单一证据或从属动作。边界例：score 60「巡逻记录应保存不少于一年」，score 74「交接班记录应由班组留存备查」。
- ≥75：可独立形成现场任务；动作、责任、证据、频率基本明确。边界例：score 75「巡逻人员应每日按路线巡查并上传巡更签到表」。
- 90-100：高质量任务种子；5W 完整、风险高或客户验收价值高。例：score 92「保安员应每季度参加岗位培训和应急处置考核，提交签到表、成绩单和培训课件」。

提取规则：
1. 只提取有明确执行动作的要求：核验、巡逻、检查、记录、留存、培训、考核、持证、交接、报告、整改、复查、处置。
2. 跳过纯定义条款、引用说明、表格注释、前言；但不要静默丢弃，低价值内容可给低 score 候选。
3. 数值、期限、频率、保存年限、人员资质必须完整保留在 sourceText 中。
4. 整改类仅当原文显式出现「整改 / 纠正 / 处置 / 复查 / 闭环」时使用 RECTIFICATION。
5. 培训类仅当原文显式涉及「培训 / 教育 / 考核 / 持证 / 上岗能力」时使用 TRAINING。
6. 每个候选必须尽量补齐 5W：谁做、做什么、什么时候做、交什么、怎么算合格。
7. 同一表格、同一章节、同一检查对象的候选优先标记 mergeable=true，并说明合并理由。

{fewShotExamples}

标准原文：
{rawText}`

export class AiInvalidJsonError extends Error {
  code = 'AI_INVALID_JSON'
  constructor(public reason: string) {
    super(`AI 返回非法 JSON：${reason}`)
  }
}

export function buildAiPrompt(rawText: string): string {
  const template = isCandidateV2Enabled() ? PROMPT_TEMPLATE : LEGACY_PROMPT_TEMPLATE
  const examples = isCandidateV2Enabled() ? FEW_SHOT_EXAMPLES : LEGACY_FEW_SHOT_EXAMPLES
  return template
    .replace('{fewShotExamples}', examples)
    .replace('{rawText}', normalizeStandardTextForParsing(rawText))
}

// DeepSeek/Qwen 等 LLM 即便 prompt 要求"不要有任何其他文字"，仍会偶发用 ```json … ``` 包裹
// 输出。在 JSON.parse 前剥离 fence，无 fence 时原样返回，避免 OCR_AI 误降级到 RULE。
function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

const TRAINING_TEXT_RE = /培训|教育|考核|持证|上岗能力/
const RECTIFICATION_TEXT_RE = /整改|纠正|处置|复查|闭环/

function trimOrNull(value: string | null | undefined) {
  const text = value?.trim()
  return text || null
}

function normalizeTaskType(type: string | null | undefined, sourceText: string, action: string) {
  if (!type || !AI_RECOMMENDED_TASK_TYPES.includes(type as never)) return null
  const text = `${sourceText}\n${action}`
  if (type === 'TRAINING' && !TRAINING_TEXT_RE.test(text)) return null
  if (type === 'RECTIFICATION' && !RECTIFICATION_TEXT_RE.test(text)) return null
  return type
}

function titleFromAction(action: string, sourceText: string) {
  const base = action.trim() || sourceText.trim()
  return base.length > 24 ? `${base.slice(0, 23)}…` : base
}

function candidateToDraft(candidate: CandidateRequirement): RequirementDraft {
  const materials = candidate.evidenceType
    ? candidate.evidenceType
      .split(/[、,，/；;]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8)
    : null
  const submitRequirement = candidate.evidenceType ? `提交或留存：${candidate.evidenceType}` : null
  return {
    clauseNo: candidate.clauseNo,
    title: titleFromAction(candidate.action, candidate.sourceText),
    requirementText: candidate.sourceText,
    executionDescription: candidate.action,
    recommendedTaskType: candidate.suggestedTaskType,
    suggestedDepartment: candidate.responsibleRole,
    suggestedFrequency: null,
    submitRequirement,
    requiredMaterials: materials?.length ? materials : null,
  }
}

function normalizeCandidate(item: z.infer<typeof AiCandidateRequirementJsonSchema>): CandidateRequirement | null {
  const sourceText = item.sourceText.trim()
  const action = item.action.trim()
  if (!sourceText || !action) return null
  return {
    clauseNo: trimOrNull(item.clauseNo),
    sourceText,
    action,
    responsibleRole: trimOrNull(item.responsibleRole),
    evidenceType: trimOrNull(item.evidenceType),
    frequency: trimOrNull(item.frequency),
    riskLevel: trimOrNull(item.riskLevel),
    suggestedTaskType: normalizeTaskType(item.suggestedTaskType, sourceText, action),
    score: Math.min(100, Math.max(0, Math.round(item.score))),
    mergeable: item.mergeable,
    mergeReason: trimOrNull(item.mergeReason),
  }
}

function legacyRequirementToCandidate(item: z.infer<typeof AiRequirementJsonSchema>): CandidateRequirement | null {
  const requirementText = (item.requirementText ?? '').trim()
  if (!requirementText) return null
  const action = item.executionDescription?.trim() || item.title.trim() || requirementText.slice(0, 40)
  return {
    clauseNo: trimOrNull(item.clauseNo),
    sourceText: requirementText,
    action,
    responsibleRole: trimOrNull(item.suggestedDepartment),
    evidenceType: trimOrNull(item.submitRequirement) || (item.requiredMaterials?.length ? item.requiredMaterials.join('、') : null),
    frequency: item.suggestedFrequency ?? null,
    riskLevel: 'MEDIUM',
    suggestedTaskType: normalizeTaskType(item.recommendedTaskType, requirementText, action),
    score: 80,
    mergeable: true,
    mergeReason: 'legacy requirement format normalized as candidate',
  }
}

function legacyRequirementToDraft(item: z.infer<typeof AiRequirementJsonSchema>): RequirementDraft | null {
  const requirementText = (item.requirementText ?? '').trim()
  if (requirementText.length < 5) return null
  return {
    clauseNo: item.clauseNo?.trim() || null,
    title: (item.title ?? '').trim() || requirementText.slice(0, 20),
    requirementText,
    executionDescription: item.executionDescription?.trim() || null,
    recommendedTaskType: item.recommendedTaskType || null,
    suggestedDepartment: item.suggestedDepartment?.trim() || null,
    suggestedFrequency: item.suggestedFrequency || null,
    submitRequirement: item.submitRequirement?.trim() || null,
    requiredMaterials: item.requiredMaterials || null,
  }
}

function parseCandidateResponse(parsed: unknown): { candidates: CandidateRequirement[]; drafts?: RequirementDraft[] } {
  const candidateResponse = AiCandidateResponseSchema.safeParse(parsed)
  if (candidateResponse.success) {
    return {
      candidates: candidateResponse.data.candidateRequirements.flatMap((item) => {
        const candidate = normalizeCandidate(item)
        return candidate ? [candidate] : []
      }),
    }
  }

  const legacyArray = AiRequirementJsonArraySchema.safeParse(parsed)
  if (legacyArray.success) {
    return {
      candidates: legacyArray.data.flatMap((item) => {
        const candidate = legacyRequirementToCandidate(item)
        return candidate ? [candidate] : []
      }),
      drafts: legacyArray.data.flatMap((item) => {
        const draft = legacyRequirementToDraft(item)
        return draft ? [draft] : []
      }),
    }
  }

  const issue = candidateResponse.error.issues[0]?.message || legacyArray.error.issues[0]?.message || 'schema validation failed'
  throw new AiInvalidJsonError(issue)
}

export function summarizeCandidateScores(
  candidates: CandidateRequirement[],
  thresholds = {
    candidateMinScore: getCandidateRequirementMinScore(),
    taskMinScore: getCandidateTaskMinScore(),
  },
): CandidateScoreDistribution {
  let lt60 = 0
  let s60to74 = 0
  let gte75 = 0
  let belowTaskThreshold = 0
  let associatedOnly = 0
  let taskEligible = 0
  for (const candidate of candidates) {
    if (candidate.score < 60) lt60++
    else if (candidate.score < 75) s60to74++
    else gte75++

    if (candidate.score < thresholds.candidateMinScore) belowTaskThreshold++
    else if (candidate.score < thresholds.taskMinScore) associatedOnly++
    else taskEligible++
  }
  return {
    total: candidates.length,
    belowTaskThreshold,
    associatedOnly,
    taskEligible,
    buckets: { lt60, s60to74, gte75 },
  }
}

export function buildDraftsFromCandidates(
  candidates: CandidateRequirement[],
  taskMinScore = getCandidateTaskMinScore(),
): RequirementDraft[] {
  return candidates
    .filter((candidate) => candidate.score >= taskMinScore)
    .map(candidateToDraft)
}

export async function parseCandidateRequirementsByAi(
  rawText: string,
  aiCaller: (prompt: string) => Promise<string>,
): Promise<CandidateRequirement[]> {
  if (!isCandidateV2Enabled()) return []
  const prompt = buildAiPrompt(rawText)
  const raw = await aiCaller(prompt) // 失败由路由捕获（AiNotConfiguredError / AiCallFailedError）

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch (e) {
    throw new AiInvalidJsonError(e instanceof Error ? e.message : 'parse failed')
  }

  return parseCandidateResponse(parsed).candidates
}

export async function parseByAiWithCandidates(
  rawText: string,
  aiCaller: (prompt: string) => Promise<string>,
) {
  const prompt = buildAiPrompt(rawText)
  const raw = await aiCaller(prompt)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch (e) {
    throw new AiInvalidJsonError(e instanceof Error ? e.message : 'parse failed')
  }

  if (!isCandidateV2Enabled()) {
    const legacyArray = AiRequirementJsonArraySchema.safeParse(parsed)
    if (!legacyArray.success) {
      throw new AiInvalidJsonError(legacyArray.error.issues[0]?.message || 'schema validation failed')
    }
    return {
      candidates: [],
      drafts: legacyArray.data.flatMap((item) => {
        const draft = legacyRequirementToDraft(item)
        return draft ? [draft] : []
      }),
      scoreDistribution: summarizeCandidateScores([]),
    }
  }

  const result = parseCandidateResponse(parsed)
  const candidates = result.candidates
  return {
    candidates,
    drafts: result.drafts ?? buildDraftsFromCandidates(candidates),
    scoreDistribution: summarizeCandidateScores(candidates),
  }
}

export async function parseByAi(
  rawText: string,
  aiCaller: (prompt: string) => Promise<string>,
): Promise<RequirementDraft[]> {
  return (await parseByAiWithCandidates(rawText, aiCaller)).drafts
}
