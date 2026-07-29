/**
 * 公告公开详情接口测试
 *
 * 覆盖：
 *  - GET /api/app/announcements/:id   命中 → 返回 {id, title, date, content}
 *  - GET /api/app/announcements/:id   id 不存在 → 404
 *  - GET /api/app/announcements/:id   systemSetting 缺失（空库）→ 404
 *
 * 该接口为公开只读，无需鉴权，因此不测权限拦截。
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  registerAppRoutes(app)
  await ensureAppSeed()
})

const ANN_KEY = 'announcements_list'

async function setAnnouncements(list: any[]) {
  await prisma.systemSetting.upsert({
    where: { key: ANN_KEY },
    update: { value: JSON.stringify(list) },
    create: { key: ANN_KEY, value: JSON.stringify(list) },
  })
}

async function clearAnnouncements() {
  await prisma.systemSetting.deleteMany({ where: { key: ANN_KEY } })
}

describe('GET /api/app/announcements/:id', () => {
  beforeEach(async () => {
    await clearAnnouncements()
  })

  it('命中：返回精简字段 {id,title,date,content}', async () => {
    await setAnnouncements([
      {
        id: 'ann-test-1',
        title: '测试公告标题',
        content: '公告正文 ABC',
        date: '2026-05-01',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ])

    const res = await request(app).get('/api/app/announcements/ann-test-1')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: 'ann-test-1',
      title: '测试公告标题',
      date: '2026-05-01',
      content: '公告正文 ABC',
    })
    expect(res.body).not.toHaveProperty('createdAt')
  })

  it('id 不存在：404', async () => {
    await setAnnouncements([{ id: 'ann-A', title: 'A', content: 'a', date: '2026-05-01' }])
    const res = await request(app).get('/api/app/announcements/not-exist')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeTruthy()
  })

  it('systemSetting 缺失（空库）：404 而非 500', async () => {
    const res = await request(app).get('/api/app/announcements/anything')
    expect(res.status).toBe(404)
    expect(res.body.error).toBeTruthy()
  })

  it('content/date 缺省时返回空串', async () => {
    await setAnnouncements([{ id: 'ann-partial', title: '只有标题' }])
    const res = await request(app).get('/api/app/announcements/ann-partial')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: 'ann-partial',
      title: '只有标题',
      date: '',
      content: '',
    })
  })
})
