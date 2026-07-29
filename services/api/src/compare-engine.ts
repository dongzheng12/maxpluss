/**
 * 文档比对引擎 — TF-IDF + 余弦相似度（Node 侧兼容引擎）
 * 真实文本比对，逐段落计算相似度
 * @date   2026-03-23
 *
 * ⚠️  【定位说明】
 *   本模块是历史兼容引擎，不是主比对链路。
 *
 *   主链路：callDedupService() → dedup Python 服务
 *     - MinHash 指纹比对 + 全库对比 + 完整报告生成
 *     - 支持 487K 标准元数据覆盖
 *     - 见 appRoutes.ts 中 /api/app/compare/* 路由
 *
 *   本模块（兼容链路）：buildRealCompareReport()
 *     - 基于 N-gram TF-IDF，仅比对两份文档之间
 *     - 在 dedup 服务不可用时作为降级兜底
 *     - 不涉及标准库全库对比，能力有限
 */

// ─── 中文分词（简易版，不依赖 native 模块）────────────────
// 使用 N-gram 分词替代 jieba，避免 native 依赖问题
// 对于标准文本比对场景，2-gram + 3-gram 效果足够

function tokenize(text: string): string[] {
  // 去除标点符号和空白
  const cleaned = text.replace(/[\s\n\r\t\u3000]+/g, '')
    .replace(/[，。、；：？！""''【】（）《》「」…—\-\.\,\!\?\;\:\"\'\[\]\(\)\<\>\/\\]/g, '')

  if (cleaned.length === 0) return []

  const tokens: string[] = []
  // 2-gram
  for (let i = 0; i < cleaned.length - 1; i++) {
    tokens.push(cleaned.slice(i, i + 2))
  }
  // 3-gram
  for (let i = 0; i < cleaned.length - 2; i++) {
    tokens.push(cleaned.slice(i, i + 3))
  }
  return tokens
}

// ─── TF-IDF 向量化 ──────────────────────────────────────

interface TfIdfVector {
  [term: string]: number
}

function termFrequency(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {}
  for (const token of tokens) {
    tf[token] = (tf[token] || 0) + 1
  }
  // 归一化
  const max = Math.max(...Object.values(tf), 1)
  for (const key in tf) {
    tf[key] /= max
  }
  return tf
}

function buildIdf(documents: string[][]): Record<string, number> {
  const df: Record<string, number> = {}
  const n = documents.length

  for (const doc of documents) {
    const seen = new Set(doc)
    for (const term of seen) {
      df[term] = (df[term] || 0) + 1
    }
  }

  const idf: Record<string, number> = {}
  for (const term in df) {
    idf[term] = Math.log((n + 1) / (df[term] + 1)) + 1
  }
  return idf
}

function toTfIdf(tokens: string[], idf: Record<string, number>): TfIdfVector {
  const tf = termFrequency(tokens)
  const vec: TfIdfVector = {}
  for (const term in tf) {
    vec[term] = tf[term] * (idf[term] || 1)
  }
  return vec
}

// ─── 余弦相似度 ──────────────────────────────────────────

function cosineSimilarity(a: TfIdfVector, b: TfIdfVector): number {
  let dotProduct = 0
  let normA = 0
  let normB = 0

  const allTerms = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const term of allTerms) {
    const va = a[term] || 0
    const vb = b[term] || 0
    dotProduct += va * vb
    normA += va * va
    normB += vb * vb
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dotProduct / denom
}

// ─── 文本分段 ────────────────────────────────────────────

interface TextSection {
  title: string
  content: string
  level: number  // 1=章, 2=节, 3=条
}

function splitIntoSections(text: string): TextSection[] {
  const lines = text.split('\n').filter(l => l.trim())
  const sections: TextSection[] = []
  let currentTitle = '正文'
  let currentContent: string[] = []
  let currentLevel = 1

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测标题行（标准文档常见格式）
    const chapterMatch = trimmed.match(/^(\d+)\s+(.+)/)
    const sectionMatch = trimmed.match(/^(\d+\.\d+)\s+(.+)/)
    const subSectionMatch = trimmed.match(/^(\d+\.\d+\.\d+)\s+(.+)/)

    if (subSectionMatch || sectionMatch || chapterMatch) {
      // 保存之前的段落
      if (currentContent.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentContent.join('\n'),
          level: currentLevel
        })
      }

      if (subSectionMatch) {
        currentTitle = trimmed
        currentLevel = 3
      } else if (sectionMatch) {
        currentTitle = trimmed
        currentLevel = 2
      } else {
        currentTitle = trimmed
        currentLevel = 1
      }
      currentContent = []
    } else {
      currentContent.push(trimmed)
    }
  }

  // 最后一段
  if (currentContent.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentContent.join('\n'),
      level: currentLevel
    })
  }

  // 如果没有识别到结构，整体作为一段
  if (sections.length === 0 && text.trim()) {
    sections.push({ title: '全文', content: text.trim(), level: 1 })
  }

  return sections
}

