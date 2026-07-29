/**
 * 企业版 /api/enterprise/standard-execution/risks — 端到端测试
 *
 * 覆盖：
 *  - GET /api/enterprise/standard-execution/risks   — 实时计算 4 类风险
 *  - 权限拦截：未登录 / 无 enterpriseId 普通 user → 401 / 403
 *  - 企业隔离：仅返回本企业风险
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let employeeToken: string
let plainToken: string
let adminToken: string

beforeEach(async () => {
  await cleanStandardExecutionData()

  for (const id of ['DEFAULT', 'ENT_A']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }

  const admin = await createUser({ role: 'admin' })
  adminToken = getTestToken(admin.id, 'admin')

  const employee = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: employee.id },
    data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' },
  })
  employeeToken = getTestToken(employee.id, 'user')

  const plain = await createUser({ role: 'user' })
  plainToken = getTestToken(plain.id, 'user')

  // ENT_A 造一个 4 天前的 ACTIVE Requirement → 触发 REQUIREMENT_NO_TASK
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_A',
      title: 's1',
      sourceType: 'PRODUCT_STANDARD',
      status: 'ACTIVE',
      createdBy: employee.id,
    },
  })
  await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_A',
      sourceId: source.id,
      title: '冷落需求',
      requirementText: '执行XX',
      status: 'ACTIVE',
      generateMode: 'MANUAL',
      createdBy: employee.id,
      // 4 天前
      createdAt: new Date(Date.now() - 4 * 24 * 3600 * 1000),
    },
  })
})

describe('GET /api/enterprise/standard-execution/risks', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/enterprise/standard-execution/risks')
    expect(res.status).toBe(401)
  })

  it('企业成员 → 200 + 至少 1 条 REQUIREMENT_NO_TASK（HIGH）', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/risks')
      .set('Authorization', `Bearer ${employeeToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBeGreaterThanOrEqual(1)
    expect(res.body.data.some((r: { riskType: string }) => r.riskType === 'REQUIREMENT_NO_TASK')).toBe(true)
  })

  it('admin → DEFAULT 企业 → 0 条', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/risks')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
  })

  it('无 enterpriseId 普通 user → 403', async () => {
    const res = await request(app)
      .get('/api/enterprise/standard-execution/risks')
      .set('Authorization', `Bearer ${plainToken}`)
    expect(res.status).toBe(403)
  })
})
