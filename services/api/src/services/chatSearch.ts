/**
 * 标准检索 — 双轨输出：
 * 1. searchStandards → 结构化 search_results 事件数据
 * 2. streamSearchSummary → LLM 生成 1-3 句结论（answer_chunk）
 */
import { callLLM, callLLMStream, LLM_FALLBACK_REPLY, getEmbedding } from './llm.js'
import { SYSTEM_GUARDRAIL } from './chatGuardrail.js'

const PYAPI_BASE = process.env.PYAPI_BASE_URL || 'http://localhost:8082'

// ─── 联网降级触发判断（呼叫小智 §3.2）──────────────────────────────
//
// 当本地标准库 empty 时，按以下 5 种触发条件判断是否走联网搜索（Qwen DashScope
// 原生 enable_search）。触发优先级：
//   no_fallback_key > user_explicit > local_empty > low_recall_with_code > time_sensitive

/** 用户显式联网请求（覆盖所有其他逻辑）*/
const EXPLICIT_WEB_PATTERNS = [
  /查全网/, /网上搜/, /网上查/, /搜一下/, /帮我搜/, /上网查/,
]

/** 时效性关键词：即使本地有结果也建议补充联网（A 阶段保守，仅 empty 时用）*/
const TIME_SENSITIVE_PATTERNS = [
  /最新/, /现行/, /新版/, /修订/, /近期/, /刚出/, /新规/, /发布/,
  /20(2[5-9]|3\d)/, // 2025-2039 年份
]

export function shouldFallbackToWeb(
  query: string,
  localHitCount: number,
  matchQuality: 'empty' | 'related' | 'exact',
): { trigger: boolean; reason: string } {
  if (!process.env.SVC_LLM_FALLBACK_KEY) {
    return { trigger: false, reason: 'no_fallback_key' }
  }
  if (EXPLICIT_WEB_PATTERNS.some(p => p.test(query))) {
    return { trigger: true, reason: 'user_explicit' }
  }
  if (matchQuality === 'empty') {
    return { trigger: true, reason: 'local_empty' }
  }
  if (localHitCount < 3 && /[A-Z]{2,4}[\s/]?\d/i.test(query)) {
    return { trigger: true, reason: 'low_recall_with_code' }
  }
  if (TIME_SENSITIVE_PATTERNS.some(p => p.test(query))) {
    return { trigger: true, reason: 'time_sensitive' }
  }
  return { trigger: false, reason: 'sufficient_local' }
}

interface SearchHit {
  code?: string
  name?: string
  status?: string
  pub_date?: string
  impl_date?: string
  industry?: string
  ics?: string
  ccs?: string
  issuing_dept?: string
  tc_committee?: string
  replaces?: string
  replaced_by?: string
  scope?: string
  [key: string]: unknown
}

interface SearchResultItem {
  code: string
  title: string
  status: string
  implDate: string
  pubDate: string
  committee: string
  replacedBy: string | null
  industry: string
  detailUrl: string
}

interface SearchResultsEvent {
  type: 'search_results'
  total: number
  items: SearchResultItem[]
  moreUrl: string
}

export type MatchQuality = 'exact' | 'related' | 'empty'

// _score >= 100 = 标准号精确/包含命中 → exact
// _score >= 10  = 名称相关命中 → related
// _score < 10   = FTS bigram 弱匹配 → 丢弃
const SCORE_EXACT = 100
const SCORE_RELATED = 10

interface QuerySuggestion {
  text: string
  label: string
}

