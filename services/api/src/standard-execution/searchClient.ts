export type SearchProvider = 'tavily' | 'serper'

export interface SearchSnippet {
  title: string
  url: string
  content: string
  provider: SearchProvider
}

export interface SearchClient {
  search(query: string, options?: { topK?: number }): Promise<SearchSnippet[]>
}

export class SearchNotConfiguredError extends Error {
  code = 'SEARCH_NOT_CONFIGURED'
  constructor() {
    super('互联网检索服务未配置')
  }
}

export class SearchCallFailedError extends Error {
  code = 'SEARCH_CALL_FAILED'
  constructor(public reason: string) {
    super(`互联网检索调用失败：${reason}`)
  }
}

function isSearchEnabled(): boolean {
  const value = String(process.env.SEARCH_ENABLED ?? 'true').toLowerCase()
  return value !== '0' && value !== 'false' && value !== 'off'
}

function getSearchProvider(): SearchProvider {
  const provider = String(process.env.SEARCH_API_PROVIDER || 'tavily').toLowerCase()
  return provider === 'serper' ? 'serper' : 'tavily'
}

function timeoutMs(): number {
  const value = Number(process.env.SEARCH_TIMEOUT_MS || 10_000)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10_000
}

function trimSnippet(text: unknown, maxLen = 500): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs())
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function tavilySearch(query: string, apiKey: string, topK: number): Promise<SearchSnippet[]> {
  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      max_results: topK,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${body.slice(0, 200)}`)
  }
  const json = await res.json() as {
    results?: Array<{ title?: string; url?: string; content?: string }>
  }
  return (json.results ?? []).slice(0, topK).map((item) => ({
    title: trimSnippet(item.title, 120) || '互联网检索结果',
    url: String(item.url || ''),
    content: trimSnippet(item.content),
    provider: 'tavily' as const,
  })).filter((item) => item.content || item.url)
}

async function serperSearch(query: string, apiKey: string, topK: number): Promise<SearchSnippet[]> {
  const res = await fetchWithTimeout('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      q: query,
      gl: 'cn',
      hl: 'zh-cn',
      num: topK,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${body.slice(0, 200)}`)
  }
  const json = await res.json() as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>
  }
  return (json.organic ?? []).slice(0, topK).map((item) => ({
    title: trimSnippet(item.title, 120) || '互联网检索结果',
    url: String(item.link || ''),
    content: trimSnippet(item.snippet),
    provider: 'serper' as const,
  })).filter((item) => item.content || item.url)
}

export function createSearchClient(): SearchClient {
  return {
    search: internetSearch,
  }
}

export async function internetSearch(query: string, options: { topK?: number } = {}): Promise<SearchSnippet[]> {
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim()
  if (!cleanQuery || !isSearchEnabled()) return []
  const apiKey = process.env.SEARCH_API_KEY
  if (!apiKey) throw new SearchNotConfiguredError()
  const topK = Math.min(Math.max(options.topK ?? 3, 1), 5)
  const provider = getSearchProvider()
  try {
    return provider === 'serper'
      ? await serperSearch(cleanQuery, apiKey, topK)
      : await tavilySearch(cleanQuery, apiKey, topK)
  } catch (err) {
    if (err instanceof SearchNotConfiguredError) throw err
    throw new SearchCallFailedError(err instanceof Error ? err.message : 'unknown')
  }
}
