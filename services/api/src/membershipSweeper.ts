/**
 * 会员到期自动降级（in-process 定时任务）
 *
 * 规则：每小时扫描一次，把 endAt < now 的 ACTIVE 会员标 EXPIRED。
 * 业务理由：会员有效期是硬截止，过期后用户访问受限功能要立即拦截。
 *           handlePostPayment / 各端鉴权都依赖 status=ACTIVE 字段，
 *           不依赖运行时 endAt 比较。
 *
 * 调度：启动时不立即跑（避免冷启动耦合首次请求），之后每 60 分钟一次。
 *       对齐 orderSweeper / uploadsSweeper 模式。
 */
import type { PrismaClient } from '@prisma/client'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // 每 1 小时

const sweeperStats = {
  startedAt: null as Date | null,
  runCount: 0,
  totalExpired: 0,
  lastRunAt: null as Date | null,
  lastRunExpired: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
}

export function getMembershipSweeperStats() {
  return { ...sweeperStats }
}

export async function expireStaleMemberships(prisma: PrismaClient): Promise<number> {
  const now = new Date()
  const result = await prisma.userMembership.updateMany({
    where: { status: 'ACTIVE', endAt: { lt: now } },
    data: { status: 'EXPIRED' },
  })

  sweeperStats.runCount++
  sweeperStats.lastRunAt = new Date()
  sweeperStats.lastRunExpired = result.count
  sweeperStats.totalExpired += result.count

  if (result.count > 0) {
    const { logger } = await import('./logger.js')
    logger.info({ module: 'membership-expiry', count: result.count }, '自动过期会员记录')
  }

  return result.count
}

export function startMembershipExpirySweeper(prisma: PrismaClient): void {
  sweeperStats.startedAt = new Date()
  setInterval(async () => {
    try {
      await expireStaleMemberships(prisma)
    } catch (err: any) {
      sweeperStats.lastError = err?.message || String(err)
      sweeperStats.lastErrorAt = new Date()
      const { logger } = await import('./logger.js')
      logger.error({ module: 'membership-expiry', err: err.message }, '清理异常')
    }
  }, SWEEP_INTERVAL_MS)
}
