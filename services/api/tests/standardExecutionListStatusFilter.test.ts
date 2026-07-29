/**
 * standard-execution / 列表 status 多值过滤测试（P1 列表 Tab 后端支撑）
 *
 * 覆盖：list 的 status 参数支持单值或逗号分隔多值（向后兼容）
 *  - task list:        status=COMPLETED,CANCELLED → 仅这两类
 *  - task list:        status=DRAFT 单值 → 向后兼容
 *  - requirement list: status=DRAFT,ACTIVE → 仅待启用 + 可派发
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
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
  // 完整 FK 拓扑序：packageItem → package → reviewLog → attachment → record → submission → assignee → quizResult → taskItem → task → plan → requirement → source → questionBank
  await cleanStandardExecutionData()
})

async function setup() {
  const admin = await createUser({ role: 'admin' })
  const token = getTestToken(admin.id, 'admin')
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId: 'DEFAULT', title: '测试标准', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: '要求项', requirementText: '应每月检查', status: 'ACTIVE', createdBy: admin.id },
  })
  return { admin, token, src, req }
}

async function makeTask(reqId: string, reviewerId: string, status: string) {
  return prisma.standardExecutionTask.create({
    data: {
      enterpriseId: 'DEFAULT',
      requirementId: reqId,
      title: `任务-${status}`,
      submitRequirement: '提交',
      deadlineAt: new Date(Date.now() + 7 * 864e5),
      reviewerId,
      status,
      createdBy: reviewerId,
    },
  })
}

describe('GET /tasks — status 多值过滤', () => {
  it('status=COMPLETED,CANCELLED 只返回已完成 + 已取消', async () => {
    const { admin, token, req } = await setup()
    await makeTask(req.id, admin.id, 'DRAFT')
    await makeTask(req.id, admin.id, 'PUBLISHED')
    await makeTask(req.id, admin.id, 'COMPLETED')
    await makeTask(req.id, admin.id, 'CANCELLED')

    const res = await request(app)
      .get('/api/admin/standard-execution/tasks?status=COMPLETED,CANCELLED&pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const statuses = res.body.data.map((t: { status: string }) => t.status).sort()
    expect(statuses).toEqual(['CANCELLED', 'COMPLETED'])
  })

  it('status=DRAFT 单值仍向后兼容', async () => {
    const { admin, token, req } = await setup()
    await makeTask(req.id, admin.id, 'DRAFT')
    await makeTask(req.id, admin.id, 'PUBLISHED')

    const res = await request(app)
      .get('/api/admin/standard-execution/tasks?status=DRAFT&pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].status).toBe('DRAFT')
  })
})

describe('GET /requirements — status 多值过滤', () => {
  it('status=DRAFT,ACTIVE 只返回待启用 + 可派发', async () => {
    const { admin, token, src } = await setup()
    // setup 已建 1 个 ACTIVE；补 DRAFT/DISABLED/ARCHIVED
    for (const st of ['DRAFT', 'DISABLED', 'ARCHIVED'] as const) {
      await prisma.standardExecutionRequirement.create({
        data: { enterpriseId: 'DEFAULT', sourceId: src.id, title: `req-${st}`, requirementText: 'x 应检查', status: st, createdBy: admin.id },
      })
    }
    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?status=DRAFT,ACTIVE&pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const statuses = res.body.data.map((r: { status: string }) => r.status).sort()
    expect(statuses).toEqual(['ACTIVE', 'DRAFT'])
  })
})

describe('GET /requirements — 关联任务统计 (P1-7)', () => {
  it('list 返回每条检查点的 taskCount + 最近任务状态', async () => {
    const { admin, token, req } = await setup()
    // 两个任务，COMPLETED 创建更晚 → 应作为 latestTaskStatus
    await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't1', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 7 * 864e5), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id, createdAt: new Date('2026-01-01T00:00:00Z') },
    })
    await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't2', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 7 * 864e5), reviewerId: admin.id, status: 'COMPLETED', createdBy: admin.id, createdAt: new Date('2026-02-01T00:00:00Z') },
    })

    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const target = res.body.data.find((r: { id: string }) => r.id === req.id)
    expect(target.taskCount).toBe(2)
    expect(target.latestTaskStatus).toBe('COMPLETED')
  })

  it('无关联任务的检查点 taskCount=0、latestTaskStatus=null', async () => {
    const { token, req } = await setup()
    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    const target = res.body.data.find((r: { id: string }) => r.id === req.id)
    expect(target.taskCount).toBe(0)
    expect(target.latestTaskStatus).toBeNull()
  })

  it('软删除的任务不计入 taskCount', async () => {
    const { admin, token, req } = await setup()
    await prisma.standardExecutionTask.create({
      data: { enterpriseId: 'DEFAULT', requirementId: req.id, title: 't-del', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 7 * 864e5), reviewerId: admin.id, status: 'DRAFT', createdBy: admin.id, deletedAt: new Date() },
    })
    const res = await request(app)
      .get('/api/admin/standard-execution/requirements?pageSize=100')
      .set('Authorization', `Bearer ${token}`)
    const target = res.body.data.find((r: { id: string }) => r.id === req.id)
    expect(target.taskCount).toBe(0)
  })
})
