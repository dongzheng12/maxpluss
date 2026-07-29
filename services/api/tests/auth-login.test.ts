/**
 * POST /api/app/auth/login — 密码登录错误码分级
 *
 * 覆盖：
 *  - 未注册手机号 → 404（前端引导用户去网页版注册）
 *  - 已注册但 passwordHash 为空（仅微信注册过）→ 401（统一文案"账号或密码错误"）
 *  - 已注册 + 密码错 → 401
 *  - 已注册 + 密码正确 → 200 + token + user + membership
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { hashPassword } from '../src/auth.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  registerAppRoutes(app)
  await ensureAppSeed()
})

// 测试用 phone / email 列表（与 SalesProfile 等其他 FK 隔离，避免清 appUser 撞外键）
const TEST_PHONES = ['13800000099', '13800000401', '13800000402', '13800000200', '13800000500']
const TEST_EMAILS = ['tester@bxz.test', 'nobody@bxz.test']

beforeEach(async () => {
  // 仅清本测试自己造的用户（精确 phone / email），不全表 deleteMany 避免撞 SalesProfile 等外键
  await prisma.appUser.deleteMany({
    where: { OR: [{ phone: { in: TEST_PHONES } }, { email: { in: TEST_EMAILS } }] },
  })
})

describe('POST /api/app/auth/login — 错误码分级', () => {
  it('未注册手机号 → 404 + "该账号未注册"', async () => {
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.1')
      .send({ account: '13800000099', password: 'whatever' })
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('未注册')
  })

  it('已注册但 passwordHash 为空（微信首注册无密码）→ 401', async () => {
    await prisma.appUser.create({
      data: { id: 'test-no-pwd', phone: '13800000401', role: 'user' },
    })
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.2')
      .send({ account: '13800000401', password: 'whatever' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('账号或密码错误')
  })

  it('已注册 + 密码错 → 401', async () => {
    const hash = await hashPassword('correctpwd')
    await prisma.appUser.create({
      data: { id: 'test-bad-pwd', phone: '13800000402', passwordHash: hash, role: 'user' },
    })
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.3')
      .send({ account: '13800000402', password: 'WRONG' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('账号或密码错误')
  })

  it('正常登录 → 200 + token + user', async () => {
    const hash = await hashPassword('correct123')
    await prisma.appUser.create({
      data: {
        id: 'test-ok-user',
        phone: '13800000200',
        name: '测试用户',
        passwordHash: hash,
        role: 'user',
      },
    })
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.4')
      .send({ account: '13800000200', password: 'correct123' })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()
    expect(res.body.user.phone).toBe('13800000200')
    expect(res.body.user.id).toBe('test-ok-user')
  })

  it('已注册邮箱 + 密码正确 → 200（邮箱登录路径同样区分）', async () => {
    const hash = await hashPassword('emailpwd')
    await prisma.appUser.create({
      data: {
        id: 'test-email-user',
        phone: '13800000500',
        email: 'tester@bxz.test',
        passwordHash: hash,
        role: 'user',
      },
    })
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.5')
      .send({ account: 'tester@bxz.test', password: 'emailpwd' })
    expect(res.status).toBe(200)
    expect(res.body.user.email).toBe('tester@bxz.test')
  })

  it('未注册邮箱 → 404（邮箱路径同样区分）', async () => {
    const res = await request(app)
      .post('/api/app/auth/login')
      .set('X-Forwarded-For', '10.1.1.6')
      .send({ account: 'nobody@bxz.test', password: 'whatever' })
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('未注册')
  })
})
