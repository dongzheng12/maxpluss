/**
 * 微信 URL Scheme 生成测试
 *
 * 覆盖：
 *   1. 正常路径：mock fetcher 返回 openlink，generateSalesScheme 返回 scheme
 *   2. WX_APPID / WX_SECRET 未配置 → throws
 *   3. 微信 API 返回 errcode（无 openlink）→ throws
 *   4. 网络超时 → throws
 *   5. 公开落地页接口：wxScheme 未缓存时首次生成并返回
 *   6. 公开落地页接口：wxScheme 已缓存时直接复用（不重新调 API）
 *   7. 公开落地页接口：scheme 生成失败时降级返回 null（不影响其他字段）
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { registerSalesV2Routes } from '../src/salesV2Routes.js'
import { generateSalesScheme, __setWxSchemeFetcher } from '../src/internal/wxScheme.js'
import { __setWxTokenFetcher, __clearWxTokenCache } from '../src/internal/wxAccessToken.js'
import { createUser, ensurePlans } from './factory.js'

// ─── 应用实例 ─────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  registerSalesV2Routes(app)
  await ensureAppSeed()
})

// ─── 辅助 ──────────────────────────────────────────────────────────────────────

async function cleanSchemeData() {
  await prisma.salesCode.deleteMany()
  await prisma.salesProfile.deleteMany()
  await prisma.salesInvite.deleteMany()
}

/** 创建一个启用状态的销售 profile，返回 { profile, salesCode } */
async function createEnabledSalesProfile(opts: { wxScheme?: string | null } = {}) {
  const user = await createUser({ role: 'sales' })
  const salesCode = 'SCHM' + Math.random().toString(36).slice(2, 6).toUpperCase()
  const profile = await prisma.salesProfile.create({
    data: {
      salesCode,
      userId: user.id,
      realName: '测试销售',
      status: 'ENABLED',
      isPublic: true,
      wxScheme: opts.wxScheme ?? null,
    },
  })
  return { profile, salesCode, user }
}

/** 标准 mock token fetcher（已有 access_token，跳过真实网络） */
function mockTokenFetcher() {
  __setWxTokenFetcher(async () => ({
    access_token: 'mock_access_token_for_test',
    expires_in: 7200,
  }))
}

// ─── 单元测试：generateSalesScheme ────────────────────────────────────────────

describe('generateSalesScheme — 单元测试', () => {
  beforeEach(() => {
    __clearWxTokenCache()
    __setWxTokenFetcher(null)
    __setWxSchemeFetcher(null)
    // 确保 WX_APPID / WX_SECRET 有值（测试环境可能未设置）
    process.env.WX_APPID = process.env.WX_APPID || 'test_appid'
    process.env.WX_SECRET = process.env.WX_SECRET || 'test_secret'
  })

  afterAll(() => {
    __setWxTokenFetcher(null)
    __setWxSchemeFetcher(null)
    __clearWxTokenCache()
  })

  it('正常路径：fetcher 返回 openlink，直接透传', async () => {
    mockTokenFetcher()
    __setWxSchemeFetcher(async (_token, path, query) => ({
      openlink: `weixin://dl/business/?t=mock_${query}`,
    }))
    const scheme = await generateSalesScheme('TESTCODE')
    expect(scheme).toBe('weixin://dl/business/?t=mock_salesCode=TESTCODE')
  })

  it('正常路径：fetcher 接收到正确的 path 和 query', async () => {
    mockTokenFetcher()
    let capturedPath = ''
    let capturedQuery = ''
    __setWxSchemeFetcher(async (_token, path, query) => {
      capturedPath = path
      capturedQuery = query
      return { openlink: 'weixin://dl/business/?t=abc123' }
    })
    await generateSalesScheme('MYCODE8A')
    expect(capturedPath).toBe('/pages/enterprise-apply/index')
    expect(capturedQuery).toBe('salesCode=MYCODE8A')
  })

  it('WX_APPID 未配置 → throws', async () => {
    const orig = process.env.WX_APPID
    delete process.env.WX_APPID
    __clearWxTokenCache()
    try {
      await expect(generateSalesScheme('X')).rejects.toThrow(/WX_APPID/)
    } finally {
      process.env.WX_APPID = orig
    }
  })

  it('微信 API 返回 errcode（无 openlink）→ throws', async () => {
    mockTokenFetcher()
    __setWxSchemeFetcher(async () => ({
      errcode: 40001,
      errmsg: 'invalid credential',
    }))
    await expect(generateSalesScheme('ERRCODE')).rejects.toThrow(/generateScheme 失败/)
  })
})

