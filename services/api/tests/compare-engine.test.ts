/**
 * 比对引擎核心算法测试
 * 覆盖锁定项（必读/MEMORY.md「比对 / 报告」段）：
 *   - 1对1 vs 全库 dupThreshold 切换（0 vs 40）
 *   - 1对1 模式重塑 schema：parsedCategories / citationIssues / termIssues / hangingSections / tabs 全部清空
 *   - titleSimilarity 优先用 targetSections[0].title（章节标题），fallback 到 targetTitle（文件名/标准名）
 *   - compareMode='ONE_TO_ONE' 与 'pair' 等价
 *   - reportCode 去 CMP- 前缀
 *   - summaryMetrics accent 颜色阈值
 *
 * 纯函数单测，不依赖 DB / HTTP / dedup。
 */
import { describe, it, expect } from 'vitest'
import { compareTexts, buildRealCompareReport } from '../src/compare-engine.js'

// ─── 测试夹具：构造可识别的标准化文本 ────────────────────────

const STANDARD_A = `1 范围
本文件规定了化妆品中重金属的检测方法。
本文件适用于化妆品中铅、汞、砷的测定。

2 规范性引用文件
GB/T 6682-2008 分析实验室用水规格和试验方法
GB/T 7679-2009 仪器分析法

3 术语和定义
下列术语和定义适用于本文件。
3.1 重金属 heavy metal
密度大于 4.5 g/cm3 的金属元素。

4 技术要求
铅含量不得超过 10 mg/kg。
汞含量不得超过 1 mg/kg。

5 试验方法
采用电感耦合等离子体质谱法。

6 检验规则
按照 GB/T 6682-2008 进行抽样检验。
`

const STANDARD_B_NEAR_DUPLICATE = `1 范围
本文件规定了化妆品中重金属的检测方法。
本文件适用于化妆品中铅、汞、砷的测定。

2 规范性引用文件
GB/T 6682-2008 分析实验室用水规格和试验方法

3 术语和定义
3.1 重金属 heavy metal
密度大于 4.5 g/cm3 的金属元素。

4 技术要求
铅含量不得超过 10 mg/kg。
汞含量不得超过 1 mg/kg。
`

const UNRELATED_TEXT = `项目管理软件 v3 用户手册
本手册介绍如何创建任务、分配负责人、跟踪进度。
首次使用请阅读快速入门一节。
快捷键 Ctrl+N 新建任务。
`

const TEXT_WITH_OLD_CITATIONS = `1 范围
本文件规定了某产品要求。

2 规范性引用文件
GB 2008-2005 旧标准
GB/T 1234-2002 更早的标准
GB/T 5678-2020 新标准
`

// ────────────────────────────────────────────────────────────

describe('compareTexts 基础相似度', () => {
  it('完全相同文本 → overallSimilarity 接近 100', () => {
    const r = compareTexts(STANDARD_A, STANDARD_A, '化妆品标准')
    expect(r.overallSimilarity).toBeGreaterThanOrEqual(95)
    expect(r.textSimilarity).toBeGreaterThanOrEqual(95)
  })

  it('完全无关文本 → overallSimilarity 极低（< 20）', () => {
    const r = compareTexts(STANDARD_A, UNRELATED_TEXT, '某软件手册')
    expect(r.overallSimilarity).toBeLessThan(20)
  })

  it('返回结构完整：含 sectionCount / duplicateParagraphs / citationsFound', () => {
    const r = compareTexts(STANDARD_A, STANDARD_B_NEAR_DUPLICATE)
    expect(r.sectionCount).toBeGreaterThan(0)
    expect(Array.isArray(r.duplicateParagraphs)).toBe(true)
    expect(Array.isArray(r.citationsFound)).toBe(true)
    // STANDARD_A 中的引用文件应被提取
    expect(r.citationsFound.length).toBeGreaterThan(0)
  })

  it('duplicateParagraphs 按相似度降序排列', () => {
    const r = compareTexts(STANDARD_A, STANDARD_B_NEAR_DUPLICATE, undefined, 0)
    if (r.duplicateParagraphs.length >= 2) {
      for (let i = 1; i < r.duplicateParagraphs.length; i++) {
        expect(r.duplicateParagraphs[i - 1].similarity).toBeGreaterThanOrEqual(
          r.duplicateParagraphs[i].similarity
        )
      }
    }
  })
})