// 推荐词策略：用短核心词（2-3字），而非组合词
// 因为 FTS bigram 匹配对长组合词命中率低，但标准名称常直接包含短核心词
const QUERY_SUGGESTION_RULES: Array<{ pattern: RegExp; suggestions: string[] }> = [
  { pattern: /(飞机|航空器|航空|飞行)/, suggestions: ['飞机', '航空', '航空器', '适航', '飞行'] },
  { pattern: /(食品|食品安全|餐饮|饮料)/, suggestions: ['食品', '饮料', '食品添加剂', '食品标签', '食品卫生'] },
  { pattern: /(焊接|焊缝|电焊|气焊)/, suggestions: ['焊接', '焊缝', '电弧焊', '焊条', '钎焊'] },
  { pattern: /(新能源|电动汽车|锂电|动力电池)/, suggestions: ['电动汽车', '动力电池', '充电', '锂离子', '电机'] },
  { pattern: /(建筑|混凝土|钢结构|地基)/, suggestions: ['建筑', '混凝土', '钢结构', '地基', '建筑材料'] },
  { pattern: /(机械|轴承|齿轮|液压)/, suggestions: ['机械', '轴承', '齿轮', '液压', '紧固件'] },
  { pattern: /(电气|电力|变压器|配电)/, suggestions: ['变压器', '配电', '电缆', '电力', '绝缘'] },
  { pattern: /(医疗|医疗器械|手术|诊断)/, suggestions: ['医疗器械', '手术', '诊断', '消毒', '灭菌'] },
  { pattern: /(环保|环境|污水|废气|排放)/, suggestions: ['污水', '废气', '排放', '噪声', '固体废物'] },
  { pattern: /(信息技术|软件|网络安全|数据)/, suggestions: ['信息安全', '软件', '网络', '数据', '密码'] },
  { pattern: /(纺织|服装|面料|印染)/, suggestions: ['纺织', '服装', '面料', '纤维', '印染'] },
  { pattern: /(化工|化学|涂料|塑料|橡胶)/, suggestions: ['涂料', '塑料', '橡胶', '化学试剂', '树脂'] },
  { pattern: /(汽车|车辆|发动机|制动)/, suggestions: ['汽车', '发动机', '制动', '轮胎', '转向'] },
]

/**
 * 检测用户输入中是否包含标准号。
 * 涵盖：国标（GB/T、GB/Z、GB）、行标（YB/T、HJ/T、JB/T、DL/T、SL、JGJ、CJJ）、
 *       地标（DB\d+/T、DB\d+）、团标（T/字母）、企标（Q/\w+）
 * 返回首个匹配到的标准号字符串，无则返回 null。
 */
// ── 行业前缀白名单 ───────────────────────────────────────────────────────
// 仅当 trim 后输入【完全等于】白名单前缀（不含数字编号部分）时触发 LIKE 快速路径。
// DB 特殊处理：纯 "DB" / "DB31" / "DB31/T" 均视作前缀，LIKE 用完整匹配字符串
const INDUSTRY_PREFIX_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /^JB\/T$/i, label: 'JB/T' },
  { re: /^HJ\/T$/i, label: 'HJ/T' },
  { re: /^DL\/T$/i, label: 'DL/T' },
  { re: /^YB\/T$/i, label: 'YB/T' },
  { re: /^SY\/T$/i, label: 'SY/T' },
  { re: /^NB\/T$/i, label: 'NB/T' },
  { re: /^QB\/T$/i, label: 'QB/T' },
  { re: /^YC\/T$/i, label: 'YC/T' },
  { re: /^WS$/i, label: 'WS' },
  { re: /^DB(\d{0,2}(\/T)?)$/i, label: 'DB' },
]

/**
 * 检测输入是否【仅】是行业标准前缀（不含数字编号部分）。
 * "JB/T" → "JB/T" ✓  |  "JB/T 74-2015" → null ✗  |  "机械" → null ✗
 * "DB31/T" → "DB31/T" ✓（保留省码）
 */
function detectIndustryPrefix(input: string): string | null {
  const trimmed = input.trim()
  for (const { re, label } of INDUSTRY_PREFIX_PATTERNS) {
    const m = trimmed.match(re)
    if (m) {
      if (label === 'DB') return m[0].toUpperCase()
      return label
    }
  }
  return null
}

