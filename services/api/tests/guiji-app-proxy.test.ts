/**
 * 归集平台前端代理路由测试 — /api/app/guiji/*
 *
 * 背景：guiji 前端原本硬编码 X-Api-Key 在 index.html，安全风险。
 * 改造后 8082 同源前端走 /api/app/guiji/*，前端不持 key，服务端读 .env
 * 的 BXZ_GUIJI_API_KEY 作为"归集服务启用开关"。原 /api/guiji/* IP 直连
 * 入口仍要求 X-Api-Key，外部归集机构对接路径不变。
 *
 * 覆盖：
 *  - /api/app/guiji/* 不需要前端持 X-Api-Key
 *  - 服务端 BXZ_GUIJI_API_KEY 缺失时 503
 *  - response body / headers 不含真实 key
 *  - ipRateLimit(3, 60_000) 生效
 *  - 原 /api/guiji/* 仍要求 X-Api-Key（401 / 403 / 200 三种路径）
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'

// 用随机 key 防止意外打到真实生产值；长度 64 与生产 hex 一致便于覆盖 timingSafeEqual
const REAL_KEY = 'test-guiji-' + 'a'.repeat(53)

const app = express()
app.use(express.json())

beforeAll(async () => {
  process.env.BXZ_GUIJI_API_KEY = REAL_KEY
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await prisma.compareTask.deleteMany()
  // 防止 cleanAll 被其他文件调用过后 guiji-anonymous 哨兵用户丢失
  await ensureAppSeed()
  process.env.BXZ_GUIJI_API_KEY = REAL_KEY
})

afterAll(async () => {
  await prisma.compareTask.deleteMany()
  delete process.env.BXZ_GUIJI_API_KEY
})

let ipCounter = 100
function uniqueIp(): string {
  ipCounter += 1
  return `10.99.0.${ipCounter}`
}

function postProxy(opts: { ip: string; sendKey?: boolean; fileB?: boolean; mode?: string }) {
  const r = request(app)
    .post('/api/app/guiji/compare/tasks')
    .set('X-Forwarded-For', opts.ip)
    .field('compareMode', opts.mode ?? 'ONE_TO_ONE')
    .field('documentName', 'guiji proxy test')
    .attach('file', Buffer.from('文档A内容'), 'a.docx')
  if (opts.fileB ?? true) r.attach('fileB', Buffer.from('文档B内容'), 'b.docx')
  if (opts.sendKey) r.set('X-Api-Key', REAL_KEY)
  return r
}

describe('/api/app/guiji/* — 前端无 key', () => {
  it('POST 不传 X-Api-Key → 200，任务创建成功', async () => {
    const res = await postProxy({ ip: uniqueIp() })
    expect(res.status).toBe(200)
    expect(res.body.taskNo).toMatch(/^CMP-/)
    expect(res.body.status).toBe('PENDING')
    const task = await prisma.compareTask.findUnique({ where: { taskNo: res.body.taskNo } })
    expect(task?.userId).toBe('guiji-anonymous')
  })

  it('POST library 全库模式 不传 X-Api-Key → 200', async () => {
    const res = await postProxy({ ip: uniqueIp(), fileB: false, mode: 'all' })
    expect(res.status).toBe(200)
    expect(res.body.taskNo).toMatch(/^CMP-/)
  })

  it('GET /:taskNo/status 不传 X-Api-Key → 200', async () => {
    const create = await postProxy({ ip: uniqueIp() })
    const res = await request(app).get(`/api/app/guiji/compare/tasks/${create.body.taskNo}/status`)
    expect(res.status).toBe(200)
    expect(res.body.taskNo).toBe(create.body.taskNo)
    expect(res.body.status).toBe('PENDING')
  })

  it('GET /:taskNo 不传 X-Api-Key → 200', async () => {
    const create = await postProxy({ ip: uniqueIp() })
    const res = await request(app).get(`/api/app/guiji/compare/tasks/${create.body.taskNo}`)
    expect(res.status).toBe(200)
    expect(res.body.taskNo).toBe(create.body.taskNo)
    expect(res.body.compareMode).toBe('ONE_TO_ONE')
  })

  it('response body / headers 不泄漏真实 BXZ_GUIJI_API_KEY', async () => {
    const create = await postProxy({ ip: uniqueIp() })
    expect(JSON.stringify(create.body)).not.toContain(REAL_KEY)
    expect(JSON.stringify(create.headers)).not.toContain(REAL_KEY)

    const status = await request(app).get(`/api/app/guiji/compare/tasks/${create.body.taskNo}/status`)
    expect(JSON.stringify(status.body)).not.toContain(REAL_KEY)
    expect(JSON.stringify(status.headers)).not.toContain(REAL_KEY)

    const detail = await request(app).get(`/api/app/guiji/compare/tasks/${create.body.taskNo}`)
    expect(JSON.stringify(detail.body)).not.toContain(REAL_KEY)
    expect(JSON.stringify(detail.headers)).not.toContain(REAL_KEY)
  })
})

describe('/api/app/guiji/* — 服务端配置门控', () => {
  it('服务端缺 BXZ_GUIJI_API_KEY → POST 返回 503', async () => {
    delete process.env.BXZ_GUIJI_API_KEY
    try {
      const res = await postProxy({ ip: uniqueIp() })
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('归集服务未启用')
    } finally {
      process.env.BXZ_GUIJI_API_KEY = REAL_KEY
    }
  })

  it('服务端缺 BXZ_GUIJI_API_KEY → GET status 返回 503', async () => {
    delete process.env.BXZ_GUIJI_API_KEY
    try {
      const res = await request(app).get('/api/app/guiji/compare/tasks/CMP-NOT-EXIST/status')
      expect(res.status).toBe(503)
    } finally {
      process.env.BXZ_GUIJI_API_KEY = REAL_KEY
    }
  })

  it('服务端缺 BXZ_GUIJI_API_KEY → GET 详情 返回 503', async () => {
    delete process.env.BXZ_GUIJI_API_KEY
    try {
      const res = await request(app).get('/api/app/guiji/compare/tasks/CMP-NOT-EXIST')
      expect(res.status).toBe(503)
    } finally {
      process.env.BXZ_GUIJI_API_KEY = REAL_KEY
    }
  })
})

describe('/api/app/guiji/* — IP 限流', () => {
  it('同一 IP 60s 内第 4 次 POST → 429', async () => {
    const ip = uniqueIp()
    for (let i = 0; i < 3; i++) {
      const r = await postProxy({ ip })
      expect(r.status).toBe(200)
    }
    const fourth = await postProxy({ ip })
    expect(fourth.status).toBe(429)
  })
})

describe('/api/guiji/* — 原 IP 直连入口仍要求 X-Api-Key', () => {
  function postLegacy(opts: { ip: string; sendKey?: string }) {
    const r = request(app)
      .post('/api/guiji/compare/tasks')
      .set('X-Forwarded-For', opts.ip)
      .field('compareMode', 'ONE_TO_ONE')
      .field('documentName', 'legacy test')
      .attach('file', Buffer.from('文档A'), 'a.docx')
      .attach('fileB', Buffer.from('文档B'), 'b.docx')
    if (opts.sendKey !== undefined) r.set('X-Api-Key', opts.sendKey)
    return r
  }

  it('不带 X-Api-Key → 401', async () => {
    const res = await postLegacy({ ip: uniqueIp() })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('缺少 API Key')
  })

  it('错误的 X-Api-Key（长度相等但内容错）→ 403', async () => {
    const wrong = 'x'.repeat(REAL_KEY.length)
    const res = await postLegacy({ ip: uniqueIp(), sendKey: wrong })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('API Key 无效')
  })

  it('错误的 X-Api-Key（长度不等）→ 403（不是 timingSafeEqual 抛错）', async () => {
    const res = await postLegacy({ ip: uniqueIp(), sendKey: 'short' })
    expect(res.status).toBe(403)
  })

  it('正确 X-Api-Key → 200', async () => {
    const res = await postLegacy({ ip: uniqueIp(), sendKey: REAL_KEY })
    expect(res.status).toBe(200)
    expect(res.body.taskNo).toMatch(/^CMP-/)
  })
})
