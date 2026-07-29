/**
 * createOutboundGuard — 出站滑动窗口 guard 单元测试
 *
 * 2026-04-24 重构：出站独立 OUTBOUND_BLOCKED_PATTERNS
 *   - 只拦「LLM 真的在吐正文」的硬特征（连续条款编号 / 多阈值 / 第X条规定+数字）
 *   - 去掉入站描述性正则，避免正面引导语被误伤
 */
import { describe, it, expect } from 'vitest'
import { createOutboundGuard } from '../src/services/chatGuardrail.js'

describe('createOutboundGuard — 出站滑窗过滤', () => {
  // ─── 基础行为 ─────────────────────────────────────────────────
  it('用例1：正常 chunk 序列全部通过', () => {
    const guard = createOutboundGuard()
    const chunks = ['这个', '标准', '发布于', '2018年', '，现行有效。']
    for (const chunk of chunks) {
      expect(guard.check(chunk)).toBeNull()
    }
  })

  it('用例2：check 返回 null 代表通过（类型契约）', () => {
    const guard = createOutboundGuard()
    const result = guard.check('你好，标准号是 GB 2626')
    expect(result).toBeNull()
  })

  // ─── 规则 O1：连续条款编号 ─────────────────────────────────────
  it('规则 O1：连续多条 N.N.N 条款编号触发拦截', () => {
    const guard = createOutboundGuard()
    const result = guard.check('4.1.1 外观应光洁 4.1.2 表面不应有裂纹')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O1：N.N 两级条款编号同样触发', () => {
    const guard = createOutboundGuard()
    const result = guard.check('5.1 技术要求 5.2 试验方法')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O1 放行：单个标准号 "GB/T 1.1-2020" 不触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('参考标准 GB/T 1.1-2020')).toBeNull()
  })

  it('规则 O1 放行：大纲里单个章节编号不触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('**章节结构**：\n\n1. 范围\n2. 规范性引用文件')).toBeNull()
  })

  // ─── 规则 O2：多个技术阈值 ─────────────────────────────────────
  it('规则 O2：多个 mg/kg 阈值触发拦截', () => {
    const guard = createOutboundGuard()
    const result = guard.check('铅≤ 0.5 mg/kg，镉≤ 0.1 mg/kg')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O2：阈值跨 chunk 拼接触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('温度≤ 25°C')).toBeNull()
    // 拼上 "，湿度≥ 60%" 后滑窗内出现两个阈值，触发
    const result = guard.check('，湿度≥ 60%')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O2 放行：单个阈值不触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('铅含量上限为≤ 0.5 mg/kg')).toBeNull()
  })

  // ─── 规则 O3：本标准第X条规定 + 数字 ────────────────────────────
  it('规则 O3：本标准第 5.2 条规定 触发拦截', () => {
    const guard = createOutboundGuard()
    const result = guard.check('本标准第 5.2 条规定：含水率应≤ 3%')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O3：第 X 条规定 + 阈值数字 触发拦截', () => {
    const guard = createOutboundGuard()
    const result = guard.check('第 4 条规定：抗拉强度≥ 300 MPa')
    expect(result).toBe('[内容已截断]')
  })

  it('规则 O3 放行："本标准参考 GB/T 1.1" 不触发', () => {
    const guard = createOutboundGuard()
    expect(guard.check('本标准参考了 GB/T 1.1-2020 起草规则')).toBeNull()
  })

  // ─── 正面引导语放行（真实事故防回归）────────────────────────────
  it('放行：国家标准全文公开系统下载引导', () => {
    // 入站 BLOCKED_PATTERNS 有 /下载.*标准/，会误伤正面引导语
    // 出站独立 patterns 必须放行
    const guard = createOutboundGuard()
    expect(guard.check('这些标准可以从国家标准全文公开系统下载。')).toBeNull()
  })

  it('放行："该标准规定了具体技术要求"（/具体.*要求/ 误伤场景）', () => {
    const guard = createOutboundGuard()
    expect(guard.check('该标准规定了具体技术要求，供起草参考。')).toBeNull()
  })

  it('放行："标准正文内容" 在描述性语境（非正文抄录）', () => {
    // 入站拦这种表达是对的（用户索要）；出站仅靠字面不拦
    const guard = createOutboundGuard()
    expect(guard.check('标准正文内容请前往 openstd.samr.gov.cn 获取。')).toBeNull()
  })

  it('放行：大纲输出中的 "4 技术要求" 单编号', () => {
    const guard = createOutboundGuard()
    expect(guard.check('4 技术要求\n\n5 试验方法')).toBeNull()
  })

  it('放行："主数据库" 描述性提及', () => {
    const guard = createOutboundGuard()
    expect(guard.check('主数据库记录了发布日期与实施日期。')).toBeNull()
  })

  // ─── 滑动窗口行为 ──────────────────────────────────────────────
  it('用例：reset 后 guard 状态清零', () => {
    const guard = createOutboundGuard()
    expect(guard.check('温度≤ 25°C')).toBeNull()
    guard.reset()
    // reset 后滑窗清空，再来一个单阈值不触发
    expect(guard.check('，湿度≥ 60%')).toBeNull()
  })

  it('用例：buffer 窗口限长（超 200 字符不膨胀）', () => {
    const guard = createOutboundGuard()
    const safe = 'A'.repeat(256)
    guard.check(safe)
    // 再喂入单阈值，不触发（buffer 里另一个阈值已被滑出窗口外）
    expect(guard.check('温度≤ 25°C')).toBeNull()
  })

  // ─── 拒绝前缀豁免（保留）──────────────────────────────────────
  it('拒绝豁免：LLM "抱歉" 开头整段 bypass', () => {
    const guard = createOutboundGuard()
    expect(guard.check('抱歉')).toBeNull()
    expect(guard.check('，我无法提供')).toBeNull()
    // bypass 后后续任意违禁字面也不截断
    expect(guard.check('4.1.1 xxx 4.1.2 yyy')).toBeNull()
  })

  it('拒绝豁免："我无法" 开头同样豁免', () => {
    const guard = createOutboundGuard()
    expect(guard.check('我无法提供该标准的正文内容')).toBeNull()
    // 后续即使出现真违禁特征也 bypass
    expect(guard.check('铅≤ 0.5 mg/kg，镉≤ 0.1 mg/kg')).toBeNull()
  })

  it('拒绝豁免：非拒绝开头 → 正常检测不误 bypass', () => {
    const guard = createOutboundGuard()
    expect(guard.check('这是关于 GB 2760 的介绍')).toBeNull()
    // 后续真违禁特征仍应拦截
    expect(guard.check('，4.1.1 甜味剂 4.1.2 防腐剂')).toBe('[内容已截断]')
  })
})
