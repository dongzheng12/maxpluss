/**
 * 意图识别 — 先正则快速判断，匹配不到再调 LLM
 */
import { callLLM } from './llm.js'

export interface IntentResult {
  intent: 'search' | 'compare' | 'scan' | 'write' | 'task_status' | 'member' | 'chat'
  keywords?: string[]
  standardNo?: string | null
}

// ─── 正则快速匹配 ─────────────────────────────────────────

const STANDARD_NO_RE = /[A-Z]{1,3}[\/\s]?[A-ZT]?\s*[\d][\d.]*[-—]\d{4}/i

const INTENT_PATTERNS: Array<{ intent: IntentResult['intent']; patterns: RegExp[] }> = [
  {
    intent: 'compare',
    patterns: [/比对/, /对比/, /相似度/, /全库比/, /一对一/, /区别/, /有何不同/, /怎么区分/, /两个.*标准/, /标准.*和.*标准/],
  },
  {
    intent: 'scan',
    patterns: [/扫一扫/, /拍照/, /识别.*封面/, /识别.*标准/, /扫描/],
  },
  {
    intent: 'write',
    patterns: [/编写.*标准/, /写.*标准/, /生成.*大纲/, /标准.*草案/, /起草/, /帮我写/],
  },
  {
    intent: 'task_status',
    patterns: [/任务.*进度/, /报告.*好了/, /比对.*状态/, /查.*任务/],
  },
  {
    intent: 'member',
    patterns: [/会员.*多少/, /价格/, /额度/, /权益/, /升级.*会员/, /开通.*会员/],
  },
  {
    intent: 'search',
    patterns: [
      /查.*标准/, /搜索/, /检索/, /有哪些标准/, /是否废止/, /现行/, /标准号/,
      // 解读/分析/理解类
      /解读.*标准/, /分析.*标准/, /理解.*标准/, /帮.*解读/, /帮.*分析/, /帮.*理解/,
      // 核心要求/主要内容类
      /核心要求/, /主要内容/, /主要规定/, /核心内容/, /主要条款/,
    ],
  },
]

function extractStandardNo(msg: string): string | null {
  const m = msg.match(STANDARD_NO_RE)
  return m ? m[0] : null
}

function regexDetect(msg: string): IntentResult | null {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(msg))) {
      const result: IntentResult = { intent }
      if (intent === 'search') {
        result.standardNo = extractStandardNo(msg)
        // 简单提取关键词：去掉常见停用词
        result.keywords = msg
          .replace(/^查一下|^查一|^帮我查|^查|帮我|请问|有没有|关于|的标准|有哪些|是否|标准/g, '')
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0)
      }
      return result
    }
  }

  // 如果消息包含标准号，默认视为 search
  const stdNo = extractStandardNo(msg)
  if (stdNo) {
    return { intent: 'search', standardNo: stdNo, keywords: [stdNo] }
  }

  return null
}

// ─── LLM 意图分类 ─────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `你是一个意图分类器。根据用户消息，返回 JSON 格式的意图分类结果。
可选意图：search, compare, scan, write, task_status, member, chat
如果是 search 意图，额外提取 keywords（搜索关键词数组）和 standardNo（标准号，如有）。
只返回 JSON，不要其他内容。
示例：{"intent":"search","keywords":["焊接","技术要求"],"standardNo":null}`

export async function detectIntent(userMessage: string): Promise<IntentResult> {
  // 先尝试正则
  const fast = regexDetect(userMessage)
  if (fast) return fast

  // 正则未命中，调 LLM
  try {
    const raw = await callLLM(
      [
        { role: 'system', content: INTENT_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0, maxTokens: 200 },
    )
    const parsed = JSON.parse(raw.trim()) as IntentResult
    if (parsed.intent) return parsed
  } catch (err) {
    console.warn('[SVC] intent fallback to chat', err)
  }

  return { intent: 'chat' }
}
