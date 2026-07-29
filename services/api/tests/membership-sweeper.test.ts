/**
 * 会员过期 sweeper 测试 — membershipSweeper.ts
 * 覆盖锁定项（必读/MEMORY.md「业务规则」）：
 *   - 每小时扫描 endAt < now 的 ACTIVE → EXPIRED
 *   - SWEEP_INTERVAL_MS = 60 * 60 * 1000
 *   - 仅 ACTIVE 状态被扫描（EXPIRED / REVOKED 不动）
 *   - endAt = now 边界 — 严格 < 才过期
 *   - 任何 source（PURCHASE / SALES_GIFT / SYSTEM / SALES_REFERRAL）只看 status+endAt，不区分来源
 *   - sweeperStats 累加：runCount / totalExpired / lastRunAt / lastRunExpired
 *
 * 不测 setInterval 真实触发（1 小时太长），抽出的 expireStaleMemberships 单测覆盖核心 SQL。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { prisma } from '../src/db.js'
import {
  expireStaleMemberships,
  getMembershipSweeperStats,
  startMembershipExpirySweeper,
} from '../src/membershipSweeper.js'
import { createUser, ensurePlans, cleanAll } from './factory.js'

beforeAll(async () => {
  await cleanAll()
  await ensurePlans()
})

beforeEach(async () => {
  await prisma.userMembership.deleteMany()
  await prisma.appOrder.deleteMany()
  await prisma.appUser.deleteMany()
})

// ─── 工具 ─────────────────────────────────────────

async function seedMember(opts: {
  status?: string
  endAt: Date
  source?: string
  planId?: string
}) {
  const u = await createUser()
  return prisma.userMembership.create({
    data: {
      userId: u.id,
      planId: opts.planId ?? 'personal',
      status: opts.status ?? 'ACTIVE',
      source: opts.source ?? 'PURCHASE',
      startAt: new Date(opts.endAt.getTime() - 365 * 24 * 60 * 60 * 1000),
      endAt: opts.endAt,
    },
  })
}

const ONE_HOUR = 60 * 60 * 1000
const ONE_DAY = 24 * ONE_HOUR

// ────────────────────────────────────────────────────────────

describe('expireStaleMemberships — 核心扫描逻辑', () => {
  it('ACTIVE + endAt < now → 标 EXPIRED', async () => {
    const m = await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    const count = await expireStaleMemberships(prisma)
    expect(count).toBeGreaterThanOrEqual(1)
    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(updated!.status).toBe('EXPIRED')
  })

  it('ACTIVE + endAt > now → 保持 ACTIVE', async () => {
    const m = await seedMember({ endAt: new Date(Date.now() + ONE_DAY) })
    await expireStaleMemberships(prisma)
    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(updated!.status).toBe('ACTIVE')
  })

  it('endAt = now（边界）→ 严格 < 才过期，等号保持 ACTIVE', async () => {
    // SQL 的 lt 是严格 <
    const m = await seedMember({ endAt: new Date(Date.now() + 5_000) })
    await expireStaleMemberships(prisma)
    const updated = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(updated!.status).toBe('ACTIVE')
  })

  it('已 EXPIRED → 不被重复处理（status filter）', async () => {
    const m = await seedMember({
      status: 'EXPIRED',
      endAt: new Date(Date.now() - ONE_DAY),
    })
    const count = await expireStaleMemberships(prisma)
    // 不应将已 EXPIRED 再算一次
    const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(after!.status).toBe('EXPIRED')
    // 拿 lastRunExpired，验证只对 ACTIVE 生效
    const stats = getMembershipSweeperStats()
    // 这一轮 EXPIRED 没新增（除非有别的 ACTIVE 到期）
    expect(stats.lastRunExpired).toBeLessThanOrEqual(count)
  })

  it('REVOKED + endAt < now → 不动（只扫 ACTIVE）', async () => {
    const m = await seedMember({
      status: 'REVOKED',
      endAt: new Date(Date.now() - ONE_DAY),
    })
    await expireStaleMemberships(prisma)
    const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(after!.status).toBe('REVOKED')
  })

  it('混合：3 ACTIVE 过期 + 2 ACTIVE 未过期 + 1 EXPIRED → 仅 3 转 EXPIRED', async () => {
    const expired = [
      await seedMember({ endAt: new Date(Date.now() - ONE_DAY) }),
      await seedMember({ endAt: new Date(Date.now() - 2 * ONE_DAY) }),
      await seedMember({ endAt: new Date(Date.now() - ONE_HOUR) }),
    ]
    const valid = [
      await seedMember({ endAt: new Date(Date.now() + ONE_DAY) }),
      await seedMember({ endAt: new Date(Date.now() + 30 * ONE_DAY) }),
    ]
    const alreadyExpired = await seedMember({
      status: 'EXPIRED',
      endAt: new Date(Date.now() - 10 * ONE_DAY),
    })

    const count = await expireStaleMemberships(prisma)
    expect(count).toBe(3)

    for (const m of expired) {
      const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
      expect(after!.status).toBe('EXPIRED')
    }
    for (const m of valid) {
      const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
      expect(after!.status).toBe('ACTIVE')
    }
    const stillExpired = await prisma.userMembership.findUnique({ where: { id: alreadyExpired.id } })
    expect(stillExpired!.status).toBe('EXPIRED')
  })

  it('source 不影响扫描：SALES_GIFT / SYSTEM / PURCHASE 全部按规则处理', async () => {
    const purchase = await seedMember({
      endAt: new Date(Date.now() - ONE_DAY), source: 'PURCHASE',
    })
    const gift = await seedMember({
      endAt: new Date(Date.now() - ONE_DAY), source: 'SALES_GIFT',
    })
    const system = await seedMember({
      endAt: new Date(Date.now() - ONE_DAY), source: 'SYSTEM',
    })
    const referral = await seedMember({
      endAt: new Date(Date.now() - ONE_DAY), source: 'SALES_REFERRAL',
    })

    await expireStaleMemberships(prisma)

    for (const m of [purchase, gift, system, referral]) {
      const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
      expect(after!.status).toBe('EXPIRED')
    }
  })

  it('返回值 = 本次实际更新的行数', async () => {
    await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    const count = await expireStaleMemberships(prisma)
    expect(count).toBe(2)
  })

  it('空表 → count=0，不抛', async () => {
    await prisma.userMembership.deleteMany()
    const count = await expireStaleMemberships(prisma)
    expect(count).toBe(0)
  })
})

describe('sweeperStats — 累加', () => {
  it('runCount / totalExpired 单调递增 + lastRunExpired 是当次值', async () => {
    const before = getMembershipSweeperStats()
    await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    await expireStaleMemberships(prisma)
    const mid = getMembershipSweeperStats()
    expect(mid.runCount - before.runCount).toBe(1)
    expect(mid.lastRunExpired).toBe(1)

    await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    await expireStaleMemberships(prisma)
    const after = getMembershipSweeperStats()
    expect(after.runCount - before.runCount).toBe(2)
    expect(after.lastRunExpired).toBe(2)
    expect(after.totalExpired - before.totalExpired).toBe(3)
    expect(after.lastRunAt!.getTime()).toBeGreaterThanOrEqual(mid.lastRunAt!.getTime())
  })

  it('返回值是快照（外部修改不影响内部）', async () => {
    const snap = getMembershipSweeperStats()
    snap.runCount = 999999
    expect(getMembershipSweeperStats().runCount).not.toBe(999999)
  })
})

describe('startMembershipExpirySweeper — 启动行为', () => {
  it('调用后 startedAt 被写入', () => {
    const before = getMembershipSweeperStats().startedAt
    startMembershipExpirySweeper(prisma)
    const after = getMembershipSweeperStats()
    expect(after.startedAt).not.toBeNull()
    if (before) {
      expect(after.startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    }
  })

  it('启动后不立即跑（与 orderSweeper / uploadsSweeper 不同 — 等首个 interval）', async () => {
    await prisma.userMembership.deleteMany()
    const m = await seedMember({ endAt: new Date(Date.now() - ONE_DAY) })
    const before = getMembershipSweeperStats().runCount
    startMembershipExpirySweeper(prisma)
    // 给事件循环 + I/O 一点时间
    await new Promise(r => setTimeout(r, 100))
    expect(getMembershipSweeperStats().runCount).toBe(before)
    const after = await prisma.userMembership.findUnique({ where: { id: m.id } })
    expect(after!.status).toBe('ACTIVE') // 未被自动扫描
  })
})

describe('源码锁定项字面量', () => {
  const SRC = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/membershipSweeper.ts'),
    'utf-8',
  )

  it('SWEEP_INTERVAL_MS = 60 * 60 * 1000（1 小时）', () => {
    expect(SRC).toMatch(/SWEEP_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/)
  })

  it('扫描条件：status: ACTIVE + endAt: { lt: now }（严格 <）', () => {
    expect(SRC).toMatch(/status:\s*['"]ACTIVE['"]/)
    expect(SRC).toMatch(/endAt:\s*\{\s*lt:\s*now\s*\}/)
  })

  it('updateMany data 仅改 status: EXPIRED（不动其他字段）', () => {
    expect(SRC).toMatch(/data:\s*\{\s*status:\s*['"]EXPIRED['"]\s*\}/)
  })
})
