/**
 * 标准编号验证 — Phase C-2 / 方案 §3.3
 *
 * 用途：LLM 生成的标准框架文本里常含若干「规范性引用文件」编号
 * （如 GB/T 1.1-2020、GB 50011-2010、HJ 25.1-2019 等）。
 * 起草人最容易踩的坑就是 LLM 编造编号。验证器从 reply 抽出所有编号，
 * 并发查询 pyapi /api/v1/search 判定实存性，结果通过 SSE 推给前端。
 *
 * 设计要点：
 *  - 抽取容错：支持 GB/GB/T/GBT/GB-T、空格 0~多、连字符变体。
 *  - normalize：统一成 pyapi 期望格式 `家族 编号-年份`（如 `GB/T 1.1-2020`）。
 *  - 并发上限：默认 6，避免压垮 pyapi。
 *  - 单次 verify timeout：5s。
 *  - 模块级 LRU 缓存：5 分钟，命中过的编号不重复打 pyapi（生成期间常有重复引用）。
 *
 * 不在范围：
 *  - 不查行业标准是否「现行/废止」状态相符 — pyapi 已返回 status 字段，
 *    我们把它透传出去由前端展示，但不在本模块对状态做策略判定。
 *  - 不修改 reply 内容（不做内联标注），只发独立 SSE event。
 */

const PYAPI_BASE = process.env.PYAPI_BASE_URL || 'http://localhost:8082'
const VERIFY_TIMEOUT_MS = 5000
const DEFAULT_CONCURRENCY = 6
const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { result: VerifiedItem | UnverifiedItem; expiresAt: number }
const cache = new Map<string, CacheEntry>()

export interface VerifiedItem {
  code: string
  title: string
  status: string
  implDate?: string
}

export interface UnverifiedItem {
  code: string
  reason: 'not_found' | 'timeout' | 'error'
}

export interface VerifiedReferences {
  verified: VerifiedItem[]
  unverified: UnverifiedItem[]
}

/**
 * 抽取文本里所有可能的标准编号。
 * 覆盖：GB / GB/T / GBZ / HJ / YY / YY/T / DB31/T / JJG / JT/T / JC/T 等常见标准家族。
 * 返回保持首次出现顺序，去重。
 */
