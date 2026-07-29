/**
 * 前端错误兜底：把后端透传或浏览器抛的英文/技术错误,翻译成"用户能看懂 + 知道下一步怎么做"的中文。
 *
 * 命中规则:任何业务调用 catch 块拿到 e?.response?.data?.error / e?.message 后,
 * 优先调 humanizeError(rawMsg) 再传给 message.error / Modal.error。
 *
 * 设计原则:
 * - 后端如果已经给中文（含汉字）→ 原文返回,不动。
 * - 命中已知英文模式 → 替换为中文 + 下一步建议。
 * - 都不命中 → 回落到通用兜底"系统处理失败,请稍后重试"。
 *
 * 不在这里建 errorMap 体系（用户要求今天不重构）,只做最小白名单。
 */

const ERROR_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /ENOENT/i, message: '系统处理失败，请稍后重试或重新上传文件。' },
  { pattern: /MODULE_NOT_FOUND/i, message: '系统处理失败，请稍后重试。' },
  { pattern: /host\.docker\.internal|ECONNREFUSED|ECONNRESET|ENOTFOUND/i, message: '文档解析服务暂时不可用，请稍后重试。' },
  { pattern: /\b(timeout|timed out)\b/i, message: '请求处理超时，请稍后重试。' },
  { pattern: /Network Error|net::ERR/i, message: '网络连接失败，请检查网络后重试。' },
  { pattern: /\bPrisma|PrismaClient|P1001/i, message: '任务处理失败，请稍后重试。' },
  { pattern: /Extract failed|EXTRACT_FAILED/i, message: '文档解析失败，请稍后重试或更换文件后重新上传。' },
  { pattern: /OCR_FAILED|TEXT_INSUFFICIENT/i, message: '文档解析失败，请上传文字版 PDF / Word 文档。' },
  { pattern: /\bUnauthorized\b|401/i, message: '登录已过期，请重新登录。' },
  { pattern: /\bForbidden\b|403/i, message: '当前账号无权访问该功能。' },
  { pattern: /\bInternal Server Error\b|500/i, message: '系统繁忙，请稍后重试。' },
  { pattern: /Bad Gateway|502|503|504/, message: '服务暂时不可用，请稍后重试。' },
]

const FALLBACK_MESSAGE = '系统处理失败，请稍后重试。'

const HAS_CJK = /[一-鿿]/
const LEADING_TECH_PREFIX = /^\s*(?:\[[A-Z0-9_]+\]|[A-Z0-9_]+:)\s*/
const BUSINESS_REASON_HINT = /页数过多|文字过多|文件过大|格式不支持|文本不足|上传文件不存在|本次失败不消耗权益/

export function humanizeError(raw: unknown, fallback: string = FALLBACK_MESSAGE): string {
  if (raw == null) return fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = typeof raw === 'string' ? raw : (raw as any)?.message || String(raw)
  if (!text) return fallback
  const strippedText = text.replace(LEADING_TECH_PREFIX, '').trim()

  if (HAS_CJK.test(strippedText) && BUSINESS_REASON_HINT.test(strippedText)) {
    return strippedText
  }

  // 后端已返回中文 → 原文(汉字密度阈值粗判)
  if (HAS_CJK.test(text) && !/[A-Za-z]{6,}/.test(text)) {
    return text
  }

  for (const { pattern, message } of ERROR_PATTERNS) {
    if (pattern.test(text)) return message
  }

  // 含汉字混英文 → 原文(假设是后端中文 + 拼接 e.message 的混排)
  if (HAS_CJK.test(text)) return text

  return fallback
}

/** 从 axios error 提取最有用的 message;catch 块直接 humanize(e) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function humanize(e: any, fallback?: string): string {
  const rawFromBody = e?.response?.data?.error || e?.response?.data?.message
  const rawFromErr = e?.message
  return humanizeError(rawFromBody || rawFromErr, fallback)
}
