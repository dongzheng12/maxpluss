/**
 * doc-extract 测试
 * 覆盖锁定项（必读/MEMORY.md「密钥/鉴权/fail-fast」+「比对/报告」）：
 *   - BXZ_INTERNAL_SECRET 缺失 fail-fast（lazy throw，绝不 fallback dev-secret）
 *   - dedup extract-text 同步 30 分钟 fail-safe timeout
 *   - dedup submit/poll：HMAC X-Internal-Key 签名格式 ts:sig
 *   - poll 各状态分支：pending/running/done/failed/not_found
 *   - mapDedupErrorCode：DEPENDENCY_MISSING / OCR_FAILED / TEXT_INSUFFICIENT / 默认 EXTRACT_FAILED
 *   - extractTextDetailed 分发：.txt/.md → plain；不支持扩展 → EXTRACT_FAILED
 *   - analyzeTextQuality 纯函数：阈值边界 + 章节命中
 *
 * 用本地 http server 模拟 dedup（端口 48067，由 setup.ts 默认 DEDUP_SERVICE_URL 指向）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import {
  analyzeTextQuality,
  extractTextFromString,
  extractTextDetailed,
  submitExtractTextJob,
  pollExtractTextJob,
  DocumentExtractError,
} from '../src/doc-extract.js'

// ─── mock dedup server ───────────────────────────────────────

type MockResponder = (req: http.IncomingMessage, body: Buffer) => { status: number; body: any | string }
let server: http.Server
let lastRequest: { path: string; method: string; headers: Record<string, string | string[] | undefined>; body: Buffer } | null
let nextResponder: MockResponder = () => ({ status: 200, body: {} })

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      lastRequest = { path: req.url!, method: req.method!, headers: req.headers, body }
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
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

beforeEach(() => {
  lastRequest = null
  nextResponder = () => ({ status: 200, body: {} })
})

// 工具：写入临时文件
function writeTmp(name: string, content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docex-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

// 工具：把 X-Internal-Key 解出来 + 校验 HMAC
function verifyInternalKey(headerValue: string | undefined, requestPath: string, secret: string): boolean {
  if (!headerValue) return false
  const [ts, sig] = headerValue.split(':')
  if (!ts || !sig) return false
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${requestPath}`).digest('hex')
  return expected === sig
}

// ────────────────────────────────────────────────────────────

describe('analyzeTextQuality 纯函数', () => {
  it('空字符串 → 全 0 + isMeaningful=false', () => {
    const q = analyzeTextQuality('')
    expect(q.rawTextLength).toBe(0)
    expect(q.compactTextLength).toBe(0)
    expect(q.validCharCount).toBe(0)
    expect(q.validCharRatio).toBe(0)
    expect(q.isMeaningful).toBe(false)
  })

  it('短文本（< 80 字符）→ isMeaningful=false', () => {
    const q = analyzeTextQuality('短文本不满足。'.repeat(3))
    expect(q.isMeaningful).toBe(false)
  })

  it('高质量长中文文本 → isMeaningful=true', () => {
    const longText = '本文件规定了化妆品中重金属铅汞砷的检测方法和检验规则。'.repeat(5)
    const q = analyzeTextQuality(longText)
    expect(q.isMeaningful).toBe(true)
    expect(q.validCharRatio).toBeGreaterThanOrEqual(0.35)
    expect(q.validCharCount).toBeGreaterThanOrEqual(40)
  })

  it('仅标点空白 → validCharCount=0 且 isMeaningful=false', () => {
    const q = analyzeTextQuality('，。、；：？！（）'.repeat(20))
    expect(q.validCharCount).toBe(0)
    expect(q.validCharRatio).toBe(0)
    expect(q.isMeaningful).toBe(false)
  })

  it('长乱码文字层 → 不能仅因长度足够被当成有效正文', () => {
    const noisyText = ('! " # $ % & \' ( ) * , - / 0 '.repeat(400)) + 'GB/T 1032'.repeat(20)
    const q = analyzeTextQuality(noisyText)
    expect(q.rawTextLength).toBeGreaterThan(1000)
    expect(q.validCharRatio).toBeLessThan(0.35)
    expect(q.isMeaningful).toBe(false)
  })

  it('章节标号被 sectionHintCount 计数', () => {
    const text = '1 范围\n本文件规定。\n2 引用文件\nGB/T 1234\n3.1 术语\n密度。\n'
    const q = analyzeTextQuality(text)
    expect(q.sectionHintCount).toBeGreaterThanOrEqual(2)
  })

  it('validCharRatio 保留 4 位小数', () => {
    const q = analyzeTextQuality('abc，。')
    // ratio = 3/5 = 0.6
    const decimals = q.validCharRatio.toString().split('.')[1] || ''
    expect(decimals.length).toBeLessThanOrEqual(4)
  })

  it('多页 pageTexts → 仅 compact >= 10 的页面计入 nonEmptyPages', () => {
    const q = analyzeTextQuality('aggregate', ['短', '足够长的页面正文一二三四五六七八九十', '另一页内容也是足够长一二三'])
    expect(q.nonEmptyPages).toBe(2)
  })
})

describe('extractTextFromString', () => {
  it('多行 + 空行 + 前后空白 → 单行清理拼回换行', () => {
    const r = extractTextFromString('  第一行  \n\n   第二行\n   \n第三行   ')
    expect(r).toBe('第一行\n第二行\n第三行')
  })

  it('空字符串 → 空', () => {
    expect(extractTextFromString('')).toBe('')
  })
})

describe('DocumentExtractError 类', () => {
  it('继承 Error + 携带 code / message / details / name', () => {
    const e = new DocumentExtractError('OCR_FAILED', 'OCR 挂了', { method: 'rapid-ocr' })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('DocumentExtractError')
    expect(e.code).toBe('OCR_FAILED')
    expect(e.message).toBe('OCR 挂了')
    expect(e.details?.method).toBe('rapid-ocr')
  })
})

describe('extractTextDetailed 类型分发', () => {
  it('不支持的扩展 → throws EXTRACT_FAILED', async () => {
    const f = writeTmp('a.xls', 'xls 内容')
    await expect(extractTextDetailed(f)).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('不支持的文件类型'),
    })
  })

  it('.txt 短内容 → throws TEXT_INSUFFICIENT', async () => {
    const f = writeTmp('short.txt', '太短')
    await expect(extractTextDetailed(f)).rejects.toMatchObject({
      code: 'TEXT_INSUFFICIENT',
    })
  })

  it('.txt 长内容 → 返回 details method=plain', async () => {
    const longText = '本文件规定了化妆品中重金属铅汞砷的检测方法和检验规则。'.repeat(5)
    const f = writeTmp('long.txt', longText)
    const r = await extractTextDetailed(f)
    expect(r.method).toBe('plain')
    expect(r.text.length).toBeGreaterThan(0)
    expect(r.errorCode).toBeNull()
  })

  it('.md 走 plain 分支', async () => {
    const longText = '本文件规定了化妆品中重金属铅汞砷的检测方法和检验规则。'.repeat(5)
    const f = writeTmp('doc.md', longText)
    const r = await extractTextDetailed(f)
    expect(r.method).toBe('plain')
  })
})

describe('submit/poll fail-fast — BXZ_INTERNAL_SECRET 缺失', () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env.BXZ_INTERNAL_SECRET
    delete process.env.BXZ_INTERNAL_SECRET
  })
  afterEach(() => {
    if (saved !== undefined) process.env.BXZ_INTERNAL_SECRET = saved
  })

  it('submitExtractTextJob → DocumentExtractError EXTRACT_FAILED 含「未配置」', async () => {
    const f = writeTmp('a.pdf', Buffer.from('%PDF-1.4 fake'))
    await expect(submitExtractTextJob(f, 'a.pdf')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('未配置'),
    })
  })

  it('pollExtractTextJob → DocumentExtractError EXTRACT_FAILED 含「未配置」', async () => {
    await expect(pollExtractTextJob('any-job-id')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('未配置'),
    })
  })

  // 不要求 helpers 在 import 阶段抛错（注释里明确写 lazy 不是 module-level）
  // 这条用例验证 lazy 行为：恢复 secret 后再调可正常签名
  it('lazy 校验：恢复 secret 后下一次调用正常签名', async () => {
    process.env.BXZ_INTERNAL_SECRET = 'temp-secret-for-lazy-test'
    nextResponder = () => ({ status: 200, body: { job_id: 'lazy-ok' } })
    const f = writeTmp('a.pdf', Buffer.from('%PDF-1.4 fake'))
    const id = await submitExtractTextJob(f, 'a.pdf')
    expect(id).toBe('lazy-ok')
    expect(verifyInternalKey(
      lastRequest!.headers['x-internal-key'] as string,
      '/internal/jobs/extract-text',
      'temp-secret-for-lazy-test',
    )).toBe(true)
  })
})

describe('submitExtractTextJob — happy + 错误分支', () => {
  it('返回 dedup 给的 job_id', async () => {
    nextResponder = () => ({ status: 200, body: { job_id: 'job-abc-123' } })
    const f = writeTmp('a.pdf', Buffer.from('%PDF-1.4 fake'))
    const id = await submitExtractTextJob(f, 'a.pdf')
    expect(id).toBe('job-abc-123')
  })

  it('请求路径为 /internal/jobs/extract-text，X-Internal-Key 签名正确', async () => {
    nextResponder = () => ({ status: 200, body: { job_id: 'sig-test' } })
    const f = writeTmp('a.pdf', Buffer.from('%PDF-1.4 fake'))
    await submitExtractTextJob(f, 'a.pdf')
    expect(lastRequest!.path).toBe('/internal/jobs/extract-text')
    expect(lastRequest!.method).toBe('POST')
    expect(verifyInternalKey(
      lastRequest!.headers['x-internal-key'] as string,
      '/internal/jobs/extract-text',
      process.env.BXZ_INTERNAL_SECRET!,
    )).toBe(true)
  })

  it('multipart body 含 filename + Content-Type=multipart/form-data', async () => {
    nextResponder = () => ({ status: 200, body: { job_id: 'b' } })
    const f = writeTmp('hello.pdf', Buffer.from('%PDF-1.4 fake'))
    await submitExtractTextJob(f, 'hello.pdf')
    expect(String(lastRequest!.headers['content-type'])).toMatch(/multipart\/form-data; boundary=/)
    expect(lastRequest!.body.toString('utf-8')).toContain('filename="hello.pdf"')
  })

  it('maxPages 参数 → 写入 form-data', async () => {
    nextResponder = () => ({ status: 200, body: { job_id: 'b' } })
    const f = writeTmp('h.pdf', Buffer.from('%PDF-1.4 fake'))
    await submitExtractTextJob(f, 'h.pdf', 5)
    const bodyStr = lastRequest!.body.toString('utf-8')
    expect(bodyStr).toContain('name="max_pages"')
    expect(bodyStr).toContain('5')
  })

  it('缺 job_id → throws「缺 job_id」', async () => {
    nextResponder = () => ({ status: 200, body: { foo: 'bar' } })
    const f = writeTmp('a.pdf', Buffer.from('%PDF'))
    await expect(submitExtractTextJob(f, 'a.pdf')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('缺 job_id'),
    })
  })

  it('HTTP 4xx → throws「submit HTTP」', async () => {
    nextResponder = () => ({ status: 400, body: { error: 'bad' } })
    const f = writeTmp('a.pdf', Buffer.from('%PDF'))
    await expect(submitExtractTextJob(f, 'a.pdf')).rejects.toThrow(/submit HTTP/)
  })

  it('非 JSON 响应 → throws「响应非 JSON」', async () => {
    nextResponder = () => ({ status: 200, body: 'not json at all' })
    const f = writeTmp('a.pdf', Buffer.from('%PDF'))
    await expect(submitExtractTextJob(f, 'a.pdf')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('非 JSON'),
    })
  })
})

describe('pollExtractTextJob — 各状态分支', () => {
  it('pending → { status: pending }', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'pending' } })
    const r = await pollExtractTextJob('job-1')
    expect(r).toEqual({ status: 'pending' })
  })

  it('running → { status: running }', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'running' } })
    const r = await pollExtractTextJob('job-1')
    expect(r).toEqual({ status: 'running' })
  })

  it('not_found → { status: not_found }（dedup 重启 / TTL 过期）', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'not_found' } })
    const r = await pollExtractTextJob('job-1')
    expect(r).toEqual({ status: 'not_found' })
  })

  it('failed + error_code=OCR_FAILED → 映射 OCR_FAILED', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'failed', error: 'ocr 挂了', error_code: 'OCR_FAILED' } })
    const r = await pollExtractTextJob('job-1')
    expect(r).toMatchObject({ status: 'failed', error: 'ocr 挂了', errorCode: 'OCR_FAILED' })
  })

  it('failed + 未知 error_code → 默认 EXTRACT_FAILED', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'failed', error: 'x', error_code: 'WHATEVER' } })
    const r = await pollExtractTextJob('job-1')
    expect(r).toMatchObject({ status: 'failed', errorCode: 'EXTRACT_FAILED' })
  })

  it('done + result.success=true → { status: done, details }', async () => {
    nextResponder = () => ({
      status: 200,
      body: {
        status: 'done',
        result: {
          success: true,
          text: '这是 dedup 提取出来的足够长的文本内容用于通过 isMeaningful 检查。'.repeat(3),
          extract_method: 'rapid-ocr',
          pages: 3,
          raw_text_length: 100,
          normalized_text_length: 95,
          compact_text_length: 80,
          non_empty_pages: 2,
          valid_char_count: 70,
          valid_char_ratio: 0.875,
        },
      },
    })
    const r = await pollExtractTextJob('job-1')
    expect(r.status).toBe('done')
    if (r.status === 'done') {
      expect(r.details.method).toBe('rapid-ocr')
      expect(r.details.pages).toBe(3)
      expect(r.details.rawTextLength).toBe(100)
      expect(r.details.text.length).toBeGreaterThan(0)
    }
  })

  it('done + result.success=false → 转换为 failed + mapDedupErrorCode', async () => {
    nextResponder = () => ({
      status: 200,
      body: {
        status: 'done',
        result: { success: false, error: '文档无文字', error_code: 'TEXT_INSUFFICIENT' },
      },
    })
    const r = await pollExtractTextJob('job-1')
    expect(r).toMatchObject({ status: 'failed', errorCode: 'TEXT_INSUFFICIENT' })
  })

  it('done + result.success=false + DEPENDENCY_MISSING → 映射对应 code', async () => {
    nextResponder = () => ({
      status: 200,
      body: {
        status: 'done',
        result: { success: false, error: '依赖缺失', error_code: 'DEPENDENCY_MISSING' },
      },
    })
    const r = await pollExtractTextJob('job-1')
    expect(r).toMatchObject({ status: 'failed', errorCode: 'DEPENDENCY_MISSING' })
  })

  it('未知 status → DocumentExtractError', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'weird' } })
    await expect(pollExtractTextJob('job-1')).rejects.toMatchObject({
      code: 'EXTRACT_FAILED',
      message: expect.stringContaining('未知状态'),
    })
  })

  it('HTTP 4xx → throws「poll HTTP」', async () => {
    nextResponder = () => ({ status: 500, body: { error: 'boom' } })
    await expect(pollExtractTextJob('job-1')).rejects.toThrow(/poll HTTP/)
  })

  it('非 JSON → throws「响应非 JSON」', async () => {
    nextResponder = () => ({ status: 200, body: '<html>oops</html>' })
    await expect(pollExtractTextJob('job-1')).rejects.toMatchObject({
      message: expect.stringContaining('非 JSON'),
    })
  })

  it('请求路径含 jobId（URL 编码）+ 签名正确 + GET', async () => {
    nextResponder = () => ({ status: 200, body: { status: 'pending' } })
    await pollExtractTextJob('jb 1+/x')
    const enc = encodeURIComponent('jb 1+/x')
    expect(lastRequest!.path).toBe(`/internal/jobs/${enc}`)
    expect(lastRequest!.method).toBe('GET')
    expect(verifyInternalKey(
      lastRequest!.headers['x-internal-key'] as string,
      `/internal/jobs/${enc}`,
      process.env.BXZ_INTERNAL_SECRET!,
    )).toBe(true)
  })
})

describe('callDedupExtractText 同步路径锁定项（源码字面量验证）', () => {
  // 30 分钟 fail-safe timeout 是 MEMORY.md 锁定项，无法通过运行时直接断言（需真长跑），
  // 这里用源码字面量保险，被无意改回 150s/600s 时立刻挂红
  it('源码内 timeout: 1_800_000 字面量存在', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/doc-extract.ts'),
      'utf-8',
    )
    expect(src).toMatch(/timeout:\s*1_800_000/)
  })

  it('源码内 submit timeout: 60_000 + poll timeout: 30_000', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/doc-extract.ts'),
      'utf-8',
    )
    expect(src).toMatch(/timeout:\s*60_000/)
    expect(src).toMatch(/timeout:\s*30_000/)
  })

  it('源码内禁止 fallback 模式 || / ?? "dev-secret-change-me"（注释里出现 OK）', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/doc-extract.ts'),
      'utf-8',
    )
    // 只拦真实的 fallback 表达式，不拦注释 / 字符串说明
    expect(src).not.toMatch(/(\|\||\?\?)\s*['"]dev-secret-change-me['"]/)
  })
})