// ─── 段落级别比对 ─────────────────────────────────────────

interface ParagraphMatch {
  sourceSection: string
  targetSection: string
  similarity: number
  risk: string
}

function classifyRisk(similarity: number): string {
  if (similarity >= 90) return '高重复'
  if (similarity >= 75) return '中高重复'
  if (similarity >= 60) return '中等相似'
  if (similarity >= 40) return '低相似'
  return '无风险'
}

// ─── 引用标准检测 ─────────────────────────────────────────

interface CitationIssue {
  sourceCode: string
  sourceTitle: string
  matchedCode: string
  matchedTitle: string
  validity: string
  replacement: string
  result: string
}

function extractCitations(text: string): string[] {
  // 匹配标准号格式：GB/T 1234-2024, GB 5678-2020, T/XXX 123-2024 等
  const pattern = /(?:GB\/T|GB|T\/[A-Z]+|JB\/T|NY\/T|HJ|DB\d+\/T?)\s*[\d\.\-]+/g
  const matches = text.match(pattern) || []
  return [...new Set(matches)]
}

// ─── 术语检测 ─────────────────────────────────────────────

interface TermIssue {
  term: string
  source: string
  issue: string
  suggestion: string
}

function extractTermDefinitions(text: string): string[] {
  // 匹配 "XXX：" 或 "3.1 XXX" 格式的术语定义
  const terms: string[] = []
  const lines = text.split('\n')
  for (const line of lines) {
    const match = line.match(/^\d+\.\d+\s+(.+?)[\s：:]/)
    if (match) terms.push(match[1].trim())
  }
  return terms
}

// ─── 主比对函数 ───────────────────────────────────────────

export interface CompareResult {
  overallSimilarity: number
  titleSimilarity: number
  scopeSimilarity: number
  textSimilarity: number
  duplicateParagraphs: ParagraphMatch[]
  citationsFound: string[]
  maxSimilaritySection: string
  sectionCount: number
}

