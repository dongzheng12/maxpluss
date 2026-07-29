/**
 * GB/T 1.1-2020 起草硬约束 prompt 内容契约测试 — Phase C / 方案 §3.3
 *
 * 验证关键条款短语被注入到 prompt 字符串中（产品/方法/管理 三类大纲 + 框架）。
 * 内容契约比 LLM 行为更稳，且修改 prompt 时如果误删条款，测试立刻报警。
 */
import { describe, it, expect } from 'vitest'
import { GB1_1_2020_DRAFTING_RULES } from '../src/services/chatStdWriting.js'

const REQUIRED_PHRASES = [
  '强制要求用「应」',
  '推荐用「宜」',
  '允许用「可」',
  '规范性引用文件格式',
  'GB/T XXXX-YYYY',
  '波浪号「～」',
  '禁止使用短横线',
  '技术要求与试验方法严格对应',
  '一切引用的标准编号都必须真实存在',
  '[待核实',
]

describe('GB1_1_2020_DRAFTING_RULES — 内容契约', () => {
  for (const phrase of REQUIRED_PHRASES) {
    it(`包含关键短语：${phrase}`, () => {
      expect(GB1_1_2020_DRAFTING_RULES).toContain(phrase)
    })
  }

  it('助动词/数值范围/编号格式三条并列规则都在', () => {
    const text = GB1_1_2020_DRAFTING_RULES
    expect(text).toMatch(/助动词[\s\S]*推荐[\s\S]*允许/)
    expect(text).toMatch(/数值范围[\s\S]*波浪号/)
    expect(text).toMatch(/规范性引用文件格式[\s\S]*GB\/T\s*XXXX/)
  })

  it('禁止虚构编号约束清晰可读', () => {
    expect(GB1_1_2020_DRAFTING_RULES).toMatch(/禁止虚构编号/)
  })
})
