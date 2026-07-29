/**
 * 企业申请模块 — 端到端测试
 *
 * 覆盖：
 *  - happy path：完整数据 → 200 + DB 写入 + 钉钉跳过
 *  - 权限：admin 接口无 token 401 / sales token 403
 *  - 边界：phone 非法 400 / name 空 400 / 更新不存在 id 404 / status 非法 400
 *  - 防刷：IP 限流 4 次第 4 次 429 / 同手机 24h 第二次返回 deduped
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import {
  registerEnterpriseRoutes,
  __resetEnterpriseIpBucket,
} from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  // 测试时不发钉钉（webhook 留空，notifyDingtalk 直接 return）
  delete process.env.ENTERPRISE_APPLY_WEBHOOK_URL
  delete process.env.ENTERPRISE_APPLY_SIGN_SECRET
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await prisma.enterpriseApplication.deleteMany()
  __resetEnterpriseIpBucket()
  // 不清 appUser：跨 test file 并行运行时其他文件持有 FK（UserMembership 等），
  // 每个测试用 createUser 创建独立 id，互不冲突。
})

const validBody = {
  name: '张三',
  position: '产品经理',
  company: '某科技有限公司',
  phone: '13800138001',
  requirement: '需要标准比对功能',
}

describe('POST /api/app/enterprise/apply', () => {
  it('happy path — 完整数据 200 + DB 写入', async () => {
    const res = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.1')
      .send(validBody)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    const rows = await prisma.enterpriseApplication.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('张三')
    expect(rows[0].status).toBe('pending')
    expect(rows[0].ipAddress).toBe('10.0.0.1')
  })

  it('兼容登录页申请字段 — 无 position，industry/companySize/useCase 打包为 requirement', async () => {
    const res = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.11')
      .send({
        company: '测试公司ZZ_DEL',
        name: '测试XU',
        phone: '18800008888',
        industry: '测试行业',
        companySize: '1-50人',
        useCase: 'console测试',
      })
    expect(res.status).toBe(200)

    const row = await prisma.enterpriseApplication.findFirstOrThrow({
      where: { phone: '18800008888' },
    })
    expect(row.position).toBe('未填写')
    expect(row.requirement).toContain('行业：测试行业')
    expect(row.requirement).toContain('规模：1-50人')
    expect(row.requirement).toContain('用途：console测试')
  })

  it('兼容旧别名字段 — companyName/contactName/contactPhone', async () => {
    const res = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.12')
      .send({
        companyName: '别名公司',
        contactName: '别名联系人',
        contactPhone: '18800009999',
        scenario: '旧表单场景',
      })
    expect(res.status).toBe(200)

    const row = await prisma.enterpriseApplication.findFirstOrThrow({
      where: { phone: '18800009999' },
    })
    expect(row.company).toBe('别名公司')
    expect(row.name).toBe('别名联系人')
    expect(row.position).toBe('未填写')
    expect(row.requirement).toContain('场景：旧表单场景')
  })

  it('phone 非法 → 400', async () => {
    const res = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.2')
      .send({ ...validBody, phone: 'abc' })
    expect(res.status).toBe(400)
  })

  it('name 空 → 400', async () => {
    const res = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.3')
      .send({ ...validBody, name: '' })
    expect(res.status).toBe(400)
  })

  it('IP 限流 — 同 IP 1 分钟内第 4 次 429', async () => {
    const ip = '10.0.0.4'
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/api/app/enterprise/apply')
        .set('X-Forwarded-For', ip)
        .send({ ...validBody, phone: `1380013800${i + 2}` })
      expect(r.status).toBe(200)
    }
    const blocked = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', ip)
      .send({ ...validBody, phone: '13800138099' })
    expect(blocked.status).toBe(429)
  })

  it('同手机号 24h 去重 — 第二次返回 deduped、DB 不新增', async () => {
    const first = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.5')
      .send(validBody)
    expect(first.status).toBe(200)

    const second = await request(app)
      .post('/api/app/enterprise/apply')
      .set('X-Forwarded-For', '10.0.0.6') // 不同 IP，确认走的是手机号去重
      .send(validBody)
    expect(second.status).toBe(200)
    expect(second.body.deduped).toBe(true)

    const count = await prisma.enterpriseApplication.count()
    expect(count).toBe(1)
  })
})

describe('GET /api/admin/enterprise/applications', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/enterprise/applications')
    expect(res.status).toBe(401)
  })

  it('sales token → 403', async () => {
    const sales = await createUser({ role: 'sales' })
    const token = getTestToken(sales.id, 'sales')
    const res = await request(app)
      .get('/api/admin/enterprise/applications')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('admin token → 200 + 数据返回', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    await prisma.enterpriseApplication.create({ data: { ...validBody } })
    const res = await request(app)
      .get('/api/admin/enterprise/applications')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(1)
    expect(res.body.data[0].company).toBe('某科技有限公司')
  })
})

describe('PATCH /api/admin/enterprise/applications/:id/status', () => {
  it('无 token → 401', async () => {
    const res = await request(app)
      .patch('/api/admin/enterprise/applications/some-id/status')
      .send({ status: 'contacted' })
    expect(res.status).toBe(401)
  })

  it('admin 更新存在的 id → 200', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    const row = await prisma.enterpriseApplication.create({ data: { ...validBody } })
    const res = await request(app)
      .patch(`/api/admin/enterprise/applications/${row.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'contacted' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('contacted')
  })

  it('admin 更新不存在 id → 404', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    const res = await request(app)
      .patch('/api/admin/enterprise/applications/non-existent-cuid-xxx/status')
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'contacted' })
    expect(res.status).toBe(404)
  })

  it('admin status 非法值 → 400', async () => {
    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    const row = await prisma.enterpriseApplication.create({ data: { ...validBody } })
    const res = await request(app)
      .patch(`/api/admin/enterprise/applications/${row.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'invalid_state' })
    expect(res.status).toBe(400)
  })
})