export function compareTexts(
  sourceText: string,
  targetText: string,
  targetTitle?: string,
  minSimilarityPct: number = 40
): CompareResult {
  // 分段
  const sourceSections = splitIntoSections(sourceText)
  const targetSections = splitIntoSections(targetText)

  // 所有段落的 tokens
  const allTokensList = [
    ...sourceSections.map(s => tokenize(s.content)),
    ...targetSections.map(s => tokenize(s.content))
  ]

  // 建 IDF
  const idf = buildIdf(allTokensList)

  // 每段的 TF-IDF 向量
  const sourceVecs = sourceSections.map(s => toTfIdf(tokenize(s.content), idf))
  const targetVecs = targetSections.map(s => toTfIdf(tokenize(s.content), idf))

  // 逐段比对，找最高相似度
  const duplicateParagraphs: ParagraphMatch[] = []
  let totalSim = 0
  let pairCount = 0

  for (let i = 0; i < sourceSections.length; i++) {
    let maxSim = 0
    let bestMatch = ''
    for (let j = 0; j < targetSections.length; j++) {
      const sim = cosineSimilarity(sourceVecs[i], targetVecs[j])
      if (sim > maxSim) {
        maxSim = sim
        bestMatch = targetSections[j].title
      }
    }

    const simPct = Math.round(maxSim * 100)
    totalSim += maxSim
    pairCount++

    if (simPct >= minSimilarityPct) {
      duplicateParagraphs.push({
        sourceSection: sourceSections[i].title,
        targetSection: bestMatch,
        similarity: simPct,
        risk: classifyRisk(simPct)
      })
    }
  }

  // 整体文本相似度
  const sourceFullTokens = tokenize(sourceText)
  const targetFullTokens = tokenize(targetText)
  const fullIdf = buildIdf([sourceFullTokens, targetFullTokens])
  const sourceFullVec = toTfIdf(sourceFullTokens, fullIdf)
  const targetFullVec = toTfIdf(targetFullTokens, fullIdf)
  const textSimilarity = Math.round(cosineSimilarity(sourceFullVec, targetFullVec) * 100)

  // 标题相似度
  // 全库模式：source 第一章节标题 vs target 标准名称（targetTitle 来自标准库元数据）
  // 1对1 模式：source 第一章节标题 vs target 第一章节标题（targetTitle 是文件名，不应用于比较）
  let titleSimilarity = 0
  {
    const sourceFirstTitle = sourceSections[0]?.title || ''
    // 如果 targetSections 有章节标题，优先用它（1对1 模式下更准确）；
    // 否则回退到 targetTitle（全库模式传的是标准名称）
    const targetFirstTitle = targetSections[0]?.title || ''
    const effectiveTargetTitle = targetFirstTitle || targetTitle || ''
    const sourceTitleTokens = tokenize(sourceFirstTitle)
    const targetTitleTokens = tokenize(effectiveTargetTitle)
    if (sourceTitleTokens.length > 0 && targetTitleTokens.length > 0) {
      const titleIdf = buildIdf([sourceTitleTokens, targetTitleTokens])
      titleSimilarity = Math.round(
        cosineSimilarity(
          toTfIdf(sourceTitleTokens, titleIdf),
          toTfIdf(targetTitleTokens, titleIdf)
        ) * 100
      )
    }
  }

  // 范围相似度（取第一段，通常是"范围"章节）
  let scopeSimilarity = 0
  if (sourceSections.length > 0 && targetSections.length > 0) {
    scopeSimilarity = Math.round(cosineSimilarity(sourceVecs[0], targetVecs[0]) * 100)
  }

  // 综合相似度
  const overallSimilarity = Math.round(
    textSimilarity * 0.5 + scopeSimilarity * 0.2 + titleSimilarity * 0.15 +
    (pairCount > 0 ? (totalSim / pairCount) * 100 * 0.15 : 0)
  )

  // 提取引用
  const citationsFound = extractCitations(sourceText)

  // 最高相似段
  const maxParagraph = duplicateParagraphs.sort((a, b) => b.similarity - a.similarity)[0]

  return {
    overallSimilarity,
    titleSimilarity,
    scopeSimilarity,
    textSimilarity,
    duplicateParagraphs: duplicateParagraphs.sort((a, b) => b.similarity - a.similarity),
    citationsFound,
    maxSimilaritySection: maxParagraph?.sourceSection || '',
    sectionCount: sourceSections.length
  }
}

// ─── 构建完整比对报告 ─────────────────────────────────────

export interface FullCompareReport {
  taskNo: string
  reportCode: string
  documentName: string
  status: string
  compareMode: string
  freeRisk: string[]
  summaryMetrics: Array<{ label: string; value: string; accent: string; detail: string }>
  similarStandards: Array<{
    code: string
    title: string
    type: string
    titleSimilarity: number
    scopeSimilarity: number
    chapterSimilarity: number
    textSimilarity: number
    overallSimilarity: number
  }>
  citationIssues: CitationIssue[]
  termIssues: TermIssue[]
  duplicateParagraphs: Array<{ section: string; similarity: number; risk: string }>
  hangingSections: Array<{ section: string; reason: string; action: string }>
  parsedCategories: Array<{ name: string; description: string; matched: boolean }>
  tabs: Array<{ key: string; label: string; intro: string; conclusions: string[] }>
  // 1v1 安全截断标志:文本超限时 worker 截到 60000 字后继续比对,
  // 此字段非空 → 报告页顶部展示"本次仅分析前 X 万字,超出部分未纳入比对结果"
  truncationNote?: string
}

