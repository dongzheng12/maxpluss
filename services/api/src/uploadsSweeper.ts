/**
 * 上传文件超时清理（in-process 定时任务）
 *
 * 兜底策略，跟 taskWorker 完成时立即清理（cleanupUploadFiles）配套：
 *   - 主路径：worker 任务完成后立即 unlink 本次上传的 fileA / fileB
 *   - 兜底：本 sweeper 每天扫一次 UPLOAD_DIR，删除 mtime > UPLOAD_RETAIN_DAYS 天的孤儿文件
 *
 * 保留策略（2026-04-12 统一）：用户上传文件本体默认保留 7 天，超期自动清理。
 * 数据库元数据（任务记录、报告 JSON）不受影响，仅删除磁盘文件本体。
 * 可通过 UPLOAD_RETAIN_DAYS 环境变量调整。
 *
 * 调度：
 *   - 启动时立即跑一次（清掉之前积压的）
 *   - 之后每 24 小时跑一次
 */
import { readdir, stat, unlink } from 'fs/promises'
import path from 'path'

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
// 默认 1 天兜底（worker 完成时已立即 unlink，sweeper 只兜未完成/异常崩的孤儿；
// 比对任务正常 1 小时内完成，1 天覆盖长任务 + retry 窗口；2026-04-12 从 30→7，2026-04-28 从 7→1）
const UPLOAD_RETAIN_DAYS = Number(process.env.UPLOAD_RETAIN_DAYS) || 1
const STALE_THRESHOLD_MS = UPLOAD_RETAIN_DAYS * 24 * 60 * 60 * 1000

// 可观测性
const sweeperStats = {
  startedAt: null as Date | null,
  runCount: 0,
  totalCleaned: 0,
  lastRunAt: null as Date | null,
  lastRunCleaned: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
}

export function getUploadsSweeperStats() {
  return { ...sweeperStats }
}

export async function sweepStaleUploads(uploadDir: string): Promise<void> {
  const cutoffMs = Date.now() - STALE_THRESHOLD_MS
  let cleaned = 0

  let entries: string[]
  try {
    entries = await readdir(uploadDir)
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      // 目录不存在，可能 docker volume 还没 mount，跳过
      return
    }
    throw err
  }

  for (const name of entries) {
    const filePath = path.join(uploadDir, name)
    try {
      const st = await stat(filePath)
      if (!st.isFile()) continue
      // 用 mtime（修改时间）作为时间锚 — multer 写入后 mtime 不会再变
      if (st.mtimeMs < cutoffMs) {
        await unlink(filePath)
        cleaned++
      }
    } catch (err: any) {
      // ENOENT = 文件被并发删除了，正常
      if (err?.code !== 'ENOENT') {
        import('./logger.js').then(({ logger }) => logger.warn({ module: 'uploadsSweeper', filePath, err: err?.message }, '清理失败'))
      }
    }
  }

  sweeperStats.runCount++
  sweeperStats.lastRunAt = new Date()
  sweeperStats.lastRunCleaned = cleaned
  sweeperStats.totalCleaned += cleaned

  if (cleaned > 0) {
    const { logger } = await import('./logger.js')
    logger.info({ module: 'uploadsSweeper', cleaned, retainDays: UPLOAD_RETAIN_DAYS }, '上传文件清理')
  }
}

export function startUploadsSweeper(uploadDir: string): void {
  const sweep = async () => {
    try {
      await sweepStaleUploads(uploadDir)
    } catch (err: any) {
      sweeperStats.lastError = err?.message || String(err)
      sweeperStats.lastErrorAt = new Date()
      import('./logger.js').then(({ logger }) => logger.error({ module: 'uploadsSweeper', err: err?.message }, '扫描异常'))
    }
  }

  sweeperStats.startedAt = new Date()

  // 启动时立即跑一次（清掉之前积压的）
  sweep()

  // 之后每 24 小时跑一次
  setInterval(sweep, SWEEP_INTERVAL_MS)

  import('./logger.js').then(({ logger }) =>
    logger.info({ module: 'uploadsSweeper', uploadDir, retainDays: UPLOAD_RETAIN_DAYS, intervalHours: 24 }, '已启动')
  )
}