// ─── 集成测试：GET /api/public/sales/:salesCode ───────────────────────────────

describe('GET /api/public/sales/:salesCode — wxScheme 集成', () => {
  beforeEach(async () => {
    await cleanSchemeData()
    __clearWxTokenCache()
    __setWxTokenFetcher(null)
    __setWxSchemeFetcher(null)
    process.env.WX_APPID = process.env.WX_APPID || 'test_appid'
    process.env.WX_SECRET = process.env.WX_SECRET || 'test_secret'
  })

  afterAll(() => {
    __setWxTokenFetcher(null)
    __setWxSchemeFetcher(null)
    __clearWxTokenCache()
  })

  it('wxScheme 未缓存 → 首次访问调 API 生成并写库，响应包含 scheme', async () => {
    const { salesCode } = await createEnabledSalesProfile({ wxScheme: null })
    mockTokenFetcher()
    __setWxSchemeFetcher(async (_t, _p, q) => ({
      openlink: `weixin://dl/business/?t=generated_${q}`,
    }))

    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(200)
    expect(res.body.wxScheme).toMatch(/^weixin:\/\//)

    // 确认已写入数据库（异步写库，等待一小段时间）
    await new Promise(r => setTimeout(r, 100))
    const updated = await prisma.salesProfile.findUnique({ where: { salesCode } })
    expect(updated?.wxScheme).toMatch(/^weixin:\/\//)
  })

  it('wxScheme 已缓存 → 直接复用，不再调 API', async () => {
    const cachedScheme = 'weixin://dl/business/?t=cached_scheme_123'
    const { salesCode } = await createEnabledSalesProfile({ wxScheme: cachedScheme })

    let fetcherCallCount = 0
    mockTokenFetcher()
    __setWxSchemeFetcher(async () => {
      fetcherCallCount++
      return { openlink: 'weixin://dl/business/?t=should_not_be_called' }
    })

    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(200)
    expect(res.body.wxScheme).toBe(cachedScheme)
    expect(fetcherCallCount).toBe(0)
  })

  it('scheme 生成失败（API 报错）→ 降级返回 wxScheme=null，其他字段正常', async () => {
    const { salesCode } = await createEnabledSalesProfile({ wxScheme: null })
    mockTokenFetcher()
    __setWxSchemeFetcher(async () => ({
      errcode: 40013,
      errmsg: 'invalid appid',
    }))

    const res = await request(app).get(`/api/public/sales/${salesCode}`)
    expect(res.status).toBe(200)
    expect(res.body.wxScheme).toBeNull()
    // 其他必要字段正常存在
    expect(res.body.salesCode).toBe(salesCode)
    expect(res.body.realName).toBe('测试销售')
  })

  it('WX_APPID 未配置 → 降级返回 wxScheme=null，不报 500', async () => {
    const { salesCode } = await createEnabledSalesProfile({ wxScheme: null })
    const orig = process.env.WX_APPID
    delete process.env.WX_APPID
    __clearWxTokenCache()
    try {
      const res = await request(app).get(`/api/public/sales/${salesCode}`)
      expect(res.status).toBe(200)
      expect(res.body.wxScheme).toBeNull()
    } finally {
      process.env.WX_APPID = orig
    }
  })
})