describe('compareTexts minSimilarityPct 阈值切换', () => {
  it('阈值=0（1对1 模式）→ 记录所有段落配对，包含低相似段', () => {
    const r = compareTexts(STANDARD_A, UNRELATED_TEXT, undefined, 0)
    // 所有 source 段落（>=1 个）都应进入 duplicateParagraphs
    expect(r.duplicateParagraphs.length).toBe(r.sectionCount)
  })

  it('阈值=40（全库默认）→ 仅记录 ≥40% 的段落，无关文本应几乎无配对', () => {
    const r = compareTexts(STANDARD_A, UNRELATED_TEXT, undefined, 40)
    expect(r.duplicateParagraphs.length).toBeLessThan(r.sectionCount)
    for (const dup of r.duplicateParagraphs) {
      expect(dup.similarity).toBeGreaterThanOrEqual(40)
    }
  })

  it('默认参数等同于 40', () => {
    const r1 = compareTexts(STANDARD_A, UNRELATED_TEXT)
    const r2 = compareTexts(STANDARD_A, UNRELATED_TEXT, undefined, 40)
    expect(r1.duplicateParagraphs.length).toBe(r2.duplicateParagraphs.length)
  })
})

describe('compareTexts titleSimilarity 优先级', () => {
  it('targetSections 有章节标题 → 优先用章节标题，忽略 targetTitle 参数', () => {
    // 两份文本第一节标题都是「1 范围」，相似度应很高
    // 即使 targetTitle 传入完全无关的字符串，结果也应该是高相似（因为优先用章节标题）
    const r1 = compareTexts(STANDARD_A, STANDARD_B_NEAR_DUPLICATE, '完全无关的标准名称')
    const r2 = compareTexts(STANDARD_A, STANDARD_B_NEAR_DUPLICATE, '化妆品中重金属检测')
    expect(r1.titleSimilarity).toBe(r2.titleSimilarity)
    expect(r1.titleSimilarity).toBeGreaterThan(0)
  })

  it('targetSections 为空（targetText=""）→ fallback 到 targetTitle', () => {
    // splitIntoSections 对非空文本总会兜底产生 "正文"/"全文" 标题，
    // 只有 targetText 完全为空时 targetSections 才真为空，fallback 到 targetTitle 才生效。
    const r1 = compareTexts(STANDARD_A, '', '范围与适用对象')
    const r2 = compareTexts(STANDARD_A, '', '与源标题无任何重叠的字符串 xyz')
    // 不同 targetTitle 应给出不同的 titleSimilarity
    expect(r1.titleSimilarity).not.toBe(r2.titleSimilarity)
    // 与源「1 范围」有 '范' '围' 重叠 → r1 应 > 0
    expect(r1.titleSimilarity).toBeGreaterThan(0)
    expect(r2.titleSimilarity).toBe(0)
  })

  it('targetTitle 缺省 + 无章节标题 → titleSimilarity = 0', () => {
    const r = compareTexts(STANDARD_A, '纯文本无标题')
    expect(r.titleSimilarity).toBe(0)
  })
})

