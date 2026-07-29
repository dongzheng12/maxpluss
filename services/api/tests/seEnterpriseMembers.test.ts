/**
 * 企业版成员管理 — POST/PATCH/DELETE 权限与隔离
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { verifyPassword } from '../src/auth.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

let seq = 0
let enterpriseId: string
let otherEnterpriseId: string
let adminId: string
let adminToken: string
let managerToken: string
let memberId: string
let otherMemberId: string

beforeEach(async () => {
  seq += 1
  enterpriseId = `ENT_MEM_A_${seq}`
  otherEnterpriseId = `ENT_MEM_B_${seq}`

  await prisma.enterprise.create({
    data: { id: enterpriseId, name: `成员测试企业 ${seq}`, code: enterpriseId, status: 'ACTIVE' },
  })
  await prisma.enterprise.create({
    data: { id: otherEnterpriseId, name: `其他企业 ${seq}`, code: otherEnterpriseId, status: 'ACTIVE' },
  })

  const admin = await createUser({ role: 'user', phone: `139001${String(seq).padStart(5, '0')}` })
  await prisma.appUser.update({
    where: { id: admin.id },
    data: { enterpriseId, enterpriseRole: 'ADMIN' },
  })
  adminId = admin.id
  adminToken = getTestToken(admin.id, 'user')

  const manager = await createUser({ role: 'user', phone: `139002${String(seq).padStart(5, '0')}` })
  await prisma.appUser.update({
    where: { id: manager.id },
    data: { enterpriseId, enterpriseRole: 'MANAGER' },
  })
  managerToken = getTestToken(manager.id, 'user')

  const member = await createUser({ role: 'user', phone: `139003${String(seq).padStart(5, '0')}` })
  await prisma.appUser.update({
    where: { id: member.id },
    data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  memberId = member.id

  const otherMember = await createUser({ role: 'user', phone: `139004${String(seq).padStart(5, '0')}` })
  await prisma.appUser.update({
    where: { id: otherMember.id },
    data: { enterpriseId: otherEnterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  otherMemberId = otherMember.id
})

describe('POST /api/enterprise/members', () => {
  it('ADMIN 可新增手机号不存在的成员', async () => {
    const phone = `139005${String(seq).padStart(5, '0')}`
    const res = await request(app)
      .post('/api/enterprise/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, name: '新成员', enterpriseRole: 'REVIEWER' })

    expect(res.status).toBe(201)
    expect(res.body.data.phone).toBe(phone)
    expect(res.body.data.nickName).toBe('新成员')
    expect(res.body.data.enterpriseRole).toBe('REVIEWER')

    const created = await prisma.appUser.findUnique({ where: { phone } })
    expect(created?.enterpriseId).toBe(enterpriseId)
    expect(created?.enterpriseRole).toBe('REVIEWER')
  })

  it('ADMIN 可把未绑定企业的旧用户加入本企业', async () => {
    const phone = `139006${String(seq).padStart(5, '0')}`
    const existing = await createUser({ role: 'user', phone })

    const res = await request(app)
      .post('/api/enterprise/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, enterpriseRole: 'EMPLOYEE' })

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(existing.id)

    const updated = await prisma.appUser.findUnique({ where: { id: existing.id } })
    expect(updated?.enterpriseId).toBe(enterpriseId)
    expect(updated?.enterpriseRole).toBe('EMPLOYEE')
  })

  it('非 ADMIN 调用 POST 被 403 拦截', async () => {
    const res = await request(app)
      .post('/api/enterprise/members')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ phone: `139007${String(seq).padStart(5, '0')}`, enterpriseRole: 'EMPLOYEE' })

    expect(res.status).toBe(403)
  })

  it('新建成员返回 8 位临时密码并标记首次登录改密', async () => {
    const phone = `139008${String(seq).padStart(5, '0')}`
    const res = await request(app)
      .post('/api/enterprise/members')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ phone, name: '默认密码成员', enterpriseRole: 'EMPLOYEE' })
    expect(res.status).toBe(201)
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{8}$/)

    const created = await prisma.appUser.findUnique({ where: { phone } })
    expect(created?.passwordHash).toBeTruthy()
    expect(created?.passwordMustChange).toBe(true)
    expect(await verifyPassword(res.body.temporaryPassword, created!.passwordHash!)).toBe(true)
    expect(await verifyPassword(phone.slice(-6), created!.passwordHash!)).toBe(false)
  })
})

describe('PATCH /api/enterprise/members/:id', () => {
  it('ADMIN 可修改本企业成员角色', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/members/${memberId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enterpriseRole: 'REVIEWER' })

    expect(res.status).toBe(200)
    expect(res.body.data.enterpriseRole).toBe('REVIEWER')

    const updated = await prisma.appUser.findUnique({ where: { id: memberId } })
    expect(updated?.enterpriseRole).toBe('REVIEWER')
  })

  it('非 ADMIN 调用 PATCH 被 403 拦截', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/members/${memberId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ enterpriseRole: 'REVIEWER' })

    expect(res.status).toBe(403)
  })

  it('不能修改自己的角色', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/members/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enterpriseRole: 'EMPLOYEE' })

    expect(res.status).toBe(400)
  })

  it('修改其他企业成员返回 404', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/members/${otherMemberId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enterpriseRole: 'REVIEWER' })

    expect(res.status).toBe(404)
  })

  it('非法角色返回 400', async () => {
    const res = await request(app)
      .patch(`/api/enterprise/members/${memberId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enterpriseRole: 'OWNER' })

    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/enterprise/members/:id', () => {
  it('ADMIN 可移除本企业成员', async () => {
    const res = await request(app)
      .delete(`/api/enterprise/members/${memberId}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const updated = await prisma.appUser.findUnique({ where: { id: memberId } })
    expect(updated?.enterpriseId).toBeNull()
    expect(updated?.enterpriseRole).toBeNull()
  })

  it('非 ADMIN 调用 DELETE 被 403 拦截', async () => {
    const res = await request(app)
      .delete(`/api/enterprise/members/${memberId}`)
      .set('Authorization', `Bearer ${managerToken}`)

    expect(res.status).toBe(403)
  })

  it('不能移除自己', async () => {
    const res = await request(app)
      .delete(`/api/enterprise/members/${adminId}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
  })

  it('移除其他企业成员返回 404', async () => {
    const res = await request(app)
      .delete(`/api/enterprise/members/${otherMemberId}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(404)
  })
})

describe('POST /api/enterprise/members/batch-remove', () => {
  const PATH = '/api/enterprise/members/batch-remove'

  it('ADMIN 批量移除本企业成员；自己 + 跨企业成员落入 skipped', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [memberId, adminId, otherMemberId] })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(1)
    expect(res.body.requested).toBe(3)
    expect(res.body.skipped).toBe(2)

    const m = await prisma.appUser.findUnique({ where: { id: memberId } })
    expect(m?.enterpriseId).toBeNull()
    expect(m?.enterpriseRole).toBeNull()
    // 自己不会被移除
    const self = await prisma.appUser.findUnique({ where: { id: adminId } })
    expect(self?.enterpriseId).toBe(enterpriseId)
    // 跨企业成员不会被动
    const other = await prisma.appUser.findUnique({ where: { id: otherMemberId } })
    expect(other?.enterpriseId).toBe(otherEnterpriseId)
  })

  it('非 ADMIN（MANAGER）→ 403', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ ids: [memberId] })
    expect(res.status).toBe(403)
  })

  it('ids 空 → 400', async () => {
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [] })
    expect(res.status).toBe(400)
  })
})