export function extractStandardCodes(text: string): string[] {
  if (!text) return []
  // 标准家族字母：1~6 个大写英文（含 / 后再可加 1~2 字母如 /T /Z）。
  // 编号主体：纯数字、点、连字符。
  // 年份：可选，4 位数字（1949..2099），与主体用连字符或空格分隔。
  // 整体形式示例：
  //   GB/T 1.1-2020 / GB 50011-2010 / HJ 25.1 / DB31/T 1234-2020 / JJG 30-2018 / JC/T 547-2020
  const FAMILY = '[A-Z]{1,4}(?:\\/[A-Z]{1,2})?'
  const CODE_BODY = '\\d{1,5}(?:\\.\\d{1,4})?'
  const YEAR = '(?:[-\\s](?:19[5-9]\\d|20\\d{2}))?'
  // 必须前面是「非字母」或开头；后面是「非数字字母」或结尾 — 避免命中 ABC123XYZ
  const re = new RegExp(
    `(?<![A-Za-z0-9])(${FAMILY})\\s*[-\\s]?\\s*(${CODE_BODY})${YEAR}(?![A-Za-z0-9])`,
    'g',
  )
  const seen = new Set<string>()
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const normalized = normalizeCode(raw)
    if (!normalized) continue
    // 过滤纯英文家族（如 ISO/IEC 单独出现）— 必须有数字
    if (!/\d/.test(normalized)) continue
    // 过滤被 [待核实：xxx] 包裹（占位符）的编号
    const before = text.slice(Math.max(0, (m.index || 0) - 6), m.index)
    if (/\[待核实[:：]\s*$/.test(before)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * 把 `GB-T1.1-2020` / `gb/t  1.1 - 2020` / `GBT 1.1-2020`
 * 统一成 pyapi 期望的 `GB/T 1.1-2020` 形式：家族 + 一个空格 + 主体 + （可选 -年份）。
 * 失败返回空字符串。
 */
export function normalizeCode(raw: string): string {
  if (!raw) return ''
  const cleaned = raw.trim().toUpperCase().replace(/\s+/g, ' ')
  // 家族 = 1~4 个字母，后缀（可选）= /T /Z /F 等单字母，分隔符 /-，主体 = 数字[.数字]，年份（可选）4 位
  const m = cleaned.match(
    /^([A-Z]{1,4})(?:[\/\-]([A-Z]{1,2}))?\s*[-\s]?\s*(\d[\d\.]*)(?:\s*[-\s]\s*(\d{4}))?/,
  )
  if (!m) return ''
  let famHead = m[1]
  let famSuffix = m[2] || ''
  // 处理无分隔符的合写：GBT / GBZ / YYT / HJT / JCT … → 拆 family + 后缀
  if (!famSuffix && famHead.length >= 3 && /[TZF]$/.test(famHead)) {
    famSuffix = famHead.slice(-1)
    famHead = famHead.slice(0, -1)
  }
  const family = famSuffix ? `${famHead}/${famSuffix}` : famHead
  const body = m[3]
  const year = m[4]
  return year ? `${family} ${body}-${year}` : `${family} ${body}`
}

interface PyapiSearchResult {
  results?: Array<{
    code?: string
    name?: string
    status?: string
    impl_date?: string
  }>
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * 验证单条编号是否真实存在。返回 VerifiedItem（找到且 code 完全匹配）
 * 或 UnverifiedItem（pyapi 报错 / 超时 / 找到但 code 不严格相等）。
 */
export async function verifyStandardCode(code: string): Promise<VerifiedItem | UnverifiedItem> {
  const normalized = normalizeCode(code) || code
  const hit = cache.get(normalized)
  if (hit && hit.expiresAt > Date.now()) return hit.result

  const url = `${PYAPI_BASE}/api/v1/search?q=${encodeURIComponent(normalized)}&limit=3`
  let result: VerifiedItem | UnverifiedItem
  try {
    const r = await fetchWithTimeout(url, VERIFY_TIMEOUT_MS)
    if (!r.ok) {
      result = { code: normalized, reason: 'error' }
    } else {
      const data = (await r.json()) as PyapiSearchResult
      const exact = (data.results || []).find((x) => x.code === normalized)
      if (exact && exact.name) {
        result = {
          code: normalized,
          title: exact.name,
          status: exact.status || 'unknown',
          implDate: exact.impl_date || undefined,
        }
      } else {
        result = { code: normalized, reason: 'not_found' }
      }
    }
  } catch (err: any) {
    const reason: UnverifiedItem['reason'] =
      err?.name === 'AbortError' ? 'timeout' : 'error'
    result = { code: normalized, reason }
  }

  cache.set(normalized, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}

/**
 * 并发验证一批编号。concurrency 默认 6。
 * 输出按输入顺序，verified / unverified 两个数组。
 */
export async function verifyStandardCodes(
  codes: string[],
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<VerifiedReferences> {
  if (codes.length === 0) return { verified: [], unverified: [] }

  const queue = [...codes]
  const results: Array<VerifiedItem | UnverifiedItem> = new Array(codes.length)
  const indexOf = new Map<string, number>()
  codes.forEach((c, i) => indexOf.set(c, i))

  async function worker() {
    while (queue.length > 0) {
      const code = queue.shift()
      if (!code) return
      const r = await verifyStandardCode(code)
      const idx = indexOf.get(code)
      if (idx !== undefined) results[idx] = r
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, codes.length) }, () => worker())
  await Promise.all(workers)

  const verified: VerifiedItem[] = []
  const unverified: UnverifiedItem[] = []
  for (const r of results) {
    if (!r) continue
    if ('title' in r) verified.push(r)
    else unverified.push(r)
  }
  return { verified, unverified }
}

// 仅测试用：重置缓存
export function __clearReferenceValidatorCache() {
  cache.clear()
}