function detectStandardCode(input: string): string | null {
  // 顺序：从最长/最具体的前缀匹配到短前缀，避免误截
  const patterns: RegExp[] = [
    // 国标系列
    /GB\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /GB\/Z\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /GB-Z\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /GB\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    // 行业标准（常见前缀）
    /YB\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /HJ\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /JB\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /DL\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /SL\s+\d+(?:\.\d+)?(?:-\d{4})?/i,
    /JGJ\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /CJJ\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    // 地方标准
    /DB\d+\/T\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    /DB\d+\s*\/\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    // 团体标准
    /T\/[A-Z]{2,}\s*\d+(?:\.\d+)?(?:-\d{4})?/i,
    // 企业标准
    /Q\/\w+\s*\d*(?:-\d{4})?/i,
  ]
  for (const pattern of patterns) {
    const m = input.match(pattern)
    if (m) return m[0].trim()
  }
  return null
}

/**
 * 行业前缀 only 快速路径：拉 limit=100 结果（score=100 即编号包含命中），
 * 过滤 code 以前缀开头，按 impl_date DESC 取 top 8。命中 0 条返回 null 降级。
 */
async function searchByPrefix(
  prefix: string,
  keywords: string[],
): Promise<{ hits: SearchHit[]; searchResultsEvent: SearchResultsEvent } | null> {
  const url = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(prefix)}&limit=100`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    const data = await res.json() as { results?: SearchHit[] }
    const pfxNorm = prefix.toUpperCase().replace(/\s+/g, '')
    const hits = (data.results || []).filter(h => {
      const score = (h._score as number) ?? 0
      if (score < 100) return false
      const codeNorm = (h.code || '').toUpperCase().replace(/\s+/g, '')
      return codeNorm.startsWith(pfxNorm)
    })

    if (hits.length === 0) return null

    hits.sort((a, b) => {
      const da = a.impl_date || ''
      const db = b.impl_date || ''
      if (da === db) return 0
      if (!da) return 1
      if (!db) return -1
      return da > db ? -1 : 1
    })

    const top8 = hits.slice(0, 8)
    const items: SearchResultItem[] = top8.map(h => ({
      code: h.code || '未知',
      title: h.name || '未知',
      status: h.status || '未知',
      implDate: h.impl_date || '',
      pubDate: h.pub_date || '',
      committee: h.tc_committee || h.issuing_dept || '',
      replacedBy: (h.replaced_by as string) || null,
      industry: h.industry || '',
      detailUrl: `/standards/${encodeURIComponent(h.code || '')}`,
    }))
    const searchResultsEvent: SearchResultsEvent = {
      type: 'search_results',
      total: hits.length,
      items,
      moreUrl: `/standards?q=${encodeURIComponent(keywords.join(' '))}`,
    }
    return { hits: top8, searchResultsEvent }
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      console.warn('[ChatSearch] searchByPrefix 请求失败', err)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 调 pyapi 搜索 + 构造结构化 search_results 事件
 */
export async function searchStandards(
  query: string,
  keywords: string[],
  limit = 10,
): Promise<{ hits: SearchHit[]; searchResultsEvent: SearchResultsEvent; matchQuality: MatchQuality; searchTimedOut: boolean }> {
  // ── 标准号快速命中前置 ──────────────────────────────────────────────────
  // engine.py search() 评分规则（engine.py L576-577）：
  //   完全匹配（归一化后 code == q_norm）→ score 200
  //   包含匹配（code LIKE %q_norm%）       → score 100
  //   名称 FTS bigram 匹配                 → score ≤ 40（通常 10-30）
  // 阈值 SCORE_CODE_HIT = 100：凡 score≥100 均为标准号命中，
  // 精确路径：用标准号作 q 查询，过滤 _score >= 100 的结果。
  // 命中 0 条 → 不返回，继续执行原有全文搜索逻辑（回落保证）。
  const SCORE_CODE_HIT = 100
  const detectedCode = detectStandardCode(query)
  if (detectedCode) {
    const exactUrl = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(detectedCode)}&limit=${limit}`
    const exactController = new AbortController()
    const exactTimeout = setTimeout(() => exactController.abort(), 10000)
    try {
      const exactRes = await fetch(exactUrl, { signal: exactController.signal })
      if (exactRes.ok) {
        const exactData = await exactRes.json() as { results?: SearchHit[] }
        const exactHits = (exactData.results || []).filter(
          h => (h._score as number ?? 0) >= SCORE_CODE_HIT,
        )
        if (exactHits.length > 0) {
          // 精确命中，直接构造结果返回，跳过全文搜索
          clearTimeout(exactTimeout)
          const items: SearchResultItem[] = exactHits.slice(0, 5).map(h => ({
            code: h.code || '未知',
            title: h.name || '未知',
            status: h.status || '未知',
            implDate: h.impl_date || '',
            pubDate: h.pub_date || '',
            committee: h.tc_committee || h.issuing_dept || '',
            replacedBy: (h.replaced_by as string) || null,
            industry: h.industry || '',
            detailUrl: `/standards/${encodeURIComponent(h.code || '')}`,
          }))
          const searchResultsEvent: SearchResultsEvent = {
            type: 'search_results',
            total: exactHits.length,
            items,
            moreUrl: `/standards?q=${encodeURIComponent(keywords.join(' '))}`,
          }
          console.log(`[ChatSearch] 标准号快速命中: detectedCode="${detectedCode}" hits=${exactHits.length} topScore=${exactHits[0]?._score ?? 0}`)
          return { hits: exactHits, searchResultsEvent, matchQuality: 'exact' as MatchQuality, searchTimedOut: false }
        }
        console.log(`[ChatSearch] 标准号快速命中 0 条，回落全文搜索: detectedCode="${detectedCode}"`)
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('[ChatSearch] 标准号精确查询失败，回落全文搜索', err)
      }
    } finally {
      clearTimeout(exactTimeout)
    }
  }
  // ── 行业前缀 only 快速路径 ──────────────────────────────────────────────
  // 用户仅输入行业标准号前缀（JB/T、HJ/T 等）时，走 LIKE + impl_date DESC 取最新 8 条。
  // 跳过 FTS（FTS 对纯前缀召回偏斜、排序不按时间）。命中 0 条回落全文搜索。
  const detectedPrefix = detectIndustryPrefix(query)
  if (detectedPrefix) {
    const prefixResult = await searchByPrefix(detectedPrefix, keywords)
    if (prefixResult) {
      console.log(`[ChatSearch] 行业前缀快速命中: prefix="${detectedPrefix}" hits=${prefixResult.hits.length}`)
      return {
        hits: prefixResult.hits,
        searchResultsEvent: prefixResult.searchResultsEvent,
        matchQuality: 'exact' as MatchQuality,
        searchTimedOut: false,
      }
    }
    console.log(`[ChatSearch] 行业前缀快速命中 0 条，回落全文搜索: prefix="${detectedPrefix}"`)
  }

  // ── 原有全文搜索逻辑 ──────────────────────────────────────────────────

  const url = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let rawHits: SearchHit[] = []
  let searchTimedOut = false
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (res.ok) {
      const data = await res.json() as { results?: SearchHit[] }
      rawHits = data.results || []
    } else {
      console.warn(`[ChatSearch] pyapi 返回 ${res.status}`)
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      searchTimedOut = true
      console.warn('[ChatSearch] pyapi 搜索超时（15s）')
    } else {
      console.warn('[ChatSearch] pyapi 请求失败', err)
    }
  } finally {
    clearTimeout(timeout)
  }

  // 按 _score 判断命中质量，过滤弱命中
  let hasExact = rawHits.some(h => (h._score as number ?? 0) >= SCORE_EXACT)
  let qualityHits = rawHits.filter(h => (h._score as number ?? 0) >= SCORE_RELATED)

  // 回退策略：多字复合词（如"食品安全""电动汽车"）FTS bigram 效果差
  // 如果主搜索无有效结果且 query 长度 >= 4，尝试取前半部分关键词重搜
  if (qualityHits.length === 0 && query.length >= 4) {
    const halfQuery = query.slice(0, Math.ceil(query.length / 2))
    const fallbackUrl = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(halfQuery)}&limit=${limit}`
    const fbController = new AbortController()
    const fbTimeout = setTimeout(() => fbController.abort(), 8000)
    try {
      const fbRes = await fetch(fallbackUrl, { signal: fbController.signal })
      if (fbRes.ok) {
        const fbData = await fbRes.json() as { results?: SearchHit[] }
        const fbHits = (fbData.results || []).filter(h => (h._score as number ?? 0) >= SCORE_RELATED)
        if (fbHits.length > 0) {
          qualityHits = fbHits
          hasExact = fbHits.some(h => (h._score as number ?? 0) >= SCORE_EXACT)
        }
      }
    } catch { /* 回退失败不影响主流程 */ }
    finally { clearTimeout(fbTimeout) }
  }

  let matchQuality: MatchQuality
  if (qualityHits.length === 0) {
    matchQuality = 'empty'
  } else if (hasExact) {
    matchQuality = 'exact'
  } else {
    matchQuality = 'related'
  }

  const hits = matchQuality === 'empty' ? [] : qualityHits

  const items: SearchResultItem[] = hits.slice(0, 5).map(h => ({
    code: h.code || '未知',
    title: h.name || '未知',
    status: h.status || '未知',
    implDate: h.impl_date || '',
    pubDate: h.pub_date || '',
    committee: h.tc_committee || h.issuing_dept || '',
    replacedBy: (h.replaced_by as string) || null,
    industry: h.industry || '',
    detailUrl: `/standards/${encodeURIComponent(h.code || '')}`,
  }))

  const searchResultsEvent: SearchResultsEvent = {
    type: 'search_results',
    total: hits.length,
    items,
    moreUrl: `/standards?q=${encodeURIComponent(keywords.join(' '))}`,
  }

  console.log(`[ChatSearch] query="${query}" matchQuality=${matchQuality} qualityHits=${hits.length} rawHits=${rawHits.length} topScore=${rawHits[0] ? (rawHits[0]._score as number ?? 0) : 0}`)

  // ── Embedding cosine 重排（仅 related 态，≥2 条结果）────────────────────
  if (matchQuality === 'related' && hits.length >= 2) {
    try {
      const hitTexts = hits.slice(0, 5).map(h => `${h.code || ''} ${h.name || ''}`.trim())
      const allTexts = [query, ...hitTexts]
      const vectors = await getEmbedding(allTexts)
      const queryVec = vectors[0]
      const hitVecs = vectors.slice(1)

      function cosine(a: number[], b: number[]): number {
        let dot = 0, na = 0, nb = 0
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i]
          na += a[i] * a[i]
          nb += b[i] * b[i]
        }
        return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10)
      }

      // 对 items（top5）和对应的 hits 前 5 条同步重排
      const top5Hits = hits.slice(0, 5)
      const scored = top5Hits.map((h, i) => ({
        hit: h,
        item: items[i],
        score: cosine(queryVec, hitVecs[i]),
      }))
      scored.sort((a, b) => b.score - a.score)

      // 重建 items 和对应 hits 前 5 的顺序
      for (let i = 0; i < scored.length; i++) {
        hits[i] = scored[i].hit
        items[i] = scored[i].item
      }
      searchResultsEvent.items = items

      console.log(`[ChatSearch] embedding rerank done, query="${query}" top="${scored[0]?.hit?.code}" cosine=${scored[0]?.score?.toFixed(4)}`)
    } catch (err) {
      console.warn('[ChatSearch] embedding rerank failed', err instanceof Error ? err.message : err)
      // 降级：保持原 BM25 顺序，不抛错
    }
  }

  return { hits, searchResultsEvent, matchQuality, searchTimedOut }
}

// trialSearch 阈值：验证推荐词时要求 score 更高（>=40），确保推出的词能召回有质量的结果
const SCORE_TRIAL_MIN = 40

/**
 * 对单个关键词做 pyapi 试搜，返回 score >= SCORE_TRIAL_MIN 的命中条数
 */
const TRIAL_SEARCH_TIMEOUT_MS = 10_000

async function trialSearch(query: string): Promise<number> {
  const url = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(query)}&limit=10`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRIAL_SEARCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      console.warn(`[ChatSearch] trialSearch HTTP ${res.status} query="${query}" → 0`)
      return 0
    }
    const data = await res.json() as { results?: Array<{ _score?: number }> }
    // 只计算高质量命中（_score >= SCORE_TRIAL_MIN），确保推荐词能召回有意义的标准
    const qualityCount = (data.results || []).filter(r => (r._score ?? 0) >= SCORE_TRIAL_MIN).length
    return qualityCount
  } catch (err: any) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      console.warn(`[ChatSearch] trialSearch timeout ${TRIAL_SEARCH_TIMEOUT_MS}ms query="${query}" → 0`)
    } else {
      console.warn(`[ChatSearch] trialSearch failed query="${query}" → 0`, err?.message || err)
    }
    return 0
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 用 LLM 从用户原始问题中提取 2-3 个精准检索关键词（非流式，短调用）
 * 返回关键词数组，失败返回空数组（由调用方回落词表）
 */
