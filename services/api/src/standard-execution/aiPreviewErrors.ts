export type AiPreviewErrorCode = 'SE_AI_PREVIEW_OVERLOADED' | 'SE_AI_PREVIEW_FAILED'

export interface AiPreviewErrorPayload {
  status: number
  code: AiPreviewErrorCode
  error: string
  detail?: string
}

const OVERLOAD_STATUS = new Set([429, 502, 503, 504])
const OVERLOAD_PATTERNS = [
  'timeout',
  'timed out',
  'abort',
  'aborted',
  'overload',
  'overloaded',
  'rate limit',
  'too many requests',
  '429',
  '502',
  '503',
  '504',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'fetch failed',
  'network',
]

export function isAiPreviewOverloadLike(input: unknown) {
  const text = String(input ?? '').toLowerCase()
  return OVERLOAD_PATTERNS.some((pattern) => text.includes(pattern))
}

export function classifyAiPreviewError(err: unknown, fallback: string): AiPreviewErrorPayload {
  const e = err as { status?: number; message?: string; code?: string; reason?: string }
  const status = e.status || 500
  const detail = e.message || e.reason || fallback
  const isOverload = OVERLOAD_STATUS.has(status) || isAiPreviewOverloadLike(`${e.code || ''} ${detail}`)

  if (isOverload) {
    return {
      status: OVERLOAD_STATUS.has(status) ? status : 503,
      code: 'SE_AI_PREVIEW_OVERLOADED',
      error: 'AI 解析服务繁忙，请稍后重试',
      detail,
    }
  }

  return {
    status,
    code: 'SE_AI_PREVIEW_FAILED',
    error: detail || fallback,
  }
}
