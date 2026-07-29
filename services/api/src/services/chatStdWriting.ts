/**
 * 标准编写服务 — 大纲生成 + 全文框架生成
 */
import { callLLMStream } from './llm.js'
import { SYSTEM_GUARDRAIL } from './chatGuardrail.js'
import { searchStandards } from './chatSearch.js'

// GB/T 1.1-2020 起草硬约束 — outline / framework 通用，写入每一类 prompt 末尾。
// 这些是行业内审稿最常被打回的低级错误，必须 LLM 在生成时就遵守。
export const GB1_1_2020_DRAFTING_RULES = `
【GB/T 1.1-2020 起草硬约束】
- 助动词：强制要求用「应」，禁止「必须」；推荐用「宜」；允许用「可」；陈述事实用「是」「能」。
- 规范性引用文件格式：每条独立一行，写作「GB/T XXXX-YYYY 标准名称」（编号与名称之间一个空格，不带书名号、不带逗号）。
- 数值范围：使用波浪号「～」（如 10 ℃ ～ 35 ℃），禁止使用短横线「-」表示范围。
- 量、单位：数字与单位之间空格（℃、kPa、mg/L 除外按 GB 3102 处理）；百分号前不空格。
- 技术要求与试验方法严格对应：第 X 章技术要求的每一条 X.n，对应第 X+1 章试验方法 (X+1).n，编号顺序、条数完全一致。
- 条款编号层级：章 / 条 (1.1) / 款 (1.1.1) / 项 a) b) / 分项 1) 2) / 注 注： / 示例 示例：。不允许混用全角／半角括号。
- 一切引用的标准编号都必须真实存在；如不确定，写作 [待核实：XXX] 占位，禁止虚构编号。`

const OUTLINE_SYSTEM_PROMPT_COMMON_HEADER = `你是标准编写助手。根据用户需求，按照 GB/T 1.1-2020《标准化工作导则 第1部分：标准化文件的结构和起草规则》生成标准大纲。
${GB1_1_2020_DRAFTING_RULES}`

const OUTLINE_SYSTEM_PROMPT_PRODUCT = `${OUTLINE_SYSTEM_PROMPT_COMMON_HEADER}

本标准为【产品标准】，请严格按照以下章节顺序生成大纲：
1 范围
2 规范性引用文件
3 术语和定义
4 技术要求（可细分为：分类与型号、外观与尺寸、物理性能、化学性能等）
5 试验方法（与第4章技术要求逐条对应）
6 检验规则（出厂检验/型式检验、抽样方案、判定规则）
7 标志、包装、运输、贮存
附录（资料性/规范性，如有）
参考文献

${SYSTEM_GUARDRAIL}

【输出格式】
请严格按以下 Markdown 格式输出，**字段之间必须保留一个空行**，**不要使用 \`---\` 分隔线**，**不要在开头添加任何引导语**，直接从"**标准名称**"开始：

**标准名称**：《XXX》

**标准类型**：产品标准

**适用范围**：一句话描述

**章节结构**：

1. 范围
2. 规范性引用文件
3. 术语和定义
...

注意：只生成大纲结构和各章标题，不生成具体条款正文。章节列表必须使用「阿拉伯数字+英文点+空格」（如 \`1. 范围\`）才能正确识别为有序列表。
最后用新段落提示用户"请确认大纲是否合适，确认后我将生成完整的标准文本框架"。`

