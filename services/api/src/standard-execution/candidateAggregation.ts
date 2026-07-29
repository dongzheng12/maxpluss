import { createHash } from 'crypto'
import { z } from 'zod'
import {
  TASK_TYPES,
  type CandidateRequirement,
  type RequirementDraft,
  type TaskGenerationCoverageReport,
  type TaskGenerationTaskPackage,
} from './types.js'
import {
  getCandidateRequirementMinScore,
  getCandidateTaskMinScore,
  getCandidateTaskPackageMax,
} from './parseRuntimeConfig.js'

type TaskType = typeof TASK_TYPES[number]

export type AggregatedRequirementDraft = RequirementDraft & {
  draftId: string
  groupId: string
  taskDrafts: Array<{
    taskDraftId: string
    groupId: string
    title: string
    description: string
    taskType: TaskType
    submitRequirement: string
  }>
}

export interface CandidateAggregationOptions {
  aiCaller?: (prompt: string) => Promise<string>
  candidateMinScore?: number
  taskMinScore?: number
  maxPackages?: number
}

export interface CandidateAggregationResult {
  drafts: AggregatedRequirementDraft[]
  taskPackages: TaskGenerationTaskPackage[]
  coverageReport: TaskGenerationCoverageReport
  warnings: string[]
}

interface CandidateInGroup {
  candidate: CandidateRequirement
  index: number
}

interface CandidateGroup {
  key: string
  taskType: TaskType
  responsibleRole: string | null
  evidenceType: string | null
  candidates: CandidateInGroup[]
}

const DEFAULT_SUBMIT_REQUIREMENT = '请提交与本任务相关的记录、照片、台账或说明材料。'

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  TRAINING: '培训考核',
  QUALIFICATION_MATERIAL: '资质材料',
  ONBOARDING_ACCESS: '上岗准入',
  INSPECTION_FILL: '现场检查',
  RECTIFICATION: '整改闭环',
  ARCHIVE_MATERIAL: '材料归档',
  DOCUMENT_UPLOAD: '文档上传',
  PHOTO: '照片留痕',
  PARAMETER: '参数填写',
  OTHER: '标准执行',
}

const AiMergedPackageSchema = z.object({
  packageId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  submitRequirement: z.string().trim().min(1).max(1000),
  taskType: z.enum(TASK_TYPES).optional().nullable(),
  requiredMaterials: z.array(z.string().trim().min(1).max(200)).max(50).optional().nullable(),
})
const AiMergedPackagesObjectSchema = z.object({ taskPackages: z.array(AiMergedPackageSchema) })
const AiMergedPackagesArraySchema = z.array(AiMergedPackageSchema)

function clamp(text: string, max: number) {
  return text.length > max ? text.slice(0, max) : text
}

function stableId(prefix: string, seed: string) {
  return `${prefix}-${createHash('sha1').update(seed).digest('hex').slice(0, 10)}`
}

function normalizeKeyPart(value: string | null | undefined, fallback: string) {
  const text = value?.trim().replace(/\s+/g, ' ')
  return text || fallback
}

function trimOrNull(value: string | null | undefined) {
  const text = value?.trim()
  return text || null
}

function taskTypeOrOther(type: string | null | undefined): TaskType {
  return typeof type === 'string' && (TASK_TYPES as readonly string[]).includes(type)
    ? type as TaskType
    : 'OTHER'
}

function splitMaterials(evidenceType: string | null | undefined) {
  if (!evidenceType?.trim()) return []
  return Array.from(new Set(
    evidenceType
      .split(/[、,，/；;和及]/)
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, 20)
}

function titleFromAction(action: string, sourceText: string) {
  const base = action.trim() || sourceText.trim()
  return clamp(base, 80)
}

function scoreOf(group: CandidateGroup) {
  return Math.max(...group.candidates.map((item) => item.candidate.score))
}

function riskOf(group: CandidateGroup) {
  const rank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }
  return group.candidates
    .map((item) => item.candidate.riskLevel)
    .filter(Boolean)
    .sort((a, b) => (rank[b as string] ?? 0) - (rank[a as string] ?? 0))[0] ?? null
}

