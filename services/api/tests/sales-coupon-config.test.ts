/**
 * 销售推广页 AI 详情页优惠券远程配置 — 端到端测试
 *
 * 覆盖：
 *  - ensureAppSeed() 注入 sales_ai_coupon_main 默认配置（结构 + 字段值）
 *  - GET /api/content-config?group=sales_ai_coupon 返回该条目
 *  - admin 关停 enabled=false 后公开接口不再返回（前端据此隐藏卡片）
 *  - extraJson 反序列化结构（tag / amountPrefix / benefits / validityDays / cta…）
 *  - 重复跑 ensureAppSeed() 不覆盖 admin 的运营改动（upsert update:{}）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans, bodyItems, findItem } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

describe('sales_ai_coupon — 默认 seed', () => {
  it('ensureAppSeed 注入 sales_ai_coupon_main 条目（含必要字段）', async () => {
    const cfg = await prisma.contentConfig.findUnique({
      where: { key: 'sales_ai_coupon_main' },
    })
    expect(cfg).toBeTruthy()
    expect(cfg.group).toBe('sales_ai_coupon')
    expect(cfg.platform).toBe('WEB')
    expect(cfg.type).toBe('COUPON_CARD')
    expect(cfg.enabled).toBe(true)
    expect(cfg.title).toBe('专属优惠')
    expect(cfg.subtitle).toBe('会员直减券')
    expect(cfg.description).toMatch(/销售推广页/)
    expect(cfg.content).toBe('50')
    expect(cfg.extraJson).toBeTruthy()

    const extra = JSON.parse(cfg.extraJson as string)
    expect(extra.tag).toBe('限时')
    expect(extra.amountPrefix).toBe('¥')
    expect(Array.isArray(extra.benefits)).toBe(true)
    expect(extra.benefits.length).toBeGreaterThan(0)
    expect(extra.validityDays).toBe(60)
    expect(extra.scene).toBe('sales_promotion_ai_detail')
    expect(Array.isArray(extra.applicablePlans)).toBe(true)
    expect(typeof extra.ctaText).toBe('string')
    expect(typeof extra.ctaAction).toBe('string')
  })

  it('GET /api/content-config?group=sales_ai_coupon 公开接口能取到', async () => {
    const res = await request(app).get('/api/content-config?group=sales_ai_coupon')
    expect(res.status).toBe(200)
    const items = bodyItems<{ key: string; enabled: boolean; extraJson: unknown }>(res)
    expect(items.length).toBeGreaterThanOrEqual(1)
    const main = items.find(i => i.key === 'sales_ai_coupon_main')
    expect(main).toBeTruthy()
    expect(main!.enabled).toBe(true)
    expect(main!.extraJson).toBeTruthy()
  })

  it('重复跑 ensureAppSeed() 不覆盖 admin 改动（upsert update:{}）', async () => {
    // admin 改 content：从 50 → 80
    const adminUser = await createUser({ role: 'admin' })
    const token = getTestToken(adminUser.id, 'admin')
    const putRes = await request(app)
      .put('/api/admin/content-config/sales_ai_coupon_main')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: '80' })
    expect(putRes.status).toBe(200)

    // 再跑一次 seed
    await ensureAppSeed()

    const after = await prisma.contentConfig.findUnique({
      where: { key: 'sales_ai_coupon_main' },
    })
    expect(after.content).toBe('80')

    // 改回去防污染其他用例
    await prisma.contentConfig.update({
      where: { key: 'sales_ai_coupon_main' },
      data: { content: '50', enabled: true },
    })
  })
})

describe('sales_ai_coupon — admin 关停', () => {
  it('admin 设 enabled=false 后公开接口不再返回（前端据此隐藏卡片）', async () => {
    const adminUser = await createUser({ role: 'admin' })
    const token = getTestToken(adminUser.id, 'admin')
    await request(app)
      .put('/api/admin/content-config/sales_ai_coupon_main')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: false })
      .expect(200)

    const res = await request(app).get('/api/content-config?group=sales_ai_coupon')
    expect(res.status).toBe(200)
    expect(findItem<{ key: string }>(res, i => i.key === 'sales_ai_coupon_main')).toBeUndefined()

    // 改回去
    await prisma.contentConfig.update({
      where: { key: 'sales_ai_coupon_main' },
      data: { enabled: true },
    })
  })
})
