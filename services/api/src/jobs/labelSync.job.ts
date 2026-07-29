/**
 * labelSync job — 每日 02:00 基于 AnalyticsEvent 聚合用户标签
 *
 * 生命周期判定（优先级从高到低，首个命中生效）：
 *  1. HIGH_ACTIVE —— 近 7 天核心事件 ≥ 10
 *  2. CHURNED    —— 曾激活 + lastActiveAt > 30 天
 *  3. SILENT     —— 曾激活 + lastActiveAt > 14 天
 *  4. PAID       —— 有过 pay_success（优先级高于 ACTIVATED）
 *  5. ACTIVATED  —— 有任一核心事件
 *  6. NEW        —— 无任何核心事件
 *
 * 核心事件集合：search_success / scan_success / compare_complete / outline_generated / chat_sent
 *
 * 结果 upsert 到 UserLabel 表；暴露 runLabelSync() 便于单元测试 + 手动触发。
 */
import cron from 'node-cron'
import { prisma } from '../db.js'
import { logger } from '../logger.js'

const CORE_EVENTS = [
  'search_success',
  'scan_success',
  'compare_complete',
  'outline_generated',
  'chat_sent',
] as const

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export type Lifecycle =
  | 'NEW'
  | 'ACTIVATED'
  | 'PAID'
  | 'HIGH_ACTIVE'
  | 'SILENT'
  | 'CHURNED'

export function classifyLifecycle(params: {
  hasCoreEvent: boolean
  hasPayEvent: boolean
  weeklyActions: number
  lastActiveAt: Date | null
  now: Date
}): Lifecycle {
  const { hasCoreEvent, hasPayEvent, weeklyActions, lastActiveAt, now } = params

  if (!hasCoreEvent) return 'NEW'

  if (weeklyActions >= 10) return 'HIGH_ACTIVE'

  if (lastActiveAt) {
    const ageMs = now.getTime() - lastActiveAt.getTime()
    if (ageMs > THIRTY_DAYS_MS) return 'CHURNED'
    if (ageMs > FOURTEEN_DAYS_MS) return 'SILENT'
  }

  if (hasPayEvent) return 'PAID'
  return 'ACTIVATED'
}

export interface LabelSyncResult {
  totalUsers: number
  written: number
  byLifecycle: Record<Lifecycle, number>
  durationMs: number
}

/**
 * 聚合所有 AppUser 的标签并 upsert 到 UserLabel。
 * 每日 cron 调用，也可手动/测试调用。
 */
export async function runLabelSync(now: Date = new Date()): Promise<LabelSyncResult> {
  const start = Date.now()
  const sevenDaysAgoMs = BigInt(now.getTime() - SEVEN_DAYS_MS)

  const users = await prisma.appUser.findMany({
    select: { id: true, lastActiveAt: true },
  })

  const byLifecycle: Record<Lifecycle, number> = {
    NEW: 0, ACTIVATED: 0, PAID: 0, HIGH_ACTIVE: 0, SILENT: 0, CHURNED: 0,
  }
  let written = 0

  for (const user of users) {
    // 查 4 个维度（并发）
    const [coreEventCount, payEventCount, weeklyActions] = await Promise.all([
      prisma.analyticsEvent.count({
        where: { userId: user.id, event: { in: [...CORE_EVENTS] } },
      }),
      prisma.analyticsEvent.count({
        where: { userId: user.id, event: 'pay_success' },
      }),
      prisma.analyticsEvent.count({
        where: {
          userId: user.id,
          event: { in: [...CORE_EVENTS] },
          serverTs: { gte: sevenDaysAgoMs },
        },
      }),
    ])

    const lifecycle = classifyLifecycle({
      hasCoreEvent: coreEventCount > 0,
      hasPayEvent: payEventCount > 0,
      weeklyActions,
      lastActiveAt: user.lastActiveAt,
      now,
    })
    const isPaid = payEventCount > 0

    await prisma.userLabel.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        lifecycle,
        lastActiveAt: user.lastActiveAt,
        weeklyActions,
        isPaid,
      },
      update: {
        lifecycle,
        lastActiveAt: user.lastActiveAt,
        weeklyActions,
        isPaid,
      },
    })

    byLifecycle[lifecycle]++
    written++
  }

  const result: LabelSyncResult = {
    totalUsers: users.length,
    written,
    byLifecycle,
    durationMs: Date.now() - start,
  }
  logger.info({ module: 'labelSync', ...result }, 'labelSync 完成')
  return result
}

let scheduled = false

/**
 * 挂上每日 02:00 的 cron。main.ts 启动时调用一次即可。
 * 重复调用只会注册一次（scheduled 守卫）。
 */
export function scheduleLabelSync(): void {
  if (scheduled) return
  scheduled = true
  // 每日 02:00
  cron.schedule('0 2 * * *', () => {
    runLabelSync().catch((err) => {
      logger.error({ module: 'labelSync', err }, 'labelSync 定时执行失败')
    })
  })
  logger.info({ module: 'labelSync' }, '已注册每日 02:00 labelSync 任务')
}
