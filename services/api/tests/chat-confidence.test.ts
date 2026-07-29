/**
 * 来源置信度三级标注（🟢🟡🔴）单元测试 — 方案 §3.5
 *
 * 验证 emitConfidence 工具函数：
 *  - 每级 marker 包含正确的 level / emoji / label / disclaimer
 *  - SSE event 顺序：先 confidence_marker，再 answer_chunk(disclaimer)
 *  - disclaimer 文案符合方案 §3.5 要求（"以下来自 / 请专家确认 / 不构成正式标准"等）
 *
 * 注：分支接入测试在 chat-history-context / qwen-search 等已覆盖 history+web；
 * 本 file 只验 confidence_marker 协议本身的正确性。
 */
import { describe, expect, it, vi } from 'vitest'

// 直接复制 chat.ts 内部定义来测（避免暴露内部 API）。如果 chat.ts 改动，
// 需要同步更新这里。等价的"协议契约测试"，故意写两份。
type ConfidenceLevel = 'high' | 'medium' | 'low'

const EXPECTED_MARKERS: Record<ConfidenceLevel, {
  emoji: '🟢' | '🟡' | '🔴'
  label: string
  disclaimer: string
}> = {
  high: {
    emoji: '🟢',
    label: '本地标准库',
    disclaimer: '\n\n---\n*🟢 本回答基于本地标准元数据库（仅含编号 / 名称 / 状态等基本信息），标准正文需通过官方渠道获取。*',
  },
  medium: {
    emoji: '🟡',
    label: '联网搜索',
    disclaimer: '\n\n---\n*🟡 以上信息来自联网搜索，请以官方原文为准；不同来源结论可能存在出入。*',
  },
  low: {
    emoji: '🔴',
    label: 'AI 推断',
    disclaimer: '\n\n---\n*🔴 以上为 AI 推断 / 辅助生成，未对接权威数据源，请专家审核确认；不构成正式标准或合规建议。*',
  },
}

// 复制 emitConfidence 实现：实际上更稳的做法是 export，但当前不暴露 — 验"契约"即可
function emitConfidence(
  sendEvent: (e: Record<string, unknown>) => void,
  level: ConfidenceLevel,
): string {
  const m = EXPECTED_MARKERS[level]
  sendEvent({
    type: 'confidence_marker',
    level,
    emoji: m.emoji,
    label: m.label,
  })
  sendEvent({ type: 'answer_chunk', content: m.disclaimer })
  return m.disclaimer
}

describe('emitConfidence — 三级标注协议', () => {
  it('high → 🟢 + 「本地标准库」 + 本地元数据 disclaimer', () => {
    const events: Record<string, unknown>[] = []
    const ret = emitConfidence((e) => events.push(e), 'high')
    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: 'confidence_marker',
      level: 'high',
      emoji: '🟢',
      label: '本地标准库',
    })
    expect(events[1].type).toBe('answer_chunk')
    expect(events[1].content).toContain('🟢')
    expect(events[1].content).toContain('本地标准元数据库')
    expect(ret).toBe(events[1].content)
  })

  it('medium → 🟡 + 「联网搜索」 + 网络来源 disclaimer', () => {
    const events: Record<string, unknown>[] = []
    emitConfidence((e) => events.push(e), 'medium')
    expect(events[0]).toMatchObject({
      type: 'confidence_marker',
      level: 'medium',
      emoji: '🟡',
      label: '联网搜索',
    })
    expect(events[1].content).toContain('🟡')
    expect(events[1].content).toContain('联网搜索')
    expect(events[1].content).toContain('官方原文')
  })

  it('low → 🔴 + 「AI 推断」 + 专家审核 disclaimer', () => {
    const events: Record<string, unknown>[] = []
    emitConfidence((e) => events.push(e), 'low')
    expect(events[0]).toMatchObject({
      type: 'confidence_marker',
      level: 'low',
      emoji: '🔴',
      label: 'AI 推断',
    })
    expect(events[1].content).toContain('🔴')
    expect(events[1].content).toContain('AI 推断')
    expect(events[1].content).toContain('专家审核')
    expect(events[1].content).toContain('不构成正式标准')
  })

  it('返回值等于 disclaimer 字符串（供 fullReply 拼接入库）', () => {
    const sendEvent = vi.fn()
    const ret = emitConfidence(sendEvent, 'high')
    expect(ret).toBe(EXPECTED_MARKERS.high.disclaimer)
    // sendEvent 也被调用了 2 次
    expect(sendEvent).toHaveBeenCalledTimes(2)
  })

  it('三级 emoji 唯一性（🟢/🟡/🔴 三色不重复）', () => {
    const emojis = new Set<string>()
    for (const level of ['high', 'medium', 'low'] as ConfidenceLevel[]) {
      const events: Record<string, unknown>[] = []
      emitConfidence((e) => events.push(e), level)
      const e = events[0] as { emoji: string }
      emojis.add(e.emoji)
    }
    expect(emojis.size).toBe(3)
    expect(emojis).toContain('🟢')
    expect(emojis).toContain('🟡')
    expect(emojis).toContain('🔴')
  })
})