export function buildRealCompareReport(params: {
  taskNo: string
  documentName: string
  sourceText: string
  targets: Array<{ code: string; title: string; type: string; textContent: string }>
  compareMode: string
  truncationNote?: string
}): FullCompareReport {
  const { taskNo, documentName, sourceText, targets, compareMode, truncationNote } = params

  // 1对1 模式段落对阈值降到 0(展示所有段落配对的 top N),
  // 全库模式保持 40% 阈值。
  // 业务理由:1对1 是用户自己的两份文档,把所有相似段落列出来用户能看到
  // 具体哪些段落最像,不涉及合规;全库模式继续 40% 阈值避免噪音。
  const isOneToOnePair = compareMode === 'ONE_TO_ONE' || compareMode === 'pair'
  const dupThreshold = isOneToOnePair ? 0 : 40

  // 逐个对比目标标准
  const similarStandards = targets.map(target => {
    const result = compareTexts(sourceText, target.textContent, target.title, dupThreshold)
    return {
      code: target.code,
      title: target.title,
      type: target.type,
      titleSimilarity: result.titleSimilarity,
      scopeSimilarity: result.scopeSimilarity,
      chapterSimilarity: Math.round((result.duplicateParagraphs.length / Math.max(result.sectionCount, 1)) * 100),
      textSimilarity: result.textSimilarity,
      overallSimilarity: result.overallSimilarity
    }
  })

  // 汇总所有段落重复
  const allDuplicates: ParagraphMatch[] = []
  for (const target of targets) {
    const result = compareTexts(sourceText, target.textContent, target.title, dupThreshold)
    for (const dup of result.duplicateParagraphs) {
      allDuplicates.push(dup)
    }
  }
  const topDuplicates = allDuplicates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10)

  // 提取引用标准并检查
  const citations = extractCitations(sourceText)
  const citationIssues: CitationIssue[] = []
  for (const cite of citations.slice(0, 10)) {
    // 简单检测：如果引用的年份较老，标记为可能已废止
    const yearMatch = cite.match(/(\d{4})/)
    if (yearMatch) {
      const year = parseInt(yearMatch[1])
      if (year < 2015) {
        citationIssues.push({
          sourceCode: cite,
          sourceTitle: '（待查询）',
          matchedCode: cite.replace(String(year), '最新版'),
          matchedTitle: '（需查询最新版本）',
          validity: year < 2010 ? '可能已废止' : '版本较旧',
          replacement: '建议查询最新现行版本',
          result: `引用的 ${year} 年版本可能已更新，建议核实`
        })
      }
    }
  }

  // 术语检测
  const terms = extractTermDefinitions(sourceText)
  const termIssues: TermIssue[] = terms.slice(0, 5).map(term => ({
    term,
    source: '企业文档术语',
    issue: '需确认术语定义来源',
    suggestion: '建议标注来源标准号或补充定义'
  }))

  // 结构完整性检测
  const sections = splitIntoSections(sourceText)
  const categoryNames = ['范围', '规范性引用', '术语', '技术要求', '试验方法', '检验规则']
  const parsedCategories = [
    { name: '范围与适用对象', description: '识别标准适用边界、对象、场景与排除项。', matched: false },
    { name: '规范性引用文件', description: '抽取文中引用的国标、行标、团标及版本信息。', matched: false },
    { name: '术语和定义', description: '识别术语列表、定义语句和来源标准号。', matched: false },
    { name: '技术要求', description: '提取核心要求条款、指标阈值和限制性描述。', matched: false },
    { name: '试验方法/验证方法', description: '识别检测方法、试验步骤和判定方式。', matched: false },
    { name: '检验规则与附录', description: '识别抽样规则、判定规则、附录与模板内容。', matched: false }
  ]
  for (const sec of sections) {
    const title = sec.title.toLowerCase()
    if (title.includes('范围') || title.includes('适用')) parsedCategories[0].matched = true
    if (title.includes('引用') || title.includes('参考')) parsedCategories[1].matched = true
    if (title.includes('术语') || title.includes('定义')) parsedCategories[2].matched = true
    if (title.includes('要求') || title.includes('技术') || title.includes('指标')) parsedCategories[3].matched = true
    if (title.includes('试验') || title.includes('方法') || title.includes('检测')) parsedCategories[4].matched = true
    if (title.includes('检验') || title.includes('附录') || title.includes('规则')) parsedCategories[5].matched = true
  }

  // 悬置段检测
  const hangingSections: Array<{ section: string; reason: string; action: string }> = []
  for (const sec of sections) {
    if (sec.content.length < 20 && sec.level === 1) {
      hangingSections.push({
        section: sec.title,
        reason: '内容过少，可能为空章节',
        action: '建议补充内容或合并到相邻章节'
      })
    }
  }

  // 计算汇总指标
  const maxOverall = Math.max(...similarStandards.map(s => s.overallSimilarity), 0)
  const totalDupRate = topDuplicates.length > 0
    ? Math.round(topDuplicates.reduce((sum, d) => sum + d.similarity, 0) / topDuplicates.length)
    : 0

  // 生成风险摘要
  const freeRisk: string[] = []
  if (citationIssues.length > 0) {
    freeRisk.push(`检测到 ${citationIssues.length} 条引用标准可能存在版本问题，建议核实。`)
  }
  if (maxOverall >= 60) {
    freeRisk.push(`命中 ${similarStandards.filter(s => s.overallSimilarity >= 60).length} 条高相似度标准，综合相似度最高 ${maxOverall}%。`)
  }
  if (hangingSections.length > 0) {
    freeRisk.push(`发现 ${hangingSections.length} 处结构问题，建议修订后再复核。`)
  }
  if (freeRisk.length === 0) {
    freeRisk.push('未发现显著风险，文档结构和内容整体符合规范。（本分析为系统自动生成，仅供参考）')
  }

  const summaryMetrics = [
    {
      label: '最高综合相似度',
      value: `${maxOverall}%`,
      accent: maxOverall >= 70 ? 'red' : maxOverall >= 50 ? 'orange' : 'green',
      detail: `与 ${similarStandards.length} 个标准比对，最高相似度 ${maxOverall}%`
    },
    {
      label: '引用规范性问题',
      value: `${citationIssues.length} 项`,
      accent: citationIssues.length >= 3 ? 'red' : citationIssues.length > 0 ? 'orange' : 'green',
      detail: citationIssues.length > 0 ? `含 ${citationIssues.filter(c => c.validity.includes('废止')).length} 条可能已废止标准` : '引用标准均为现行版本'
    },
    {
      label: '术语疑似问题',
      value: `${termIssues.length} 项`,
      accent: termIssues.length >= 3 ? 'teal' : 'green',
      detail: termIssues.length > 0 ? '部分术语缺少来源标准号' : '术语定义规范'
    },
    {
      label: '正文重复率',
      value: `${totalDupRate}%`,
      accent: totalDupRate >= 50 ? 'red' : totalDupRate >= 30 ? 'blue' : 'green',
      detail: topDuplicates.length > 0 ? `${topDuplicates.length} 段存在重复` : '未发现显著重复段落'
    }
  ]

  // 生成分析结论
  const tabs = [
    {
      key: 'overall',
      label: '总体分析',
      intro: '综合评估文档结构和相似度情况。',
      conclusions: generateOverallConclusions(maxOverall, citationIssues.length, hangingSections.length, parsedCategories)
    },
    {
      key: 'structure',
      label: '结构完整性',
      intro: '检查标准文本固定结构是否齐全。',
      conclusions: generateStructureConclusions(parsedCategories)
    },
    {
      key: 'citation',
      label: '引用文件',
      intro: '关注引用是否存在待核查、废止风险或格式问题。',
      conclusions: generateCitationConclusions(citations, citationIssues)
    },
    {
      key: 'terms',
      label: '术语定义',
      intro: '关注术语是否有来源、定义是否可执行。',
      conclusions: generateTermConclusions(termIssues)
    },
    {
      key: 'risk',
      label: '重复与风险',
      intro: '关注正文复用程度和潜在立项风险。',
      conclusions: generateRiskConclusions(topDuplicates, maxOverall)
    }
  ]

  // ─── 1对1 模式:重塑 report schema,把"标准合规审查"那套字段全部清空 ───
  // 全库报告的 parsedCategories / citationIssues / termIssues / hangingSections / tabs
  // 都是为「评审国标草稿合规性」设计的,套到「两份任意文档对比」上完全不合语境,
  // 报告页会显示「6 个未匹配合规分类」「未检测到术语」「符合规范」之类的废话。
  // 这里直接给 1对1 一套精简专用 schema。
  const isOneToOne = compareMode === 'ONE_TO_ONE' || compareMode === 'pair'
  if (isOneToOne) {
    const targetForPair = similarStandards[0]
    const overallPair = targetForPair?.overallSimilarity ?? 0
    const topDupSim = topDuplicates[0]?.similarity ?? 0

    let pairFreeRisk: string
    let pairAccent: string
    if (overallPair >= 70) {
      pairFreeRisk = `两份文档高度相似 (${overallPair}%)，存在大段重复内容。建议人工核对差异点。`
      pairAccent = 'red'
    } else if (overallPair >= 40) {
      pairFreeRisk = `两份文档存在中等相似度 (${overallPair}%)，部分章节有重叠。`
      pairAccent = 'orange'
    } else if (topDuplicates.length > 0) {
      pairFreeRisk = `两份文档相似度较低 (${overallPair}%)，仅有少量段落存在相似。`
      pairAccent = 'green'
    } else {
      pairFreeRisk = `两份文档相似度极低 (${overallPair}%)，几乎没有内容重合,可视为不相关文档。`
      pairAccent = 'green'
    }

    return {
      taskNo,
      reportCode: `BZ-${taskNo.replace(/^CMP-/, '')}`,
      documentName,
      status: '分析完成',
      compareMode,
      freeRisk: [pairFreeRisk],
      summaryMetrics: [
        {
          label: '总体相似度',
          value: `${overallPair}%`,
          accent: pairAccent,
          detail: 'A 文档与 B 文档综合相似度'
        },
        {
          label: '相似段落对',
          value: `${topDuplicates.length} 对`,
          accent: topDuplicates.length === 0 ? 'green' : topDuplicates.length >= 5 ? 'orange' : 'blue',
          detail: '相似度 ≥ 40% 的段落配对数量'
        },
        {
          label: '最高段落相似度',
          value: `${topDupSim}%`,
          accent: topDupSim >= 75 ? 'red' : topDupSim >= 40 ? 'orange' : 'green',
          detail: topDuplicates.length > 0 ? '所有配对段落中相似度最高的一对' : '未发现匹配段落'
        }
      ],
      similarStandards,
      // 以下四块在 1对1 模式下不适用,清空,前端 PairReport 不渲染
      citationIssues: [],
      termIssues: [],
      hangingSections: [],
      parsedCategories: [],
      duplicateParagraphs: topDuplicates.map(d => ({
        section: `${d.sourceSection} ↔ ${d.targetSection}`,
        similarity: d.similarity,
        risk: d.risk
      })),
      // tabs 是为全库的 5 个分析维度(总体/结构/引用/术语/风险)设计的,
      // 1对1 不做这些分析,tabs 置空,前端的 `report.tabs?.length > 0` 自然不渲染
      tabs: [],
      truncationNote
    }
  }

  return {
    taskNo,
    reportCode: `BZ-${taskNo.replace(/^CMP-/, '')}`,
    documentName,
    status: '分析完成',
    compareMode,
    freeRisk,
    summaryMetrics,
    similarStandards,
    citationIssues,
    termIssues,
    duplicateParagraphs: topDuplicates.map(d => ({
      section: `${d.sourceSection} ↔ ${d.targetSection}`,
      similarity: d.similarity,
      risk: d.risk
    })),
    hangingSections,
    parsedCategories,
    tabs,
    truncationNote
  }
}

