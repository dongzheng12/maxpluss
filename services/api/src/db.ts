/**
 * Prisma 数据库连接
 * @date   2026-03-21
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaInited?: boolean }

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn']
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// WAL: 写不阻塞读，多并发写排队但不超时；持久化在 db 文件级，设置一次永久生效。
// busy_timeout: 写锁等待 5s 再抛 SQLITE_BUSY，避免 Prisma 默认 5s 事务超时被抢锁打断。
//   注意 busy_timeout 是 per-connection，Prisma SQLite 默认连接池=1，单进程下设一次够用。
// PG 兼容：DATABASE_URL=postgresql:// 时跳过 SQLite-only PRAGMA（PG 不识别该语法）。
//   仅给 8083 POC 用，正式生产仍走 SQLite 分支不变。
export async function initDatabase(): Promise<void> {
  if (globalForPrisma.prismaInited) return
  const dbUrl = process.env.DATABASE_URL || ''
  if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
    globalForPrisma.prismaInited = true
    console.log('[db] 检测到 PostgreSQL，跳过 SQLite PRAGMA 初始化')
    return
  }
  try {
    // 两条 PRAGMA 都返回结果集（journal_mode 返回当前模式 / busy_timeout 返回当前超时），
    // 必须用 $queryRawUnsafe；用 $executeRawUnsafe 会报 "Execute returned results"
    const mode = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      `PRAGMA journal_mode=WAL`
    )
    await prisma.$queryRawUnsafe(`PRAGMA busy_timeout=5000`)
    globalForPrisma.prismaInited = true
    console.log(`[db] PRAGMA 初始化完成: journal_mode=${mode?.[0]?.journal_mode || 'unknown'}, busy_timeout=5000ms`)
  } catch (err: any) {
    console.error('[db] PRAGMA 初始化失败:', err?.message || err)
    throw err
  }
}
