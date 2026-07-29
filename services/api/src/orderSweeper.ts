/**
 * 订单超时自动清理（in-process 定时任务）
 *
 * 规则：
 *   - PAYING 超过 30 分钟未收到微信回调 → 标 FAILED（语义：支付失败/超时）
 *   - PENDING 超过 30 分钟用户未发起支付 → 标 CANCELLED（语义：用户放弃）
 *
 * 调度：
 *   - 启动时立即跑一次（清掉之前积压的垃圾单）
 *   - 之后每 5 分钟跑一次
 *
 * 时间锚：
 *   依赖 AppOrder.updatedAt 字段（Prisma @updatedAt 自动维护）。
 *   updatedAt 反映"状态最后一次变更时间"，比 createdAt 精确：
 *   一条 PENDING 订单变 PAYING 后 updatedAt 会刷新，30 分钟从那一刻起算，
 *   不会因创建时间过早被误清。
 *   schema 加 updatedAt 字段见 migration 20260409105500。
 */
import type { PrismaClient } from '@prisma/client'
import { couponsEnabled } from './coupons'

const SWEEP_INTERVAL_MS = 5 * 60 * 1000   // 每 5 分钟扫一次
const STALE_THRESHOLD_MS = 30 * 60 * 1000 // 超过 30 分钟视为僵尸订单

// 可观测性：sweeper 运行状态，供 GET /api/internal/sweeper/stats 暴露
const sweeperStats = {
  startedAt: null as Date | null,
  runCount: 0,
  totalPayingCleaned: 0,
  totalPendingCleaned: 0,
  lastRunAt: null as Date | null,
  lastRunCleaned: 0,
  lastError: null as string | null,
  lastErrorAt: null as Date | null,
}

export function getSweeperStats() {
  return { ...sweeperStats }
}

export async function sweepStaleOrders(prisma: PrismaClient): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)

  // 阶段三：超时关单前先查出涉及的订单号，事后统一解锁优惠券
  // 1. couponsEnabled()=false 时整段跳过（db 可能还没 add_coupons migration）
  // 2. 闸门通过但 db 实际无表/字段（migration 未跑成功）→ catch 住静默跳过，不阻塞主 sweeper
  let staleOrderNos: string[] = []
  if (couponsEnabled()) {
    try {
      const stalePaying = await prisma.appOrder.findMany({
        where: { status: 'PAYING', updatedAt: { lt: cutoff }, userCouponId: { not: null } },
        select: { orderNo: true },
      })
      const stalePending = await prisma.appOrder.findMany({
        where: { status: 'PENDING', updatedAt: { lt: cutoff }, userCouponId: { not: null } },
        select: { orderNo: true },
      })
      staleOrderNos = [...stalePaying, ...stalePending].map(o => o.orderNo)
    } catch (err: any) {
      const { logger } = await import('./logger.js')
      logger.warn({ module: 'orderSweeper', err: err.message }, '优惠券扫描跳过（db 可能未 migrate）')
    }
  }

  // PAYING 超时 → FAILED（区分语义：支付链路曾被触发但失败/超时）
  const failedResult = await prisma.appOrder.updateMany({
    where: {
      status: 'PAYING',
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      failReason: '支付超时自动关闭',
    },
  })

  // PENDING 超时 → CANCELLED（用户从未操作支付）
  const cancelledResult = await prisma.appOrder.updateMany({
    where: {
      status: 'PENDING',
      updatedAt: { lt: cutoff },
    },
    data: {
      status: 'CANCELLED',
      failReason: '下单超时自动关闭',
    },
  })

  // 专家评审投票联动：AppOrder 超时 → 同步把 ExpertVoteRequest 由 PAYING 迁 CANCELLED
  // - productType=EXPERT_VOTE 且 productRef=requestNo
  // - 仅迁 status=PAYING 的请求，避免误改已支付的（虽然理论上 AppOrder 已支付不会进 sweeper，但 CAS 兜底）
  // - 表不存在时 catch 静默跳过（与优惠券解锁同样的兜底策略）
  try {
    const expertVoteOrders = await prisma.appOrder.findMany({
      where: {
        productType: 'EXPERT_VOTE',
        productRef: { not: null },
        status: { in: ['FAILED', 'CANCELLED'] },
        updatedAt: { gte: cutoff },
      },
      select: { productRef: true, status: true },
    })
    for (const o of expertVoteOrders) {
      if (!o.productRef) continue
      await prisma.expertVoteRequest.updateMany({
        where: { requestNo: o.productRef, status: 'PAYING' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: o.status === 'FAILED' ? '支付超时自动关闭' : '下单超时自动关闭',
        },
      })
    }
  } catch (err: any) {
    const { logger } = await import('./logger.js')
    logger.warn({ module: 'orderSweeper', err: err.message }, '专家评审同步跳过（db 可能未 migrate）')
  }

  // 解锁这些超时订单关联的优惠券（LOCKED → AVAILABLE）
  // 同样 catch 兜底：UserCoupon 表不存在时静默跳过
  if (staleOrderNos.length > 0) {
    try {
      await prisma.userCoupon.updateMany({
        where: { lockedOrderNo: { in: staleOrderNos }, status: 'LOCKED' },
        data: { status: 'AVAILABLE', lockedOrderNo: null, lockedAt: null },
      })
    } catch (err: any) {
      const { logger } = await import('./logger.js')
      logger.warn({ module: 'orderSweeper', err: err.message }, '优惠券解锁跳过（db 可能未 migrate）')
    }
  }

  // 更新 stats
  sweeperStats.runCount++
  sweeperStats.lastRunAt = new Date()
  sweeperStats.lastRunCleaned = failedResult.count + cancelledResult.count
  sweeperStats.totalPayingCleaned += failedResult.count
  sweeperStats.totalPendingCleaned += cancelledResult.count

  if (failedResult.count > 0 || cancelledResult.count > 0) {
    const { logger } = await import('./logger.js')
    logger.info({ module: 'orderSweeper', payingFailed: failedResult.count, pendingCancelled: cancelledResult.count }, '订单超时清理')
  }
}

export function startOrderSweeper(prisma: PrismaClient): void {
  const sweep = async () => {
    try {
      await sweepStaleOrders(prisma)
    } catch (err: any) {
      sweeperStats.lastError = err.message
      sweeperStats.lastErrorAt = new Date()
      const { logger } = await import('./logger.js')
      logger.error({ module: 'orderSweeper', err: err.message }, '扫描异常')
    }
  }

  sweeperStats.startedAt = new Date()

  // 启动时立即跑一次（清理之前积压的）
  sweep()

  // 之后每 5 分钟跑一次
  setInterval(sweep, SWEEP_INTERVAL_MS)

  import('./logger.js').then(({ logger }) =>
    logger.info({ module: 'orderSweeper', intervalMin: 5 }, '已启动')
  )
}