function frequencyOf(group: CandidateGroup) {
  const values = group.candidates.map((item) => trimOrNull(item.candidate.frequency)).filter(Boolean) as string[]
  if (values.length === 0) return null
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

function buildGroupKey(candidate: CandidateRequirement) {
  const taskType = taskTypeOrOther(candidate.suggestedTaskType)
  const responsibleRoleKey = normalizeKeyPart(candidate.responsibleRole, 'UNSPECIFIED_ROLE')
  const evidenceTypeKey = normalizeKeyPart(candidate.evidenceType, 'UNSPECIFIED_EVIDENCE')
  return {
    taskType,
    responsibleRole: trimOrNull(candidate.responsibleRole),
    evidenceType: trimOrNull(candidate.evidenceType),
    key: `${taskType}::${responsibleRoleKey}::${evidenceTypeKey}`,
  }
}

function buildGroups(candidates: CandidateRequirement[], candidateMinScore: number) {
  const groups = new Map<string, CandidateGroup>()
  candidates.forEach((candidate, index) => {
    if (candidate.score < candidateMinScore) return
    const key = buildGroupKey(candidate)
    const existing = groups.get(key.key)
    if (existing) {
      existing.candidates.push({ candidate, index })
      return
    }
    groups.set(key.key, {
      key: key.key,
      taskType: key.taskType,
      responsibleRole: key.responsibleRole,
      evidenceType: key.evidenceType,
      candidates: [{ candidate, index }],
    })
  })
  return Array.from(groups.values())
}

function buildPackageTitle(group: CandidateGroup) {
  const top = group.candidates.slice().sort((a, b) => b.candidate.score - a.candidate.score)[0]
  if (group.candidates.length === 1) return titleFromAction(top.candidate.action, top.candidate.sourceText)
  const role = group.responsibleRole ? `${group.responsibleRole}` : '相关岗位'
  const frequency = frequencyOf(group)
  const prefix = frequency ? `${frequency}` : ''
  return clamp(`${prefix}${role}${TASK_TYPE_LABELS[group.taskType]}任务包`, 80)
}

function buildPackageDescription(group: CandidateGroup) {
  return clamp(
    group.candidates
      .map(({ candidate }, index) => {
        const head = [candidate.clauseNo, candidate.action].filter(Boolean).join(' ')
        return `${index + 1}. ${head || candidate.sourceText}`
      })
      .join('\n'),
    2000,
  )
}

function buildSubmitRequirement(group: CandidateGroup) {
  const materials = Array.from(new Set(group.candidates.flatMap((item) => splitMaterials(item.candidate.evidenceType))))
  if (materials.length === 0) return DEFAULT_SUBMIT_REQUIREMENT
  return clamp(`提交或留存：${materials.slice(0, 12).join('、')}`, 1000)
}

function deterministicPackages(groups: CandidateGroup[]): TaskGenerationTaskPackage[] {
  return groups.map((group) => {
    const packageId = stableId('pkg', group.key)
    const candidateIndexes = group.candidates.map((item) => item.index)
    const draftIds = candidateIndexes.map((index) => `draft-${index + 1}`)
    const materials = Array.from(new Set(group.candidates.flatMap((item) => splitMaterials(item.candidate.evidenceType)))).slice(0, 20)
    return {
      packageId,
      groupId: stableId('group', group.key),
      key: {
        taskType: group.taskType,
        responsibleRole: group.responsibleRole,
        evidenceType: group.evidenceType,
      },
      title: buildPackageTitle(group),
      description: buildPackageDescription(group),
      submitRequirement: buildSubmitRequirement(group),
      taskType: group.taskType,
      responsibleRole: group.responsibleRole,
      evidenceType: group.evidenceType,
      frequency: frequencyOf(group),
      riskLevel: riskOf(group),
      score: scoreOf(group),
      candidateCount: group.candidates.length,
      candidateIndexes,
      clauseNos: group.candidates.map((item) => item.candidate.clauseNo).filter(Boolean) as string[],
      draftIds,
      requiredMaterials: materials,
      mergeMode: 'DETERMINISTIC',
      warnings: [],
    }
  })
}

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

function buildMergePrompt(packages: TaskGenerationTaskPackage[], candidates: CandidateRequirement[]) {
  const payload = packages.map((pkg) => ({
    packageId: pkg.packageId,
    hardKey: pkg.key,
    current: {
      title: pkg.title,
      description: pkg.description,
      submitRequirement: pkg.submitRequirement,
      taskType: pkg.taskType,
      requiredMaterials: pkg.requiredMaterials,
    },
    candidateRequirements: pkg.candidateIndexes.map((index) => {
      const candidate = candidates[index]
      return {
        candidateIndex: index,
        clauseNo: candidate.clauseNo,
        sourceText: candidate.sourceText,
        action: candidate.action,
        responsibleRole: candidate.responsibleRole,
        evidenceType: candidate.evidenceType,
        frequency: candidate.frequency,
        riskLevel: candidate.riskLevel,
        suggestedTaskType: candidate.suggestedTaskType,
        score: candidate.score,
      }
    }),
  }))
  return `你是安保行业标准执行顾问。请只在每个 taskPackage 内部合并 candidateRequirements，改写成少而精的现场任务包；严禁跨 package 调整候选、严禁改变 packageId。

返回 JSON 对象，不要输出其他文字：
{
  "taskPackages": [
    {
      "packageId": "原样返回",
      "title": "任务包标题，不超过 80 字",
      "description": "谁做、做什么、什么时候做、怎么算合格，不超过 2000 字",
      "submitRequirement": "提交或留存哪些材料，不超过 1000 字",
      "taskType": "TRAINING / QUALIFICATION_MATERIAL / ONBOARDING_ACCESS / INSPECTION_FILL / RECTIFICATION / ARCHIVE_MATERIAL / OTHER",
      "requiredMaterials": ["材料 1"]
    }
  ]
}

合并规则：
1. 只做组内措辞，不新增候选，不丢弃候选。
2. 同一责任对象、任务类型、证据类型的要求合并成一个可执行工作包。
3. 每个包必须满足 5W：谁做、做什么、什么时候做、交什么、怎么算合格。
4. 整改类仅当候选原文显式出现整改/纠正/处置/复查/闭环。
5. 培训类仅当候选原文显式涉及培训/教育/考核/持证/上岗能力。

输入：
${JSON.stringify(payload)}`
}

function parseMergedPackages(raw: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'parse failed')
  }
  const objectResult = AiMergedPackagesObjectSchema.safeParse(parsed)
  if (objectResult.success) return objectResult.data.taskPackages
  const arrayResult = AiMergedPackagesArraySchema.safeParse(parsed)
  if (arrayResult.success) return arrayResult.data
  throw new Error(objectResult.error.issues[0]?.message || arrayResult.error.issues[0]?.message || 'schema validation failed')
}