export async function extractKeywordsViaLLM(userMessage: string): Promise<string[]> {
  const prompt = `你是标准检索助手。根据用户问题，提取 2-3 个适合在标准数据库中检索的精准中文关键词。
要求：
- 每个关键词 2-6 个汉字，是标准名称中常见的核心词，不要用整句话
- 优先提取专业术语、材料名称、工艺方法、设备类型等具体词
- 不要输出用户原话，要提炼更精准的检索词
- 只输出关键词，用换行或逗号分隔，不要解释，不要序号

用户问题：${userMessage}`

  try {
    const result = await callLLM([
      { role: 'user', content: prompt },
    ], { maxTokens: 60, temperature: 0.2 })
    // callLLM 在双 provider 均失败/超时时返回 LLM_FALLBACK_REPLY 字符串，
    // 不识别会把"抱歉，AI 服务暂时不可用..."当成关键词丢给 trialSearch
    if (!result || result === LLM_FALLBACK_REPLY) {
      console.warn('[ChatSearch] extractKeywordsViaLLM: LLM 不可用（fallback reply） → []')
      return []
    }
    // 解析：支持换行或逗号分隔
    const keywords = result
      .split(/[\n,，、]+/)
      .map(k => k.replace(/^\d+[.、]\s*/, '').trim())
      .filter(k => k.length >= 2 && k.length <= 10)
      .slice(0, 3)
    return keywords
  } catch (err: any) {
    console.warn('[ChatSearch] extractKeywordsViaLLM 异常 → []', err?.message || err)
    return []
  }
}

