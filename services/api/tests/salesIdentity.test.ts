/**
 * ensureSalesProfileAndPrimaryCode 单元测试（v3 §3 统一服务）
 *
 * 覆盖：
 *   - happy path：新用户首次调 → 创建 SalesProfile + 主推码
 *   - 幂等 1：已有 Profile + 主推码 → 不重复创建，created=false primaryCodeCreated=false
 *   - 幂等 2：已有 Profile 但 SalesCode 表缺主码 → 补建主码，created=false primaryCodeCreated=true
 *   - 用户不存在 → throw
 *   - 不修改 AppUser.role / 不影响订单/会员
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import { ensureSalesProfileAndPrimaryCode } from '../src/services/salesIdentity.js'
import { createUser, createMembership, createPaidOrder, ensurePlans } from './factory.js'

async function clean() {
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
}

describe('ensureSalesProfileAndPrimaryCode', () => {
  beforeEach(async () => {
    await ensurePlans()
    await clean()
  })

  it('happy path：新用户首次调 → 创建 Profile + 主推码', async () => {
    const u = await createUser({ role: 'user' })
    const r = await ensureSalesProfileAndPrimaryCode(u.id, { realName: '测试销售', companyName: '测试公司' })
    expect(r.created).toBe(true)
    expect(r.primaryCodeCreated).toBe(true)
    expect(r.primaryCode).toMatch(/^[A-Z2-9]{8}$/)
    expect(r.profile.realName).toBe('测试销售')
    expect(r.profile.companyName).toBe('测试公司')

    const inDb = await prisma.salesProfile.findUnique({ where: { userId: u.id } })
    expect(inDb).not.toBeNull()
    const codes = await prisma.salesCode.findMany({ where: { profileId: r.profile.id } })
    expect(codes).toHaveLength(1)
    expect(codes[0].label).toBe('主码')
    expect(codes[0].status).toBe('ACTIVE')
  })

  it('幂等：已有 Profile + 主推码 → 全部返回 false', async () => {
    const u = await createUser({ role: 'user' })
    const first = await ensureSalesProfileAndPrimaryCode(u.id)
    const second = await ensureSalesProfileAndPrimaryCode(u.id, { realName: '改名应被忽略' })
    expect(second.created).toBe(false)
    expect(second.primaryCodeCreated).toBe(false)
    expect(second.primaryCode).toBe(first.primaryCode)
    expect(second.profile.id).toBe(first.profile.id)
    expect(second.profile.realName).toBe(first.profile.realName) // 不被覆盖
    // SalesCode 仍只有 1 条
    const codes = await prisma.salesCode.findMany({ where: { profileId: first.profile.id } })
    expect(codes).toHaveLength(1)
  })

  it('幂等：已有 Profile 但 SalesCode 表缺主码 → 补建主码', async () => {
    const u = await createUser({ role: 'user' })
    // 手工建 Profile 但不建 SalesCode（模拟历史脏数据）
    const profile = await prisma.salesProfile.create({
      data: { salesCode: 'OLDORPHN', userId: u.id, realName: '旧销售' },
    })
    const r = await ensureSalesProfileAndPrimaryCode(u.id)
    expect(r.created).toBe(false)
    expect(r.primaryCodeCreated).toBe(true)
    expect(r.primaryCode).toBe('OLDORPHN')
    const codes = await prisma.salesCode.findMany({ where: { profileId: profile.id } })
    expect(codes).toHaveLength(1)
    expect(codes[0].label).toBe('主码')
  })

  it('用户不存在 → throw', async () => {
    await expect(ensureSalesProfileAndPrimaryCode('nonexistent-id')).rejects.toThrow(/用户不存在/)
  })

  it('不修改 AppUser.role / 不影响订单/会员', async () => {
    const u = await createUser({ role: 'user' })
    await createMembership(u.id, 'personal')
    await createPaidOrder(u.id, 'personal')

    await ensureSalesProfileAndPrimaryCode(u.id)

    const after = await prisma.appUser.findUnique({ where: { id: u.id } })
    expect(after?.role).toBe('user') // 不动 role
    const memberships = await prisma.userMembership.findMany({ where: { userId: u.id } })
    expect(memberships).toHaveLength(1)
    expect(memberships[0].status).toBe('ACTIVE') // 不动会员
    const orders = await prisma.appOrder.findMany({ where: { userId: u.id } })
    expect(orders).toHaveLength(1)
    expect(orders[0].status).toBe('PAID') // 不动订单
  })

  it('未传 realName 时 fallback 到 user.name；user.name 为空时 fallback "销售"', async () => {
    const u1 = await createUser({ role: 'user' })
    await prisma.appUser.update({ where: { id: u1.id }, data: { name: '老张' } })
    const r1 = await ensureSalesProfileAndPrimaryCode(u1.id)
    expect(r1.profile.realName).toBe('老张')

    const u2 = await createUser({ role: 'user' })
    const r2 = await ensureSalesProfileAndPrimaryCode(u2.id)
    expect(r2.profile.realName).toBe('销售')
  })
})
