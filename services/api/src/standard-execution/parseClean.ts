/**
 * standard-execution / 解析三段管道的「清洗 + 分段 + 校验」纯函数（Phase 0.5 #4 修复）
 *
 * 背景：GB/T1032 等超长标准（7万字）解析出 424 条垃圾检查点。根因 =
 *   ① AI 对超长全文返回非法 JSON → 静默降级 RULE
 *   ② RULE 把目录/前言/术语定义全当条款过度切片，无数量上限
 *
 * 三段管道职责分工（RULE 不再做语义判断）：
 *   段1 cleanStandardText  — 把脏文本变干净：剥封面/目次/前言/引言/范围/规范性引用/
 *                            术语和定义/符号/附录/参考文献 + 去重复页眉
 *   段2 chunkText          — 按章节边界 + 字数窗口分段，避免超 token
 *   段3 validateDrafts     — 落库前兜底：去重 + 过滤(空标题/过短/术语定义残留) + 数量上限告警
 *
 * 纯函数，不依赖 prisma / network / env，便于单测。
 * @see 必读/02_技术架构.md §九 AI 链路；Phase 0 diagnostic #4 报告
 */
import type { RequirementDraft } from './types.js'

// 一级编号章节标题："5 基本要求"（数字后直接空格再非数字非点 → 排除 "5.1"）
const SECTION_TITLE_RE = /^\s*(\d{1,2})\s+[^\d.\s].*$/
// 资料性/规范性附录 + 参考文献（文末非要求块）
const APPENDIX_RE = /^\s*(附录\s*[A-Za-z]|参考文献)\b/
// 重复页眉噪声行：GB/T 1032—2023 / GB 50011-2010 之类单独成行
const HEADER_NOISE_RE = /^\s*[A-Z]{1,4}(\/[A-Z])?\s*\d{2,5}\s*[—\-–]\s*\d{4}\s*$/

const TERM_SECTION_RE = /术语和定义|术语、定义/

/**
 * 段1：清洗标准原文 → 只保留正文要求章节。
 * 国标惯例：1 范围 / 2 规范性引用文件 / 3 术语和定义 / 4+ 正文要求。
 * 正文起点 = 第一个编号 ≥4 的一级章节（兜底：术语和定义之后第一个一级章节）。
 * 文末 = 第一个「附录/参考文献」之前。
 * 定位失败时返回去噪全文（靠段2/段3 + AI 兜底，不至于丢内容）。
 */
export function cleanStandardText(rawText: string): string {
  if (!rawText || !rawText.trim()) return ''
  const lines = rawText.replace(/\r\n?/g, '\n').split('\n')

  // 1) 去重复页眉噪声行
  const deNoised = lines.filter((l) => !HEADER_NOISE_RE.test(l.trim()))

  // 目次行 "5 基本要求 5"（尾带页码）也匹配 SECTION_TITLE_RE，必须排除：
  // 正文章节标题行尾不会是页码数字（目次专有特征 = 行尾 " 数字"）
  const PAGE_TAIL = /\s\d{1,4}$/
  const isBodyTitle = (line: string) => SECTION_TITLE_RE.test(line) && !PAGE_TAIL.test(line.trim())

  // 2) 正文起点：第一个编号 ≥4 的一级章节标题（排除目次假标题行）
  let bodyStart = -1
  for (let i = 0; i < deNoised.length; i++) {
    const m = deNoised[i].match(SECTION_TITLE_RE)
    if (m && Number(m[1]) >= 4 && !PAGE_TAIL.test(deNoised[i].trim())) { bodyStart = i; break }
  }
  // 兜底：术语和定义章节之后第一个一级章节（termIdx 也排除目次假行）
  if (bodyStart < 0) {
    const termIdx = deNoised.findIndex((l) => TERM_SECTION_RE.test(l) && !PAGE_TAIL.test(l.trim()))
    if (termIdx >= 0) {
      for (let i = termIdx + 1; i < deNoised.length; i++) {
        if (isBodyTitle(deNoised[i])) { bodyStart = i; break }
      }
    }
  }
  if (bodyStart < 0) bodyStart = 0 // 仍定位不到 → 不剥前置，去噪全文兜底

  // 3) 文末：第一个 附录/参考文献
  let bodyEnd = deNoised.length
  for (let i = bodyStart; i < deNoised.length; i++) {
    if (APPENDIX_RE.test(deNoised[i].trim())) { bodyEnd = i; break }
  }

  const body = deNoised.slice(bodyStart, bodyEnd).join('\n').trim()
  return body || deNoised.join('\n').trim()
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max))
  return out
}

