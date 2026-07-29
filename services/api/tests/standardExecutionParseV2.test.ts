import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { EmbedClient } from '../src/standard-execution/embedClient.js'
import type { QdrantClient, VectorCollection, VectorSearchHit } from '../src/standard-execution/qdrantClient.js'
import type { SearchClient, SearchSnippet } from '../src/standard-execution/searchClient.js'
import { prisma } from '../src/db.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { __setParseV2RouteDepsForTest } from '../src/standard-execution/parseV2Routes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await prisma.appUser.deleteMany()
  __setParseV2RouteDepsForTest(null)
})

afterEach(() => {
  __setParseV2RouteDepsForTest(null)
})

function okAiResponse(clauseNo = '4.1', overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    requirements: [
      {
        clauseNo,
        title: clauseNo === '4.2' ? '巡逻记录留存' : '门岗来访登记',
        requirementText: clauseNo === '4.2'
          ? '巡逻人员应每日按路线巡查并保存巡更记录。'
          : '门岗值守人员应核验来访人员身份并登记进出时间。',
        executionDescription: clauseNo === '4.2'
          ? '每日核查巡逻路线完成情况，并上传巡更记录。'
          : '核验来访人员身份，登记姓名、单位、事由和进出时间。',
        recommendedTaskType: 'INSPECTION_FILL',
        suggestedDepartment: '安保部',
        suggestedFrequency: clauseNo === '4.2' ? '每日' : '每次来访',
        submitRequirement: clauseNo === '4.2' ? '上传巡更记录' : '上传来访登记台账',
        requiredMaterials: clauseNo === '4.2' ? ['巡更记录'] : ['来访登记台账'],
        confidence: 0.86,
        reasoning: '原文动作明确，并参考了相似历史控制点和互联网摘要。',
        sourceChunks: clauseNo === '4.2'
          ? ['chunk:1', 'execution_records:record-1', 'search:0']
          : ['chunk:0', 'requirement_points:req-1', 'search:0'],
        needsReview: false,
        ...overrides,
      },
    ],
    disclaimer: '仅供参考，最终以人工审核为准',
  })
}

function makeEmbedClient(): EmbedClient {
  return {
    vectorSize: 8,
    embedTexts: vi.fn(async (texts: string[]) => texts.map((text) => (
      Array.from({ length: 8 }, (_, index) => (text.length + index) / 100)
    ))),
  }
}

function makeQdrantClient(searchImpl?: QdrantClient['search']): Pick<QdrantClient, 'search'> {
  return {
    search: vi.fn(searchImpl ?? (async (collection: VectorCollection): Promise<VectorSearchHit[]> => {
      if (collection === 'requirement_points') {
        return [{
          id: 'req-1',
          score: 0.91,
          payload: {
            title: '门岗登记历史控制点',
            requirementText: '门岗人员应核验来访身份并保留登记台账。',
          },
        }]
      }
      if (collection === 'execution_records') {
        return [{
          id: 'record-1',
          score: 0.82,
          payload: {
            title: '巡更记录样例',
            summary: '巡逻队每日上传巡更记录并由主管复核。',
          },
        }]
      }
      return [{
        id: 'clause-1',
        score: 0.79,
        payload: {
          title: '相似门岗条款',
          chunkText: '门岗值守人员应核验身份并登记进出时间。',
        },
      }]
    })),
  }
}

function makeSearchClient(searchImpl?: SearchClient['search']): SearchClient {
  return {
    search: vi.fn(searchImpl ?? (async (): Promise<SearchSnippet[]> => [{
      title: '来访登记监管提示',
      url: 'https://example.test/security-register',
      content: '监管检查通常关注来访登记完整性、进出时间和台账留存。',
      provider: 'tavily',
    }])),
  }
}

async function makeAdminAndSource(rawText?: string) {
  const admin = await createUser({ role: 'admin' })
  const token = getTestToken(admin.id, 'admin')
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'DEFAULT',
      title: '安保服务规范',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'T/SEC 1-2026',
      rawText: rawText ?? [
        '4.1 门岗值守',
        '门岗值守人员应核验来访人员身份并登记进出时间。',
        '4.2 巡逻检查',
        '巡逻人员应每日按路线巡查并保存巡更记录。',
      ].join('\n'),
      createdBy: admin.id,
    },
  })
  return { admin, token, source }
}

async function waitForJob(token: string, jobId: string) {
  for (let i = 0; i < 60; i++) {
    const res = await request(app)
      .get(`/api/admin/standard-execution/parse-jobs/${jobId}`)
      .set('Authorization', `Bearer ${token}`)
    if (res.body.status === 'DONE' || res.body.status === 'FAILED') return res
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`parse job ${jobId} did not finish`)
}

