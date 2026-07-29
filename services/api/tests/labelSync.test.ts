/**
 * labelSync job 单元测试 — 覆盖 6 种 lifecycle 的判定路径
 *
 * 测试 classifyLifecycle（纯函数）+ runLabelSync 端到端（写事件 → 跑 job → 查 UserLabel）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import { classifyLifecycle, runLabelSync } from '../src/jobs/labelSync.job.js'
import { createUser } from './factory.js'

const NOW = new Date('2026-05-01T12:00:00Z')
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)

async function seedEvent(userId: string, event: string, at: Date) {
  return prisma.analyticsEvent.create({
    data: {
      event,
      platform: 'server',
      userId,
      serverTs: BigInt(at.getTime()),
    },
  })
}

describe('classifyLifecycle 纯函数判定', () => {
  const base = { lastActiveAt: NOW, now: NOW }

  it('无任何核心事件 → NEW', () => {
    expect(classifyLifecycle({ ...base, hasCoreEvent: false, hasPayEvent: false, weeklyActions: 0 })).toBe('NEW')
  })

  it('有核心事件 + 未付费 + 近期活跃 + weekly<10 → ACTIVATED', () => {
    expect(classifyLifecycle({ ...base, hasCoreEvent: true, hasPayEvent: false, weeklyActions: 3 })).toBe('ACTIVATED')
  })

  it('有核心事件 + 付费过 → PAID（优先于 ACTIVATED）', () => {
    expect(classifyLifecycle({ ...base, hasCoreEvent: true, hasPayEvent: true, weeklyActions: 3 })).toBe('PAID')
  })

  it('近 7 天 ≥ 10 次 → HIGH_ACTIVE（优先于 PAID）', () => {
    expect(classifyLifecycle({ ...base, hasCoreEvent: true, hasPayEvent: true, weeklyActions: 12 })).toBe('HIGH_ACTIVE')
  })

  it('曾激活 + lastActiveAt 超过 14 天但不到 30 天 → SILENT', () => {
    expect(classifyLifecycle({
      hasCoreEvent: true, hasPayEvent: false, weeklyActions: 0,
      lastActiveAt: DAYS_AGO(20), now: NOW,
    })).toBe('SILENT')
  })

  it('曾激活 + lastActiveAt 超过 30 天 → CHURNED（优先于 SILENT）', () => {
    expect(classifyLifecycle({
      hasCoreEvent: true, hasPayEvent: false, weeklyActions: 0,
      lastActiveAt: DAYS_AGO(45), now: NOW,
    })).toBe('CHURNED')
  })

  it('PAID 用户 30 天未活跃 → CHURNED（召回流失付费用户的关键）', () => {
    expect(classifyLifecycle({
      hasCoreEvent: true, hasPayEvent: true, weeklyActions: 0,
      lastActiveAt: DAYS_AGO(45), now: NOW,
    })).toBe('CHURNED')
  })
})

describe('runLabelSync 端到端：从 AnalyticsEvent 聚合到 UserLabel', () => {
  beforeEach(async () => {
    // 每条用例独立清场，避免互相污染
    await prisma.userLabel.deleteMany()
    await prisma.analyticsEvent.deleteMany()
    await prisma.appUser.deleteMany({ where: { phone: { startsWith: '13855' } } })
  })

  it('NEW：新用户无事件', async () => {
    const u = await createUser({ phone: '13855550001' })
    const result = await runLabelSync(NOW)
    expect(result.written).toBeGreaterThanOrEqual(1)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('NEW')
    expect(label?.isPaid).toBe(false)
    expect(label?.weeklyActions).toBe(0)
  })

  it('ACTIVATED：有 1 条 search_success，近期活跃', async () => {
    const u = await createUser({ phone: '13855550002' })
    await prisma.appUser.update({ where: { id: u.id }, data: { lastActiveAt: DAYS_AGO(1) } })
    await seedEvent(u.id, 'search_success', DAYS_AGO(1))
    await runLabelSync(NOW)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('ACTIVATED')
    expect(label?.weeklyActions).toBe(1)
  })

  it('PAID：有 pay_success + 有核心事件', async () => {
    const u = await createUser({ phone: '13855550003' })
    await prisma.appUser.update({ where: { id: u.id }, data: { lastActiveAt: DAYS_AGO(3) } })
    await seedEvent(u.id, 'chat_sent', DAYS_AGO(3))
    await seedEvent(u.id, 'pay_success', DAYS_AGO(3))
    await runLabelSync(NOW)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('PAID')
    expect(label?.isPaid).toBe(true)
  })

  it('HIGH_ACTIVE：近 7 天 ≥ 10 次核心事件', async () => {
    const u = await createUser({ phone: '13855550004' })
    await prisma.appUser.update({ where: { id: u.id }, data: { lastActiveAt: DAYS_AGO(1) } })
    for (let i = 0; i < 12; i++) await seedEvent(u.id, 'search_success', DAYS_AGO(1))
    await runLabelSync(NOW)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('HIGH_ACTIVE')
    expect(label?.weeklyActions).toBe(12)
  })

  it('SILENT：lastActiveAt 20 天前 + 曾激活', async () => {
    const u = await createUser({ phone: '13855550005' })
    await prisma.appUser.update({ where: { id: u.id }, data: { lastActiveAt: DAYS_AGO(20) } })
    await seedEvent(u.id, 'compare_complete', DAYS_AGO(20))
    await runLabelSync(NOW)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('SILENT')
    expect(label?.weeklyActions).toBe(0) // 近 7 天无事件
  })

  it('CHURNED：lastActiveAt 45 天前 + 曾付费', async () => {
    const u = await createUser({ phone: '13855550006' })
    await prisma.appUser.update({ where: { id: u.id }, data: { lastActiveAt: DAYS_AGO(45) } })
    await seedEvent(u.id, 'chat_sent', DAYS_AGO(45))
    await seedEvent(u.id, 'pay_success', DAYS_AGO(50))
    await runLabelSync(NOW)
    const label = await prisma.userLabel.findUnique({ where: { userId: u.id } })
    expect(label?.lifecycle).toBe('CHURNED')
    expect(label?.isPaid).toBe(true)
  })

  it('幂等：重复跑结果一致，upsert 不抛错', async () => {
    const u = await createUser({ phone: '13855550007' })
    await seedEvent(u.id, 'search_success', DAYS_AGO(1))
    await runLabelSync(NOW)
    await runLabelSync(NOW)
    const labels = await prisma.userLabel.findMany({ where: { userId: u.id } })
    expect(labels.length).toBe(1)
  })
})
