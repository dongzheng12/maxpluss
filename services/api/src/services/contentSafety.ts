/**
 * 内容安全 — 第三方词库子串检测
 *
 * 数据来源：fwwdn/sensitive-stop-words (Apache 2.0)，详见
 * src/data/sensitive-words/NOTICE.md。
 *
 * 与 chatGuardrail.ts 的区别：
 *   - chatGuardrail：版权红线（防 LLM 输出标准正文）
 *   - contentSafety：内容安全红线（政治 / 色情 / 涉枪涉爆），
 *     满足《互联网信息服务深度合成管理规定》对 AI 服务的内容安全要求
 *
 * 接入点：
 *   - chat 入站：routes/chat.ts checkGuardrail 后追加一道
 *   - sales bio：utils/sensitiveWords.ts detectSensitiveWord 主防线
 */
import { POLITICAL_WORDS, SEXUAL_WORDS, WEAPONS_WORDS, COUNTS } from '../data/sensitive-words/words.gen.js'

export type SafetyCategory = 'political' | 'sexual' | 'weapons'

export interface SafetyHit {
  hit: string
  category: SafetyCategory
}

const POLITICAL_LOWER = POLITICAL_WORDS.map(w => w.toLowerCase())
const SEXUAL_LOWER = SEXUAL_WORDS.map(w => w.toLowerCase())
const WEAPONS_LOWER = WEAPONS_WORDS.map(w => w.toLowerCase())

function scan(textLower: string, words: readonly string[], category: SafetyCategory): SafetyHit | null {
  for (const w of words) {
    if (textLower.includes(w)) return { hit: w, category }
  }
  return null
}

/**
 * 检测文本是否命中内容安全词库。
 * @param text 用户输入或销售 bio 等待审文本
 * @returns 命中返回 {hit, category}；未命中返回 null
 */
export function detectUnsafeContent(text: string | null | undefined): SafetyHit | null {
  if (!text || typeof text !== 'string') return null
  const lower = text.toLowerCase()
  return (
    scan(lower, POLITICAL_LOWER, 'political') ??
    scan(lower, SEXUAL_LOWER, 'sexual') ??
    scan(lower, WEAPONS_LOWER, 'weapons')
  )
}

export const SAFETY_BLOCKED_REPLY =
  '抱歉，您的输入触发了平台内容安全策略，无法继续处理。\n\n' +
  '本平台依据《互联网信息服务深度合成管理规定》《生成式人工智能服务管理暂行办法》等法律法规，' +
  '对涉及政治敏感、违法违禁、色情低俗等内容的请求统一拒绝。\n\n' +
  '如属误判，请调整表述后重试，或通过客服反馈。'

export { COUNTS as SAFETY_WORD_COUNTS }