/**
 * 0 结果推荐词 — 候选词经真实标准库试搜验证
 * @param failedTerms 本轮会话中已失败过的推荐词，避免重复推荐
 * @param zeroCount   当前会话连续 0 结果次数（1=第一次，2=第二次，3+=第三次）
 */
export async function buildZeroResultSuggestions(
  userMessage: string,
  keywords: string[],
  failedTerms: Set<string> = new Set(),
  zeroCount = 1,
): Promise<QuerySuggestion[]> {
  let candidates: string[]

  if (zeroCount >= 3) {
    // 第 3 次：不再机械推荐词，返回空（由 buildZeroResultReply 给引导文案）
    return []
  }

  if (zeroCount === 2) {
    // 第 2 次：推荐方向分类词
    candidates = ['设计标准', '安全标准', '材料标准', '检测标准', '制造标准', '环境标准', '质量管理', '试验方法']
  } else {
    // 第 1 次：优先用 LLM 从用户问题中提取精准关键词，失败则回落词表
    const llmKeywords = await extractKeywordsViaLLM(userMessage)
    if (llmKeywords.length > 0) {
      console.log(`[ChatSearch] LLM 提词: [${llmKeywords.join(',')}]`)
      // LLM 词优先，再补充词表候选作备选（不超过 8 个总量）
      const queryText = [userMessage, ...keywords].join(' ').trim()
      const matchedRule = QUERY_SUGGESTION_RULES.find(rule => rule.pattern.test(queryText))
      const ruleBackup = matchedRule?.suggestions || buildGenericSuggestions(keywords)
      candidates = [...llmKeywords, ...ruleBackup.filter(c => !llmKeywords.includes(c))]
    } else {
      // LLM 提词失败 → 回落词表
      console.log(`[ChatSearch] LLM 提词失败，回落词表`)
      const queryText = [userMessage, ...keywords].join(' ').trim()
      const matchedRule = QUERY_SUGGESTION_RULES.find(rule => rule.pattern.test(queryText))
      candidates = matchedRule?.suggestions || buildGenericSuggestions(keywords)
    }
  }

  // 去掉已失败过的词
  candidates = candidates.filter(c => !failedTerms.has(c))

  // 并发试搜验证（最多 8 个），要求 score >= SCORE_TRIAL_MIN（40）才算有效推荐
  const toVerify = Array.from(new Set(candidates)).slice(0, 8)
  const results = await Promise.all(
    toVerify.map(async (text) => {
      const count = await trialSearch(text)
      return { text, count }
    }),
  )

  // 只保留命中 > 0 的（trialSearch 内部已过滤 score<40），按命中数降序
  const verified = results
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map(r => ({ text: r.text, label: r.text }))

  console.log(`[ChatSearch] suggestions: zeroCount=${zeroCount} candidates=${toVerify.length} verified=${verified.length} failedTerms=${failedTerms.size} returned=[${verified.map(v => v.text).join(',')}]`)

  // 兜底：LLM 提词 + 试搜全部失败 → 回落原词表（不做试搜，直接返回）
  if (verified.length === 0 && zeroCount === 1) {
    const queryText = [userMessage, ...keywords].join(' ').trim()
    const matchedRule = QUERY_SUGGESTION_RULES.find(rule => rule.pattern.test(queryText))
    const fallbackCandidates = (matchedRule?.suggestions || buildGenericSuggestions(keywords))
      .filter(c => !failedTerms.has(c))
      .slice(0, 5)
    if (fallbackCandidates.length > 0) {
      console.log(`[ChatSearch] suggestions 兜底：LLM 验证 0 条，回落词表 [${fallbackCandidates.join(',')}]`)
      return fallbackCandidates.map(t => ({ text: t, label: t }))
    }
  }

  return verified
}