describe('buildRealCompareReport 全库模式 schema', () => {
  const baseTargets = [
    { code: 'GB/T 12345-2020', title: '化妆品标准 A', type: 'GB', textContent: STANDARD_B_NEAR_DUPLICATE },
    { code: 'GB/T 67890-2019', title: '化妆品标准 B', type: 'GB', textContent: UNRELATED_TEXT },
  ]

  it('compareMode=LIBRARY → 6 类 parsedCategories + 5 个 tabs + 4 项 summaryMetrics', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-TEST-001',
      documentName: '我的草稿.docx',
      sourceText: STANDARD_A,
      targets: baseTargets,
      compareMode: 'LIBRARY',
    })
    expect(report.parsedCategories).toHaveLength(6)
    expect(report.tabs).toHaveLength(5)
    expect(report.summaryMetrics).toHaveLength(4)
    // 6 类齐全
    expect(report.parsedCategories.map(p => p.name)).toEqual([
      '范围与适用对象',
      '规范性引用文件',
      '术语和定义',
      '技术要求',
      '试验方法/验证方法',
      '检验规则与附录',
    ])
    // tabs key 齐全
    expect(report.tabs.map(t => t.key)).toEqual(['overall', 'structure', 'citation', 'terms', 'risk'])
  })

  it('reportCode 去掉 CMP- 前缀', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-XYZ-999',
      documentName: 'a.docx',
      sourceText: STANDARD_A,
      targets: baseTargets,
      compareMode: 'LIBRARY',
    })
    expect(report.reportCode).toBe('BZ-XYZ-999')
  })

  it('parsedCategories 按章节标题关键词命中', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-T',
      documentName: 'a.docx',
      sourceText: STANDARD_A,
      targets: baseTargets,
      compareMode: 'LIBRARY',
    })
    // STANDARD_A 含「范围 / 引用 / 术语 / 要求 / 试验 / 检验」全部 6 类
    for (const cat of report.parsedCategories) {
      expect(cat.matched).toBe(true)
    }
  })

  it('similarStandards 顺序与 targets 输入一致', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-T',
      documentName: 'a.docx',
      sourceText: STANDARD_A,
      targets: baseTargets,
      compareMode: 'LIBRARY',
    })
    expect(report.similarStandards).toHaveLength(2)
    expect(report.similarStandards[0].code).toBe('GB/T 12345-2020')
    expect(report.similarStandards[1].code).toBe('GB/T 67890-2019')
  })

  it('citationIssues 对 < 2015 年份标记版本旧 / < 2010 标记可能已废止', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-T',
      documentName: 'old.docx',
      sourceText: TEXT_WITH_OLD_CITATIONS,
      targets: baseTargets,
      compareMode: 'LIBRARY',
    })
    expect(report.citationIssues.length).toBeGreaterThanOrEqual(1)
    const has2005 = report.citationIssues.some(c => c.sourceCode.includes('2005'))
    const has2002 = report.citationIssues.some(c => c.sourceCode.includes('2002'))
    expect(has2005 || has2002).toBe(true)
    // 2002 < 2010 → 可能已废止；2005 < 2010 → 可能已废止
    const old = report.citationIssues.find(c => c.sourceCode.includes('2002'))
    if (old) expect(old.validity).toBe('可能已废止')
    // 2020 ≥ 2015 不应进入 issues
    expect(report.citationIssues.every(c => !c.sourceCode.includes('2020'))).toBe(true)
  })
})