describe('POST /api/admin/standard-execution/sources/:id/parse-v2', () => {
  it('异步解析返回 Job result，注入 RAG/搜索上下文且不自动写入 Requirement', async () => {
    const { token, source } = await makeAdminAndSource()
    const capturedPrompts: string[] = []
    const qdrantClient = makeQdrantClient()
    const searchClient = makeSearchClient()
    __setParseV2RouteDepsForTest({
      embedClient: makeEmbedClient(),
      qdrantClient,
      searchClient,
      aiCaller: async (prompt) => {
        capturedPrompts.push(prompt)
        return okAiResponse(prompt.includes('clauseNo=4.2') ? '4.2' : '4.1')
      },
    })

    const create = await request(app)
      .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(create.status).toBe(202)
    expect(create.body.jobId).toBeTruthy()

    const done = await waitForJob(token, create.body.jobId)
    expect(done.status).toBe(200)
    expect(done.body.status).toBe('DONE')
    expect(done.body.progress).toBe(100)
    expect(done.body.result.version).toBe('v2')
    expect(done.body.result.requirements[0]).toMatchObject({
      confidence: 0.86,
      reasoning: '原文动作明确，并参考了相似历史控制点和互联网摘要。',
    })
    expect(done.body.result.metadata.retrieval.requirementPoints).toBeGreaterThan(0)
    expect(done.body.result.metadata.retrieval.internetSnippets).toBeGreaterThan(0)
    expect(done.body.result.chunks[0].similarRequirements[0].id).toBe('requirement_points:req-1')

    expect(capturedPrompts.join('\n')).toContain('相似历史控制点')
    expect(capturedPrompts.join('\n')).toContain('requirement_points:req-1')
    expect(capturedPrompts.join('\n')).toContain('来访登记监管提示')
    expect(qdrantClient.search).toHaveBeenCalledWith('standard_clauses', expect.any(Array), expect.objectContaining({ topK: 3 }))
    expect(qdrantClient.search).toHaveBeenCalledWith('requirement_points', expect.any(Array), expect.objectContaining({ topK: 5 }))
    expect(searchClient.search).toHaveBeenCalledWith(expect.stringContaining('T/SEC 1-2026'), { topK: 3 })

    const requirementCount = await prisma.standardExecutionRequirement.count({ where: { sourceId: source.id } })
    expect(requirementCount).toBe(0)
  })

  it('单条重新生成只复用 Job 缓存上下文，不重新调用 Qdrant / 搜索', async () => {
    const { token, source } = await makeAdminAndSource()
    const qdrantClient = makeQdrantClient()
    const searchClient = makeSearchClient()
    const aiCaller = vi.fn(async (prompt: string) => {
      if (aiCaller.mock.calls.length >= 3) {
        return okAiResponse('4.1', {
          title: '门岗登记复核',
          reasoning: '基于缓存上下文重新合成。',
        })
      }
      return okAiResponse(prompt.includes('clauseNo=4.2') ? '4.2' : '4.1')
    })
    __setParseV2RouteDepsForTest({
      embedClient: makeEmbedClient(),
      qdrantClient,
      searchClient,
      aiCaller,
    })

    const create = await request(app)
      .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const done = await waitForJob(token, create.body.jobId)
    expect(done.body.status).toBe('DONE')
    const qdrantCalls = vi.mocked(qdrantClient.search).mock.calls.length
    const searchCalls = vi.mocked(searchClient.search).mock.calls.length

    const regenerated = await request(app)
      .post(`/api/admin/standard-execution/parse-jobs/${create.body.jobId}/requirements/0/regenerate`)
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(regenerated.status).toBe(200)
    expect(regenerated.body.data.title).toBe('门岗登记复核')
    expect(regenerated.body.result.requirements[0].title).toBe('门岗登记复核')
    expect(vi.mocked(qdrantClient.search).mock.calls.length).toBe(qdrantCalls)
    expect(vi.mocked(searchClient.search).mock.calls.length).toBe(searchCalls)
    expect(aiCaller).toHaveBeenCalledTimes(3)
  })

  it('同一 source 的活跃任务重复提交时复用已有 jobId', async () => {
    const { token, source } = await makeAdminAndSource()
    let resolveAi: (value: string) => void = () => undefined
    const pendingAi = new Promise<string>((resolve) => { resolveAi = resolve })
    const aiCaller = vi.fn(async () => pendingAi)
    __setParseV2RouteDepsForTest({
      embedClient: makeEmbedClient(),
      qdrantClient: makeQdrantClient(),
      searchClient: makeSearchClient(),
      aiCaller,
    })

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
        .set('Authorization', `Bearer ${token}`)
        .send({}),
      request(app)
        .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
        .set('Authorization', `Bearer ${token}`)
        .send({}),
    ])

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    expect(second.body.jobId).toBe(first.body.jobId)
    expect([first.body.reused, second.body.reused].filter(Boolean)).toHaveLength(1)

    resolveAi(okAiResponse())
    const done = await waitForJob(token, first.body.jobId)
    expect(done.body.status).toBe('DONE')
    expect(aiCaller).toHaveBeenCalledTimes(2)
  })

  it('Qdrant 和互联网检索不可用时静默降级并完成解析', async () => {
    const { token, source } = await makeAdminAndSource()
    __setParseV2RouteDepsForTest({
      embedClient: makeEmbedClient(),
      qdrantClient: makeQdrantClient(async () => {
        throw new Error('qdrant down')
      }),
      searchClient: makeSearchClient(async () => {
        throw new Error('search down')
      }),
      aiCaller: async (prompt) => okAiResponse(prompt.includes('clauseNo=4.2') ? '4.2' : '4.1'),
    })

    const create = await request(app)
      .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    const done = await waitForJob(token, create.body.jobId)

    expect(done.body.status).toBe('DONE')
    expect(done.body.result.requirements.length).toBeGreaterThan(0)
    expect(done.body.result.metadata.degradedSteps).toEqual(expect.arrayContaining([
      'RAG_STANDARD_CLAUSES_UNAVAILABLE',
      'RAG_REQUIREMENT_POINTS_UNAVAILABLE',
      'RAG_EXECUTION_RECORDS_UNAVAILABLE',
      'SEARCH_UNAVAILABLE',
    ]))
  })

  it('非 admin 不能启动 parse-v2', async () => {
    const { source } = await makeAdminAndSource()
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .post(`/api/admin/standard-execution/sources/${source.id}/parse-v2`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
      .send({})
    expect(res.status).toBe(403)
  })
})