/**
 * 根据连续 0 结果次数生成不同引导文案
 */
export function buildZeroResultReply(
  userMessage: string,
  suggestions: QuerySuggestion[],
  zeroCount = 1,
): string {
  if (zeroCount >= 3) {
    return `连续几次都没有找到匹配”${userMessage}”的标准。建议您描述一下具体的使用场景或用途，比如”我需要做XX产品的XX试验，需要什么标准”，我来帮您精准定位。`
  }
  if (zeroCount === 2) {
    if (suggestions.length > 0) {
      return `”${userMessage}”仍然没有直接命中。标准库按细分方向组织，试试从下面的大方向切入：`
    }
    return `”${userMessage}”仍然没有直接命中。建议换一个更具体的关键词，或者告诉我您想查的具体用途。`
  }
  // 第 1 次
  if (suggestions.length > 0) {
    return `暂时没有直接匹配”${userMessage}”的标准。这类标准通常分散在更具体的方向里，试试下面的关键词：`
  }
  return `暂时没有直接匹配”${userMessage}”的标准。建议换一个更具体的关键词，或者告诉我您想查的行业领域。`
}

function buildGenericSuggestions(keywords: string[]): string[] {
  const seed = keywords.find(keyword => keyword.trim().length >= 2)?.trim()
  if (!seed) {
    return ['安全', '检测', '试验方法', '质量', '包装']
  }
  // 用 seed 本身作为推荐词（短核心词命中率高），再加几个通用方向
  return [seed, '安全', '检测', '试验方法', '包装']
}

