import { z } from 'zod'
import { callStandardAI } from './aiClient.js'
import { isLocalAiMockEnabled } from './localAiMock.js'

export type ReviewAiRecommendation = 'APPROVE' | 'REJECT' | 'MANUAL'

export interface ReviewAiAnalysisInput {
  requirement: {
    title: string
    requirementText: string
    submitRequirement?: string | null
    requiredMaterials?: unknown
  }
  task: {
    title: string
    taskType?: string | null
    checklistSchema?: unknown
    parametersSchema?: unknown
  }
  submission: {
    submitText: string
    submitDataJson?: unknown
  }
  attachments: Array<{ fileName: string }>
  history: Array<{ submitText: string }>
}

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

const DISCLAIMER = '仅供参考，最终以人工审核为准'

const ReviewAiAnalysisSchema = z.object({
  recommendation: z.enum(['APPROVE', 'REJECT', 'MANUAL']),
  confidence: z.number().min(0).max(1).default(0.6),
  summary: z.string().min(1).max(500),
  reasons: z.array(z.string().min(1).max(300)).max(8).default([]),
  checks: z.object({
    completeness: z.object({
      status: z.enum(['PASS', 'WARN', 'FAIL']),
      missingMaterials: z.array(z.string()).default([]),
      note: z.string().default(''),
    }),
    fillQuality: z.object({
      status: z.enum(['PASS', 'WARN', 'FAIL', 'NA']),
      note: z.string().default(''),
    }),
    anomaly: z.object({
      status: z.enum(['PASS', 'WARN', 'NA']),
      note: z.string().default(''),
    }),
  }),
  suggestedComment: z.string().min(1).max(1000),
  disclaimer: z.string().default(DISCLAIMER),
})

function jsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return jsonStringArray(parsed)
    } catch {
      return value.trim() ? [value.trim()] : []
    }
  }
  return []
}

function safeText(value: string) {
  return value.replace(/[A-Za-z0-9_-]{18,}/g, '[已隐藏标识]').replace(/\/[^\s，。；、]+/g, '[已隐藏路径]')
}

function lowerCompact(value: string) {
  return value.toLowerCase().replace(/\s+/g, '')
}

function materialMatched(material: string, corpus: string) {
  const normalized = lowerCompact(material)
  if (!normalized) return true
  if (corpus.includes(normalized)) return true
  const chineseTokens = Array.from(material.matchAll(/[\u4e00-\u9fa5]{2,}/g)).map((match) => match[0])
  return chineseTokens.length > 0 && chineseTokens.some((token) => corpus.includes(lowerCompact(token)))
}

function extractRangeItems(schema: unknown) {
  const root = schema && typeof schema === 'object' ? schema as { items?: unknown } : null
  const items = Array.isArray(root?.items) ? root.items : []
  return items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const min = Number(item.min ?? item.minValue ?? item.lowerBound)
    const max = Number(item.max ?? item.maxValue ?? item.upperBound)
    if (!Number.isFinite(min) && !Number.isFinite(max)) return []
    return [{
      name: String(item.name ?? item.label ?? item.title ?? '结构化填报项'),
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
    }]
  })
}

function extractNumbers(value: unknown): number[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return Array.from(text.matchAll(/-?\d+(?:\.\d+)?/g)).map((match) => Number(match[0])).filter(Number.isFinite)
}