describe('buildRealCompareReport 1对1 模式 schema 重塑', () => {
  const oneTarget = [{
    code: 'USER_B',
    title: 'B 文件名.docx',
    type: 'DOCX',
    textContent: STANDARD_B_NEAR_DUPLICATE,
  }]

  it('compareMode=ONE_TO_ONE → 清空 parsedCategories / citationIssues / termIssues / hangingSections / tabs', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-O2O',
      documentName: 'A.docx',
      sourceText: STANDARD_A,
      targets: oneTarget,
      compareMode: 'ONE_TO_ONE',
    })
    expect(report.parsedCategories).toEqual([])
    expect(report.citationIssues).toEqual([])
    expect(report.termIssues).toEqual([])
    expect(report.hangingSections).toEqual([])
    expect(report.tabs).toEqual([])
  })

  it('compareMode=pair 与 ONE_TO_ONE 同等处理', () => {
    const r1 = buildRealCompareReport({
      taskNo: 'CMP-A', documentName: 'A.docx', sourceText: STANDARD_A,
      targets: oneTarget, compareMode: 'ONE_TO_ONE',
    })
    const r2 = buildRealCompareReport({
      taskNo: 'CMP-A', documentName: 'A.docx', sourceText: STANDARD_A,
      targets: oneTarget, compareMode: 'pair',
    })
    expect(r2.parsedCategories).toEqual(r1.parsedCategories)
    expect(r2.tabs).toEqual(r1.tabs)
    expect(r2.summaryMetrics).toHaveLength(3)
  })

  it('1对1 summaryMetrics 是 3 项专用指标（总体/段落对/最高段相似度）', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-X', documentName: 'A.docx', sourceText: STANDARD_A,
      targets: oneTarget, compareMode: 'ONE_TO_ONE',
    })
    expect(report.summaryMetrics).toHaveLength(3)
    expect(report.summaryMetrics.map(m => m.label)).toEqual([
      '总体相似度',
      '相似段落对',
      '最高段落相似度',
    ])
  })

  it('1对1 高相似度 → freeRisk 红色提示 + accent=red', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-H', documentName: 'A.docx',
      sourceText: STANDARD_A,
      targets: [{ code: 'USER_B', title: 'B', type: 'DOCX', textContent: STANDARD_A }],
      compareMode: 'ONE_TO_ONE',
    })
    expect(report.summaryMetrics[0].accent).toBe('red')
    expect(report.freeRisk[0]).toMatch(/高度相似/)
  })

  it('1对1 极低相似度 → accent=green', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-L', documentName: 'A.docx',
      sourceText: STANDARD_A,
      targets: [{ code: 'USER_B', title: 'B', type: 'DOCX', textContent: UNRELATED_TEXT }],
      compareMode: 'ONE_TO_ONE',
    })
    expect(report.summaryMetrics[0].accent).toBe('green')
  })

  it('1对1 段落阈值 dupThreshold=0 → duplicateParagraphs 含所有配对（包含低相似）', () => {
    // 与全库模式对照：相同输入 + 不同 mode → 全库段落数 ≤ 1对1
    const reportPair = buildRealCompareReport({
      taskNo: 'CMP-P', documentName: 'A.docx',
      sourceText: STANDARD_A,
      targets: [{ code: 'USER_B', title: 'B', type: 'DOCX', textContent: UNRELATED_TEXT }],
      compareMode: 'ONE_TO_ONE',
    })
    const reportLib = buildRealCompareReport({
      taskNo: 'CMP-P', documentName: 'A.docx',
      sourceText: STANDARD_A,
      targets: [{ code: 'GB/T 1', title: 'X', type: 'GB', textContent: UNRELATED_TEXT }],
      compareMode: 'LIBRARY',
    })
    expect(reportPair.duplicateParagraphs.length).toBeGreaterThanOrEqual(reportLib.duplicateParagraphs.length)
  })

  it('1对1 duplicateParagraphs.section 格式为 "A段落 ↔ B段落"', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-S', documentName: 'A.docx', sourceText: STANDARD_A,
      targets: oneTarget, compareMode: 'ONE_TO_ONE',
    })
    if (report.duplicateParagraphs.length > 0) {
      expect(report.duplicateParagraphs[0].section).toContain('↔')
    }
  })
})

describe('buildRealCompareReport 通用字段', () => {
  it('status 固定为「分析完成」', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-1', documentName: 'a.docx', sourceText: STANDARD_A,
      targets: [{ code: 'X', title: 'X', type: 'GB', textContent: STANDARD_B_NEAR_DUPLICATE }],
      compareMode: 'LIBRARY',
    })
    expect(report.status).toBe('分析完成')
  })

  it('compareMode 透传到 report.compareMode 字段', () => {
    const report = buildRealCompareReport({
      taskNo: 'CMP-1', documentName: 'a.docx', sourceText: STANDARD_A,
      targets: [{ code: 'X', title: 'X', type: 'GB', textContent: STANDARD_B_NEAR_DUPLICATE }],
      compareMode: 'LIBRARY',
    })
    expect(report.compareMode).toBe('LIBRARY')
  })
})
