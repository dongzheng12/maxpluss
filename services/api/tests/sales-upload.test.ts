/**
 * 销售上传权限测试
 *
 * 覆盖 /api/app/sales/upload：
 *   - 历史 role=sales 可上传
 *   - 新角色系统分配"销售"内置角色可上传
 *   - 普通 user 被拒绝
 *   - admin 保持原放行逻辑
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { unlink } from 'fs/promises'
import { join } from 'path'
import { prisma } from '../src/db.js'
import { registerSalesRoutes } from '../src/salesRoutes.js'
import { ensureBuiltInRoles, SALES_BUILT_IN_ROLE_NAME } from '../src/services/builtInRoles.js'
import { createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())
registerSalesRoutes(app)

const TEST_PHONE_PREFIX = '139881'
const png = Buffer.from('test-image')
const uploaded: string[] = []

async function cleanup() {
  const users = await prisma.appUser.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  })
  const ids = users.map(u => u.id)
  if (ids.length > 0) {
    await prisma.adminUserRole.deleteMany({ where: { userId: { in: ids } } })
    await prisma.appUser.deleteMany({ where: { id: { in: ids } } })
  }
}

async function grantSalesRole(userId: string) {
  await ensureBuiltInRoles('test')
  const role = await prisma.adminRole.findUnique({ where: { name: SALES_BUILT_IN_ROLE_NAME } })
  if (!role) throw new Error('销售内置角色不存在')
  await prisma.adminUserRole.create({
    data: { userId, roleId: role.id, status: 'ACTIVE', assignedBy: 'test' },
  })
}

function uploadAs(token: string) {
  return request(app)
    .post('/api/app/sales/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', png, { filename: 'avatar.png', contentType: 'image/png' })
}

beforeEach(async () => {
  await cleanup()
  uploaded.splice(0, uploaded.length)
})

afterEach(async () => {
  await Promise.all(uploaded.map(async (filename) => {
    try {
      await unlink(join(process.cwd(), 'uploads', 'sales', filename))
    } catch {}
  }))
  uploaded.splice(0, uploaded.length)
})

afterAll(async () => {
  await cleanup()
})

describe('POST /api/app/sales/upload', () => {
  it('旧 role=sales 用户上传仍可用', async () => {
    const sales = await createUser({ phone: `${TEST_PHONE_PREFIX}00001`, role: 'sales' })

    const res = await uploadAs(getTestToken(sales.id, 'sales'))

    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^\/uploads\/sales\/sales-.+\.png$/)
    uploaded.push(res.body.filename)
  })

  it('新角色系统销售用户上传可用', async () => {
    const user = await createUser({ phone: `${TEST_PHONE_PREFIX}00002`, role: 'user' })
    await grantSalesRole(user.id)

    const res = await uploadAs(getTestToken(user.id, 'user'))

    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^\/uploads\/sales\/sales-.+\.png$/)
    uploaded.push(res.body.filename)
  })

  it('普通 user 上传仍被拒绝', async () => {
    const user = await createUser({ phone: `${TEST_PHONE_PREFIX}00003`, role: 'user' })

    const res = await uploadAs(getTestToken(user.id, 'user'))

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('无权上传')
  })

  it('admin 上传保持可用', async () => {
    const admin = await createUser({ phone: `${TEST_PHONE_PREFIX}00004`, role: 'admin' })

    const res = await uploadAs(getTestToken(admin.id, 'admin'))

    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^\/uploads\/sales\/sales-.+\.png$/)
    uploaded.push(res.body.filename)
  })
})
