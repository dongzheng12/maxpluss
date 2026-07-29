/**
 * 1v1 比对双层限流测试 — 防 OOM 死循环回归
 *
 * 仅作用于 1v1 / ONE_TO_ONE,全库比对 library / full-corpus 不受限制。
 *
 * 层一(任务创建,POST /api/app/compare/tasks):
 *   - 单文件 ≤ 10MB
 *   - 双文件合计 ≤ 20MB
 *   超限 → 400 + 清孤儿 + 不消耗队列(用户友好文案,不暴露内部机制)
 *
 * 层二(worker processPair):
 *   - 单文件: pages ≤ 60, normalized ≤ 60000, sections ≤ 150
 *   - 合计: pages ≤ 120, normalized ≤ 100000, sections ≤ 300
 *   超限抛 DocumentExtractError → 任务 FAILED + 不进入 buildRealCompareReport
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { createUser, getTestToken, ensurePlans, createMembership } from './factory.js'
import {
  assertPairFileWithinLimit,
  assertPairTotalWithinLimit,
  buildPairTruncationNote,
  PAIR_PER_FILE_PAGE_LIMIT,
  PAIR_PER_FILE_NORMALIZED_LIMIT,
  PAIR_PER_FILE_SECTION_LIMIT,
  PAIR_TOTAL_PAGE_LIMIT,
  PAIR_TOTAL_NORMALIZED_LIMIT,
  PAIR_TOTAL_SECTION_LIMIT,
} from '../src/taskWorker.js'
import { DocumentExtractError, type ExtractTextDetails } from '../src/doc-extract.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

beforeEach(async () => {
  await prisma.compareTask.deleteMany()
  await prisma.userMembership.deleteMany()
})

let ipCounter = 300
function uniqueIp(): string {
  ipCounter += 1
  return `10.2.0.${ipCounter}`
}

/** 构造指定 MB Buffer */
function buildBuffer(mb: number): Buffer {
  return Buffer.alloc(Math.round(mb * 1024 * 1024), 'a')
}

/** 创建会员用户 + token,绕过 1v1 会员门控直接测 size 校验 */
async function setupMemberUser() {
  const user = await createUser()
  await createMembership(user.id, 'pro')
  return getTestToken(user.id)
}

/** 创建免费用户 + token,用于 library 模式测试 */
async function setupFreeUser() {
  const user = await createUser()
  return getTestToken(user.id)
}

