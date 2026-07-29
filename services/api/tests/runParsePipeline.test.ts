/**
 * Phase 0.5 #4 三段管道编排集成测试：runParse（mock aiCaller）
 * 证明修复目标真生效：不静默降级 / 超量告警 / 段3过滤 / 分段。
 */
import { describe, it, expect } from 'vitest'
import { runParse } from '../src/standard-execution/autoGenerateRoute.js'
import { AiCallFailedError } from '../src/standard-execution/aiClient.js'

// 带封面/前言/术语/正文的样本：clean 后应从「5 基本要求」起，剥前言/范围/术语
const STD = `前言
本文件代替旧版，主要技术变化如下：
a）增加了术语；
1 范围
本文件规定三相异步电动机试验方法。
3 术语和定义
3.1 电机 是指一种旋转设备。
5 基本要求
5.1 试验前应检查电机绝缘电阻并记录数值结果数据。
5.2 应记录试验环境温湿度并留存台账资料。
6 试验准备
6.1 应配备经校准的测量仪表并保持有效期内。`

describe('runParse 三段管道编排', () => {
  it('OCR_AI 全段失败 → 降级 RULE + warning 不静默（修 #4 静默降级）', async () => {
    const r = await runParse(STD, 'OCR_AI', async () => { throw new AiCallFailedError('boom') })
    expect(r.parseMode).toBe('RULE')
    expect(r.degraded).toBe(true)
    expect(r.warnings.some((w) => w.includes('降级') || w.includes('失败'))).toBe(true)
  })

  it('AI 返回 >100 条 → overLimit 告警且不硬删（修 #4 无上限）', async () => {
    const big = JSON.stringify(
      Array.from({ length: 115 }, (_, i) => ({
        clauseNo: `5.${i}`, title: `检查${i}`, requirementText: `应执行第${i}项检查并完整记录结果数据内容`,
      })),
    )
    const r = await runParse(STD, 'OCR_AI', async () => big)
    expect(r.drafts.length).toBeGreaterThan(100)
    expect(r.warnings.some((w) => w.includes('告警阈值'))).toBe(true)
  })

  it('AI 返回术语定义残留 → 段3 DEFINITION 过滤（修 #4 垃圾入库）', async () => {
    // 注：parseByAi 会用 requirementText 前 20 字补全空 title，故空标题过滤只在 parseClean 纯函数层测；
    // 这里经真实 parseByAi 路径，验证术语定义残留被段3拦截。
    const mixed = JSON.stringify([
      { clauseNo: '5.1', title: '正常', requirementText: '应定期检查并记录设备运行状态数据' },
      { clauseNo: '3.1', title: '术语', requirementText: '电机是指一种旋转设备装置' },
    ])
    const r = await runParse(STD, 'OCR_AI', async () => mixed)
    expect(r.drafts).toHaveLength(1)
    expect(r.drafts[0].title).toBe('正常')
    expect(r.rejectedCount).toBe(1)
  })

  it('超长文本 → 分段多次调 AI（修 #4 超 token 非法 JSON）', async () => {
    const previous = process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
    process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = '99'
    try {
      const long = '5 基本要求\n' + '应执行检查并记录结果数据内容。'.repeat(3000)
      let calls = 0
      await runParse(long, 'OCR_AI', async () => { calls++; return '[]' })
      expect(calls).toBeGreaterThan(1)
    } finally {
      if (previous === undefined) delete process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
      else process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = previous
    }
  })

  it('超长文本 → AI 分段有限并发执行（修 T1 大文档总耗时）', async () => {
    const previous = process.env.STANDARD_AI_PARSE_CONCURRENCY
    const previousMaxChunks = process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
    process.env.STANDARD_AI_PARSE_CONCURRENCY = '3'
    process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = '99'
    try {
      const long = '5 基本要求\n' + '应执行检查并记录结果数据内容。'.repeat(6000)
      let calls = 0
      let active = 0
      let maxActive = 0
      await runParse(long, 'OCR_AI', async () => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active--
        return '[]'
      })
      expect(calls).toBeGreaterThan(2)
      expect(maxActive).toBeGreaterThan(1)
    } finally {
      if (previous === undefined) delete process.env.STANDARD_AI_PARSE_CONCURRENCY
      else process.env.STANDARD_AI_PARSE_CONCURRENCY = previous
      if (previousMaxChunks === undefined) delete process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
      else process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = previousMaxChunks
    }
  })

  it('超长文本超过实时 AI 上限 → 按产品策略快速使用 RULE 草稿（修 T1 8083 504）', async () => {
    const previous = process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
    process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = '2'
    try {
      const long = '5 基本要求\n' + '应执行检查并记录结果数据内容。'.repeat(6000)
      let calls = 0
      const r = await runParse(long, 'OCR_AI', async () => { calls++; return '[]' })
      expect(calls).toBe(0)
      expect(r.parseMode).toBe('RULE')
      expect(r.degraded).toBe(true)
      expect(r.degradedReason).toBe('REALTIME_RULE_LIMIT')
      expect(r.drafts.length).toBeGreaterThan(0)
      expect(r.warnings.some((w) => w.includes('超出 AI 实时解析上限') && w.includes('将使用规则解析'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
      else process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = previous
    }
  })

  it('RULE 模式也走 clean（术语定义不进结果）', async () => {
    const r = await runParse(STD, 'RULE')
    expect(r.parseMode).toBe('RULE')
    expect(r.drafts.every((d) => !d.requirementText.includes('是指'))).toBe(true)
  })

  it('RULE 模式在 candidate v2 开关打开时同样输出聚合证据，且不调用 AI', async () => {
    const previous = process.env.STANDARD_AI_CANDIDATE_V2
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    try {
      let calls = 0
      const r = await runParse(STD, 'RULE', async () => {
        calls++
        throw new Error('RULE should not call AI')
      })
      expect(calls).toBe(0)
      expect(r.parseMode).toBe('RULE')
      expect(r.candidateV2Enabled).toBe(true)
      expect(r.candidateRequirements?.length).toBeGreaterThan(0)
      expect(r.taskPackages?.length).toBeGreaterThan(0)
      expect(r.coverageReport?.totalCandidates).toBe(r.candidateRequirements?.length)
      expect(r.taskPackages?.every((pkg) => pkg.mergeMode === 'DETERMINISTIC')).toBe(true)
      expect(r.drafts.every((draft) => draft.taskDrafts?.[0]?.groupId)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.STANDARD_AI_CANDIDATE_V2
      else process.env.STANDARD_AI_CANDIDATE_V2 = previous
    }
  })

  it('超实时上限降 RULE 时也保留 candidate v2 覆盖报告', async () => {
    const previousFlag = process.env.STANDARD_AI_CANDIDATE_V2
    const previousMaxChunks = process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = '2'
    try {
      const long = '5 基本要求\n' + '门岗值守人员应每日检查访客登记记录并留存门岗系统截图。'.repeat(3000)
      let calls = 0
      const r = await runParse(long, 'OCR_AI', async () => { calls++; return '[]' })
      expect(calls).toBe(0)
      expect(r.parseMode).toBe('RULE')
      expect(r.degradedReason).toBe('REALTIME_RULE_LIMIT')
      expect(r.candidateV2Enabled).toBe(true)
      expect(r.coverageReport?.entries.length).toBe(r.candidateRequirements?.length)
      expect(r.warnings.some((w) => w.includes('规则候选要求'))).toBe(true)
    } finally {
      if (previousFlag === undefined) delete process.env.STANDARD_AI_CANDIDATE_V2
      else process.env.STANDARD_AI_CANDIDATE_V2 = previousFlag
      if (previousMaxChunks === undefined) delete process.env.STANDARD_AI_REALTIME_MAX_CHUNKS
      else process.env.STANDARD_AI_REALTIME_MAX_CHUNKS = previousMaxChunks
    }
  })

  it('AI_STUB → 空 drafts + 空 warnings', async () => {
    const r = await runParse(STD, 'AI_STUB')
    expect(r.drafts).toHaveLength(0)
    expect(r.warnings).toHaveLength(0)
  })
})
