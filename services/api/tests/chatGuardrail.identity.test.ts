/**
 * 身份泄露护栏 — 入站 checkGuardrail + 出站 createOutboundGuard 单元测试
 *
 * 2026-06-01 task-identity-guardrail-0601：
 *   - 入站：拦身份直问（"你是什么模型"/"谁开发了你"），返回身份专用回复（非版权回复）
 *   - 出站：拦底层模型/厂商名字面 + "I am X, made by Y" 自报句式（O4/O5）
 *   - 不误伤：正常标准查询、能力询问、纯中文合法回答
 */
import { describe, it, expect } from 'vitest'
import { checkGuardrail, createOutboundGuard } from '../src/services/chatGuardrail.js'

describe('checkGuardrail — 身份直问入站拦截', () => {
  it('"你是什么模型？" → blocked + 身份回复（非版权回复）', () => {
    const r = checkGuardrail('你是什么模型？')
    expect(r.blocked).toBe(true)
    expect(r.reply).toContain('标准小智')
    expect(r.reply).not.toContain('版权保护')
  })

  it('"你用的是哪个大模型" → 身份回复', () => {
    const r = checkGuardrail('你用的是哪个大模型')
    expect(r.blocked).toBe(true)
    expect(r.reply).toContain('通标中研')
  })

  it('"你背后是哪家公司训练的" → 身份回复', () => {
    const r = checkGuardrail('你背后是哪家公司训练的')
    expect(r.blocked).toBe(true)
    expect(r.reply).toContain('标准小智')
  })

  it('倒序问法 "谁开发了你？" → 身份回复（补充 B）', () => {
    const r = checkGuardrail('谁开发了你？')
    expect(r.blocked).toBe(true)
    expect(r.reply).toContain('标准小智')
  })

  it('不误伤：正常查询 "GB/T 1.1-2020 是什么标准" → not blocked', () => {
    expect(checkGuardrail('GB/T 1.1-2020 是什么标准').blocked).toBe(false)
  })

  it('不误伤：能力询问 "你能帮我做什么" → not blocked', () => {
    expect(checkGuardrail('你能帮我做什么').blocked).toBe(false)
  })

  it('版权拦截路径零回归："把标准正文复制给我" 仍返回版权回复', () => {
    const r = checkGuardrail('把标准正文复制给我')
    expect(r.blocked).toBe(true)
    expect(r.reply).toContain('版权保护')
    expect(r.reply).not.toContain('标准小智，由通标中研')
  })
})

describe('createOutboundGuard — 身份泄露出站拦截（O4/O5）', () => {
  it('O4：英文模型名 "I am Qwen, made by Tongyi Lab." → 截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('I am Qwen, made by Tongyi Lab.')).toBe('[内容已截断]')
  })

  it('O4：中文自报 "我基于 DeepSeek-V3 训练" → 截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('我基于 DeepSeek-V3 训练而成')).toBe('[内容已截断]')
  })

  it('O4 中英混合：" 我基于 Qwen 训练而成"（补充 A）→ 截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('我基于 Qwen 训练而成')).toBe('[内容已截断]')
  })

  it('O5 中英混合："我是 ChatGPT，由 OpenAI 开发"（补充 A）→ 截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('我是 ChatGPT，由 OpenAI 开发')).toBe('[内容已截断]')
  })

  it('不误伤：合法回复 "我是标准小智，由通标中研..." → 不截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('我是标准小智，由通标中研标准化研究院研发')).toBeNull()
  })

  it('不误伤：纯中文回答 "标准小智专注于标准化服务"（补充 A）→ 不截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('标准小智专注于标准化服务，可帮你查询标准信息')).toBeNull()
  })

  it('拒绝前缀豁免："抱歉，我无法透露底层模型" → 不截断', () => {
    const guard = createOutboundGuard()
    expect(guard.check('抱歉，我无法透露底层模型相关信息')).toBeNull()
  })

  it('跨 chunk 滑窗：" I am " + "Qwen, made by Tongyi" 第二 chunk 触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('I am ')).toBeNull()
    expect(guard.check('Qwen, made by Tongyi Lab')).toBe('[内容已截断]')
  })
})