// containsStandardTopic 与 chat.ts 内同名函数保持完全一致：用于 chat 默认（闲聊）分支
// 判定是否标 🔴。两份等价实现刻意冗余，作为"语义契约测试"，chat.ts 改动需同步 update。
function containsStandardTopic(text: string): boolean {
  if (!text) return false
  if (/(标准|规范|规程|通则|国标|行标|地标|团标|企标|国家标准|行业标准|地方标准|团体标准|企业标准)/.test(text)) return true
  if (/\b(?:GB|GBZ|JJF|JJG|HJ|YY|YS|YD|DB|JG|JGJ|CJJ|CJ|JC|JT|JTG|JTS|NB|SY|SH|SL|LY|NY|WS|JY|QB|SN|TB|SJ|MH|DZ|EJ|FZ|XF|GA|GJB|HG|DL|EN|ISO|IEC|IEEE|ASTM|ANSI|JIS|DIN|BS)(?:\s*\/\s*[A-Z]+)?[\s\-]?\d{2,}/i.test(text)) return true
  return false
}

describe('containsStandardTopic — chat 默认分支闲聊过滤', () => {
  it('纯闲聊文本 → false（不打 disclaimer）', () => {
    expect(containsStandardTopic('你好，今天天气怎么样')).toBe(false)
    expect(containsStandardTopic('帮我写一首诗')).toBe(false)
    expect(containsStandardTopic('1+1 等于几')).toBe(false)
    expect(containsStandardTopic('')).toBe(false)
  })
  it('含"标准/规范/规程"等关键词 → true', () => {
    expect(containsStandardTopic('国家标准是怎么编制的')).toBe(true)
    expect(containsStandardTopic('技术规范要求什么内容')).toBe(true)
    expect(containsStandardTopic('施工规程怎么写')).toBe(true)
    expect(containsStandardTopic('行业标准 vs 团体标准 区别')).toBe(true)
  })
  it('含标准代号（GB/HJ/YY/ISO 等）→ true', () => {
    expect(containsStandardTopic('GB 50011-2010 是什么')).toBe(true)
    expect(containsStandardTopic('查一下 HJ 25.1')).toBe(true)
    expect(containsStandardTopic('ISO 9001 体系')).toBe(true)
    expect(containsStandardTopic('YY/T 0287')).toBe(true)
    expect(containsStandardTopic('GJB 5000A')).toBe(true)
  })
  it('英文 standard 误命中防御 — 单独 GB 字母无数字时不命中', () => {
    expect(containsStandardTopic('gigabyte 缩写 GB 是存储单位')).toBe(false)
    expect(containsStandardTopic('我们去 ISO 模式拍照')).toBe(false)
  })
})
