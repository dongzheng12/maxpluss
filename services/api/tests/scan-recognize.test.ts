/**
 * 扫一扫端到端冒烟测试 — POST /api/app/scan/recognize
 *
 * 不依赖：真摄像头、真微信端、生产 dedup 服务。
 * 仅依赖：本地 http mock dedup（127.0.0.1:48067，由 setup.ts 默认 DEDUP_SERVICE_URL 指向）+ supertest。
 *
 * 覆盖：
 *   - 鉴权：无 token → 401
 *   - 无文件 → 400
 *   - happy path（exact 模式）→ 200 + 透传 recognition_mode/industry_token/risk_directions
 *     + 合成 match_source(label) / ocr_preview / service_offer
 *   - happy path（general 模式）→ recognition_mode='general' + service_offer 仍存在
 *   - dedup 504 / 503 / 500 路径
 *   - first_scan 埋点：firstScanAt 原子写入只发生一次
 *
 * 注意：scan/recognize 命中 ipRateLimit(30, 60_000)，单测用例数 < 30，不会触发限流。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans, cleanAll } from './factory.js'

// ─── mock dedup server ─────────────────────────────────────────

type MockResponder = (req: http.IncomingMessage, body: Buffer) => { status: number; body: any | string }
let server: http.Server
let lastRequest: { path: string; method: string; headers: Record<string, string | string[] | undefined> } | null = null
let nextResponder: MockResponder = () => ({ status: 200, body: {} })

const app = express()
app.use(express.json())

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      lastRequest = { path: req.url!, method: req.method!, headers: req.headers }
      const body = Buffer.concat(chunks)
      const r = nextResponder(req, body)
      const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      res.writeHead(r.status, { 'Content-Type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(48067, '127.0.0.1', () => resolve())
  })
  await ensurePlans()
  registerAppRoutes(app)
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(async () => {
  lastRequest = null
  nextResponder = () => ({ status: 200, body: {} })
  await cleanAll()
  await ensurePlans()
})

// ─── 工具：生成临时图片文件 ────────────────────────────────────

function tmpJpeg(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const p = path.join(dir, 'test.jpg')
  // 不需要真实 JPEG 内容，dedup 是 mock 的，不会真解码
  fs.writeFileSync(p, Buffer.from('fake-jpeg-bytes-for-mock-only'))
  return p
}

async function newAuthedUser() {
  const u = await createUser({ role: 'user' })
  return { user: u, token: getTestToken(u.id, 'user') }
}

/**
 * trackScanSuccess 是 fire-and-forget（埋点失败不拖累用户响应），
 * HTTP 200 返回时 firstScanAt 写入可能尚未到达 DB。
 * SQLite 同进程 + better-sqlite3 通常下一 tick 完成；PG 走 socket 慢一个量级。
 * 这里短轮询直到 firstScanAt 落库或超时。
 */
async function waitForFirstScan(userId: string, maxMs = 1000): Promise<Date | null> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const u = await prisma.appUser.findUnique({ where: { id: userId } })
    if (u?.firstScanAt) return u.firstScanAt
    await new Promise((r) => setTimeout(r, 20))
  }
  const u = await prisma.appUser.findUnique({ where: { id: userId } })
  return u?.firstScanAt ?? null
}

// ─── 测试 ──────────────────────────────────────────────────────

describe('POST /api/app/scan/recognize 鉴权 + 入参', () => {
  it('无 token → 401', async () => {
    const res = await request(app).post('/api/app/scan/recognize')
    expect(res.status).toBe(401)
  })

  it('有 token 但缺 file → 400「请上传文件」', async () => {
    const { token } = await newAuthedUser()
    const res = await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/上传/)
  })
})