const OUTLINE_SYSTEM_PROMPT_METHOD = `${OUTLINE_SYSTEM_PROMPT_COMMON_HEADER}

本标准为【方法标准（检测/试验/测定/分析方法）】，请严格按照以下章节顺序生成大纲：
1 范围
2 规范性引用文件
3 术语和定义
4 原理（方法原理/化学反应方程式等）
5 试剂和材料（含纯度要求、配制方法）
6 仪器设备（规格参数要求）
7 分析步骤（样品制备、测定过程、操作顺序）
8 结果计算和表达（计算公式、有效数字、单位）
9 精密度（重复性限 r、再现性限 R）
附录（资料性/规范性，如有）
参考文献

${SYSTEM_GUARDRAIL}

【输出格式】
请严格按以下 Markdown 格式输出，**字段之间必须保留一个空行**，**不要使用 \`---\` 分隔线**，**不要在开头添加任何引导语**，直接从"**标准名称**"开始：

**标准名称**：《XXX》

**标准类型**：方法标准

**适用范围**：一句话描述

**章节结构**：

1. 范围
2. 规范性引用文件
3. 术语和定义
...

注意：只生成大纲结构和各章标题，不生成具体条款正文。章节列表必须使用「阿拉伯数字+英文点+空格」（如 \`1. 范围\`）才能正确识别为有序列表。
最后用新段落提示用户"请确认大纲是否合适，确认后我将生成完整的标准文本框架"。`

const OUTLINE_SYSTEM_PROMPT_MANAGEMENT = `${OUTLINE_SYSTEM_PROMPT_COMMON_HEADER}

本标准为【管理标准（管理规范/管理规程/管理办法/技术规程）】，请严格按照以下章节顺序生成大纲：
1 范围
2 规范性引用文件
3 术语和定义
4 职责（各岗位/部门的职责划分）
5 流程（业务流程/操作规程，可细分为多个子流程章节）
6 记录（应保留的记录、表单清单及保存要求）
附录（规范性表单/流程图，如有）
参考文献

${SYSTEM_GUARDRAIL}

【输出格式】
请严格按以下 Markdown 格式输出，**字段之间必须保留一个空行**，**不要使用 \`---\` 分隔线**，**不要在开头添加任何引导语**，直接从"**标准名称**"开始：

**标准名称**：《XXX》

**标准类型**：管理标准

**适用范围**：一句话描述

**章节结构**：

1. 范围
2. 规范性引用文件
3. 术语和定义
...

注意：只生成大纲结构和各章标题，不生成具体条款正文。章节列表必须使用「阿拉伯数字+英文点+空格」（如 \`1. 范围\`）才能正确识别为有序列表。
最后用新段落提示用户"请确认大纲是否合适，确认后我将生成完整的标准文本框架"。`

const OUTLINE_SYSTEM_PROMPT_GENERIC = `${OUTLINE_SYSTEM_PROMPT_COMMON_HEADER}

标准文件的典型章节结构：
1 范围
2 规范性引用文件
3 术语和定义
4-N 技术内容章节（根据标准类型确定）
附录（资料性/规范性）
参考文献

标准类型与对应章节：
- 产品标准：范围→引用→术语→分类与型号→技术要求→试验方法→检验规则→标志、包装、运输和贮存
- 方法标准：范围→引用→术语→原理→试剂和材料→仪器设备→试验步骤→结果处理→精密度
- 管理标准：范围→引用→术语→职责→管理要求→实施→监督与考核

${SYSTEM_GUARDRAIL}

【输出格式】
请严格按以下 Markdown 格式输出，**字段之间必须保留一个空行**，**不要使用 \`---\` 分隔线**，**不要在开头添加任何引导语**，直接从"**标准名称**"开始：

**标准名称**：《XXX》

**标准类型**：产品标准/方法标准/管理标准/...

**适用范围**：一句话描述

**章节结构**：

1. 范围
2. 规范性引用文件
3. 术语和定义
...

注意：只生成大纲结构和各章标题，不生成具体条款正文。章节列表必须使用「阿拉伯数字+英文点+空格」（如 \`1. 范围\`）才能正确识别为有序列表。
最后用新段落提示用户"请确认大纲是否合适，确认后我将生成完整的标准文本框架"。`

