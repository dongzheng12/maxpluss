/**
 * Admin 一键开通企业申请 — Enterprise + AppUser + application converted
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes, __resetEnterpriseIpBucket } from '../src/enterpriseRoutes.js'
import { verifyPassword } from '../src/auth.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await prisma.enterpriseApplication.deleteMany()
  __resetEnterpriseIpBucket()
})

async function adminToken() {
  const admin = await createUser({ role: 'admin' })
  return getTestToken(admin.id, 'admin')
}

function applicationData(phone: string) {
  return {
    name: '申请人',
    position: '质量负责人',
    company: '一键开通测试企业',
    phone,
    requirement: '开通标准执行企业版',
  }
}

describe('POST /api/admin/enterprise/applications/:id/activate', () => {
  it('同一申请重复开通幂等复用 Enterprise 和 AppUser', async () => {
    const token = await adminToken()
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010001'),
    })

    const first = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
    const second = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.data.enterprise.id).toBe(first.body.data.enterprise.id)
    expect(second.body.data.user.id).toBe(first.body.data.user.id)

    const enterpriseCount = await prisma.enterprise.count({
      where: { code: `ENT-${appRow.id}`.toUpperCase() },
    })
    const userCount = await prisma.appUser.count({ where: { phone: appRow.phone } })
    expect(enterpriseCount).toBe(1)
    expect(userCount).toBe(1)
  })

  it('手机号不存在时创建 AppUser 并默认设为企业 MANAGER，平台 role 保持 user', async () => {
    const token = await adminToken()
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010002'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.user.phone).toBe(appRow.phone)
    expect(res.body.data.user.name).toBe(appRow.name)
    expect(res.body.data.user.enterpriseRole).toBe('MANAGER')

    const user = await prisma.appUser.findUnique({ where: { phone: appRow.phone } })
    expect(user?.enterpriseId).toBe(res.body.data.enterprise.id)
    expect(user?.role).toBe('user')
    expect(user?.enterpriseRole).toBe('MANAGER')
    expect(res.body.data.defaultPassword).toBe(appRow.phone.slice(-6))
    expect(await verifyPassword(appRow.phone.slice(-6), user!.passwordHash!)).toBe(true)
  })

  it('手机号已存在时复用旧 AppUser 并绑定新企业 MANAGER，已有密码不覆盖', async () => {
    const token = await adminToken()
    const existing = await createUser({ role: 'user', phone: '13900010003' })
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010003'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.user.id).toBe(existing.id)

    const user = await prisma.appUser.findUnique({ where: { id: existing.id } })
    expect(user?.enterpriseId).toBe(res.body.data.enterprise.id)
    expect(user?.role).toBe('user')
    expect(user?.enterpriseRole).toBe('MANAGER')
    expect(res.body.data.defaultPassword).toBeNull()
    expect(user?.passwordHash).toBe(existing.passwordHash)
  })

  it('手机号已是平台 admin 时开通企业版，保留平台 admin 并绑定企业角色', async () => {
    const token = await adminToken()
    const existing = await createUser({ role: 'admin', phone: '13900010007' })
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010007'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enterpriseRole: 'ADMIN' })

    expect(res.status).toBe(200)
    expect(res.body.data.user.id).toBe(existing.id)

    const user = await prisma.appUser.findUnique({ where: { id: existing.id } })
    expect(user?.enterpriseId).toBe(res.body.data.enterprise.id)
    expect(user?.role).toBe('admin')
    expect(user?.enterpriseRole).toBe('ADMIN')
  })

  it('支持显式选择企业角色 ADMIN，但平台 role 仍保持 user', async () => {
    const token = await adminToken()
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010006'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ enterpriseRole: 'ADMIN' })

    expect(res.status).toBe(200)
    expect(res.body.data.user.enterpriseRole).toBe('ADMIN')

    const user = await prisma.appUser.findUnique({ where: { phone: appRow.phone } })
    expect(user?.role).toBe('user')
    expect(user?.enterpriseRole).toBe('ADMIN')
  })

  it('手机号已存在但无密码时补默认密码，确保企业版可登录', async () => {
    const token = await adminToken()
    const existing = await prisma.appUser.create({
      data: { id: `wx-only-${Date.now()}`, phone: '13900010005', role: 'user' },
    })
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010005'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.user.id).toBe(existing.id)
    expect(res.body.data.defaultPassword).toBe(appRow.phone.slice(-6))

    const user = await prisma.appUser.findUnique({ where: { id: existing.id } })
    expect(user?.enterpriseId).toBe(res.body.data.enterprise.id)
    expect(user?.role).toBe('user')
    expect(user?.enterpriseRole).toBe('MANAGER')
    expect(await verifyPassword(appRow.phone.slice(-6), user!.passwordHash!)).toBe(true)
  })

  it('开通成功后申请状态置为 converted', async () => {
    const token = await adminToken()
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010004'),
    })

    const res = await request(app)
      .post(`/api/admin/enterprise/applications/${appRow.id}/activate`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.application.status).toBe('converted')

    const updated = await prisma.enterpriseApplication.findUnique({ where: { id: appRow.id } })
    expect(updated?.status).toBe('converted')
  })

  it('禁止手动把申请状态改为 converted，必须走一键开通事务', async () => {
    const token = await adminToken()
    const appRow = await prisma.enterpriseApplication.create({
      data: applicationData('13900010008'),
    })

    const res = await request(app)
      .patch(`/api/admin/enterprise/applications/${appRow.id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'converted' })

    expect(res.status).toBe(400)
    const updated = await prisma.enterpriseApplication.findUnique({ where: { id: appRow.id } })
    expect(updated?.status).toBe('pending')
  })
})