/**
 * 截断 scope：按句号切（中文「。」/ 英文「.」），保证 ≤300 字；首句 >300 则硬截加「…」
 */
function truncateScope(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  // 按句号切分，保留句号本身
  const sentences = text.split(/(?<=[。.])/)
  let result = ''
  for (const s of sentences) {
    if ((result + s).length > 300) break
    result += s
  }
  if (!result) {
    // 第一句就超过 300 字
    return text.slice(0, 300) + '…'
  }
  return result.trim()
}

/**
 * 为 LLM 格式化搜索上下文
 */
function formatSearchContext(hits: SearchHit[], totalCount?: number): string {
  if (hits.length === 0) return '未找到相关标准。'
  const actualTotal = totalCount ?? hits.length
  const showCount = Math.min(hits.length, 5)
  const header = actualTotal > showCount
    ? `共找到 ${actualTotal} 条相关标准，以下为前 ${showCount} 条元数据（其余省略以控制 token）：\n`
    : `共找到 ${actualTotal} 条相关标准：\n`
  const body = hits
    .slice(0, 5)
    .map((h, i) => {
      const scope = h.scope ? truncateScope(h.scope) : ''
      const parts = [
        `${i + 1}. 标准号: ${h.code || '未知'}`,
        `标题: ${h.name || '未知'}`,
        h.status ? `状态: ${h.status}` : null,
        h.impl_date ? `实施日期: ${h.impl_date}` : null,
        scope ? `适用范围: ${scope}` : null,
      ]
      return parts.filter(Boolean).join(' | ')
    })
    .join('\n')
  return header + body
}

