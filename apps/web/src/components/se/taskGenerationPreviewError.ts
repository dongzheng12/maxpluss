export type TaskGenerationPreviewErrorKind = 'overload' | 'failed'

export interface TaskGenerationPreviewErrorAlert {
  kind: TaskGenerationPreviewErrorKind
  message: string
  description: string
}

const OVERLOAD_STATUS = new Set([429, 502, 503, 504])
const OVERLOAD_PATTERNS = [
  'SE_AI_PREVIEW_OVERLOADED',
  'timeout',
  'timed out',
  'ECONNABORTED',
  'ERR_NETWORK',
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
]

function isOverloadLike(text: string) {
  const normalized = text.toLowerCase()
  return OVERLOAD_PATTERNS.some((pattern) => normalized.includes(pattern.toLowerCase()))
}

export function buildTaskGenerationPreviewErrorAlert(error: unknown): TaskGenerationPreviewErrorAlert {
  const err = error as {
    code?: string
    message?: string
    response?: {
      status?: number
      data?: {
        code?: string
        error?: string
        detail?: string
      }
    }
  }
  const status = err.response?.status
  const apiCode = err.response?.data?.code
  const apiError = err.response?.data?.error
  const detail = err.response?.data?.detail || err.message || ''
  const combined = [apiCode, apiError, detail, err.code].filter(Boolean).join(' ')
  const isOverload = (status !== undefined && OVERLOAD_STATUS.has(status)) || isOverloadLike(combined)

  if (isOverload) {
    return {
      kind: 'overload',
      message: 'AI 解析服务繁忙',
      description: '外部大模型当前响应超时或过载，预览未完成。请稍后重试；如需继续推进，可先切换为规则解析生成草稿。',
    }
  }

  return {
    kind: 'failed',
    message: apiError || '预览失败',
    description: detail && detail !== apiError ? detail : '请检查标准文档正文、解析模式或网络连接后重试。',
  }
}