const FRAMEWORK_SYSTEM_PROMPT = `你是标准编写助手。根据用户确认的大纲，按照 GB/T 1.1-2020 生成完整的标准文本框架。
${GB1_1_2020_DRAFTING_RULES}

${SYSTEM_GUARDRAIL}

【输出要求】
1. 封面模板：
   [标准号]
   《标准名称》
   [发布日期] 发布    [实施日期] 实施

2. 目次（根据大纲章节自动生成）

3. 前言：
   包含编写依据说明模板，如"本文件按照 GB/T 1.1-2020《标准化工作导则 第1部分：标准化文件的结构和起草规则》的规定起草。"

4. 各章节标题 + 条款编号骨架：
   每个条款位置标注 [待填写：此处填写具体技术要求/参数/方法/...] 占位

5. 附录结构（如有）

6. 参考文献

【关键原则】
- 只生成格式框架和条款编号骨架
- 所有具体技术内容一律用 [待填写：xxx] 占位
- 绝不编造任何技术参数或标准条文
- 条款编号严格按照 GB/T 1.1-2020 层级规则`

/**
 * 根据用户输入检测标准类型
 */
function detectStandardType(input: string): 'product' | 'method' | 'management' | null {
  if (input.includes('产品标准')) return 'product'
  if (
    input.includes('检测方法') ||
    input.includes('试验方法') ||
    input.includes('测定方法') ||
    input.includes('分析方法')
  ) return 'method'
  if (
    input.includes('管理规范') ||
    input.includes('管理规程') ||
    input.includes('管理办法') ||
    input.includes('技术规程')
  ) return 'management'
  return null
}

/**
 * 流式生成标准大纲
 */
export async function* streamWriteOutline(
  description: string,
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): AsyncGenerator<string> {
  const stdType = detectStandardType(description)
  const systemPrompt =
    stdType === 'product'    ? OUTLINE_SYSTEM_PROMPT_PRODUCT :
    stdType === 'method'     ? OUTLINE_SYSTEM_PROMPT_METHOD :
    stdType === 'management' ? OUTLINE_SYSTEM_PROMPT_MANAGEMENT :
                               OUTLINE_SYSTEM_PROMPT_GENERIC

  yield* callLLMStream([
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: description },
  ], { maxTokens: 2048 })
}

/**
 * 从用户"起草标准"的描述中提取搜索关键词。
 * 规则：去掉动词引导词（"帮我起草/制定/编写"等），取最长的2-4字名词短语。
 * 最多返回一个 query 字符串（供 searchStandards 使用）。
 */
function extractWriteQuery(description: string): string {
  // 去掉常见引导词
  const stripped = description
    .replace(/帮我|请|我要|我想|需要|起草|制定|编写|撰写|生成|写一个|写一份|做一个|做一份|的?标准|草案/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // 优先取带"产品标准"/"检测方法"/"管理规范"前的核心主题（最多6字）
  // 匹配连续2-6个汉字组成的词组（排除功能性词汇）
  const chunks = stripped.match(/[一-龥]{2,6}/g) || []
  const stopWords = new Set(['产品标准', '方法标准', '管理标准', '检测方法', '试验方法', '测定方法', '分析方法', '管理规范', '管理规程', '管理办法', '技术规程'])
  const meaningful = chunks.filter(c => !stopWords.has(c))

  if (meaningful.length === 0) {
    // 回退：直接取原始输入前20字
    return description.slice(0, 20).trim()
  }
  // 取前2个词组拼接（避免太长）
  return meaningful.slice(0, 2).join(' ')
}

/**
 * 大纲生成完成后，搜索相关现有标准作为参考文献。
 * 返回：
 * - prefixChunk: 发给前端的前置文案（answer_chunk 内容）
 * - searchResultsEvent: search_results 事件对象（无命中则 null）
 */
/** 参考文献查询外层硬超时：15s（兜底 searchStandards 内部 timeout，双保险） */
const REFERENCE_STANDARDS_TIMEOUT_MS = 15_000

type ReferenceStandardsResult = { prefixChunk: string; searchResultsEvent: object | null }
type ReferenceCacheEntry = { result: ReferenceStandardsResult; expiresAt: number }

const REFERENCE_CACHE_TTL_MS = 10 * 60 * 1000
const REFERENCE_CACHE_MAX = 200
const referenceCache = new Map<string, ReferenceCacheEntry>()

function getCachedReference(conversationId: string): ReferenceStandardsResult | null {
  const entry = referenceCache.get(conversationId)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    referenceCache.delete(conversationId)
    return null
  }
  // LRU：命中后重新插入到末尾，保证淘汰时清掉最早的
  referenceCache.delete(conversationId)
  referenceCache.set(conversationId, entry)
  return entry.result
}

