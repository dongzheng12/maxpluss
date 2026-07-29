import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { readFileSync } from 'node:fs'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
})

async function adminCtx() {
  const admin = await createUser({ role: 'admin' })
  const token = getTestToken(admin.id, 'admin')
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'DEFAULT',
      title: '审核门测试标准',
      sourceType: 'PRODUCT_STANDARD',
      rawText: '4.1 企业应建立并保存标准执行记录。',
      createdBy: admin.id,
    },
  })
  return { admin, token, source }
}

describe('Requirement review gate', () => {
  it('auto-generate 完成后自动进入 REVIEW_PENDING', async () => {
    const { token, source } = await adminCtx()
    const res = await request(app)
      .post('/api/admin/standard-execution/requirements/auto-generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: source.id, parseMode: 'RULE' })

    expect(res.status).toBe(200)
    const rows = await prisma.standardExecutionRequirement.findMany({
      where: { sourceId: source.id },
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'REVIEW_PENDING')).toBe(true)
  })

  it('REVIEW_PENDING 可编辑 AI 字段后审核激活为 ACTIVE', async () => {
    const { admin, token, source } = await adminCtx()
    const req = await prisma.standardExecutionRequirement.create({
      data: {
        enterpriseId: 'DEFAULT',
        sourceId: source.id,
        title: '待审核要求项',
        requirementText: '应按月保存记录。',
        status: 'REVIEW_PENDING',
        createdBy: admin.id,
      },
    })

    const update = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${req.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '审核后要求项',
        requirementText: '应按月保存记录，记录不少于三年。',
        recommendedTaskType: 'ARCHIVE_MATERIAL',
        executionDescription: '按月整理并归档记录。',
        submitRequirement: '提交记录台账和归档截图。',
        requiredMaterials: ['记录台账', '归档截图'],
      })
    expect(update.status).toBe(200)
    expect(update.body.data.requiredMaterials).toEqual(['记录台账', '归档截图'])

    const activate = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${req.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(activate.status).toBe(200)
    expect(activate.body.data.status).toBe('ACTIVE')
  })

  it('DRAFT 不能跨越审核门直接激活', async () => {
    const { admin, token, source } = await adminCtx()
    const req = await prisma.standardExecutionRequirement.create({
      data: {
        enterpriseId: 'DEFAULT',
        sourceId: source.id,
        title: '历史草稿',
        requirementText: '历史草稿要求。',
        status: 'DRAFT',
        createdBy: admin.id,
      },
    })

    const res = await request(app)
      .patch(`/api/admin/standard-execution/requirements/${req.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('DRAFT')
  })

  it('migration 将历史 DRAFT 回填为 REVIEW_PENDING，rollback 可还原', () => {
    const migration = readFileSync(
      'prisma/migrations/20260601140000_se_requirement_review_gate/migration.sql',
      'utf8',
    )
    const rollback = readFileSync(
      'prisma/migrations/20260601140000_se_requirement_review_gate/rollback.sql',
      'utf8',
    )

    expect(migration).toContain(`SET "status" = 'REVIEW_PENDING'`)
    expect(migration).toContain(`WHERE "status" = 'DRAFT'`)
    expect(rollback).toContain(`SET "status" = 'DRAFT'`)
    expect(rollback).toContain(`WHERE "status" = 'REVIEW_PENDING'`)
  })
})
