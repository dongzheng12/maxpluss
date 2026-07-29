/**
 * 阶段 0 — /api/app/pricing + /api/app/membership/plans 测试
 *
 * 覆盖：
 *  - /api/app/pricing 返回 plans + compareUnlock
 *  - 每个 plan 含完整字段：id/name/price/badge/description/features/originalPrice/priceUnit/unit/color/bg/note/quotas
 *  - admin 改 MembershipPlan 后接口跟随（真读 DB，非 hardcoded）
 *  - 兜底：DB 行 featuresJson 是旧的纯数组格式时，正确反序列化为 features 数组
 *  - 兜底：缺字段（originalPrice/unit 等）时，从 appData.ts hardcoded 同 id 兜底
 *  - SystemSetting compare_unlock_price 改 → compareUnlock 跟随
 *  - 缺省 compareUnlock = 400
 *  - /api/app/membership/plans 同样真读 DB
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { ensurePlans } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

describe('GET /api/app/pricing', () => {
  afterEach(async () => {
    // 清理本测试可能写的 SystemSetting
    await prisma.systemSetting.delete({ where: { key: 'compare_unlock_price' } }).catch(() => null)
  })

  it('返回 plans 数组 + compareUnlock，plan 含完整字段', async () => {
    const res = await request(app).get('/api/app/pricing')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.plans)).toBe(true)
    expect(res.body.plans.length).toBeGreaterThanOrEqual(2)
    expect(typeof res.body.compareUnlock).toBe('number')

    for (const plan of res.body.plans) {
      expect(plan).toHaveProperty('id')
      expect(plan).toHaveProperty('name')
      expect(typeof plan.price).toBe('number')
      expect(plan).toHaveProperty('badge')
      expect(plan).toHaveProperty('description')
      expect(Array.isArray(plan.features)).toBe(true)
      expect(plan).toHaveProperty('originalPrice')
      expect(plan).toHaveProperty('priceUnit')
      expect(plan).toHaveProperty('unit')
      expect(plan).toHaveProperty('color')
      expect(plan).toHaveProperty('bg')
      expect(plan).toHaveProperty('note')
      expect(plan).toHaveProperty('quotas')
    }
  })

  it('admin 改 DB plan price → 接口跟随（真读 DB）', async () => {
    const before = await request(app).get('/api/app/pricing')
    const personalBefore = before.body.plans.find((p: any) => p.id === 'personal')
    const original = personalBefore.price

    await prisma.membershipPlan.update({
      where: { id: 'personal' },
      data: { price: 777 },
    })

    const after = await request(app).get('/api/app/pricing')
    const personalAfter = after.body.plans.find((p: any) => p.id === 'personal')
    expect(personalAfter.price).toBe(777)

    // 恢复
    await prisma.membershipPlan.update({
      where: { id: 'personal' },
      data: { price: original },
    })
  })

  it('featuresJson 为旧纯数组格式时仍能反序列化（向后兼容）', async () => {
    const oldFormat = JSON.stringify(['权益 A', '权益 B', '权益 C'])
    await prisma.membershipPlan.update({
      where: { id: 'personal' },
      data: { featuresJson: oldFormat },
    })

    const res = await request(app).get('/api/app/pricing')
    const personal = res.body.plans.find((p: any) => p.id === 'personal')
    expect(personal.features).toEqual(['权益 A', '权益 B', '权益 C'])
    // 缺字段从 appData.ts hardcoded 兜底
    expect(personal.unit).toBe('年')
    expect(personal.originalPrice).toBeGreaterThan(0)
  })

  it('SystemSetting compare_unlock_price 改 → compareUnlock 跟随', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'compare_unlock_price' },
      update: { value: '688' },
      create: { key: 'compare_unlock_price', value: '688' },
    })
    const res = await request(app).get('/api/app/pricing')
    expect(res.body.compareUnlock).toBe(688)
  })

  it('compareUnlock 缺省 400', async () => {
    await prisma.systemSetting.delete({ where: { key: 'compare_unlock_price' } }).catch(() => null)
    const res = await request(app).get('/api/app/pricing')
    expect(res.body.compareUnlock).toBe(400)
  })

  it('compareUnlock 非数字 → 兜底 400', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'compare_unlock_price' },
      update: { value: 'not-a-number' },
      create: { key: 'compare_unlock_price', value: 'not-a-number' },
    })
    const res = await request(app).get('/api/app/pricing')
    expect(res.body.compareUnlock).toBe(400)
  })
})

describe('GET /api/app/membership/plans — 阶段 0 改读 DB', () => {
  it('plans 来自 DB（admin 改后接口跟随）', async () => {
    await prisma.membershipPlan.update({
      where: { id: 'pro' },
      data: { price: 1234 },
    })
    const res = await request(app).get('/api/app/membership/plans')
    expect(res.status).toBe(200)
    const pro = res.body.plans.find((p: any) => p.id === 'pro')
    expect(pro.price).toBe(1234)

    // 恢复（hardcoded 998）
    await prisma.membershipPlan.update({
      where: { id: 'pro' },
      data: { price: 998 },
    })
  })

  it('plans 含完整字段（features + originalPrice + quotas 等）', async () => {
    const res = await request(app).get('/api/app/membership/plans')
    for (const plan of res.body.plans) {
      expect(plan).toHaveProperty('features')
      expect(Array.isArray(plan.features)).toBe(true)
      expect(plan).toHaveProperty('originalPrice')
      expect(plan).toHaveProperty('quotas')
    }
  })
})