/**
 * 段2：把清洗后文本按「一级章节边界 + 字数窗口」分段，避免 AI 超 token。
 * 优先在章节边界断（buf 已 ≥60% 窗口时遇到新章节就断），保证语义不腰斩；
 * 单章节超窗口则硬切。空文本 → []；不超窗口 → 单段。
 */
export function chunkText(text: string, maxChars = 8000): string[] {
  if (!text || !text.trim()) return []
  if (text.length <= maxChars) return [text]

  const lines = text.split('\n')
  const chunks: string[] = []
  let buf: string[] = []
  let bufLen = 0
  const flush = () => {
    if (buf.length) { chunks.push(buf.join('\n')); buf = []; bufLen = 0 }
  }
  for (const line of lines) {
    const isSection = SECTION_TITLE_RE.test(line)
    if (isSection && bufLen >= maxChars * 0.6) flush()
    if (bufLen + line.length + 1 > maxChars && buf.length) flush()
    buf.push(line)
    bufLen += line.length + 1
  }
  flush()
  return chunks.flatMap((c) => (c.length <= maxChars ? [c] : hardSplit(c, maxChars)))
}

export const MAX_DRAFTS_WARN = 100

export interface ValidateResult {
  valid: RequirementDraft[]
  rejected: Array<{ draft: RequirementDraft; reason: string }>
  warnings: string[]
  overLimit: boolean
  total: number
}

// 术语定义残留："异步电机 是指…" / "电动机 定义为…"（前 12 字内出现定义动词）
const DEFINITION_RE = /^.{0,12}?(是指|指的是|定义为|系指|是一[种类项])/
const ACTION_REQUIREMENT_RE = /(应当|应|必须|不得|禁止|严禁|需要|确保|定期|记录|检查|培训|留存|备案|报备|提交|建立|制定|明确|配备|开展|组织|评估|评审|监视|测量|控制|识别|分类|标识|处置|整改|验证|考核|提供|设置|编制|实施|保持|维护)/
const SECTION_HEADING_ONLY_RE = /^\s*\d+(?:\.\d+){0,3}\s*[\u4e00-\u9fffA-Za-z（）()、\s]{1,30}$/

/**
 * 段3：落库前兜底校验。去重 + 过滤(空标题/过短/术语定义残留) + 数量上限告警。
 * 不静默丢弃：rejected 带 reason，warnings 给前端 dryRun 预览提示。
 * overLimit（> MAX_DRAFTS_WARN）不硬删，标记让用户人工确认。
 */
export function validateDrafts(drafts: RequirementDraft[]): ValidateResult {
  const valid: RequirementDraft[] = []
  const rejected: ValidateResult['rejected'] = []
  const seen = new Set<string>()
  for (const d of drafts) {
    const text = (d.requirementText || '').trim()
    const title = (d.title || '').trim()
    if (!title) { rejected.push({ draft: d, reason: 'EMPTY_TITLE' }); continue }
    if (text.length < 8) { rejected.push({ draft: d, reason: 'TOO_SHORT' }); continue }
    if (DEFINITION_RE.test(text)) { rejected.push({ draft: d, reason: 'DEFINITION' }); continue }
    if (SECTION_HEADING_ONLY_RE.test(text) && !ACTION_REQUIREMENT_RE.test(text)) {
      rejected.push({ draft: d, reason: 'SECTION_HEADING' }); continue
    }
    if (!ACTION_REQUIREMENT_RE.test(text)) {
      rejected.push({ draft: d, reason: 'NO_ACTION_REQUIREMENT' }); continue
    }
    const key = `${d.clauseNo ?? ''}::${text.slice(0, 60)}`
    if (seen.has(key)) { rejected.push({ draft: d, reason: 'DUPLICATE' }); continue }
    seen.add(key)
    valid.push(d)
  }
  const warnings: string[] = []
  const overLimit = valid.length > MAX_DRAFTS_WARN
  if (overLimit) {
    warnings.push(`解析出 ${valid.length} 条要求项，超过 ${MAX_DRAFTS_WARN} 条告警阈值，建议人工确认后再下发`)
  }
  if (rejected.length > 0) {
    warnings.push(`已自动过滤 ${rejected.length} 条（空标题/过短/术语定义/重复）`)
  }
  return { valid, rejected, warnings, overLimit, total: drafts.length }
}