function setCachedReference(conversationId: string, result: ReferenceStandardsResult): void {
  if (!referenceCache.has(conversationId) && referenceCache.size >= REFERENCE_CACHE_MAX) {
    const firstKey = referenceCache.keys().next().value
    if (firstKey !== undefined) referenceCache.delete(firstKey)
  }
  referenceCache.set(conversationId, {
    result,
    expiresAt: Date.now() + REFERENCE_CACHE_TTL_MS,
  })
}

export async function fetchReferenceStandards(
  description: string,
  conversationId?: string,
): Promise<ReferenceStandardsResult> {
  if (conversationId) {
    const cached = getCachedReference(conversationId)
    if (cached) {
      console.log(`[ChatStdWriting] referenceStandards cache hit, conversationId=${conversationId}`)
      return cached
    }
  }

  const query = extractWriteQuery(description)
  if (!query) {
    return { prefixChunk: '', searchResultsEvent: null }
  }

  // 外层 Promise.race 做硬超时兜底。内部 searchStandards 有自己的 15s timeout，
  // 这层是双保险：万一主流程阻塞，写作主流程不能被拖住。失败一律降级跳过参考文献。
  const TIMEOUT_SENTINEL = Symbol('timeout')
  try {
    const result = await Promise.race([
      searchStandards(query, [query], 8),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), REFERENCE_STANDARDS_TIMEOUT_MS),
      ),
    ])
    if (result === TIMEOUT_SENTINEL) {
      console.warn(`[ChatStdWriting] fetchReferenceStandards 外层硬超时 ${REFERENCE_STANDARDS_TIMEOUT_MS}ms → 跳过参考文献`)
      return { prefixChunk: '', searchResultsEvent: null }
    }
    const { searchResultsEvent, matchQuality, searchTimedOut } = result
    if (searchTimedOut) {
      console.warn(`[ChatStdWriting] fetchReferenceStandards: searchStandards 内部超时 → 跳过参考文献`)
      return { prefixChunk: '', searchResultsEvent: null }
    }
    if (matchQuality === 'empty') {
      const emptyResult: ReferenceStandardsResult = { prefixChunk: '', searchResultsEvent: null }
      if (conversationId) setCachedReference(conversationId, emptyResult)
      return emptyResult
    }
    // `---` 前后都有空行，CommonMark 只会解析为 HR（不会触发 setext H2）
    const prefixChunk = `\n\n---\n\n以下是与"${query}"相关的现有标准，供起草时参考：`
    const hitResult: ReferenceStandardsResult = { prefixChunk, searchResultsEvent }
    if (conversationId) setCachedReference(conversationId, hitResult)
    return hitResult
  } catch (err: any) {
    console.warn('[ChatStdWriting] fetchReferenceStandards 异常 → 跳过参考文献', err?.message || err)
    return { prefixChunk: '', searchResultsEvent: null }
  }
}

/**
 * 流式生成标准全文框架
 */
export async function* streamWriteFramework(
  outline: string,
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): AsyncGenerator<string> {
  yield* callLLMStream([
    { role: 'system', content: FRAMEWORK_SYSTEM_PROMPT },
    ...(history || []),
    { role: 'user', content: `请根据以下大纲生成完整的标准文本框架：\n\n${outline}` },
  ], { maxTokens: 4096 })
}
