/**
 * 阶段 0 — /api/app/feature-flags 测试
 *
 * 覆盖：
 *  - 默认（SystemSetting 无 feature_flags 行）→ 返回 { flags: { couponEnabled: <env> } }
 *  - SystemSetting 写入 → 接口返回该 JSON + env 合并
 *  - env couponEnabled 优先级最高（不被 admin JSON 覆盖）
 *  - SystemSetting value 不是合法 JSON → 不报 500，返回兜底
 *  - Cache-Control: public, max-age=300
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

afterEach(async () => {
  await prisma.systemSetting.delete({ where: { key: 'feature_flags' } }).catch(() => null)
})

describe('GET /api/app/feature-flags', () => {
  it('SystemSetting 无 feature_flags 行 → 返回 { flags: { couponEnabled } }', async () => {
    const res = await request(app).get('/api/app/feature-flags')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('flags')
    expect(res.body.flags).toHaveProperty('couponEnabled')
    expect(typeof res.body.flags.couponEnabled).toBe('boolean')
  })

  it('SystemSetting 有合法 JSON → 接口返回 + env 合并', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'feature_flags' },
      update: { value: JSON.stringify({ scanV2Enabled: true, demoMode: 'A', percent: 50 }) },
      create: { key: 'feature_flags', value: JSON.stringify({ scanV2Enabled: true, demoMode: 'A', percent: 50 }) },
    })
    const res = await request(app).get('/api/app/feature-flags')
    expect(res.body.flags.scanV2Enabled).toBe(true)
    expect(res.body.flags.demoMode).toBe('A')
    expect(res.body.flags.percent).toBe(50)
    expect(res.body.flags).toHaveProperty('couponEnabled')
  })

  it('admin JSON 想覆盖 couponEnabled 也无效（env 优先）', async () => {
    // 测试环境 BXZ_COUPON_ENABLED 未 set → couponEnabled=false
    // admin 写 couponEnabled=true，env 应该把它压回 false
    await prisma.systemSetting.upsert({
      where: { key: 'feature_flags' },
      update: { value: JSON.stringify({ couponEnabled: true }) },
      create: { key: 'feature_flags', value: JSON.stringify({ couponEnabled: true }) },
    })
    const res = await request(app).get('/api/app/feature-flags')
    // env 默认未 set，couponsEnabled() 应返回 false
    expect(res.body.flags.couponEnabled).toBe(false)
  })

  it('SystemSetting value 非法 JSON → 不 500，返回兜底', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'feature_flags' },
      update: { value: '{{not json' },
      create: { key: 'feature_flags', value: '{{not json' },
    })
    const res = await request(app).get('/api/app/feature-flags')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('flags')
    expect(res.body.flags).toHaveProperty('couponEnabled')
  })

  it('Cache-Control: public, max-age=300', async () => {
    const res = await request(app).get('/api/app/feature-flags')
    expect(res.headers['cache-control']).toMatch(/public.*max-age=300/)
  })
})
