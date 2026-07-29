/**
 * 工作台入口配置接口测试 (1.0.2)
 *
 * 端点：GET /api/app/workbench/entries
 * 数据源：ContentConfig group=workbench_entries（seedWorkbenchEntries seed）
 *
 * 覆盖：
 *   - seed 后接口返回 11 个 visible=true 条目（新增 3 个 visible=false 默认不返）
 *   - 字段映射正确（key/label/icon/path/visible/sort/isTab）
 *   - 公开接口（无需登录）
 *   - 单条 admin 关闭后立刻不返
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { ensurePlans, bodyItems, findItem } from './factory.js'

interface WorkbenchEntry {
  key: string
  label: string
  icon: string
  path: string
  visible: boolean
  sort: number
  isTab: boolean
}

const app = express()
app.use(express.json())

beforeAll(async () => {
  // 清掉 contentConfig 旧数据，再重 seed，保证测试隔离
  await prisma.contentConfig.deleteMany({ where: { group: 'workbench_entries' } })
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

describe('GET /api/app/workbench/entries', () => {
  it('200 + 仅返回 visible=true 的 11 个条目', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.items)).toBe(true)
    expect(res.body.items.length).toBe(11) // seed 中 visible=true 共 11 个
  })

  it('字段映射完整：key/label/icon/path/visible/sort/isTab', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    const chat = findItem<WorkbenchEntry>(res, (e) => e.key === 'chat')
    expect(chat).toBeDefined()
    expect(chat!.label).toBe('呼叫小智')
    expect(chat!.icon).toBe('chat')
    expect(chat!.path).toBe('/pages/chat/index')
    expect(chat!.visible).toBe(true)
    expect(chat!.sort).toBe(1)
    expect(chat!.isTab).toBe(false)
  })

  it('compare 入口 isTab=true（接口正确透传）', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    const compare = findItem<WorkbenchEntry>(res, (e) => e.key === 'compare')
    expect(compare).toBeDefined()
    expect(compare!.isTab).toBe(true)
  })

  it('按 sort ASC 排列', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    const sorts = bodyItems<WorkbenchEntry>(res).map((e) => e.sort)
    const sorted = [...sorts].sort((a, b) => a - b)
    expect(sorts).toEqual(sorted)
  })

  it('新增的 3 个骨架页 (workbench/expert-vote/draft-center) 默认 visible=false 不出现', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    const keys = bodyItems<WorkbenchEntry>(res).map((e) => e.key)
    expect(keys).not.toContain('workbench')
    expect(keys).not.toContain('expert-vote')
    expect(keys).not.toContain('draft-center')
  })

  it('admin 把 visible=false 的条目开成 true 后立刻可见', async () => {
    // 直接改 DB 模拟 admin 操作
    await prisma.contentConfig.update({
      where: { key: 'workbench_entry_workbench' },
      data: { enabled: true },
    })
    const res = await request(app).get('/api/app/workbench/entries')
    const wb = findItem<WorkbenchEntry>(res, (e) => e.key === 'workbench')
    expect(wb).toBeDefined()
    expect(wb!.label).toBe('我的工作台')
    expect(wb!.path).toBe('/pages/workbench/index')

    // 复原以免影响其他测试
    await prisma.contentConfig.update({
      where: { key: 'workbench_entry_workbench' },
      data: { enabled: false },
    })
  })

  it('Cache-Control: public, max-age=300（CDN/客户端缓存契约）', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('无需登录（公开接口，不带 Authorization 也能访问）', async () => {
    const res = await request(app).get('/api/app/workbench/entries')
    expect(res.status).toBe(200)
  })
})