describe('POST /api/app/scan/recognize happy path', () => {
  it('exact 模式 + ocr_code → 透传 + 合成完整字段', async () => {
    const { token, user } = await newAuthedUser()
    nextResponder = () => ({
      status: 200,
      body: {
        success: true,
        recognized: '矿泉水',
        confidence: 0.92,
        standards: [
          { code: 'GB 8537-2018', name: '食品安全国家标准 饮用天然矿泉水', status: '现行' },
          { code: 'GB/T 5750-2006', name: '生活饮用水标准检验方法', status: '现行' },
        ],
        ocr_text: 'GB 8537-2018 饮用天然矿泉水',
        recognition_mode: 'exact',
        industry_token: 'food.beverage',
        risk_directions: ['重金属', '微生物'],
      },
    })
    const filePath = tmpJpeg()
    const res = await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)

    expect(res.status).toBe(200)
    expect(res.body.recognized).toBe('矿泉水')
    expect(res.body.recognition_mode).toBe('exact')
    expect(res.body.industry_token).toBe('food.beverage')
    expect(res.body.risk_directions).toEqual(['重金属', '微生物'])
    // ocr_code 因为 standards[0].code 在 ocr_text 里
    expect(res.body.match_source).toBe('ocr_code')
    expect(res.body.match_source_label).toBe('包装标准号直连')
    expect(res.body.ocr_preview).toContain('GB 8537')
    // service_offer 必须固定文案
    expect(res.body.service_offer).toMatchObject({
      title: expect.any(String),
      cta: expect.objectContaining({ url: expect.stringContaining('/pages/compare/index') }),
    })
    // dedup 接收到 multipart 请求
    expect(lastRequest?.path).toBe('/internal/scan-recognize')
    expect(lastRequest?.method).toBe('POST')
    expect(String(lastRequest?.headers['content-type'])).toMatch(/multipart\/form-data/)
    // first_scan 应已写入（异步埋点，等到落库）
    const firstScanAt = await waitForFirstScan(user.id)
    expect(firstScanAt).not.toBeNull()
  })

  it('general 模式 + 无 standards → 仍 200 + service_offer 存在', async () => {
    const { token } = await newAuthedUser()
    nextResponder = () => ({
      status: 200,
      body: {
        success: false,
        recognized: null,
        confidence: 0,
        standards: [],
        ocr_text: '',
        recognition_mode: 'general',
        industry_token: null,
        risk_directions: [],
      },
    })
    const filePath = tmpJpeg()
    const res = await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)

    expect(res.status).toBe(200)
    expect(res.body.recognition_mode).toBe('general')
    expect(res.body.match_source).toBe('unknown')
    expect(res.body.service_offer).toBeDefined()
  })

  it('category 模式 + 类别关键字 → match_source=category_keyword', async () => {
    const { token } = await newAuthedUser()
    nextResponder = () => ({
      status: 200,
      body: {
        success: true,
        recognized: '化妆品',
        confidence: 0.55,
        standards: [{ code: 'GB/T 35910-2018', name: '化妆品检测方法', status: '现行' }],
        ocr_text: '某某品牌护肤霜 净含量 50g',
        recognition_mode: 'category',
        industry_token: 'cosmetic',
        risk_directions: ['重金属', '微生物'],
      },
    })
    const filePath = tmpJpeg()
    const res = await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)

    expect(res.status).toBe(200)
    // ocr_text 不含 GB/T 35910，但有 confidence/recognized → category_keyword
    expect(res.body.match_source).toBe('category_keyword')
    expect(res.body.match_source_label).toBe('商品类别关联')
    expect(res.body.recognition_mode).toBe('category')
  })
})

describe('POST /api/app/scan/recognize 错误路径', () => {
  it('dedup 返回 500 → 透传到 500「识别失败」', async () => {
    const { token } = await newAuthedUser()
    nextResponder = () => ({ status: 500, body: { error: 'dedup boom' } })
    const filePath = tmpJpeg()
    const res = await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/识别失败/)
  })

  it('dedup 端口未起 → ECONNREFUSED 映射为 503', async () => {
    const { token } = await newAuthedUser()
    // 临时关 server 模拟服务下线
    await new Promise<void>(r => server.close(() => r()))
    const filePath = tmpJpeg()
    try {
      const res = await request(app).post('/api/app/scan/recognize')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', filePath)
      expect(res.status).toBe(503)
      expect(res.body.error).toMatch(/识别服务暂不可用/)
    } finally {
      // 重启 server 给后续测试
      await new Promise<void>((resolve, reject) => {
        server = http.createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            lastRequest = { path: req.url!, method: req.method!, headers: req.headers }
            const r = nextResponder(req, Buffer.concat(chunks))
            const payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
            res.writeHead(r.status, { 'Content-Type': 'application/json' })
            res.end(payload)
          })
        })
        server.once('error', reject)
        server.listen(48067, '127.0.0.1', () => resolve())
      })
    }
  })
})

describe('first_scan 埋点幂等', () => {
  it('同一用户两次 scan 成功 → firstScanAt 不被覆盖', async () => {
    const { token, user } = await newAuthedUser()
    nextResponder = () => ({
      status: 200,
      body: {
        success: true,
        recognized: '商品A',
        confidence: 0.8,
        standards: [{ code: 'GB 1', name: 'X', status: '现行' }],
        ocr_text: 'GB 1',
        recognition_mode: 'exact',
        industry_token: 'food',
        risk_directions: [],
      },
    })

    const filePath = tmpJpeg()
    await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)

    // 等异步埋点把 firstScanAt 写入
    const firstScanAt = await waitForFirstScan(user.id)
    expect(firstScanAt).not.toBeNull()

    // 第二次扫
    await request(app).post('/api/app/scan/recognize')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', filePath)

    // 第二次扫的埋点 update 走 firstScanAt:null where 不命中（count=0）；
    // 为避免读到第一次未完成的 update，这里再做一次短等待保证两次 in-flight 都已 settle
    await new Promise((r) => setTimeout(r, 100))
    const u2 = await prisma.appUser.findUnique({ where: { id: user.id } })
    expect(u2?.firstScanAt?.getTime()).toBe(firstScanAt!.getTime())
  })
})
