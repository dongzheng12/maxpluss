/**
 * GET /api/enterprise/me — 企业版当前用户身份接口
 *
 * 覆盖：
 *  - 未登录 → 401
 *  - 普通用户（enterpriseId/Role 为空）→ 200 + 字段全 null
 *  - 企业成员（enterpriseRole=EMPLOYEE）→ 200 + 真实 enterpriseName
 *  - admin 通配 → 200 + isAdminBypass=true + enterpriseId='DEFAULT'
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  // 确保 DEFAULT 企业存在（admin 通配 + 企业成员都需要）
  await prisma.enterprise.upsert({
    where: { id: 'DEFAULT' },
    update: { name: '默认企业', status: 'ACTIVE' },
    create: { id: 'DEFAULT', name: '默认企业', code: 'DEFAULT', status: 'ACTIVE' },
  })
})

describe('GET /api/enterprise/me', () => {
  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/enterprise/me')
    expect(res.status).toBe(401)
  })

  it('普通用户（无 enterpriseId）→ 200 + 字段全 null', async () => {
    const user = await createUser({ role: 'user' })
    const token = getTestToken(user.id, 'user')
    const res = await request(app)
      .get('/api/enterprise/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.enterpriseId).toBeNull()
    expect(res.body.enterpriseRole).toBeNull()
    expect(res.body.enterpriseName).toBeNull()
    expect(res.body.isAdminBypass).toBe(false)
    expect(res.body.user.id).toBe(user.id)
  })

  it('企业成员（enterpriseRole=EMPLOYEE）→ 200 + 真实 enterpriseName', async () => {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId: 'DEFAULT', enterpriseRole: 'EMPLOYEE' },
    })
    const token = getTestToken(user.id, 'user')
    const res = await request(app)
      .get('/api/enterprise/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.enterpriseId).toBe('DEFAULT')
    expect(res.body.enterpriseRole).toBe('EMPLOYEE')
    expect(res.body.enterpriseName).toBe('默认企业')
    expect(res.body.enterpriseStatus).toBe('ACTIVE')
    expect(res.body.isAdminBypass).toBe(false)
  })

  it('admin 通配 → 200 + isAdminBypass=true', async () => {
    const user = await createUser({ role: 'admin' })
    const token = getTestToken(user.id, 'admin')
    const res = await request(app)
      .get('/api/enterprise/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.isAdminBypass).toBe(true)
    expect(res.body.enterpriseId).toBe('DEFAULT')
    expect(res.body.enterpriseRole).toBe('ADMIN')
    expect(res.body.enterpriseName).toBe('默认企业')
  })

  it('已绑定企业 admin → 200 + 返回真实企业', async () => {
    await prisma.enterprise.upsert({
      where: { id: 'ENT_DEMO' },
      update: { name: '演示企业', status: 'ACTIVE' },
      create: { id: 'ENT_DEMO', name: '演示企业', code: 'ENT_DEMO', status: 'ACTIVE' },
    })
    const user = await createUser({ role: 'admin' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId: 'ENT_DEMO', enterpriseRole: 'ADMIN' },
    })
    const token = getTestToken(user.id, 'admin')
    const res = await request(app)
      .get('/api/enterprise/me')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.isAdminBypass).toBe(true)
    expect(res.body.enterpriseId).toBe('ENT_DEMO')
    expect(res.body.enterpriseRole).toBe('ADMIN')
    expect(res.body.enterpriseName).toBe('演示企业')
  })
})