/** 构造 ExtractTextDetails 测试 fixture */
function makeDetails(overrides: Partial<ExtractTextDetails> = {}): ExtractTextDetails {
  return {
    text: 'mock text',
    method: 'pymupdf',
    pages: 5,
    rawTextLength: 1000,
    normalizedTextLength: 800,
    compactTextLength: 600,
    nonEmptyPages: 5,
    validCharCount: 600,
    validCharRatio: 0.95,
    sectionHintCount: 10,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════
// Layer 1 — 任务创建时文件大小校验(只 1v1 触发)
// ═══════════════════════════════════════════════════════════
describe('Layer 1 — 1v1 POST /compare/tasks 文件大小校验', () => {
  it('1v1 fileA > 10MB → 400, 用户友好文案不含内部机制', async () => {
    const token = await setupMemberUser()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(11), 'big-a.pdf')
      .attach('fileB', buildBuffer(1), 'small-b.pdf')
      .field('compareMode', 'ONE_TO_ONE')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('文档 A')
    expect(res.body.error).toContain('文件过大')
    expect(res.body.error).toContain('10 MB')
    expect(res.body.error).toContain('本次失败不消耗权益')
    // 不暴露内部机制
    expect(res.body.error).not.toMatch(/OOM|heap|worker|container|512MB|V8/i)
  })

  it('1v1 fileB > 10MB → 400, 用户友好文案', async () => {
    const token = await setupMemberUser()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(1), 'small-a.pdf')
      .attach('fileB', buildBuffer(11), 'big-b.pdf')
      .field('compareMode', 'ONE_TO_ONE')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('文档 B')
    expect(res.body.error).toContain('文件过大')
    expect(res.body.error).toContain('本次失败不消耗权益')
    expect(res.body.error).not.toMatch(/OOM|heap|worker|container|V8/i)
  })

  it('1v1 fileA + fileB > 20MB(虽然两者都 < 10MB 数学上不可达,total 路径作 belt-and-suspenders 防御)', async () => {
    // 数学上严格 ">10MB" 单文件拦截 + ">20MB" 合计拦截:
    //   两个 ≤ 10MB 合计最多 20MB(刚好不超 ">"判定),所以 single 不超 + total 超不可达。
    // 但代码路径仍然存在(防御性),通过 unit test 直接测 helper 路径。
    // 这里 supertest 用 single 超限 case 兜底,确保 total 不会被路径误绕过。
    const token = await setupMemberUser()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(11), 'a.pdf')
      .attach('fileB', buildBuffer(11), 'b.pdf')
      .field('compareMode', 'ONE_TO_ONE')
    // 单 A 先超限触发,400 一致
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('文档 A')
  })

  it('1v1 正常 size (两文件都 < 10MB) → 200 入队,不被 size 校验拦', async () => {
    const token = await setupMemberUser()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(1), 'normal-a.pdf')
      .attach('fileB', buildBuffer(1), 'normal-b.pdf')
      .field('compareMode', 'ONE_TO_ONE')
    expect([200, 409]).toContain(res.status)
  })

  it('1v1 size 超限不创建 task / 不占队列 / 清理孤儿', async () => {
    const token = await setupMemberUser()
    const before = await prisma.compareTask.count()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(11), 'oversize.pdf')
      .attach('fileB', buildBuffer(1), 'b.pdf')
      .field('compareMode', 'ONE_TO_ONE')
    expect(res.status).toBe(400)
    const after = await prisma.compareTask.count()
    expect(after).toBe(before)
  })

  it('library / full-corpus compare 模式 — 不受层一 size 限制(11MB 文件可入队)', async () => {
    // user instruction: 全库比对 library / full-corpus 不走层一这套 size 限制
    const token = await setupFreeUser()
    const res = await request(app)
      .post('/api/app/compare/tasks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', uniqueIp())
      .attach('file', buildBuffer(11), 'big-library.pdf')
      .field('compareMode', 'all')
      .field('documentName', 'library 11MB test')
    // 期望:不被层一 400 size 错误拦截。可能 200 入队,可能 409 队列去重,可能 429 队列满
    // 关键是 status != 400 OR (400 但 error 不是 size 文案)
    if (res.status === 400) {
      expect(res.body.error || '').not.toContain('文件过大')
    } else {
      expect([200, 409, 429]).toContain(res.status)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// Layer 2 — worker 提取后超限校验(单元测试 helper)
// ═══════════════════════════════════════════════════════════
describe('Layer 2 — assertPairFileWithinLimit 单文件超限', () => {
  it('1v1 fileA pages > 60 → throw DocumentExtractError, 用户友好文案细分到页数', () => {
    const details = makeDetails({ nonEmptyPages: PAIR_PER_FILE_PAGE_LIMIT + 1 })
    expect(() => assertPairFileWithinLimit(details, '文档 A', 'CMP-TEST-1')).toThrow(DocumentExtractError)
    try {
      assertPairFileWithinLimit(details, '文档 A', 'CMP-TEST-1')
    } catch (e: any) {
      expect(e.message).toContain('文档 A')
      expect(e.message).toContain('页数过多')
      expect(e.message).toContain('本次失败不消耗权益')
      expect(e.message).not.toMatch(/OOM|heap|worker|V8|内存|container/i)
    }
  })

  it('1v1 fileA normalized > 60000 → 不抛、截断到限内、返回 truncated=true（方案 A）', () => {
    // 构造一个真实长文本（每行短句，70 000 字符量级）触发 normalized 超限
    const longText = '本段内容用于触发字数超限触发字数超限触发字数超限触发字数超限触发字数超限。\n'.repeat(2200)
    const details = makeDetails({
      text: longText,
      nonEmptyPages: 5,
      normalizedTextLength: longText.length,  // > PAIR_PER_FILE_NORMALIZED_LIMIT
      sectionHintCount: 0,                     // 无章节编号 → 截后 sections 闸通过
    })
    expect(longText.length).toBeGreaterThan(PAIR_PER_FILE_NORMALIZED_LIMIT)
    const result = assertPairFileWithinLimit(details, '文档 A', 'CMP-TRUNC-1')
    expect(result.truncated).toBe(true)
    expect(result.originalCharLength).toBe(longText.length)
    // 截断后 details.text 字符数 ≤ 限制(可能因 normalize trim 略小)
    expect(details.text.length).toBeLessThanOrEqual(PAIR_PER_FILE_NORMALIZED_LIMIT)
    expect(details.normalizedTextLength).toBeLessThanOrEqual(PAIR_PER_FILE_NORMALIZED_LIMIT)
  })

  it('1v1 fileA normalized 在限内 → truncated=false', () => {
    const details = makeDetails({
      text: '正常长度的文档内容',
      nonEmptyPages: 5,
      normalizedTextLength: 1000,
    })
    const result = assertPairFileWithinLimit(details, '文档 A')
    expect(result.truncated).toBe(false)
  })

  it('1v1 fileA sections > 150 → 不再 throw,仅日志诊断,truncated=false', () => {
    const details = makeDetails({
      nonEmptyPages: 5,
      normalizedTextLength: 1000,
      sectionHintCount: PAIR_PER_FILE_SECTION_LIMIT + 1,
    })
    expect(() => assertPairFileWithinLimit(details, '文档 A')).not.toThrow()
    const result = assertPairFileWithinLimit(details, '文档 A')
    expect(result.truncated).toBe(false)
    expect(result.originalCharLength).toBe(1000)
  })

  it('1v1 fileB sections > 150 → 不再 throw,仅日志诊断,truncated=false', () => {
    const details = makeDetails({
      nonEmptyPages: 5,
      normalizedTextLength: 1000,
      sectionHintCount: PAIR_PER_FILE_SECTION_LIMIT + 1,
    })
    expect(() => assertPairFileWithinLimit(details, '文档 B')).not.toThrow()
    const result = assertPairFileWithinLimit(details, '文档 B')
    expect(result.truncated).toBe(false)
  })

  it('1v1 单文件全部在限内 → 不抛、truncated=false', () => {
    const details = makeDetails({
      nonEmptyPages: PAIR_PER_FILE_PAGE_LIMIT,
      normalizedTextLength: PAIR_PER_FILE_NORMALIZED_LIMIT,
      sectionHintCount: PAIR_PER_FILE_SECTION_LIMIT,
    })
    expect(() => assertPairFileWithinLimit(details, '文档 A')).not.toThrow()
    const result = assertPairFileWithinLimit(details, '文档 A')
    expect(result.truncated).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// buildPairTruncationNote — 截断提示文案组装
// ═══════════════════════════════════════════════════════════
describe('buildPairTruncationNote — 截断提示文案', () => {
  it('A 截 B 不截 → 单边文案含 文档 A', () => {
    const note = buildPairTruncationNote(
      { truncated: true, originalCharLength: 80000 },
      { truncated: false, originalCharLength: 0 },
    )
    expect(note).toBeDefined()
    expect(note).toContain('文档 A')
    expect(note).toContain('未纳入比对结果')
    expect(note).not.toContain('文档 B')
  })

  it('B 截 A 不截 → 单边文案含 文档 B', () => {
    const note = buildPairTruncationNote(
      { truncated: false, originalCharLength: 0 },
      { truncated: true, originalCharLength: 70000 },
    )
    expect(note).toContain('文档 B')
    expect(note).not.toContain('文档 A')
  })

  it('A B 都截 → 双边文案', () => {
    const note = buildPairTruncationNote(
      { truncated: true, originalCharLength: 80000 },
      { truncated: true, originalCharLength: 90000 },
    )
    expect(note).toContain('文档 A')
    expect(note).toContain('文档 B')
  })

  it('都没截 → undefined', () => {
    const note = buildPairTruncationNote(
      { truncated: false, originalCharLength: 0 },
      { truncated: false, originalCharLength: 0 },
    )
    expect(note).toBeUndefined()
  })
})

describe('Layer 2 — assertPairTotalWithinLimit 合计超限', () => {
  it('1v1 A+B pages > 120 → throw 合计文案', () => {
    const a = makeDetails({ nonEmptyPages: 61 })
    const b = makeDetails({ nonEmptyPages: 60 })
    // 单 A 已超 60 → 实际生产路径会先在 fileA 单文件校验拦截。
    // 但 helper unit test 单独测合计逻辑:把 single 写在限内,合计超限。
    const aOk = makeDetails({ nonEmptyPages: 60 }) // 边界
    const bOver = makeDetails({ nonEmptyPages: 61 }) // 60+61=121 > 120
    // 上面 a/b 不实际用,做 belt-and-suspenders 描述;真正测试用 aOk + bOver
    void a; void b
    expect(() => assertPairTotalWithinLimit(aOk, bOver)).toThrow(DocumentExtractError)
    try {
      assertPairTotalWithinLimit(aOk, bOver)
    } catch (e: any) {
      expect(e.message).toContain('两份文档合计')
      expect(e.message).toContain('页数过多')
    }
  })

  it('1v1 A+B normalized > 100000 → throw 合计文字过多', () => {
    const a = makeDetails({
      nonEmptyPages: 5, normalizedTextLength: 50001, sectionHintCount: 10,
    })
    const b = makeDetails({
      nonEmptyPages: 5, normalizedTextLength: 50000, sectionHintCount: 10,
    }) // 50001+50000 = 100001 > 100000
    expect(() => assertPairTotalWithinLimit(a, b)).toThrow(DocumentExtractError)
    try {
      assertPairTotalWithinLimit(a, b)
    } catch (e: any) {
      expect(e.message).toContain('两份文档合计')
      expect(e.message).toContain('文字过多')
    }
  })

  it('1v1 A+B sections > 300 → 不再 throw,仅日志诊断', () => {
    const a = makeDetails({ nonEmptyPages: 5, normalizedTextLength: 1000, sectionHintCount: 150 })
    const b = makeDetails({ nonEmptyPages: 5, normalizedTextLength: 1000, sectionHintCount: 151 })
    // 150+151 = 301 > 300，sections 只是日志诊断，不再硬抛
    expect(() => assertPairTotalWithinLimit(a, b)).not.toThrow()
  })

  it('1v1 A+B 全部在限内 → 不抛(60+60 pages, 60000+40000 chars, 150+150 sections 边界)', () => {
    const a = makeDetails({
      nonEmptyPages: 60, normalizedTextLength: 60000, sectionHintCount: 150,
    })
    const b = makeDetails({
      nonEmptyPages: 60, normalizedTextLength: 40000, sectionHintCount: 150,
    })
    // 60+60=120 ≤ 120, 60000+40000=100000 ≤ 100000, 150+150=300 ≤ 300 ALL boundary OK
    expect(() => assertPairTotalWithinLimit(a, b)).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════
// 阈值常量自检(锁定参数,防误改)
// ═══════════════════════════════════════════════════════════
describe('1v1 限流阈值常量(锁参数)', () => {
  it('单文件阈值: 60 / 60000 / 150', () => {
    expect(PAIR_PER_FILE_PAGE_LIMIT).toBe(60)
    expect(PAIR_PER_FILE_NORMALIZED_LIMIT).toBe(60000)
    expect(PAIR_PER_FILE_SECTION_LIMIT).toBe(150)
  })

  it('合计阈值: 120 / 100000 / 300', () => {
    expect(PAIR_TOTAL_PAGE_LIMIT).toBe(120)
    expect(PAIR_TOTAL_NORMALIZED_LIMIT).toBe(100000)
    expect(PAIR_TOTAL_SECTION_LIMIT).toBe(300)
  })
})