async function mergePackagesWithAi(
  packages: TaskGenerationTaskPackage[],
  candidates: CandidateRequirement[],
  aiCaller: ((prompt: string) => Promise<string>) | undefined,
) {
  if (!aiCaller || packages.length === 0) return { packages, warnings: [] as string[] }
  try {
    const raw = await aiCaller(buildMergePrompt(packages, candidates))
    const merged = parseMergedPackages(raw)
    const byId = new Map(merged.map((item) => [item.packageId, item]))
    const warnings: string[] = []
    const next = packages.map((pkg) => {
      const item = byId.get(pkg.packageId)
      if (!item) {
        warnings.push(`候选聚合 LLM 未返回任务包 ${pkg.packageId}，已保留确定性聚合结果`)
        return {
          ...pkg,
          mergeMode: 'LLM_FALLBACK' as const,
          warnings: [...pkg.warnings, 'LLM 未返回该任务包，使用确定性聚合结果'],
        }
      }
      const taskType = taskTypeOrOther(item.taskType || pkg.taskType)
      return {
        ...pkg,
        title: clamp(item.title.trim(), 80),
        description: clamp(item.description.trim(), 2000),
        submitRequirement: clamp(item.submitRequirement.trim(), 1000),
        taskType,
        requiredMaterials: item.requiredMaterials?.filter(Boolean).slice(0, 20) || pkg.requiredMaterials,
        mergeMode: 'LLM_MERGED' as const,
      }
    })
    return { packages: next, warnings }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    return {
      packages: packages.map((pkg) => ({
        ...pkg,
        mergeMode: 'LLM_FALLBACK' as const,
        warnings: [...pkg.warnings, 'LLM 聚合失败，使用确定性聚合结果'],
      })),
      warnings: [`候选聚合 LLM 失败，已使用确定性聚合结果：${reason}`],
    }
  }
}