const SEARCH_SUMMARY_PROMPT = `你是"标准小智"，专业标准化服务助手。用户正在检索标准。

以下是从标准元数据库检索到的结果（仅包含元数据，非标准正文）：
{context}

请用 1-3 句话简要回答用户的问题。要求：
- 先给结论（找到多少条、最相关的是什么）
- 若用户问题包含「解读」「适用范围」「核心要求」「主要内容」「适用于哪些场景」「用在哪里」「干什么用的」等意图词，必须优先引用 Context 中的「适用范围」字段作为回答核心内容，用一两句话概括后再补其他元数据
- 不要逐条列出标准列表（系统会单独展示卡片）
- 不要输出标准正文内容、具体条款或技术参数
- 如果没有结果，说"未找到相关标准"并建议换关键词
- 保持简洁

${SYSTEM_GUARDRAIL}`

/**
 * 流式生成搜索结论句（1-3 句）
 */
export async function* streamSearchSummary(
  hits: SearchHit[],
  userMessage: string,
  totalCount?: number,
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): AsyncGenerator<string> {
  const context = formatSearchContext(hits, totalCount)
  const systemPrompt = SEARCH_SUMMARY_PROMPT.replace('{context}', context)

  yield* callLLMStream([
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: userMessage },
  ], { maxTokens: 300 })
}

const RELATED_SUMMARY_PROMPT = `你是"标准小智"，专业标准化服务助手。用户正在检索标准。

以下是从标准元数据库检索到的相关结果（注意：这些结果与用户问题相关，但并非精确匹配，仅供参考）：
{context}

请用 1-3 句话引导用户参考这些相关标准。要求：
- 开头明确说明这是"相关标准"而非"精确匹配结果"，避免用户误以为找到了确切答案
- 简要说明下面列出的标准大致涉及哪些方向或适用于哪些场景（优先引用 Context 中的「适用范围」字段）
- 语气引导性，例如"以下标准与您的问题相关，其中 XX 标准适用于……，可供参考"
- 不要逐条列出标准列表（系统会单独展示卡片）
- 不要输出标准正文内容、具体条款或技术参数
- 保持简洁

${SYSTEM_GUARDRAIL}`

/**
 * 流式生成 related 状态引导总结（1-3 句，强调"相关非精确"）
 */
export async function* streamRelatedSummary(
  hits: SearchHit[],
  userMessage: string,
  totalCount?: number,
  history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): AsyncGenerator<string> {
  const context = formatSearchContext(hits, totalCount)
  const systemPrompt = RELATED_SUMMARY_PROMPT.replace('{context}', context)

  yield* callLLMStream([
    { role: 'system', content: systemPrompt },
    ...(history || []),
    { role: 'user', content: userMessage },
  ], { maxTokens: 200 })
}