function buildRuleAnalysis(input: ReviewAiAnalysisInput): ReviewAiAnalysis {
  const requiredMaterials = jsonStringArray(input.requirement.requiredMaterials)
  const corpus = lowerCompact([
    input.submission.submitText,
    input.attachments.map((attachment) => attachment.fileName).join(' '),
  ].join(' '))

  const missingMaterials = requiredMaterials.filter((material) => !materialMatched(material, corpus))
  const hasMinimalSubmission = input.submission.submitText.trim().length >= 8 || input.attachments.length > 0
  const completenessStatus = missingMaterials.length > 0 || !hasMinimalSubmission ? 'FAIL' : 'PASS'

  const ranges = [
    ...extractRangeItems(input.task.checklistSchema),
    ...extractRangeItems(input.task.parametersSchema),
  ]
  let fillStatus: ReviewAiAnalysis['checks']['fillQuality']['status'] = ranges.length ? 'PASS' : 'NA'
  let fillNote = ranges.length ? '结构化填报数值未发现越界。' : '非结构化填报任务，未执行数值范围检查。'
  if (ranges.length > 0) {
    const numbers = extractNumbers(input.submission.submitDataJson ?? input.submission.submitText)
    const outOfRange = ranges.find((range) => numbers.some((num) =>
      (range.min !== null && num < range.min) || (range.max !== null && num > range.max),
    ))
    if (outOfRange) {
      fillStatus = 'FAIL'
      fillNote = `${outOfRange.name} 存在超出标准范围的填报值。`
    } else if (numbers.length === 0) {
      fillStatus = 'WARN'
      fillNote = '任务要求结构化数值填报，但本次提交未识别到数值。'
    }
  }

  let anomalyStatus: ReviewAiAnalysis['checks']['anomaly']['status'] = 'NA'
  let anomalyNote = '无历史同类提交，未执行异常检测。'
  if (input.history.length >= 3) {
    const avgLength = input.history.reduce((sum, row) => sum + row.submitText.length, 0) / input.history.length
    anomalyStatus = input.submission.submitText.length < avgLength * 0.35 ? 'WARN' : 'PASS'
    anomalyNote = anomalyStatus === 'WARN'
      ? '本次提交说明明显短于同类历史提交，建议人工复核。'
      : '与同类历史提交相比未发现明显长度异常。'
  }

  const reasons: string[] = []
  if (missingMaterials.length > 0) reasons.push(`缺少或未明确体现材料：${missingMaterials.join('、')}`)
  if (!hasMinimalSubmission) reasons.push('提交说明和附件均不足，无法支撑控制点要求。')
  if (fillStatus === 'FAIL' || fillStatus === 'WARN') reasons.push(fillNote)
  if (anomalyStatus === 'WARN') reasons.push(anomalyNote)

  const recommendation: ReviewAiRecommendation = completenessStatus === 'FAIL' || fillStatus === 'FAIL'
    ? 'REJECT'
    : reasons.length > 0
      ? 'MANUAL'
      : 'APPROVE'
  const summary = recommendation === 'APPROVE'
    ? '提交内容与当前控制点要求基本匹配，可考虑通过。'
    : recommendation === 'REJECT'
      ? '提交内容未能充分覆盖当前控制点要求，建议驳回补充。'
      : '提交内容存在需人工判断的事项，建议审核人重点复核。'
  const suggestedCore = recommendation === 'REJECT'
    ? `建议补充后重新提交：${reasons.join('；') || '材料不足'}。`
    : recommendation === 'APPROVE'
      ? '材料与说明基本完整，建议审核通过。'
      : `请人工复核：${reasons.join('；')}。`

  return {
    recommendation,
    confidence: recommendation === 'MANUAL' ? 0.62 : 0.78,
    summary,
    reasons: reasons.length ? reasons.map(safeText) : ['未发现明显缺失或异常。'],
    checks: {
      completeness: {
        status: completenessStatus,
        missingMaterials: missingMaterials.map(safeText),
        note: completenessStatus === 'PASS' ? '已覆盖控制点材料要求。' : '提交内容未覆盖全部材料要求。',
      },
      fillQuality: { status: fillStatus, note: safeText(fillNote) },
      anomaly: { status: anomalyStatus, note: safeText(anomalyNote) },
    },
    suggestedComment: `${safeText(suggestedCore)}${DISCLAIMER}`,
    disclaimer: DISCLAIMER,
  }
}

function buildPrompt(input: ReviewAiAnalysisInput) {
  const requiredMaterials = jsonStringArray(input.requirement.requiredMaterials)
  return `
你是企业合规审核辅助 Copilot。请基于控制点要求、提交内容、附件名称和历史摘要输出 JSON，不要输出企业 ID、内部路径或文件 URL。

控制点：${input.requirement.title}
控制点要求：${input.requirement.requirementText}
需提交材料：${requiredMaterials.join('、') || '未配置'}
任务：${input.task.title}
任务类型：${input.task.taskType || '未标记'}
提交内容：${input.submission.submitText.slice(0, 1200)}
附件名称：${input.attachments.map((attachment) => attachment.fileName).join('、') || '无'}
同类历史提交数：${input.history.length}

必须返回 JSON：
{"recommendation":"APPROVE|REJECT|MANUAL","confidence":0.0,"summary":"","reasons":[],"checks":{"completeness":{"status":"PASS|WARN|FAIL","missingMaterials":[],"note":""},"fillQuality":{"status":"PASS|WARN|FAIL|NA","note":""},"anomaly":{"status":"PASS|WARN|NA","note":""}},"suggestedComment":"","disclaimer":"${DISCLAIMER}"}
所有文字结尾必须保留：${DISCLAIMER}
`.trim()
}

export async function analyzeReviewSubmission(input: ReviewAiAnalysisInput): Promise<ReviewAiAnalysis> {
  const fallback = buildRuleAnalysis(input)
  if (isLocalAiMockEnabled()) return fallback

  try {
    const raw = await callStandardAI(buildPrompt(input))
    const jsonStart = raw.indexOf('{')
    const jsonEnd = raw.lastIndexOf('}')
    if (jsonStart < 0 || jsonEnd <= jsonStart) return fallback
    const parsed = ReviewAiAnalysisSchema.parse(JSON.parse(raw.slice(jsonStart, jsonEnd + 1)))
    const suggestedComment = parsed.suggestedComment.includes(DISCLAIMER)
      ? parsed.suggestedComment
      : `${parsed.suggestedComment}${DISCLAIMER}`
    return {
      ...parsed,
      reasons: parsed.reasons.map(safeText),
      suggestedComment: safeText(suggestedComment),
      disclaimer: DISCLAIMER,
    }
  } catch {
    return fallback
  }
}
