/**
 * 企业试用开通 POST /api/admin/enterprise/provision
 *
 * 修复安全漏洞：旧做法给试用客户 role='admin'（同时拿到平台后台权限）。
 * 正确做法：role='user' + 独立 enterpriseId + enterpriseRole='ADMIN'。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { registerAppRoutes } from '../src/appRoutes.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
  registerAppRoutes(app) // 提供 /api/app/auth/login，验证初始密码可登录
})

function randPhone(): string {
  return '137' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
}

let adminToken: string
let userToken: string

beforeEach(async () => {
  const admin = await createUser({ role: 'admin' })
  adminToken = getTestToken(admin.id, 'admin')
  const normalUser = await createUser({ role: 'user' })
  userToken = getTestToken(normalUser.id, 'user')
})

describe('POST /api/admin/enterprise/provision', () => {
  it('admin 开通新企业试用：建独立 Enterprise + user(role=user, enterpriseRole=ADMIN)', async () => {
    const phone = randPhone()
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, name: '张三', enterpriseName: '测试科技有限公司' })

    expect(res.status).toBe(201)
    expect(res.body.enterpriseId).toBeTruthy()
    expect(res.body.enterpriseId).not.toBe('DEFAULT') // 独立企业
    expect(res.body.enterpriseRole).toBe('ADMIN')
    expect(res.body.created).toBe(true)

    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.role).toBe('user') // 关键：不是 admin
    expect(u?.enterpriseId).toBe(res.body.enterpriseId)
    expect(u?.enterpriseRole).toBe('ADMIN')
  })

  it('已存在用户开通：更新绑定，role 保持 user', async () => {
    const phone = randPhone()
    await createUser({ role: 'user', phone })
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, enterpriseName: '已有用户企业' })

    expect(res.status).toBe(201)
    expect(res.body.created).toBe(false)
    const u = await prisma.appUser.findUnique({ where: { phone } })
    expect(u?.role).toBe('user')
    expect(u?.enterpriseRole).toBe('ADMIN')
  })

  it('用户已属其他企业 → 409', async () => {
    const phone = randPhone()
    const ent = await prisma.enterprise.create({ data: { name: '其他企业', code: `OTHER_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` } })
    const u = await createUser({ role: 'user', phone })
    await prisma.appUser.update({ where: { id: u.id }, data: { enterpriseId: ent.id, enterpriseRole: 'EMPLOYEE' } })

    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, enterpriseName: '新企业' })
    expect(res.status).toBe(409)
  })

  it('复用已有 enterpriseId：绑定到指定企业', async () => {
    const phone = randPhone()
    const ent = await prisma.enterprise.create({ data: { name: '指定企业', code: `SPEC_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` } })
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, enterpriseName: '忽略', enterpriseId: ent.id })
    expect(res.status).toBe(201)
    expect(res.body.enterpriseId).toBe(ent.id)
  })

  it('指定不存在的 enterpriseId → 404', async () => {
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: randPhone(), enterpriseName: 'X', enterpriseId: 'NOT_EXIST_ENT' })
    expect(res.status).toBe(404)
  })

  it('非 admin → 403', async () => {
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ phone: randPhone(), enterpriseName: 'X' })
    expect(res.status).toBe(403)
  })

  it('手机号格式错误 → 400', async () => {
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: 'abc', enterpriseName: 'X' })
    expect(res.status).toBe(400)
  })

  it('企业名称缺失 → 400', async () => {
    const res = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone: randPhone() })
    expect(res.status).toBe(400)
  })

  it('新建用户可用手机号后6位密码登录', async () => {
    const phone = randPhone()
    const prov = await request(app)
      .post('/api/admin/enterprise/provision')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, name: '李四', enterpriseName: '登录测试企业' })
    expect(prov.status).toBe(201)
    expect(prov.body.defaultPassword).toBe(phone.slice(-6))

    // 用初始密码（手机号后 6 位）登录
    const login = await request(app)
      .post('/api/app/auth/login')
      .send({ account: phone, password: phone.slice(-6) })
    expect(login.status).toBe(200)
    expect(login.body.token).toBeTruthy()
    expect(login.body.user.role).toBe('user')
    expect(login.body.user.enterpriseRole).toBe('ADMIN')
  })
})
