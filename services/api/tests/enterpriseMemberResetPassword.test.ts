/**
 * 企业成员密码重置 — POST /api/enterprise/members/:id/reset-password
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes } from '../src/appRoutes.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { verifyPassword } from '../src/auth.js'
import { createUser, getTestToken, cleanAll } from './factory.js'

const app = express()
app.use(express.json())
beforeAll(() => {
  registerAppRoutes(app)
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await cleanAll()
  for (const id of ['DEFAULT', 'ENT_A']) {
    await prisma.enterprise.upsert({ where: { id }, update: { status: 'ACTIVE' }, create: { id, name: id, code: id, status: 'ACTIVE' } })
  }
})

const RESET = (id: string) => `/api/enterprise/members/${id}/reset-password`

describe('POST /api/enterprise/members/:id/reset-password', () => {
  it('企业 ADMIN 重置成员密码 → 返回 8 位临时密码，成员登录后必须改密', async () => {
    const admin = await createUser({ role: 'user', phone: '13900000001' })
    await prisma.appUser.update({ where: { id: admin.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' } })
    const member = await createUser({ role: 'user', phone: '13800001234' })
    await prisma.appUser.update({ where: { id: member.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE', passwordHash: null } })

    const res = await request(app)
      .post(RESET(member.id))
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{8}$/)
    expect(res.body.passwordMustChange).toBe(true)

    const updated = await prisma.appUser.findUnique({ where: { id: member.id } })
    expect(updated?.passwordHash).not.toBeNull()
    expect(updated?.passwordMustChange).toBe(true)
    expect(await verifyPassword(res.body.temporaryPassword, updated!.passwordHash!)).toBe(true)

    const loginRes = await request(app)
      .post('/api/app/auth/login')
      .send({ account: member.phone, password: res.body.temporaryPassword })
    expect(loginRes.status).toBe(200)
    expect(loginRes.body.user.passwordMustChange).toBe(true)
  })

  it('EMPLOYEE 无权重置 → 403', async () => {
    const emp = await createUser({ role: 'user', phone: '13900000002' })
    await prisma.appUser.update({ where: { id: emp.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })
    const member = await createUser({ role: 'user', phone: '13800005678' })
    await prisma.appUser.update({ where: { id: member.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE' } })

    const res = await request(app)
      .post(RESET(member.id))
      .set('Authorization', `Bearer ${getTestToken(emp.id, 'user')}`)
      .send({})
    expect(res.status).toBe(403)
  })

  it('跨企业成员 → 404', async () => {
    const admin = await createUser({ role: 'user', phone: '13900000003' })
    await prisma.appUser.update({ where: { id: admin.id }, data: { enterpriseId: 'ENT_A', enterpriseRole: 'ADMIN' } })
    const other = await createUser({ role: 'user', phone: '13800009999' })
    await prisma.appUser.update({ where: { id: other.id }, data: { enterpriseId: 'DEFAULT', enterpriseRole: 'EMPLOYEE' } })

    const res = await request(app)
      .post(RESET(other.id))
      .set('Authorization', `Bearer ${getTestToken(admin.id, 'user')}`)
      .send({})
    expect(res.status).toBe(404)
  })

  it('成员自改密码成功后清除强制改密标记', async () => {
    const member = await createUser({ role: 'user', phone: '13800001111', password: 'temp1234' })
    await prisma.appUser.update({
      where: { id: member.id },
      data: { enterpriseId: 'ENT_A', enterpriseRole: 'EMPLOYEE', passwordMustChange: true },
    })

    const token = getTestToken(member.id, 'user')
    const res = await request(app)
      .post('/api/app/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: 'temp1234', newPassword: 'memberNew123' })

    expect(res.status).toBe(200)
    const updated = await prisma.appUser.findUnique({ where: { id: member.id } })
    expect(updated?.passwordMustChange).toBe(false)
    expect(await verifyPassword('memberNew123', updated!.passwordHash!)).toBe(true)
  })

  it('无 token → 401', async () => {
    const res = await request(app).post(RESET('any')).send({})
    expect(res.status).toBe(401)
  })
})
