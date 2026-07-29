/**
 * standard-execution / 题库 AI 出题（P1-9）
 *
 * 纯函数：拿标准内容 + 出题参数 + aiCaller → 返回库格式题目数组（GeneratedQuestion[]）。
 * 失败（aiCaller 异常 / 非法 JSON / 校验失败）抛 AiQuizInvalidError，由路由层转 4xx/5xx。
 *
 * 重要：AI 生成的题目只返回给前端预览，由用户确认后才走题库 create/update 入库（不在此入库）。
 */
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

export const AI_QUESTION_TYPES = ['SINGLE', 'MULTI', 'TRUEFALSE'] as const
export const AI_QUIZ_DIFFICULTIES = ['BASIC', 'MEDIUM', 'HARD'] as const

export const AiGenerateQuestionsSchema = z
  .object({
    requirementId: z.string().trim().optional(),
    requirementText: z.string().trim().max(10_000).optional(),
    count: z.coerce.number().int().min(1).max(20),
    questionType: z.enum(AI_QUESTION_TYPES),
    difficulty: z.enum(AI_QUIZ_DIFFICULTIES),
  })
  .refine((d) => d.requirementId || d.requirementText, {
    message: 'requirementId 与 requirementText 至少提供一个',
  })
export type AiGenerateQuestionsInput = z.infer<typeof AiGenerateQuestionsSchema>

/** 入库格式（对齐 questionBankRoutes.QuestionSchema：type single|multi） */
export interface GeneratedQuestion {
  id: string
  type: 'single' | 'multi'
  text: string
  opts: string[]
  answer: number[]
  score: number
  exp?: string
  relatedRequirementId?: string | null // 来源检查点（由路由层注入，供前端显示「该题来自 XX 检查点」）
}

const TYPE_LABEL: Record<string, string> = { SINGLE: '单选题', MULTI: '多选题', TRUEFALSE: '判断题' }
const DIFF_LABEL: Record<string, string> = { BASIC: '基础', MEDIUM: '中等', HARD: '较难' }

export class AiQuizInvalidError extends Error {
  code = 'AI_QUIZ_INVALID'
  constructor(public reason: string) {
    super(`AI 出题失败：${reason}`)
  }
}

// AI 返回的单题结构（出库前形态）
const AiQuestionSchema = z.object({
  text: z.string().min(1).max(1000),
  opts: z.array(z.string().min(1).max(500)).min(2).max(8),
  answer: z.array(z.number().int().min(0)).min(1),
  exp: z.string().max(2000).optional().nullable(),
})
const AiQuestionArraySchema = z.array(AiQuestionSchema)

export function buildQuizPrompt(
  sourceText: string,
  count: number,
  questionType: (typeof AI_QUESTION_TYPES)[number],
  difficulty: (typeof AI_QUIZ_DIFFICULTIES)[number],
): string {
  const typeRule =
    questionType === 'TRUEFALSE'
      ? '每题为判断题，opts 固定为 ["正确","错误"]，answer 含 1 个索引（0=正确，1=错误）'
      : questionType === 'MULTI'
        ? '每题为多选题，opts 含 3-6 个选项，answer 含 2 个及以上正确索引'
        : '每题为单选题，opts 含 3-4 个选项，answer 含且仅含 1 个正确索引'
  return `你是标准合规培训出题专家。请根据下面的标准内容，出 ${count} 道${TYPE_LABEL[questionType]}，难度为「${DIFF_LABEL[difficulty]}」。
只返回 JSON 数组，不要任何其他文字。每道题的格式：
{ "text": "题干", "opts": ["选项1","选项2", ...], "answer": [正确选项的 0 基索引], "exp": "答案解析（说明为什么）" }

出题规则：
1. ${typeRule}
2. 题干须紧扣标准内容，考核执行要点 / 数值约束 / 合规动作，不出无关常识题
3. answer 的索引必须落在 opts 范围内
4. 解析 exp 简明说明依据
5. 共 ${count} 道，难度统一为「${DIFF_LABEL[difficulty]}」

标准内容：
${sourceText}`
}

function stripJsonFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
}

export async function generateQuizQuestions(
  sourceText: string,
  opts: { count: number; questionType: (typeof AI_QUESTION_TYPES)[number]; difficulty: (typeof AI_QUIZ_DIFFICULTIES)[number] },
  aiCaller: (prompt: string) => Promise<string>,
): Promise<GeneratedQuestion[]> {
  if (!sourceText || !sourceText.trim()) throw new AiQuizInvalidError('标准内容为空')
  const prompt = buildQuizPrompt(sourceText, opts.count, opts.questionType, opts.difficulty)
  const raw = await aiCaller(prompt)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch (e) {
    throw new AiQuizInvalidError(e instanceof Error ? e.message : 'JSON 解析失败')
  }
  const arr = AiQuestionArraySchema.safeParse(parsed)
  if (!arr.success) throw new AiQuizInvalidError(arr.error.issues[0]?.message || 'schema 校验失败')

  const dbType: 'single' | 'multi' = opts.questionType === 'MULTI' ? 'multi' : 'single'
  const perScore = Math.max(1, Math.floor(100 / opts.count))

  const questions: GeneratedQuestion[] = []
  for (const q of arr.data) {
    // 过滤越界 answer
    const validAnswer = q.answer.filter((a) => a >= 0 && a < q.opts.length)
    if (validAnswer.length === 0) continue
    questions.push({
      id: randomUUID(),
      type: dbType,
      text: q.text.trim(),
      opts: q.opts.map((o) => o.trim()),
      answer: dbType === 'multi' ? validAnswer : [validAnswer[0]],
      score: perScore,
      exp: q.exp?.trim() || undefined,
    })
  }
  if (questions.length === 0) throw new AiQuizInvalidError('AI 未返回有效题目')
  // 满分补齐 100：floor(100/count) 的余数补给最后一题，避免总分 99/98
  const remainder = 100 - perScore * questions.length
  if (remainder !== 0) questions[questions.length - 1].score += remainder
  return questions
}
