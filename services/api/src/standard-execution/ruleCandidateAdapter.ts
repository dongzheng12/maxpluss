import { TASK_TYPES, type CandidateRequirement, type RequirementDraft } from './types.js'

type TaskType = typeof TASK_TYPES[number]

const ROLE_PATTERNS = [
  '门岗值守人员',
  '监控室值守人员',
  '消防控制室值班人员',
  '巡逻队长',
  '巡逻人员',
  '押运队长',
  '押运人员',
  '培训负责人',
  '安保主管',
  '项目负责人',
  '班组长',
  '值班人员',
  '保安员',
  '门卫',
  '管理人员',
  '企业',
  '单位',
  '部门',
  '人员',
]

function compact(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ') || null
}

function taskTypeOrNull(type: string | null | undefined): TaskType | null {
  return typeof type === 'string' && (TASK_TYPES as readonly string[]).includes(type) ? type as TaskType : null
}

function inferTaskType(text: string, draft: RequirementDraft): TaskType {
  const explicit = taskTypeOrNull(draft.recommendedTaskType)
  if (explicit) return explicit
  if (/培训|教育|考核|持证|上岗能力/.test(text)) return 'TRAINING'
  if (/整改|纠正|处置|复查|闭环/.test(text)) return 'RECTIFICATION'
  if (/资质|资格|许可证|证书|备案|报备/.test(text)) return 'QUALIFICATION_MATERIAL'
  if (/上岗|准入|授权|门禁|权限/.test(text)) return 'ONBOARDING_ACCESS'
  if (/检查|巡查|巡逻|核验|监视|测量|评估|评审|验证/.test(text)) return 'INSPECTION_FILL'
  if (/记录|台账|留存|保存|归档|档案/.test(text)) return 'ARCHIVE_MATERIAL'
  return 'OTHER'
}

function inferResponsibleRole(text: string, draft: RequirementDraft) {
  const explicit = compact(draft.suggestedDepartment)
  if (explicit) return explicit
  const match = ROLE_PATTERNS.find((role) => text.includes(role))
  return match ?? '相关责任人'
}

function inferEvidenceType(draft: RequirementDraft) {
  const materials = draft.requiredMaterials?.map((item) => item.trim()).filter(Boolean) ?? []
  if (materials.length > 0) return Array.from(new Set(materials)).join('、')
  const submitRequirement = compact(draft.submitRequirement)
  return submitRequirement ?? '完成说明及必要证明材料'
}

function inferFrequency(text: string, draft: RequirementDraft) {
  const explicit = compact(draft.suggestedFrequency)
  if (explicit) return explicit
  const match = text.match(/每(?:日|天|班次|班|次|周|月|季度|年)|定期|发生时|及时/)
  return match?.[0] ?? null
}

function inferRiskLevel(text: string): CandidateRequirement['riskLevel'] {
  if (/重大|高风险|应急|突发|消防|报警|事故|危险|整改|处置|复查|闭环|不得|禁止|严禁/.test(text)) return 'HIGH'
  if (/保存|归档|留存|备案|报备/.test(text)) return 'LOW'
  return 'MEDIUM'
}

function scoreRuleCandidate(text: string, draft: RequirementDraft) {
  const hasRole = inferResponsibleRole(text, draft) !== '相关责任人'
  const hasFrequency = Boolean(inferFrequency(text, draft))
  const evidence = inferEvidenceType(draft)
  const hasSpecificEvidence = evidence !== '完成说明及必要证明材料'
  const hasAcceptanceCue = /记录|台账|照片|截图|报告|清单|签到|考核|证书|凭证|留存|提交|保存/.test(evidence + text)
  let score = 78
  if (hasRole) score += 4
  if (hasFrequency) score += 4
  if (hasSpecificEvidence) score += 3
  if (hasAcceptanceCue) score += 3
  if (inferRiskLevel(text) === 'HIGH') score += 2
  return Math.min(90, score)
}

export function ruleDraftsToCandidateRequirements(drafts: RequirementDraft[]): CandidateRequirement[] {
  return drafts.map((draft) => {
    const sourceText = draft.requirementText.trim()
    const action = compact(draft.executionDescription)?.replace(/^请按原文要求执行并留痕：/, '') || draft.title
    const suggestedTaskType = inferTaskType(sourceText, draft)
    return {
      clauseNo: compact(draft.clauseNo),
      sourceText,
      action,
      responsibleRole: inferResponsibleRole(sourceText, draft),
      evidenceType: inferEvidenceType(draft),
      frequency: inferFrequency(sourceText, draft),
      riskLevel: inferRiskLevel(sourceText),
      suggestedTaskType,
      score: scoreRuleCandidate(sourceText, draft),
      mergeable: true,
      mergeReason: '规则解析候选，按任务类型、责任角色、证据类型进入确定性聚合；未进入任务包时保留在覆盖报告。',
    }
  })
}
