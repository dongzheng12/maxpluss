/**
 * CMS 展示内容管理 — 端到端测试
 *
 * 覆盖：
 *  - GET /api/content-config        公开接口，返回 enabled 条目
 *  - GET /api/content-config?group= 按分组过滤
 *  - GET /api/admin/content-config  admin 鉴权（无 token / 普通 user 被拦）
 *  - PUT /api/admin/content-config/:key  admin 更新 content / enabled / sortOrder
 *  - 边界：key 不存在 → 404
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans } from './factory.js'
import { createId } from '@paralleldrive/cuid2'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

// ──────────────────────────── 辅助 ────────────────────────────

async function clearConfigs() {
  await (prisma as any).contentConfig.deleteMany()
}

async function seedConfig(overrides: Partial<{
  key: string
  group: string
  platform: string
  type: string
  content: string
  enabled: boolean
  sortOrder: number
}> = {}) {
  const key = overrides.key ?? `test_key_${createId()}`
  return (prisma as any).contentConfig.create({
    data: {
      id: createId(),
      key,
      group: overrides.group ?? 'test_group',
      platform: overrides.platform ?? 'WEB',
      type: overrides.type ?? 'TEXT',
      content: overrides.content ?? '测试内容',
      enabled: overrides.enabled !== undefined ? overrides.enabled : true,
      sortOrder: overrides.sortOrder ?? 0,
    },
  })
}

// ──────────────────────────── 公开接口 ────────────────────────────

describe('GET /api/content-config — 公开接口', () => {
  beforeEach(clearConfigs)

  it('返回所有 enabled=true 的条目', async () => {
    await seedConfig({ key: 'pub_1', group: 'g1', enabled: true })
    await seedConfig({ key: 'pub_2', group: 'g1', enabled: false })
    await seedConfig({ key: 'pub_3', group: 'g2', enabled: true })

    const res = await request(app).get('/api/content-config')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
    const keys = res.body.items.map((i: any) => i.key)
    expect(keys).toContain('pub_1')
    expect(keys).toContain('pub_3')
    expect(keys).not.toContain('pub_2')
  })

  it('?group= 只返回该分组的 enabled 条目', async () => {
    await seedConfig({ key: 'grp_a1', group: 'hero_tags', enabled: true })
    await seedConfig({ key: 'grp_a2', group: 'hero_tags', enabled: true })
    await seedConfig({ key: 'grp_b1', group: 'other', enabled: true })

    const res = await request(app).get('/api/content-config?group=hero_tags')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2)
    expect(res.body.items.every((i: any) => i.group === 'hero_tags')).toBe(true)
  })

  it('无数据时返回空数组', async () => {
    const res = await request(app).get('/api/content-config?group=nonexistent')
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(0)
  })
})

// ──────────────────────────── Admin GET 鉴权 ────────────────────────────

describe('GET /api/admin/content-config — 权限拦截', () => {
  it('无 token → 401', async () => {
    const res = await request(app).get('/api/admin/content-config')
    expect(res.status).toBe(401)
  })

  it('普通 user token → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const res = await request(app)
      .get('/api/admin/content-config')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('admin token → 200，返回所有条目（含 disabled）', async () => {
    await clearConfigs()
    await seedConfig({ key: 'admin_vis_1', enabled: true })
    await seedConfig({ key: 'admin_vis_2', enabled: false })

    const admin = await createUser({ role: 'admin' })
    const token = getTestToken(admin.id, 'admin')
    const res = await request(app)
      .get('/api/admin/content-config')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.items.length).toBeGreaterThanOrEqual(2)
  })
})

// ──────────────────────────── Admin PUT ────────────────────────────

describe('PUT /api/admin/content-config/:key', () => {
  let adminToken: string

  beforeAll(async () => {
    const admin = await createUser({ role: 'admin' })
    adminToken = getTestToken(admin.id, 'admin')
  })

  beforeEach(clearConfigs)

  it('无 token → 401', async () => {
    const res = await request(app).put('/api/admin/content-config/any_key').send({ content: 'x' })
    expect(res.status).toBe(401)
  })

  it('普通 user → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const res = await request(app)
      .put('/api/admin/content-config/any_key')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'x' })
    expect(res.status).toBe(403)
  })

  it('key 不存在 → 404', async () => {
    const res = await request(app)
      .put('/api/admin/content-config/nonexistent_key_xyz')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '新内容' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/不存在/)
  })

  it('更新 content → DB 写入 + 返回 ok', async () => {
    const cfg = await seedConfig({ key: 'update_test', content: '旧内容' })
    const res = await request(app)
      .put(`/api/admin/content-config/${cfg.key}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ content: '新内容' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.item.content).toBe('新内容')

    // 验证 DB 写入
    const fromDb = await (prisma as any).contentConfig.findUnique({ where: { key: cfg.key } })
    expect(fromDb.content).toBe('新内容')
  })

  it('更新 enabled=false → DB 禁用', async () => {
    const cfg = await seedConfig({ key: 'toggle_test', enabled: true })
    const res = await request(app)
      .put(`/api/admin/content-config/${cfg.key}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.item.enabled).toBe(false)

    // 公开接口不再返回该条目
    const pubRes = await request(app).get('/api/content-config')
    const keys = pubRes.body.items.map((i: any) => i.key)
    expect(keys).not.toContain(cfg.key)
  })

  it('更新 sortOrder → 排序正确', async () => {
    await seedConfig({ key: 'sort_a', group: 'sg', sortOrder: 5 })
    await seedConfig({ key: 'sort_b', group: 'sg', sortOrder: 1 })

    await request(app)
      .put('/api/admin/content-config/sort_a')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ sortOrder: 0 })

    const res = await request(app).get('/api/content-config?group=sg')
    expect(res.status).toBe(200)
    expect(res.body.items[0].key).toBe('sort_a')
  })
})