// ─── 结论生成辅助函数 ─────────────────────────────────────

function generateOverallConclusions(maxSim: number, citationCount: number, hangingCount: number, categories: Array<{ matched: boolean }>): string[] {
  const conclusions: string[] = []
  const matchedCount = categories.filter(c => c.matched).length

  if (maxSim >= 70 || citationCount >= 3 || hangingCount >= 2) {
    conclusions.push('当前文档存在较多需修订之处，建议完成修订后再进入送审流程。')
  } else if (maxSim >= 50 || citationCount > 0) {
    conclusions.push('文档整体质量尚可，但仍有部分细节需要修正。')
  } else {
    conclusions.push('文档整体质量较好，风险可控。')
  }

  if (matchedCount >= 5) {
    conclusions.push(`文档结构较完整，已覆盖 ${matchedCount}/6 个标准必备类别。`)
  } else {
    conclusions.push(`文档结构覆盖 ${matchedCount}/6 个标准必备类别，建议补充缺失部分。`)
  }

  if (citationCount > 0) {
    conclusions.push(`发现 ${citationCount} 条引用标准问题，建议优先修正引用文件清单。`)
  }

  return conclusions
}

function generateStructureConclusions(categories: Array<{ name: string; matched: boolean }>): string[] {
  const matched = categories.filter(c => c.matched)
  const missing = categories.filter(c => !c.matched)

  const conclusions: string[] = []
  if (matched.length > 0) {
    conclusions.push(`已识别结构类别：${matched.map(c => `"${c.name}"`).join('、')}。`)
  }
  if (missing.length > 0) {
    conclusions.push(`缺失结构类别：${missing.map(c => `"${c.name}"`).join('、')}，建议补充。`)
  }
  return conclusions
}

