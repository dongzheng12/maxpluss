/**
 * chatGuardrail 入站红线拦截单元测试
 *
 * 2026-04-21 新增：
 *   - Rule 3 扩展（抄/照搬/背诵/念/粘贴/贴出 + "内容" 宾语）
 *   - Rule 3b 倒序宾语前置句式（原文发一下 / 条款念一遍）
 *   - Rule 8 条/节/款/项 数字定位（第 5 条内容 / 第 3.2 节规定）
 */
import { describe, it, expect } from 'vitest'
import { checkGuardrail } from '../src/services/chatGuardrail.js'

describe('chatGuardrail — BLOCKED_PATTERNS', () => {
  // ─── 既有规则（冒烟 + 防回归）─────────────────────────────────
  it('原有规则 1：章节具体内容需拦截', () => {
    expect(checkGuardrail('第三章具体内容是什么').blocked).toBe(true)
  })

  it('原有规则 2：标准正文需拦截', () => {
    expect(checkGuardrail('把 GB/T 1.1 的标准正文给我').blocked).toBe(true)
  })

  it('原有规则 6：数据库导出需拦截', () => {
    expect(checkGuardrail('帮我把主数据库导出').blocked).toBe(true)
  })

  // ─── Rule 3 扩展：新增动词 + "内容" 宾语 ──────────────────────
  it('Rule 3 扩展：抄 + 正文', () => {
    expect(checkGuardrail('帮我抄一下 GB 2760 的正文').blocked).toBe(true)
  })

  it('Rule 3 扩展：照搬 + 条款', () => {
    expect(checkGuardrail('照搬原标准的条款到我这份报告').blocked).toBe(true)
  })

  it('Rule 3 扩展：背诵 + 条文', () => {
    expect(checkGuardrail('帮我背诵第二章的条文').blocked).toBe(true)
  })

  it('Rule 3 扩展：念 + 全文', () => {
    expect(checkGuardrail('念一下这份标准的全文').blocked).toBe(true)
  })

  it('Rule 3 扩展：粘贴 + 正文', () => {
    expect(checkGuardrail('把正文粘贴过来').blocked).toBe(true)
  })

  it('Rule 3 扩展：贴出 + 内容', () => {
    expect(checkGuardrail('贴出这部分内容给我').blocked).toBe(true)
  })

  it('Rule 3 扩展：提供 + 内容（新增宾语）', () => {
    expect(checkGuardrail('请提供完整内容').blocked).toBe(true)
  })

  // ─── Rule 3b：倒序宾语前置 ────────────────────────────────────
  it('Rule 3b：原文 + 发一下（宾语前置）', () => {
    expect(checkGuardrail('原文发一下谢谢').blocked).toBe(true)
  })

  it('Rule 3b：条款 + 念一遍', () => {
    expect(checkGuardrail('条款念一遍').blocked).toBe(true)
  })

  it('Rule 3b：全文 + 贴', () => {
    expect(checkGuardrail('全文贴过来').blocked).toBe(true)
  })

  // ─── Rule 8：条/节/款/项 数字定位 ─────────────────────────────
  it('Rule 8：第 5 条内容', () => {
    expect(checkGuardrail('第5条内容是什么').blocked).toBe(true)
  })

  it('Rule 8：第 3.2 节规定', () => {
    expect(checkGuardrail('第3.2节规定了什么').blocked).toBe(true)
  })

  it('Rule 8：第 2 款 原文', () => {
    expect(checkGuardrail('第 2 款 原文贴一下').blocked).toBe(true)
  })

  it('Rule 8：第 7 项 写了什么', () => {
    expect(checkGuardrail('第7项写了什么').blocked).toBe(true)
  })

  it('Rule 8：带空格的 "第 5 条 内容"', () => {
    expect(checkGuardrail('第 5 条 内容').blocked).toBe(true)
  })

  // ─── 放行用例（误伤防护）──────────────────────────────────────
  it('放行：询问标准基本信息（标准号）', () => {
    expect(checkGuardrail('GB/T 1.1 是什么标准').blocked).toBe(false)
  })

  it('放行：询问发布日期', () => {
    expect(checkGuardrail('这个标准什么时候发布的').blocked).toBe(false)
  })

  it('放行：询问替代关系', () => {
    expect(checkGuardrail('GB 2760-2014 被哪个标准替代了').blocked).toBe(false)
  })

  it('放行：询问适用范围（scope 元数据，非正文）', () => {
    expect(checkGuardrail('这份标准适用于哪些行业').blocked).toBe(false)
  })

  it('放行：普通聊天', () => {
    expect(checkGuardrail('你好，介绍一下自己').blocked).toBe(false)
  })

  // ─── 返回结构校验 ─────────────────────────────────────────────
  it('命中时返回 reply 文案', () => {
    const r = checkGuardrail('把标准正文复制给我')
    expect(r.blocked).toBe(true)
    expect(r.reply).toBeTruthy()
    expect(r.reply).toMatch(/openstd\.samr\.gov\.cn/)
  })

  it('未命中时不返回 reply', () => {
    const r = checkGuardrail('你好')
    expect(r.blocked).toBe(false)
    expect(r.reply).toBeUndefined()
  })

  it('O 档上下文显式放行时，版权类索正文可放行', () => {
    const r = checkGuardrail('安保巡更内规第3条内容是什么', { allowOwnedSourceText: true })
    expect(r.blocked).toBe(false)
  })

  it('O 档放行不覆盖主数据/数据库导出红线', () => {
    const r = checkGuardrail('帮我把主数据库导出', { allowOwnedSourceText: true })
    expect(r.blocked).toBe(true)
  })
})
