import crypto from 'crypto'

export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small'
export const DEFAULT_EMBED_API_URL = 'https://api.openai.com/v1/embeddings'
export const DEFAULT_EMBED_VECTOR_SIZE = 1536
export const MAX_EMBED_BATCH_SIZE = 100

export class EmbedNotConfiguredError extends Error {
  code = 'EMBED_NOT_CONFIGURED'
  constructor() {
    super('Embedding 服务未配置')
  }
}

export class EmbedCallFailedError extends Error {
  code = 'EMBED_CALL_FAILED'
  constructor(public reason: string) {
    super(`Embedding 调用失败：${reason}`)
  }
}

export type EmbedClient = {
  vectorSize: number
  embedTexts(texts: string[]): Promise<number[][]>
}

function getVectorSize(): number {
  const value = Number(process.env.EMBED_VECTOR_SIZE || DEFAULT_EMBED_VECTOR_SIZE)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_EMBED_VECTOR_SIZE
}

function isLocalEmbedMockEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' &&
    (process.env.EMBED_MOCK === '1' || process.env.SE_AI_MOCK === '1')
}

function buildMockVector(text: string, size: number): number[] {
  const vector: number[] = []
  let seed = crypto.createHash('sha256').update(text || 'empty').digest()
  while (vector.length < size) {
    for (const byte of seed) {
      vector.push((byte / 127.5) - 1)
      if (vector.length >= size) break
    }
    seed = crypto.createHash('sha256').update(seed).digest()
  }
  return vector
}

export function createEmbedClient(): EmbedClient {
  return {
    vectorSize: getVectorSize(),
    embedTexts,
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length > MAX_EMBED_BATCH_SIZE) {
    throw new EmbedCallFailedError(`单批 embedding 数量超过 ${MAX_EMBED_BATCH_SIZE}`)
  }
  const cleanTexts = texts.map((text) => String(text || '').trim())
  const vectorSize = getVectorSize()
  if (cleanTexts.length === 0) return []

  if (isLocalEmbedMockEnabled()) {
    return cleanTexts.map((text) => buildMockVector(text, vectorSize))
  }

  const apiKey = process.env.EMBED_API_KEY
  if (!apiKey) throw new EmbedNotConfiguredError()

  const apiUrl = process.env.EMBED_API_URL || DEFAULT_EMBED_API_URL
  const model = process.env.EMBED_MODEL || DEFAULT_EMBED_MODEL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(process.env.EMBED_TIMEOUT_MS || 30_000))
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: cleanTexts }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`${res.status} ${body.slice(0, 200)}`)
    }
    const json = await res.json() as { data?: Array<{ embedding?: number[] }> }
    const vectors = json.data?.map((item) => item.embedding ?? []) ?? []
    if (vectors.length !== cleanTexts.length || vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
      throw new Error('embedding 响应结构异常')
    }
    return vectors
  } catch (err) {
    if (err instanceof EmbedNotConfiguredError) throw err
    throw new EmbedCallFailedError(err instanceof Error ? err.message : 'unknown')
  } finally {
    clearTimeout(timer)
  }
}
