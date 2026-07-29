/**
 * 比对队列保护 — 端到端测试
 *
 * 覆盖 appRoutes.ts checkCompareQueue 的两层保护：
 *   Layer 1（所有非 admin）：同 userId 已有 PENDING/PROCESSING → 409 ALREADY_PROCESSING
 *   Layer 2（仅免费用户）：全局 PENDING ≥ FREE_QUEUE_LIMIT → 429 QUEUE_FULL
 *   admin 完全绕过两层
 *   会员仅绕过 Layer 2，仍受 Layer 1 约束
 *
 * 测试要点：
 *   - 用唯一 X-Forwarded-For 头跳过 ipRateLimit 5 req/min 的串扰
 *   - test 环境不启动 taskWorker（NODE_ENV='test'），任务停在 PENDING 不会被消费
 *   - 直接 prisma.compareTask.create 注入跨用户排队任务
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans, createMembership } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await prisma.compareTask.deleteMany()
  await prisma.userMembership.deleteMany()
})

// 每个测试用唯一 IP，避免 ipRateLimit(5/min) 跨测试累积触发 429
let ipCounter = 100
function uniqueIp(): string {
  ipCounter += 1
  return `10.0.0.${ipCounter}`
}

async function postLibrary(token: string, ip: string) {
  return request(app)
    .post('/api/app/compare/library')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Forwarded-For', ip)
    .attach('file', Buffer.from('dummy content'), 'test.docx')
    .field('documentName', 'test.docx')
}

async function seedPendingTasks(count: number) {
  // 跨用户的排队任务用 userId=null（CompareTask.userId 是可空 FK，不能填假 ID）
  // 关键：必须不属于待测用户，否则会被 Layer 1 优先拦截
  for (let i = 0; i < count; i++) {
    await prisma.compareTask.create({
      data: {
        taskNo: `CMP-SEED-${Date.now()}-${i}`,
        userId: null,
        documentName: `seed-${i}.docx`,
        compareMode: 'library',
        selectedStandardIds: '[]',
        status: 'PENDING',
        priority: 1,
      },
    })
  }
}

describe('比对队列保护', () => {
  describe('Layer 1：单用户去重（409）', () => {
    it('同一用户连续两次提交 → 第二次返回 409 ALREADY_PROCESSING + currentTaskNo', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)
      const ip = uniqueIp()

      const first = await postLibrary(token, ip)
      expect(first.status).toBe(200)
      expect(first.body.taskNo).toMatch(/^CMP-/)
      const firstTaskNo = first.body.taskNo

      const second = await postLibrary(token, uniqueIp())
      expect(second.status).toBe(409)
      expect(second.body.error).toBe('ALREADY_PROCESSING')
      expect(second.body.currentTaskNo).toBe(firstTaskNo)
      expect(second.body.currentStatus).toBe('PENDING')
      expect(second.body.message).toContain('正在处理中')
    })

    it('PROCESSING 状态也被 Layer 1 拦截（不只是 PENDING）', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      // 直接创建一个 PROCESSING 任务模拟 worker 已领取
      await prisma.compareTask.create({
        data: {
          taskNo: 'CMP-INFLIGHT-001',
          userId: user.id,
          documentName: 'inflight.docx',
          compareMode: 'library',
          selectedStandardIds: '[]',
          status: 'PROCESSING',
          priority: 1,
        },
      })

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(409)
      expect(res.body.currentTaskNo).toBe('CMP-INFLIGHT-001')
      expect(res.body.currentStatus).toBe('PROCESSING')
    })

    it('任务完成（COMPLETED）后再提交 → 200 OK 入队', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      const first = await postLibrary(token, uniqueIp())
      expect(first.status).toBe(200)

      // 模拟 worker 完成
      await prisma.compareTask.update({
        where: { taskNo: first.body.taskNo },
        data: { status: 'COMPLETED', finishedAt: new Date() },
      })

      const second = await postLibrary(token, uniqueIp())
      expect(second.status).toBe(200)
      expect(second.body.taskNo).toMatch(/^CMP-/)
      expect(second.body.taskNo).not.toBe(first.body.taskNo)
    })

    it('FAILED 任务不挡新提交（用户应能立即重试）', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      await prisma.compareTask.create({
        data: {
          taskNo: 'CMP-FAILED-001',
          userId: user.id,
          documentName: 'failed.docx',
          compareMode: 'library',
          selectedStandardIds: '[]',
          status: 'FAILED',
          priority: 1,
          errorMessage: '文档解析失败',
        },
      })

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(200)
    })
  })

  describe('Layer 2：全局队列保护（429，仅免费用户）', () => {
    it('免费用户 + 全局 PENDING=21 → 429 QUEUE_FULL + queuePosition + estimateMinutes', async () => {
      await seedPendingTasks(21) // 跨用户排队 21 条

      const user = await createUser() // 免费用户，自己没有任务
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(429)
      expect(res.body.error).toBe('QUEUE_FULL')
      expect(res.body.queuePosition).toBe(22)
      expect(res.body.estimateMinutes).toBe(44) // 22 * 2 min
      expect(res.body.upgradeUrl).toBe('/membership')
      expect(res.body.message).toContain('排队较长')
    })

    it('免费用户 + 全局 PENDING=20（恰好等于阈值）→ 429（≥ 是闭区间）', async () => {
      await seedPendingTasks(20)
      const user = await createUser()
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(429)
      expect(res.body.queuePosition).toBe(21)
    })

    it('免费用户 + 全局 PENDING=19（阈值以下）→ 200 OK 正常入队', async () => {
      await seedPendingTasks(19)
      const user = await createUser()
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(200)
      expect(res.body.taskNo).toMatch(/^CMP-/)
    })

    it('个人会员 + 全局 PENDING=100 → 200 OK（会员绕过 Layer 2）', async () => {
      await seedPendingTasks(100)
      const user = await createUser()
      await createMembership(user.id, 'personal')
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(200)
      expect(res.body.taskNo).toMatch(/^CMP-/)
    })

    it('专业会员 + 全局 PENDING=100 → 200 OK', async () => {
      await seedPendingTasks(100)
      const user = await createUser()
      await createMembership(user.id, 'pro')
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(200)
    })

    it('过期会员（status=EXPIRED）当作免费用户处理 → 队列满时 429', async () => {
      await seedPendingTasks(21)
      const user = await createUser()
      await createMembership(user.id, 'personal', { status: 'EXPIRED' })
      const token = getTestToken(user.id)

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(429)
    })
  })

  describe('admin 角色：完全绕过两层', () => {
    it('admin 连续两次提交 → 都返回 200', async () => {
      const admin = await createUser({ role: 'admin' })
      const token = getTestToken(admin.id, 'admin')

      const first = await postLibrary(token, uniqueIp())
      expect(first.status).toBe(200)

      const second = await postLibrary(token, uniqueIp())
      expect(second.status).toBe(200)
      expect(second.body.taskNo).not.toBe(first.body.taskNo)
    })

    it('admin + 全局 PENDING=100 → 仍 200 OK（绕过 Layer 2）', async () => {
      await seedPendingTasks(100)
      const admin = await createUser({ role: 'admin' })
      const token = getTestToken(admin.id, 'admin')

      const res = await postLibrary(token, uniqueIp())
      expect(res.status).toBe(200)
    })
  })

  describe('两个 compare 端点都受保护', () => {
    it('/api/app/compare/tasks（一对一）也走 Layer 1 拦截', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      // 用户已有 library PENDING 任务
      await prisma.compareTask.create({
        data: {
          taskNo: 'CMP-EXISTING-001',
          userId: user.id,
          documentName: 'lib.docx',
          compareMode: 'library',
          selectedStandardIds: '[]',
          status: 'PENDING',
          priority: 1,
        },
      })

      const res = await request(app)
        .post('/api/app/compare/tasks')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', uniqueIp())
        .attach('file', Buffer.from('A'), 'a.docx')
        .attach('fileB', Buffer.from('B'), 'b.docx')
        .field('compareMode', 'ONE_TO_ONE')
        .field('documentName', 'a vs b')

      expect(res.status).toBe(409)
      expect(res.body.error).toBe('ALREADY_PROCESSING')
      expect(res.body.currentTaskNo).toBe('CMP-EXISTING-001')
    })
  })

  describe('未登录 → 走 requireAuth 拦截，不到 queue 检查', () => {
    it('无 token → 401（不是 409/429）', async () => {
      const res = await request(app)
        .post('/api/app/compare/library')
        .set('X-Forwarded-For', uniqueIp())
        .attach('file', Buffer.from('x'), 'x.docx')
      expect(res.status).toBe(401)
    })
  })
})