function buildCoverageReport(
  candidates: CandidateRequirement[],
  taskPackages: TaskGenerationTaskPackage[],
  overflowIndexes: Set<number>,
  thresholds: { candidateMinScore: number; taskMinScore: number },
): TaskGenerationCoverageReport {
  const packageByCandidateIndex = new Map<number, string>()
  for (const pkg of taskPackages) {
    for (const index of pkg.candidateIndexes) packageByCandidateIndex.set(index, pkg.packageId)
  }
  const entries = candidates.map((candidate, index) => {
    const packageId = packageByCandidateIndex.get(index) ?? null
    if (packageId) {
      return {
        candidateIndex: index,
        clauseNo: candidate.clauseNo,
        sourceText: candidate.sourceText,
        score: candidate.score,
        destination: 'TASK_PACKAGE' as const,
        packageId,
        reason: '进入同硬键任务包',
      }
    }
    if (candidate.score < thresholds.candidateMinScore) {
      return {
        candidateIndex: index,
        clauseNo: candidate.clauseNo,
        sourceText: candidate.sourceText,
        score: candidate.score,
        destination: 'LOW_SCORE_CANDIDATE' as const,
        packageId: null,
        reason: `score ${candidate.score} < 候选入围阈值 ${thresholds.candidateMinScore}`,
      }
    }
    if (overflowIndexes.has(index)) {
      return {
        candidateIndex: index,
        clauseNo: candidate.clauseNo,
        sourceText: candidate.sourceText,
        score: candidate.score,
        destination: 'OVERFLOW_CANDIDATE' as const,
        packageId: null,
        reason: '超过任务包数量上限，保留为候选',
      }
    }
    return {
      candidateIndex: index,
      clauseNo: candidate.clauseNo,
      sourceText: candidate.sourceText,
      score: candidate.score,
      destination: 'ASSOCIATED_CANDIDATE' as const,
      packageId: null,
      reason: candidate.score < thresholds.taskMinScore
        ? `score ${candidate.score} 位于关联要求区间`
        : '未命中可聚合任务包，保留为候选',
    }
  })
  return {
    totalCandidates: candidates.length,
    taskPackageCount: taskPackages.length,
    candidateOnlyCount: entries.filter((entry) => entry.destination !== 'TASK_PACKAGE').length,
    entries,
  }
}

function draftFromCandidate(candidate: CandidateRequirement, index: number, pkg: TaskGenerationTaskPackage): AggregatedRequirementDraft {
  const draftId = `draft-${index + 1}`
  const taskDraft = {
    taskDraftId: `task-${pkg.packageId}`,
    groupId: pkg.groupId,
    title: pkg.title,
    description: pkg.description,
    taskType: pkg.taskType,
    submitRequirement: pkg.submitRequirement,
  }
  return {
    draftId,
    groupId: pkg.groupId,
    clauseNo: candidate.clauseNo,
    title: titleFromAction(candidate.action, candidate.sourceText),
    requirementText: candidate.sourceText,
    executionDescription: candidate.action,
    recommendedTaskType: pkg.taskType,
    suggestedDepartment: candidate.responsibleRole,
    suggestedFrequency: candidate.frequency,
    submitRequirement: pkg.submitRequirement,
    requiredMaterials: splitMaterials(candidate.evidenceType).length
      ? splitMaterials(candidate.evidenceType)
      : pkg.requiredMaterials.length ? pkg.requiredMaterials : null,
    taskDrafts: [taskDraft],
  }
}

export async function aggregateCandidateRequirements(
  candidates: CandidateRequirement[],
  options: CandidateAggregationOptions = {},
): Promise<CandidateAggregationResult> {
  const candidateMinScore = options.candidateMinScore ?? getCandidateRequirementMinScore()
  const taskMinScore = options.taskMinScore ?? getCandidateTaskMinScore()
  const maxPackages = options.maxPackages ?? getCandidateTaskPackageMax()
  const groups = buildGroups(candidates, candidateMinScore)
  const taskSeedGroups = groups.filter((group) => group.candidates.some((item) => item.candidate.score >= taskMinScore))
  const sortedGroups = taskSeedGroups
    .slice()
    .sort((a, b) =>
      scoreOf(b) - scoreOf(a) ||
      b.candidates.length - a.candidates.length ||
      a.key.localeCompare(b.key),
    )
  const selectedGroups = sortedGroups.slice(0, maxPackages)
  const overflowIndexes = new Set<number>()
  for (const group of sortedGroups.slice(maxPackages)) {
    for (const item of group.candidates) overflowIndexes.add(item.index)
  }

  const deterministic = deterministicPackages(selectedGroups)
  const merged = await mergePackagesWithAi(deterministic, candidates, options.aiCaller)
  const packageByCandidateIndex = new Map<number, TaskGenerationTaskPackage>()
  for (const pkg of merged.packages) {
    for (const index of pkg.candidateIndexes) packageByCandidateIndex.set(index, pkg)
  }
  const drafts = Array.from(packageByCandidateIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, pkg]) => draftFromCandidate(candidates[index], index, pkg))
  return {
    drafts,
    taskPackages: merged.packages,
    coverageReport: buildCoverageReport(candidates, merged.packages, overflowIndexes, { candidateMinScore, taskMinScore }),
    warnings: merged.warnings,
  }
}
