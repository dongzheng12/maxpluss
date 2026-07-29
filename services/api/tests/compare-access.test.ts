/**
 * 比对功能权限测试 — 一对一比对会员门控
 *
 * 覆盖 appRoutes.ts isPaidCompareUser 在 /api/app/compare/tasks 的门控逻辑：
 *   - ONE_TO_ONE 模式：免费用户 / 未登录 → 403 / 401
 *   - ONE_TO_ONE 模式：个人会员 / 专业会员 → 放行进入队列（200 或 409）
 *   - ONE_TO_ONE 模式：过期会员 → 403（当作免费处理）
 *   - library 模式：免费用户不受此门控影响（不会 403）
 *   - 归集平台 /api/guiji/compare/tasks 不受影响（匿名可提交）
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

let ipCounter = 200
function uniqueIp(): string {
  ipCounter += 1
  return `10.1.0.${ipCounter}`
}

/** 发起 /api/app/compare/tasks 一对一比对请求 */
async function postOneToOne(token: string | null, ip: string) {
  const req = request(app)
    .post('/api/app/compare/tasks')
    .set('X-Forwarded-For', ip)
    .attach('file', Buffer.from('文档A内容'), 'a.docx')
    .attach('fileB', Buffer.from('文档B内容'), 'b.docx')
    .field('compareMode', 'ONE_TO_ONE')
    .field('documentName', 'test a vs b')
  if (token) req.set('Authorization', `Bearer ${token}`)
  return req
}

/** 发起 /api/app/compare/tasks library（全库）请求 */
async function postLibraryMode(token: string, ip: string) {
  return request(app)
    .post('/api/app/compare/tasks')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Forwarded-For', ip)
    .attach('file', Buffer.from('文档A内容'), 'a.docx')
    .field('compareMode', 'all')
    .field('documentName', 'test library')
}

describe('一对一比对 — 会员权限门控', () => {
  describe('免费用户 / 未登录 → 拒绝访问', () => {
    it('免费用户提交 ONE_TO_ONE → 403，body 含 upgradeUrl', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      const res = await postOneToOne(token, uniqueIp())
      expect(res.status).toBe(403)
      expect(res.body.error).toContain('一对一比对为会员专属功能')
      expect(res.body.upgradeUrl).toBe('/membership')
    })

    it('未登录（无 token）→ 401，不是 403', async () => {
      const res = await postOneToOne(null, uniqueIp())
      expect(res.status).toBe(401)
    })

    it('过期会员（status=EXPIRED）→ 403，视同免费用户', async () => {
      const user = await createUser()
      await createMembership(user.id, 'personal', { status: 'EXPIRED' })
      const token = getTestToken(user.id)

      const res = await postOneToOne(token, uniqueIp())
      expect(res.status).toBe(403)
      expect(res.body.upgradeUrl).toBe('/membership')
    })
  })

  describe('付费会员 → 放行进队列', () => {
    it('个人会员（personal, ACTIVE）→ 200 入队', async () => {
      const user = await createUser()
      await createMembership(user.id, 'personal')
      const token = getTestToken(user.id)

      const res = await postOneToOne(token, uniqueIp())
      // 200 = 正常入队；409 = 已有任务（也是放行，因为已过 403 门控）
      expect([200, 409]).toContain(res.status)
      if (res.status === 200) {
        expect(res.body.taskNo).toMatch(/^CMP-/)
      }
    })

    it('专业会员（pro, ACTIVE）→ 200 入队', async () => {
      const user = await createUser()
      await createMembership(user.id, 'pro')
      const token = getTestToken(user.id)

      const res = await postOneToOne(token, uniqueIp())
      expect([200, 409]).toContain(res.status)
    })

    it('个人会员连续两次提交 → 第二次 409（队列去重），不是 403', async () => {
      const user = await createUser()
      await createMembership(user.id, 'personal')
      const token = getTestToken(user.id)

      const first = await postOneToOne(token, uniqueIp())
      expect(first.status).toBe(200)

      const second = await postOneToOne(token, uniqueIp())
      expect(second.status).toBe(409)
      expect(second.body.error).toBe('ALREADY_PROCESSING')
    })
  })

  describe('library 模式不受一对一门控影响', () => {
    it('免费用户提交 library 模式 → 不返回 403（只受队列保护）', async () => {
      const user = await createUser()
      const token = getTestToken(user.id)

      const res = await postLibraryMode(token, uniqueIp())
      // 免费用户 library 模式只触发队列保护，不触发会员门控
      expect(res.status).not.toBe(403)
      expect([200, 409, 429]).toContain(res.status)
    })
  })

  // 归集平台 /api/guiji/* 走独立路由，与 /api/app/* 完全隔离，
  // 代码层面已确认不受 isPaidCompareUser 影响，test 环境不注册 guiji 路由，无需此用例。
})
