/**
 * Phase 0.5 #4 三段管道纯函数单测：cleanStandardText / chunkText / validateDrafts
 * 纯函数，不依赖 DB（但 vitest globalSetup 仍会连 PG，跑测请 source .env.test）。
 */
import { describe, it, expect } from 'vitest'
import { cleanStandardText, chunkText, validateDrafts, MAX_DRAFTS_WARN } from '../src/standard-execution/parseClean.js'
import type { RequirementDraft } from '../src/standard-execution/types.js'

// 模拟 GB/T1032 结构：封面 + 目次 + 前言 + 1范围 + 2引用 + 3术语 + 4符号 + 5/6正文 + 附录 + 参考文献
const SAMPLE = `ICS 29.160.01
GB/T1032—2023
三相异步电动机试验方法
2023-09-07发布
目次
前言
1 范围 1
3 术语和定义 2
5 基本要求 5
前言
本文件代替GB/T1032—2012，主要技术变化如下：
a）增加了术语和定义；
b）删除了某试验方法；
1 范围
本文件规定了三相异步电动机的试验方法。
2 规范性引用文件
GB/T 755 旋转电机基本技术要求
3 术语和定义
3.1 异步电机 asynchronous machine 是指转子绕组通过电磁感应的电机。
4 符号
P 功率
5 基本要求
5.1 试验前应检查电机绝缘电阻，确保符合标准要求。
5.2 应记录试验环境温度和湿度并留存台账。
6 试验准备
6.1 应配备经校准的测量仪表并保持有效期内。
附录A（规范性）
仪器仪表损耗修正方法
参考文献
[1] GB/T 755 旋转电机`

describe('cleanStandardText (段1 清洗)', () => {
  const cleaned = cleanStandardText(SAMPLE)

  it('剥掉前言修订说明（a) b) 不应残留）', () => {
    expect(cleaned).not.toContain('主要技术变化')
    expect(cleaned).not.toContain('删除了某试验方法')
  })

  it('剥掉术语和定义章节（3.1 异步电机定义不残留）', () => {
    expect(cleaned).not.toContain('asynchronous machine')
    expect(cleaned).not.toContain('转子绕组通过电磁感应')
  })

  it('剥掉文末附录 + 参考文献', () => {
    expect(cleaned).not.toContain('仪器仪表损耗修正方法')
    expect(cleaned).not.toContain('旋转电机基本技术要求') // 规范性引用文件内容
  })

  it('保留正文要求章节（5/6 章可执行要求）', () => {
    expect(cleaned).toContain('试验前应检查电机绝缘电阻')
    expect(cleaned).toContain('应配备经校准的测量仪表')
  })

  it('剥掉重复页眉噪声行 GB/T1032—2023', () => {
    expect(cleaned).not.toContain('GB/T1032—2023')
  })

  it('空输入 → 空串', () => {
    expect(cleanStandardText('')).toBe('')
    expect(cleanStandardText('   ')).toBe('')
  })

  it('无法定位正文（无编号章节）→ 兜底返回去噪全文，不丢内容', () => {
    const plain = '这是一段没有章节编号的自由文本，应当保留下来交给 AI 判断。'
    expect(cleanStandardText(plain)).toContain('应当保留下来交给 AI 判断')
  })
})

describe('chunkText (段2 分段)', () => {
  it('空文本 → []', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
  })

  it('短文本（≤ maxChars）→ 单段', () => {
    expect(chunkText('短文本', 8000)).toHaveLength(1)
  })

  it('长文本按章节分多段，每段不超窗口', () => {
    const longBody = Array.from({ length: 20 }, (_, i) =>
      `${i + 4} 第${i + 4}章\n` + '应当执行某项检查并记录。'.repeat(40),
    ).join('\n')
    const chunks = chunkText(longBody, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000)
  })

  it('分段后合并内容无丢失（字符总量覆盖原文非空内容）', () => {
    const body = '4 章节\n' + '内容'.repeat(2000)
    const chunks = chunkText(body, 500)
    const merged = chunks.join('')
    expect(merged.replace(/\n/g, '').length).toBeGreaterThanOrEqual(body.replace(/\n/g, '').length - chunks.length)
  })
})

describe('validateDrafts (段3 校验)', () => {
  const mk = (over: Partial<RequirementDraft>): RequirementDraft => ({
    clauseNo: null, title: 't', requirementText: '这是一条足够长的可执行要求项内容', ...over,
  })

  it('过滤空标题 / 过短 / 术语定义残留', () => {
    const r = validateDrafts([
      mk({ title: '', requirementText: '空标题应被过滤掉的内容' }),
      mk({ title: '短', requirementText: '太短' }),
      mk({ title: '术语', requirementText: '异步电机是指一种电机设备' }),
      mk({ title: '正常', requirementText: '应定期检查并记录设备运行状态' }),
    ])
    expect(r.valid).toHaveLength(1)
    expect(r.valid[0].title).toBe('正常')
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(['DEFINITION', 'EMPTY_TITLE', 'TOO_SHORT'])
  })

  it('去重（同 clauseNo + 同前缀）', () => {
    const r = validateDrafts([
      mk({ clauseNo: '5.1', title: 'a', requirementText: '应检查绝缘电阻并记录数值结果' }),
      mk({ clauseNo: '5.1', title: 'b', requirementText: '应检查绝缘电阻并记录数值结果' }),
    ])
    expect(r.valid).toHaveLength(1)
    expect(r.rejected[0].reason).toBe('DUPLICATE')
  })

  it(`超 ${MAX_DRAFTS_WARN} 条 → overLimit + 告警（不硬删）`, () => {
    const many = Array.from({ length: MAX_DRAFTS_WARN + 5 }, (_, i) =>
      mk({ clauseNo: `5.${i}`, requirementText: `第${i}条应执行的检查要求内容描述` }),
    )
    const r = validateDrafts(many)
    expect(r.overLimit).toBe(true)
    expect(r.valid.length).toBe(MAX_DRAFTS_WARN + 5) // 不硬删
    expect(r.warnings.some((w) => w.includes('告警阈值'))).toBe(true)
  })

  it('正常数量不告警', () => {
    const r = validateDrafts([mk({ requirementText: '应定期巡检并形成记录台账' })])
    expect(r.overLimit).toBe(false)
    expect(r.warnings).toHaveLength(0)
  })
})
