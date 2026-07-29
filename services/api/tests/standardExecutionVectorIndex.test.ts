import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import type { QdrantClient, VectorCollection, VectorPoint, VectorSearchHit } from '../src/standard-execution/qdrantClient.js'
import { prisma } from '../src/db.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { __setVectorIndexDepsForTest } from '../src/vectorIndexWorker.js'
import { cleanStandardExecutionData } from './seClean.js'
import { createUser, getTestToken } from './factory.js'

class MemoryQdrantClient implements QdrantClient {
  collections = new Set<VectorCollection>()
  points = new Map<VectorCollection, Map<string, VectorPoint>>()

  async ensureCollections() {
    for (const name of ['standard_clauses', 'requirement_points', 'execution_records'] as VectorCollection[]) {
      this.collections.add(name)
      if (!this.points.has(name)) this.points.set(name, new Map())
    }
  }

  async upsertPoints(collection: VectorCollection, points: VectorPoint[]) {
    const rows = this.points.get(collection) ?? new Map<string, VectorPoint>()
    for (const point of points) rows.set(String(point.id), point)
    this.points.set(collection, rows)
  }

  async search(): Promise<VectorSearchHit[]> {
    return []
  }

  async count(collection: VectorCollection) {
    return this.points.get(collection)?.size ?? 0
  }

  totalPoints() {
    return Array.from(this.points.values()).reduce((sum, rows) => sum + rows.size, 0)
  }
}

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await prisma.appUser.deleteMany()
  __setVectorIndexDepsForTest(null)
})

async function seedVectorData() {
  const admin = await createUser({ role: 'admin' })
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'DEFAULT',
      title: '安保服务规范',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'T/TEST 1',
      rawText: [
        '4.1 门岗值守',
        '门岗值守人员应核验来访人员身份并登记进出时间。',
        '4.2 巡逻检查',
        '巡逻人员应每日按路线巡查并保存巡更记录。',
      ].join('\n'),
      createdBy: admin.id,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'DEFAULT',
      sourceId: source.id,
      clauseNo: '4.1',
      title: '门岗登记',
      requirementText: '门岗值守人员应核验来访人员身份并登记进出时间。',
      status: 'ACTIVE',
      createdBy: admin.id,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'DEFAULT',
      requirementId: requirement.id,
      title: '门岗登记抽查',
      status: 'COMPLETED',
      createdBy: admin.id,
    },
  })
  const submission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId: 'DEFAULT',
      taskId: task.id,
      assigneeId: admin.id,
      submitText: '已上传来访登记台账。',
      status: 'APPROVED',
    },
  })
  await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId: 'DEFAULT',
      sourceId: source.id,
      requirementId: requirement.id,
      taskId: task.id,
      submissionId: submission.id,
      assigneeId: admin.id,
      title: '门岗登记台账',
      summary: '6 月门岗来访登记抽查记录。',
      status: 'VALID',
    },
  })
  return { admin }
}

describe('POST /api/admin/standard-execution/vector-index/run-once', () => {
  it('重复运行索引 worker 不重复 upsert 点位', async () => {
    const { admin } = await seedVectorData()
    const token = getTestToken(admin.id, 'admin')
    const memoryQdrant = new MemoryQdrantClient()
    __setVectorIndexDepsForTest({
      prisma,
      qdrantClient: memoryQdrant,
      embedClient: {
        vectorSize: 8,
        embedTexts: async (texts) => texts.map((text) => Array.from({ length: 8 }, (_, index) => (text.length + index) / 100)),
      },
    })

    const first = await request(app)
      .post('/api/admin/standard-execution/vector-index/run-once')
      .set('Authorization', `Bearer ${token}`)
      .send({ limit: 50 })
    expect(first.status).toBe(200)
    expect(first.body.data.indexed).toBe(4)
    expect(first.body.data.failed).toBe(0)
    expect(memoryQdrant.totalPoints()).toBe(4)

    const second = await request(app)
      .post('/api/admin/standard-execution/vector-index/run-once')
      .set('Authorization', `Bearer ${token}`)
      .send({ limit: 50 })
    expect(second.status).toBe(200)
    expect(second.body.data.indexed).toBe(0)
    expect(second.body.data.skipped).toBe(4)
    expect(memoryQdrant.totalPoints()).toBe(4)
  })

  it('非 admin 不能触发索引', async () => {
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .post('/api/admin/standard-execution/vector-index/run-once')
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
      .send({})
    expect(res.status).toBe(403)
  })
})
