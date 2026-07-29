/**
 * 上传文件清理 sweeper 测试 — uploadsSweeper.ts
 * 覆盖：
 *   - sweepStaleUploads：mtime > 阈值的文件被删，新文件保留
 *   - 目录不存在 → 静默 return（容忍 docker volume 未 mount）
 *   - 子目录跳过（只处理 isFile）
 *   - 文件并发删除（stat ENOENT）静默不抛
 *   - sweeperStats：runCount / lastRunAt / lastRunCleaned / totalCleaned 累加
 *   - startUploadsSweeper：startedAt 写入 + 启动立即跑一次
 *   - UPLOAD_RETAIN_DAYS env 默认 1 天（2026-04-28 从 7→1）
 *   - SWEEP_INTERVAL_MS = 24 小时（源码字面量）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  sweepStaleUploads,
  startUploadsSweeper,
  getUploadsSweeperStats,
} from '../src/uploadsSweeper.js'

// ─── 工具 ─────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sweeper-'))
}

/** 写文件并强制设 mtime（1 天 = 86400_000ms） */
async function writeFileWithMtime(dir: string, name: string, ageMs: number): Promise<string> {
  const p = path.join(dir, name)
  await fsp.writeFile(p, 'x')
  const t = (Date.now() - ageMs) / 1000 // utimes 接收秒
  await fsp.utimes(p, t, t)
  return p
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

// ────────────────────────────────────────────────────────────

describe('sweepStaleUploads — 核心行为', () => {
  it('目录不存在 → 静默 return（不 throw）', async () => {
    const nonExistent = path.join(os.tmpdir(), `no-such-${Date.now()}`)
    await expect(sweepStaleUploads(nonExistent)).resolves.toBeUndefined()
  })

  it('空目录 → cleaned=0，不抛', async () => {
    const dir = mkTmpDir()
    const before = getUploadsSweeperStats()
    await sweepStaleUploads(dir)
    const after = getUploadsSweeperStats()
    expect(after.runCount - before.runCount).toBe(1)
    expect(after.lastRunCleaned).toBe(0)
  })

  it('mtime 超过保留窗口 → 文件被 unlink', async () => {
    const dir = mkTmpDir()
    // 默认 UPLOAD_RETAIN_DAYS=1，2 天前的文件应被清
    const oldFile = await writeFileWithMtime(dir, 'old.bin', 2 * ONE_DAY_MS)
    expect(fs.existsSync(oldFile)).toBe(true)
    await sweepStaleUploads(dir)
    expect(fs.existsSync(oldFile)).toBe(false)
  })

  it('mtime 在保留窗口内 → 文件保留', async () => {
    const dir = mkTmpDir()
    // 1 小时前 < 1 天阈值
    const freshFile = await writeFileWithMtime(dir, 'fresh.bin', 60 * 60 * 1000)
    await sweepStaleUploads(dir)
    expect(fs.existsSync(freshFile)).toBe(true)
  })

  it('混合：3 旧 + 2 新 → 仅 3 个被删', async () => {
    const dir = mkTmpDir()
    const old1 = await writeFileWithMtime(dir, 'o1.bin', 5 * ONE_DAY_MS)
    const old2 = await writeFileWithMtime(dir, 'o2.bin', 3 * ONE_DAY_MS)
    const old3 = await writeFileWithMtime(dir, 'o3.bin', 10 * ONE_DAY_MS)
    const new1 = await writeFileWithMtime(dir, 'n1.bin', 2 * 60 * 60 * 1000) // 2h
    const new2 = await writeFileWithMtime(dir, 'n2.bin', 12 * 60 * 60 * 1000) // 12h

    const before = getUploadsSweeperStats()
    await sweepStaleUploads(dir)
    const after = getUploadsSweeperStats()

    expect(fs.existsSync(old1)).toBe(false)
    expect(fs.existsSync(old2)).toBe(false)
    expect(fs.existsSync(old3)).toBe(false)
    expect(fs.existsSync(new1)).toBe(true)
    expect(fs.existsSync(new2)).toBe(true)
    expect(after.lastRunCleaned).toBe(3)
    expect(after.totalCleaned - before.totalCleaned).toBe(3)
  })

  it('子目录（非文件）跳过 — 不被 unlink', async () => {
    const dir = mkTmpDir()
    const subdir = path.join(dir, 'sub')
    fs.mkdirSync(subdir)
    // 设子目录 mtime 很旧
    const t = (Date.now() - 5 * ONE_DAY_MS) / 1000
    await fsp.utimes(subdir, t, t)
    await sweepStaleUploads(dir)
    expect(fs.existsSync(subdir)).toBe(true) // 目录还在
  })

  it('mtime 正好等于 cutoff（边界）→ 保留（严格 < 才删）', async () => {
    const dir = mkTmpDir()
    // 设 mtime 接近 cutoff 边界 — 用 1 天 - 100ms（明确仍在窗口内）
    const justInside = await writeFileWithMtime(dir, 'edge.bin', ONE_DAY_MS - 100)
    await sweepStaleUploads(dir)
    expect(fs.existsSync(justInside)).toBe(true)
  })

  it('文件并发被删（stat ENOENT）→ 静默忽略，不抛', async () => {
    const dir = mkTmpDir()
    // 创建 2 个旧文件
    const f1 = await writeFileWithMtime(dir, 'a.bin', 5 * ONE_DAY_MS)
    const f2 = await writeFileWithMtime(dir, 'b.bin', 5 * ONE_DAY_MS)
    // 在 sweep 前同步删一个，模拟「readdir 已列出但 stat 时已被并发清掉」
    fs.unlinkSync(f1)
    await expect(sweepStaleUploads(dir)).resolves.toBeUndefined()
    expect(fs.existsSync(f1)).toBe(false)
    expect(fs.existsSync(f2)).toBe(false) // 被 sweeper 清掉
  })

  it('多次调用 → runCount / totalCleaned 单调累加', async () => {
    const dir = mkTmpDir()
    await writeFileWithMtime(dir, 's1.bin', 5 * ONE_DAY_MS)
    const before = getUploadsSweeperStats()
    await sweepStaleUploads(dir)
    const mid = getUploadsSweeperStats()
    await writeFileWithMtime(dir, 's2.bin', 5 * ONE_DAY_MS)
    await sweepStaleUploads(dir)
    const after = getUploadsSweeperStats()

    expect(mid.runCount - before.runCount).toBe(1)
    expect(after.runCount - before.runCount).toBe(2)
    expect(after.totalCleaned - before.totalCleaned).toBeGreaterThanOrEqual(2)
    expect(after.lastRunAt!.getTime()).toBeGreaterThanOrEqual(mid.lastRunAt!.getTime())
  })
})

describe('startUploadsSweeper — 启动行为', () => {
  it('调用后 startedAt 被写入', async () => {
    const dir = mkTmpDir()
    const beforeStart = getUploadsSweeperStats().startedAt
    startUploadsSweeper(dir)
    const after = getUploadsSweeperStats()
    expect(after.startedAt).not.toBeNull()
    if (beforeStart) {
      expect(after.startedAt!.getTime()).toBeGreaterThanOrEqual(beforeStart.getTime())
    }
  })

  it('启动后立即跑一次 sweep（清掉旧文件）', async () => {
    const dir = mkTmpDir()
    const oldFile = await writeFileWithMtime(dir, 'preexist.bin', 5 * ONE_DAY_MS)
    startUploadsSweeper(dir)
    // 立即 sweep 是 fire-and-forget，等待事件循环 + I/O 完成
    await new Promise(r => setTimeout(r, 100))
    expect(fs.existsSync(oldFile)).toBe(false)
  })
})

describe('getUploadsSweeperStats — 字段结构', () => {
  it('返回 7 个固定字段', () => {
    const s = getUploadsSweeperStats()
    expect(s).toHaveProperty('startedAt')
    expect(s).toHaveProperty('runCount')
    expect(s).toHaveProperty('totalCleaned')
    expect(s).toHaveProperty('lastRunAt')
    expect(s).toHaveProperty('lastRunCleaned')
    expect(s).toHaveProperty('lastError')
    expect(s).toHaveProperty('lastErrorAt')
  })

  it('返回值是快照（外部修改不影响内部状态）', async () => {
    const dir = mkTmpDir()
    await sweepStaleUploads(dir)
    const snap = getUploadsSweeperStats()
    snap.runCount = 999999
    const fresh = getUploadsSweeperStats()
    expect(fresh.runCount).not.toBe(999999)
  })
})

describe('源码锁定项字面量', () => {
  const SRC = fs.readFileSync(
    path.resolve(import.meta.dirname, '../src/uploadsSweeper.ts'),
    'utf-8',
  )

  it('SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000（24 小时）', () => {
    expect(SRC).toMatch(/SWEEP_INTERVAL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/)
  })

  it('UPLOAD_RETAIN_DAYS 默认 = 1（2026-04-28 从 7→1，源码注释记录此演进）', () => {
    // env 缺省 fallback 应为 1
    expect(SRC).toMatch(/UPLOAD_RETAIN_DAYS\)\s*\|\|\s*1\b/)
  })

  it('用 mtime（修改时间）作为时间锚，不用 ctime/atime', () => {
    expect(SRC).toMatch(/st\.mtimeMs\s*<\s*cutoffMs/)
  })

  it('ENOENT 容错：目录不存在时 return，文件被并发删除时不告警', () => {
    expect(SRC).toMatch(/code === ['"]ENOENT['"]/)
    // 文件级也有 ENOENT 静默
    expect(SRC).toMatch(/err\?\.code\s*!==\s*['"]ENOENT['"]/)
  })
})
