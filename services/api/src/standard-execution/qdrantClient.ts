export const VECTOR_COLLECTIONS = ['standard_clauses', 'requirement_points', 'execution_records'] as const
export type VectorCollection = typeof VECTOR_COLLECTIONS[number]

export type VectorPoint = {
  id: string
  vector: number[]
  payload: Record<string, unknown>
}

export type VectorSearchHit = {
  id: string | number
  score: number
  payload?: Record<string, unknown>
}

export type QdrantClient = {
  ensureCollections(vectorSize: number): Promise<void>
  upsertPoints(collection: VectorCollection, points: VectorPoint[]): Promise<void>
  search(collection: VectorCollection, vector: number[], options: {
    enterpriseId: string
    topK: number
    filter?: Record<string, unknown>
  }): Promise<VectorSearchHit[]>
  count(collection: VectorCollection, enterpriseId?: string): Promise<number>
}

function qdrantUrl(): string {
  return (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/+$/, '')
}

async function requestQdrant<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${qdrantUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Qdrant ${res.status}: ${body.slice(0, 300)}`)
  }
  return await res.json() as T
}

async function qdrantCollectionExists(collection: VectorCollection): Promise<boolean> {
  const res = await fetch(`${qdrantUrl()}/collections/${collection}`)
  if (res.status === 404) return false
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Qdrant ${res.status}: ${body.slice(0, 300)}`)
  }
  return true
}

function enterpriseFilter(enterpriseId: string): Record<string, unknown> {
  return {
    should: [
      { key: 'enterpriseId', match: { value: enterpriseId } },
      { key: 'enterpriseId', match: { value: 'DEFAULT' } },
    ],
  }
}

export function createQdrantClient(): QdrantClient {
  return {
    async ensureCollections(vectorSize: number) {
      for (const collection of VECTOR_COLLECTIONS) {
        if (await qdrantCollectionExists(collection)) continue
        await requestQdrant(`/collections/${collection}`, {
          method: 'PUT',
          body: JSON.stringify({
            vectors: {
              size: vectorSize,
              distance: 'Cosine',
            },
          }),
        })
      }
    },

    async upsertPoints(collection: VectorCollection, points: VectorPoint[]) {
      if (points.length === 0) return
      await requestQdrant(`/collections/${collection}/points?wait=true`, {
        method: 'PUT',
        body: JSON.stringify({ points }),
      })
    },

    async search(collection: VectorCollection, vector: number[], options) {
      const baseFilter = enterpriseFilter(options.enterpriseId)
      const filter = options.filter
        ? { ...baseFilter, must: [options.filter] }
        : baseFilter
      const json = await requestQdrant<{ result?: VectorSearchHit[] }>(`/collections/${collection}/points/search`, {
        method: 'POST',
        body: JSON.stringify({
          vector,
          limit: options.topK,
          with_payload: true,
          filter,
        }),
      })
      return json.result ?? []
    },

    async count(collection: VectorCollection, enterpriseId?: string) {
      const json = await requestQdrant<{ result?: { count?: number } }>(`/collections/${collection}/points/count`, {
        method: 'POST',
        body: JSON.stringify({
          exact: true,
          filter: enterpriseId ? enterpriseFilter(enterpriseId) : undefined,
        }),
      })
      return json.result?.count ?? 0
    },
  }
}
