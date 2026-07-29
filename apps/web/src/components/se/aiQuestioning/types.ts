export interface AIQuestionContext {
  page: string
  objectType: string
  objectId: string
  summary: string
  title?: string | null
  meta?: Record<string, string | number | boolean | null | undefined>
}

export const DEFAULT_AI_CONTEXT_QUESTION = '请结合这段页面内容，解释重点并给出下一步处理建议。'
export const DEFAULT_CONTEXT_SUMMARY_LIMIT = 600

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

export function summarizeAIContextText(value: string, limit = DEFAULT_CONTEXT_SUMMARY_LIMIT) {
  const text = compactWhitespace(value || '')
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function formatAIQuestionContext(context: AIQuestionContext) {
  const metaLines = Object.entries(context.meta || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)

  return [
    '【问小智上下文】',
    `page=${context.page}`,
    `objectType=${context.objectType}`,
    `objectId=${context.objectId}`,
    context.title ? `title=${compactWhitespace(context.title)}` : null,
    ...metaLines,
    '正文摘要：',
    summarizeAIContextText(context.summary),
  ].filter(Boolean).join('\n')
}

export function buildAIAskPayload(context: AIQuestionContext, question = DEFAULT_AI_CONTEXT_QUESTION) {
  return {
    question,
    contextText: formatAIQuestionContext(context),
  }
}
