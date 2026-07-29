/**
 * 企业版 /api/enterprise/standard-execution/requirements/auto-generate — 端到端测试
 *
 * 覆盖：
 *  - dryRun=true  → 返回 drafts 但不写库
 *  - dryRun=false → 写库 createdCount > 0
 *  - sourceId 不属于本企业 → 400
 *  - 普通 user 无 enterpriseId → 403
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

let currentAiCaller: (prompt: string) => Promise<string> = async () => '[]'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app, (prompt) => currentAiCaller(prompt))
})

let employeeToken: string
let plainToken: string
let entASourceId: string
let entBSourceId: string

const RAWTEXT = `5.1 外观应平整无划痕。
5.2 尺寸偏差不应大于 0.5mm。
5.3 包装应清洁完好。`

beforeEach(async () => {
  await cleanStandardExecutionData()
  currentAiCaller = async () => '[]'

  for (const id of ['DEFAULT', 'ENT_A', 'ENT_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }

  const emp = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: emp.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'MANAGER' },
  })
  employeeToken = getTestToken(emp.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  const srcA = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_A',
      title: 'A 企业标准',
      sourceType: 'PRODUCT_STANDARD',
      status: 'ACTIVE',
      rawText: RAWTEXT,
      createdBy: emp.id,
    },
  })
  entASourceId = srcA.id

  const srcB = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_B',
      title: 'B 企业标准',
      sourceType: 'PRODUCT_STANDARD',
      status: 'ACTIVE',
      rawText: RAWTEXT,
      createdBy: 'someuser',
    },
  })
  entBSourceId = srcB.id
})

describe('POST /api/enterprise/standard-execution/requirements/auto-generate', () => {
  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .send({ sourceId: entASourceId, parseMode: 'RULE', dryRun: true })
    expect(res.status).toBe(401)
  })

  it('dryRun=true → 200 + drafts ≥ 1 + 不写库', async () => {
    const before = await prisma.standardExecutionRequirement.count({ where: { enterpriseId: 'ENT_A' } })
    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ sourceId: entASourceId, parseMode: 'RULE', dryRun: true })
    expect(res.status).toBe(200)
    expect(res.body.data.dryRun).toBe(true)
    expect(res.body.data.drafts.length).toBeGreaterThanOrEqual(1)
    expect(res.body.data.createdCount).toBe(0)
    const after = await prisma.standardExecutionRequirement.count({ where: { enterpriseId: 'ENT_A' } })
    expect(after).toBe(before)
  })

  it('dryRun=false → 200 + createdCount ≥ 1 + 落库且 enterpriseId=ENT_A', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ sourceId: entASourceId, parseMode: 'RULE', dryRun: false })
    expect(res.status).toBe(200)
    expect(res.body.data.createdCount).toBeGreaterThanOrEqual(1)
    const rows = await prisma.standardExecutionRequirement.findMany({ where: { sourceId: entASourceId } })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.every((r) => r.enterpriseId === 'ENT_A')).toBe(true)
    expect(rows.every((r) => r.status === 'REVIEW_PENDING')).toBe(true)
    expect(rows.every((r) => r.parseMode === 'RULE')).toBe(true)
    expect(res.body.data.ruleCount).toBe(rows.length)
  })

  it('OCR_AI → 保存 AI 可执行字段与解析审计字段', async () => {
    currentAiCaller = async () =>
      JSON.stringify([
        {
          clauseNo: '5.8',
          title: '安全档案',
          requirementText: '企业应建立安全生产记录档案并妥善保存',
          executionDescription: '检查安全台账、责任人签字和归档目录',
          recommendedTaskType: 'ARCHIVE_MATERIAL',
          submitRequirement: '上传安全台账和归档目录',
          requiredMaterials: ['安全台账', '归档目录'],
        },
      ])

    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ sourceId: entASourceId, parseMode: 'OCR_AI', dryRun: false })

    expect(res.status).toBe(200)
    expect(res.body.data.createdCount).toBe(1)
    expect(res.body.data.aiCount).toBe(1)
    expect(res.body.data.degradedCount).toBe(0)

    const row = await prisma.standardExecutionRequirement.findFirstOrThrow({ where: { sourceId: entASourceId } })
    expect(row.generateMode).toBe('AI')
    expect(row.parseMode).toBe('OCR_AI')
    expect(row.degradedReason).toBeNull()
    expect(row.recommendedTaskType).toBe('ARCHIVE_MATERIAL')
    expect(row.executionDescription).toContain('检查安全台账')
    expect(row.submitRequirement).toContain('上传')
    expect(row.requiredMaterials).toEqual(['安全台账', '归档目录'])
  })

  it('跨企业 source（ENT_A 用户用 ENT_B sourceId）→ 400', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ sourceId: entBSourceId, parseMode: 'RULE', dryRun: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('不存在或不属于本企业')
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .post('/api/enterprise/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${plainToken}`)
      .send({ sourceId: entASourceId, parseMode: 'RULE', dryRun: true })
    expect(res.status).toBe(403)
  })
})