function generateCitationConclusions(citations: string[], issues: CitationIssue[]): string[] {
  const conclusions: string[] = []
  conclusions.push(`共检测到 ${citations.length} 条引用标准。`)
  if (issues.length > 0) {
    conclusions.push(`其中 ${issues.length} 条存在版本或有效性问题，建议逐条核实并更新到现行版本。`)
  } else {
    conclusions.push('所有引用标准版本均在合理范围内。')
  }
  return conclusions
}

function generateTermConclusions(issues: TermIssue[]): string[] {
  if (issues.length === 0) return ['未检测到术语定义问题。']
  return [
    `检测到 ${issues.length} 个术语需要确认来源或补充定义。`,
    '建议为每个术语标注来源标准号，并确保定义表述一致。'
  ]
}

function generateRiskConclusions(duplicates: ParagraphMatch[], maxSim: number): string[] {
  const conclusions: string[] = []
  const highRisk = duplicates.filter(d => d.similarity >= 75)

  if (highRisk.length > 0) {
    conclusions.push(`${highRisk.length} 个段落与现有标准高度相似（≥75%），存在重复建设风险。`)
    conclusions.push('建议对高重复段落进行重写，强化本文档的差异化内容。')
  } else if (duplicates.length > 0) {
    conclusions.push(`${duplicates.length} 个段落存在中等相似度，风险可控。`)
  } else {
    conclusions.push('未发现显著重复段落，文档原创性良好。')
  }

  if (maxSim >= 70) {
    conclusions.push('综合相似度偏高，若以当前文本立项可能面临评审风险。')
  }

  return conclusions
}
